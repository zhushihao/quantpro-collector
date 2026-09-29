// Single-shot run envelope contract (spec docs/specs/2026-09-29-envelope-spec.md).
//
// submit_run_envelope: one MCP call registers the run (run-v3 row) and lands
// the channel content. Idempotency, channel validation, ledger write, outcome
// derivation, fresh counting, and the notification floor all happen
// server-side; the model self-reports nothing. `channel_payload` omitted
// means a heartbeat: no ledger write, one SILENT run row.
import { z } from "zod";

import { AUTOMATION_REGISTRY_KEYS } from "./automation-run-ledger.ts";
import {
	computeTimeliness,
	ensureRunEnvelopeTables,
	readScheduleRows,
	resolveSlotBinding,
} from "./automation-schedule.ts";
import { getStateWriteReceipt } from "./state-receipts.ts";
import { StateGatewayError } from "./state-gateway.ts";
import {
	AS_OF_SCHEMA,
	CLOSE_EVENT_COMMAND_SCHEMA,
	COMPANY_EVENT_COMMAND_SCHEMA,
	INDUSTRY_EVENT_COMMAND_SCHEMA,
	appendInvestmentCommand,
	appendMarketObservation,
	buildInvestmentCommandBatch,
} from "./state-commands.ts";
import { MARKET_LEDGER_SLOT_SCHEMA } from "./market-ledger.ts";

export {
	computeTimeliness,
	deriveMissedSlots,
	deriveMissedSlotsFromRows,
	ensureRunEnvelopeTables,
	readScheduleRows,
	resolveSlotBinding,
	runScheduleReconciliation,
} from "./automation-schedule.ts";

const ENVELOPE_SUMMARY_SCHEMA = z.string().min(1).max(1200);

function investmentChannelMember(eventSchema: z.ZodTypeAny) {
	return {
		as_of: AS_OF_SCHEMA,
		events: z.array(eventSchema).min(1).max(128),
	};
}

// Closed envelope surface: top-level strict + discriminated union members
// strict + event items strict → JSON Schema additionalProperties:false on both
// layers, same host-safety shape as the narrow append tools (spec §1.2).
export const SUBMIT_RUN_ENVELOPE_INPUT_SCHEMA = z
	.object({
		task_name: z.enum(AUTOMATION_REGISTRY_KEYS),
		summary: ENVELOPE_SUMMARY_SCHEMA,
		channel_payload: z
			.discriminatedUnion("channel", [
				z
					.object({
						channel: z.literal("INDUSTRY"),
						...investmentChannelMember(INDUSTRY_EVENT_COMMAND_SCHEMA.strict()),
					})
					.strict(),
				z
					.object({
						channel: z.literal("COMPANY"),
						...investmentChannelMember(COMPANY_EVENT_COMMAND_SCHEMA.strict()),
					})
					.strict(),
				z
					.object({
						channel: z.literal("CLOSE"),
						...investmentChannelMember(CLOSE_EVENT_COMMAND_SCHEMA.strict()),
					})
					.strict(),
				z
					.object({
						channel: z.literal("MARKET"),
						trading_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
						as_of: AS_OF_SCHEMA,
						scheduled_slot: MARKET_LEDGER_SLOT_SCHEMA,
						production_ref: z.string().regex(/^[0-9a-f]{40}$/i),
						records: z.array(z.record(z.string().min(1), z.unknown())).max(512),
					})
					.strict(),
			])
			.optional(),
	})
	.strict();

export type RunEnvelopeOutcome = "COMPLETED" | "SILENT" | "BLOCKED" | "FAILED" | "UNKNOWN";

export type RunEnvelopeLedgerStatus =
	| "PERSISTED"
	| "IDEMPOTENT_REPLAY"
	| "SKIPPED_HEARTBEAT"
	| null;

export type RunEnvelopeReceipt = {
	status: "ENVELOPE_RECORDED" | "ENVELOPE_REPLAY";
	run_id: string;
	task_name: string;
	outcome: RunEnvelopeOutcome;
	envelope_key: string;
	slot: string | null;
	slot_date: string | null;
	ledger: {
		status: RunEnvelopeLedgerStatus;
		channel: string | null;
		write_key: string | null;
		comment_id: string | null;
		url: string | null;
	} | null;
	fresh_delta_count: number | null;
	event_count: number | null;
	notification_required: boolean;
	notification_semantics: "SERVER_DERIVED_FLOOR";
	delivery: "MODEL_DELIVERY_UNVERIFIED";
	timeliness: "FRESH" | "STALE";
};

/**
 * StateGatewayError that carries the recorded run fields so the tool error
 * response can stay honest about what was already persisted (spec §1.4 step 8:
 * record first, then throw).
 */
export class RunEnvelopeError extends StateGatewayError {
	readonly runId: string | null;
	readonly outcome: RunEnvelopeOutcome | null;
	readonly envelopeKey: string | null;
	readonly blockerCode: string | null;

	constructor(
		details: {
			code: StateGatewayError["code"];
			phase: StateGatewayError["phase"];
			message: string;
			retryable?: boolean;
			requestId?: string;
			httpStatus?: number | null;
		},
		run: {
			runId?: string | null;
			outcome?: RunEnvelopeOutcome | null;
			envelopeKey?: string | null;
			blockerCode?: string | null;
		} = {},
	) {
		super(details);
		this.name = "RunEnvelopeError";
		this.runId = run.runId ?? null;
		this.outcome = run.outcome ?? null;
		this.envelopeKey = run.envelopeKey ?? null;
		this.blockerCode = run.blockerCode ?? null;
	}
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(object)
				.sort()
				.map((key) => [key, canonicalize(object[key])]),
		);
	}
	return value;
}

async function sha256Hex(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function newRunId(): string {
	return `run_${crypto.randomUUID().replaceAll("-", "")}`;
}

type StoredRunV3Row = {
	task_name: string;
	run_id: string;
	envelope_key: string;
	channel: string | null;
	write_key: string | null;
	as_of: string | null;
	received_at: string;
	slot: string | null;
	slot_date: string | null;
	fresh_delta_count: number | null;
	event_count: number | null;
	outcome: RunEnvelopeOutcome;
	blocker_code: string | null;
	summary: string | null;
	created_at: string;
	updated_at: string;
};

function normalizeRunV3Row(row: Record<string, unknown> | null): StoredRunV3Row | null {
	if (!row) return null;
	return {
		task_name: String(row.task_name ?? ""),
		run_id: String(row.run_id ?? ""),
		envelope_key: String(row.envelope_key ?? ""),
		channel: row.channel == null ? null : String(row.channel),
		write_key: row.write_key == null ? null : String(row.write_key),
		as_of: row.as_of == null ? null : String(row.as_of),
		received_at: String(row.received_at ?? ""),
		slot: row.slot == null ? null : String(row.slot),
		slot_date: row.slot_date == null ? null : String(row.slot_date),
		fresh_delta_count: row.fresh_delta_count == null ? null : Number(row.fresh_delta_count),
		event_count: row.event_count == null ? null : Number(row.event_count),
		outcome: String(row.outcome ?? "UNKNOWN") as RunEnvelopeOutcome,
		blocker_code: row.blocker_code == null ? null : String(row.blocker_code),
		summary: row.summary == null ? null : String(row.summary),
		created_at: String(row.created_at ?? ""),
		updated_at: String(row.updated_at ?? ""),
	};
}

async function readRunV3(
	db: D1Database,
	taskName: string,
	envelopeKey: string,
): Promise<StoredRunV3Row | null> {
	return normalizeRunV3Row(
		await db
			.prepare(
				`SELECT * FROM automation_runs_v3 WHERE task_name=?1 AND envelope_key=?2`,
			)
			.bind(taskName, envelopeKey)
			.first<Record<string, unknown>>(),
	);
}

type WindowMinuteLookup = (taskName: string) => number | null;

function windowMinuteLookup(rows: Awaited<ReturnType<typeof readScheduleRows>>): WindowMinuteLookup {
	return (taskName) => {
		const row = rows.find((candidate) => candidate.task_name === taskName && candidate.enabled);
		return row ? row.window_minutes : null;
	};
}

type LedgerOutcome =
	| { kind: "heartbeat" }
	| { kind: "executed"; result: Awaited<ReturnType<typeof appendInvestmentCommand>> }
	| { kind: "error"; error: StateGatewayError; eventCount: number | null };

function ledgerFromReceipt(
	row: StoredRunV3Row,
	receipt: Awaited<ReturnType<typeof getStateWriteReceipt>>,
): RunEnvelopeReceipt["ledger"] {
	if (!row.write_key) {
		if (!row.channel && row.envelope_key.startsWith("HB:")) {
			return {
				status: "SKIPPED_HEARTBEAT",
				channel: null,
				write_key: null,
				comment_id: null,
				url: null,
			};
		}
		return null;
	}
	const replayedStatus: RunEnvelopeLedgerStatus =
		receipt && (receipt.status === "PERSISTED" || receipt.status === "IDEMPOTENT_REPLAY")
			? receipt.status
			: null;
	return {
		status: replayedStatus,
		channel: row.channel,
		write_key: row.write_key,
		comment_id: receipt?.comment_id ?? null,
		url: receipt?.comment_url ?? null,
	};
}

async function receiptFromRow(
	db: D1Database,
	row: StoredRunV3Row,
	windowMinutesFor: WindowMinuteLookup,
): Promise<RunEnvelopeReceipt> {
	const receipt = row.write_key ? await getStateWriteReceipt(db, row.write_key) : null;
	return {
		status: "ENVELOPE_REPLAY",
		run_id: row.run_id,
		task_name: row.task_name,
		outcome: row.outcome,
		envelope_key: row.envelope_key,
		slot: row.slot,
		slot_date: row.slot_date,
		ledger: ledgerFromReceipt(row, receipt),
		fresh_delta_count: row.fresh_delta_count,
		event_count: row.event_count,
		notification_required: (row.fresh_delta_count ?? 0) > 0,
		notification_semantics: "SERVER_DERIVED_FLOOR",
		delivery: "MODEL_DELIVERY_UNVERIFIED",
		timeliness: computeTimeliness(
			row.as_of,
			Date.parse(row.received_at),
			windowMinutesFor(row.task_name),
		),
	};
}

async function updateRunV3Row(input: {
	db: D1Database;
	row: StoredRunV3Row;
	channel: string | null;
	writeKey: string | null;
	asOf: string | null;
	slot: string | null;
	slotDate: string | null;
	freshDeltaCount: number | null;
	eventCount: number | null;
	outcome: RunEnvelopeOutcome;
	blockerCode: string | null;
	summary: string | null;
	collectorBuildSha: string | null;
	cloudflareVersionId: string | null;
	updatedAt: string;
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE automation_runs_v3
			SET channel=?3,
				write_key=?4,
				as_of=?5,
				slot=?6,
				slot_date=?7,
				fresh_delta_count=?8,
				event_count=?9,
				outcome=?10,
				blocker_code=?11,
				summary=?12,
				collector_build_sha=COALESCE(?13, collector_build_sha),
				cloudflare_version_id=COALESCE(?14, cloudflare_version_id),
				updated_at=?15
			WHERE task_name=?1 AND run_id=?2 AND outcome='UNKNOWN'`,
		)
		.bind(
			input.row.task_name,
			input.row.run_id,
			input.channel,
			input.writeKey,
			input.asOf,
			input.slot,
			input.slotDate,
			input.freshDeltaCount,
			input.eventCount,
			input.outcome,
			input.blockerCode,
			input.summary,
			input.collectorBuildSha,
			input.cloudflareVersionId,
			input.updatedAt,
		)
		.run();
}

function outcomeForGatewayError(error: StateGatewayError): RunEnvelopeOutcome {
	if (error.retryable) return "UNKNOWN";
	if (error.code === "STATE_CONFLICT" || error.code === "STATE_CHAIN_MISMATCH") return "BLOCKED";
	return "FAILED";
}

function runEnvelopeErrorFor(
	error: StateGatewayError,
	run: { runId: string; envelopeKey: string; outcome: RunEnvelopeOutcome },
): RunEnvelopeError {
	return new RunEnvelopeError(
		{
			code: error.code,
			phase: error.phase,
			message: error.message,
			retryable: error.retryable,
			httpStatus: error.httpStatus,
		},
		{
			runId: run.runId,
			outcome: run.outcome,
			envelopeKey: run.envelopeKey,
			blockerCode: `${error.code}:${error.phase}`,
		},
	);
}

async function insertInvalidRunRow(input: {
	db: D1Database;
	taskName: string;
	envelopeKey: string;
	receivedAt: string;
	slot: string | null;
	slotDate: string | null;
	blockerCode: string;
	summary: string | null;
	collectorBuildSha?: string | null;
	cloudflareVersionId?: string | null;
}): Promise<{ replay: StoredRunV3Row | null; runId: string }> {
	const runId = newRunId();
	const nowIso = new Date().toISOString();
	const insert = await input.db
		.prepare(
			`INSERT INTO automation_runs_v3 (
				task_name, run_id, envelope_key, channel, write_key, as_of,
				received_at, slot, slot_date, fresh_delta_count, event_count,
				outcome, blocker_code, summary, prompt_version,
				collector_build_sha, cloudflare_version_id, created_at, updated_at
			) VALUES (
				?1, ?2, ?3, NULL, NULL, NULL,
				?4, ?5, ?6, NULL, NULL,
				'FAILED', ?7, ?8, NULL,
				?9, ?10, ?11, ?11
			)
			ON CONFLICT(task_name, envelope_key) DO NOTHING`,
		)
		.bind(
			input.taskName,
			runId,
			input.envelopeKey,
			input.receivedAt,
			input.slot,
			input.slotDate,
			input.blockerCode,
			input.summary,
			input.collectorBuildSha ?? null,
			input.cloudflareVersionId ?? null,
			nowIso,
		)
		.run();
	if (Number((insert as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0) {
		return { replay: null, runId };
	}
	// Same bad envelope retried: the unique index hands back the original
	// FAILED row, which the caller replays verbatim (review F2).
	return { replay: await readRunV3(input.db, input.taskName, input.envelopeKey), runId };
}

async function insertUnknownRunRow(input: {
	db: D1Database;
	taskName: string;
	runId: string;
	envelopeKey: string;
	receivedAt: string;
	slot: string | null;
	slotDate: string | null;
	promptVersion?: string | null;
	collectorBuildSha?: string | null;
	cloudflareVersionId?: string | null;
}): Promise<"inserted" | "conflicted"> {
	// Review F4: plain INSERT ... ON CONFLICT DO NOTHING — never INSERT OR
	// IGNORE, which would also swallow NOT NULL/CHECK violations and leave the
	// no-row branch undefined. A non-conflict insert failure surfaces as a
	// read-back miss below and becomes a retryable STATE_UNAVAILABLE.
	const insert = await input.db
		.prepare(
			`INSERT INTO automation_runs_v3 (
				task_name, run_id, envelope_key, channel, write_key, as_of,
				received_at, slot, slot_date, fresh_delta_count, event_count,
				outcome, blocker_code, summary, prompt_version,
					collector_build_sha, cloudflare_version_id, created_at, updated_at
				) VALUES (
					?1, ?2, ?3, NULL, NULL, NULL,
					?4, ?5, ?6, NULL, NULL,
					'UNKNOWN', NULL, NULL, ?7,
					?8, ?9, ?10, ?10
				)
				ON CONFLICT(task_name, envelope_key) DO NOTHING`,
			)
			.bind(
				input.taskName,
				input.runId,
				input.envelopeKey,
				input.receivedAt,
				input.slot,
				input.slotDate,
				input.promptVersion ?? null,
				input.collectorBuildSha ?? null,
				input.cloudflareVersionId ?? null,
				new Date().toISOString(),
			)
		.run();
	return Number((insert as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0
		? "inserted"
		: "conflicted";
}

/**
 * Core envelope processor (spec §1.4). Directly callable for tests and
 * internal lanes; the MCP tool handler wraps it with scope/auth/env gates.
 * The envelope has already passed SUBMIT_RUN_ENVELOPE_INPUT_SCHEMA by the time
 * the MCP SDK reaches the handler (two-layer validation contract, review F1);
 * strict parsing here is defense in depth for direct/internal calls.
 */
export async function processRunEnvelope(input: {
	db: D1Database;
	token: string;
	envelope: unknown;
	resolveOwnerContext?: () => Promise<{
		portfolioVersion: string;
		liveUniverseHash: string;
	}>;
	collectorBuildSha?: string | null;
	cloudflareVersionId?: string | null;
	fetchImpl?: typeof fetch;
	now?: string;
	requestId?: string;
}): Promise<RunEnvelopeReceipt> {
	const requestId = input.requestId ?? crypto.randomUUID().replaceAll("-", "");
	const receivedAt = input.now ?? new Date().toISOString();
	const receivedAtMs = Date.parse(receivedAt);

	// ---- Envelope schema gate (two-layer contract, review F1) ----------------
	const parsed = SUBMIT_RUN_ENVELOPE_INPUT_SCHEMA.safeParse(input.envelope);
	if (!parsed.success) {
		const raw = input.envelope;
		const rawTaskName =
			raw && typeof raw === "object" && !Array.isArray(raw)
				? (raw as Record<string, unknown>).task_name
				: undefined;
		const taskName = AUTOMATION_REGISTRY_KEYS.find((key) => key === rawTaskName);
		if (!taskName) {
			// No key to hang a row on: return the error without persisting
			// anything (honest boundary, spec §4.2).
			throw new RunEnvelopeError({
				code: "STATE_VALIDATION_FAILED",
				phase: "VALIDATE",
				message: "run envelope does not match the submit_run_envelope schema",
				retryable: false,
				requestId,
			});
		}
		await ensureRunEnvelopeTables(input.db);
		const envelopeKey = `E:INVALID:${await sha256Hex(raw)}`;
		const scheduleRows = await readScheduleRows(input.db);
		const binding = resolveSlotBinding(scheduleRows, taskName, receivedAtMs);
		const rawSummary =
			raw && typeof raw === "object" && !Array.isArray(raw)
				? (raw as Record<string, unknown>).summary
				: undefined;
		const blockerCode = "STATE_VALIDATION_FAILED:VALIDATE";
		const inserted = await insertInvalidRunRow({
			db: input.db,
			taskName,
			envelopeKey,
			receivedAt,
			slot: binding?.slot ?? null,
			slotDate: binding?.slot_date ?? null,
			blockerCode,
			summary: typeof rawSummary === "string" ? rawSummary.slice(0, 1200) : null,
			collectorBuildSha: input.collectorBuildSha,
			cloudflareVersionId: input.cloudflareVersionId,
		});
		if (inserted.replay) {
			return receiptFromRow(
				input.db,
				inserted.replay,
				windowMinuteLookup(scheduleRows),
			);
		}
		throw new RunEnvelopeError(
			{
				code: "STATE_VALIDATION_FAILED",
				phase: "VALIDATE",
				message: "run envelope does not match the submit_run_envelope schema",
				retryable: false,
				requestId,
			},
			{ runId: null, outcome: "FAILED", envelopeKey, blockerCode },
		);
	}

	const envelope = parsed.data;
	const taskName = envelope.task_name;
	await ensureRunEnvelopeTables(input.db);
	const scheduleRows = await readScheduleRows(input.db);
	const windowMinutesFor = windowMinuteLookup(scheduleRows);

	// ---- Envelope identity (spec §2.3) --------------------------------------
	const payload = envelope.channel_payload;
	let envelopeKey: string;
	let channel: "INDUSTRY" | "COMPANY" | "CLOSE" | "MARKET" | null = null;
	let eventCount: number | null = null;
	let asOf: string | null = null;
	if (!payload) {
		envelopeKey = `HB:${new Date(receivedAtMs).toISOString().slice(0, 13)}`;
	} else if (payload.channel === "MARKET") {
		channel = "MARKET";
		asOf = payload.as_of;
		eventCount = payload.records.length;
		envelopeKey = `E:MARKET:${await sha256Hex({
			trading_date: payload.trading_date,
			scheduled_slot: payload.scheduled_slot,
			production_ref: payload.production_ref,
			records: payload.records,
		})}`;
	} else {
		channel = payload.channel;
		asOf = payload.as_of;
		eventCount = payload.events.length;
		// as_of is deliberately excluded from the digest (spec §2.1); the
		// portfolio version placeholder never reaches the digest input.
		const prepared = await buildInvestmentCommandBatch({
			channel,
			command: { as_of: payload.as_of, events: payload.events },
			portfolioVersion: "envelope-key-derivation",
		});
		envelopeKey = `E:${channel}:${prepared.payloadSha256}`;
	}

	const binding = resolveSlotBinding(scheduleRows, taskName, receivedAtMs);

	// ---- Replay gate (spec §1.4 step 3) -------------------------------------
	const existing = await readRunV3(input.db, taskName, envelopeKey);
	if (existing && existing.outcome !== "UNKNOWN") {
		return receiptFromRow(input.db, existing, windowMinutesFor);
	}
	let runId = existing?.run_id ?? newRunId();

	// ---- UNKNOWN row reservation (spec §1.4 step 5) --------------------------
	let insertState: "inserted" | "conflicted";
	try {
		insertState = await insertUnknownRunRow({
			db: input.db,
			taskName,
			runId,
			envelopeKey,
			receivedAt,
			slot: binding?.slot ?? null,
			slotDate: binding?.slot_date ?? null,
			// The first-receipt row carries the envelope's actual production_ref
			// (MARKET only): a later BLOCKED/FAILED terminal must not erase which
			// version was submitted. Non-MARKET channels/heartbeats keep null.
			promptVersion: payload && payload.channel === "MARKET" ? payload.production_ref : null,
			collectorBuildSha: input.collectorBuildSha,
			cloudflareVersionId: input.cloudflareVersionId,
		});
	} catch {
		// Non-conflict insert failure (constraint/violation, storage error):
		// the row is absent, so the same envelope stays retryable (review F4).
		throw new RunEnvelopeError(
			{
				code: "STATE_UNAVAILABLE",
				phase: "WRITE",
				message: "run envelope row could not be reserved",
				retryable: true,
				requestId,
			},
			{ runId, outcome: null, envelopeKey },
		);
	}
	if (insertState === "conflicted") {
		const winner = await readRunV3(input.db, taskName, envelopeKey);
		if (winner && winner.outcome !== "UNKNOWN") {
			return receiptFromRow(input.db, winner, windowMinutesFor);
		}
		if (!winner) {
			throw new RunEnvelopeError(
				{
					code: "STATE_UNAVAILABLE",
					phase: "WRITE",
					message: "run envelope row could not be reserved",
					retryable: true,
					requestId,
				},
				{ runId, outcome: null, envelopeKey },
			);
		}
		// Loser of the insert race adopts the winner's row (review F2):
		// updating our own newRunId() would match zero rows and silently
		// drop the terminal update behind a phantom run_id.
		runId = winner.run_id;
	}

	// ---- Execute (spec §1.4 step 6) ------------------------------------------
	let ledgerOutcome: LedgerOutcome;
	if (!payload) {
		ledgerOutcome = { kind: "heartbeat" };
	} else {
		let executedEventCount: number | null = null;
		try {
			if (!input.resolveOwnerContext) {
				throw new StateGatewayError({
					code: "STATE_UNAVAILABLE",
					phase: "READ",
					message: "LIVE universe context resolver is not configured",
					retryable: true,
				});
			}
			const context = await input.resolveOwnerContext();
			if (channel === "MARKET" && payload.channel === "MARKET") {
				executedEventCount = eventCount;
				const result = await appendMarketObservation({
					db: input.db,
					token: input.token,
					command: {
						trading_date: payload.trading_date,
						as_of: payload.as_of,
						scheduled_slot: payload.scheduled_slot,
						production_ref: payload.production_ref,
						records: payload.records,
					},
					portfolioVersion: context.portfolioVersion,
					liveUniverseHash: context.liveUniverseHash,
					fetchImpl: input.fetchImpl,
					now: input.now,
					requestId,
					envelopeKey,
					eventCount,
				});
				ledgerOutcome = { kind: "executed", result };
			} else if (payload.channel !== "MARKET") {
				executedEventCount = eventCount;
				const result = await appendInvestmentCommand({
					db: input.db,
					token: input.token,
					channel: payload.channel,
					command: { as_of: payload.as_of, events: payload.events },
					portfolioVersion: context.portfolioVersion,
					fetchImpl: input.fetchImpl,
					now: input.now,
					requestId,
					envelopeKey,
					eventCount,
				});
				ledgerOutcome = { kind: "executed", result };
			} else {
				throw new StateGatewayError({
					code: "STATE_VALIDATION_FAILED",
					phase: "VALIDATE",
					message: "run envelope channel dispatch mismatch",
					retryable: false,
				});
			}
		} catch (error) {
			const gatewayError =
				error instanceof StateGatewayError
					? error
					: new StateGatewayError({
							code: "STATE_OUTCOME_UNKNOWN",
							phase: "WRITE",
							message: "run envelope execution failed with an unclassified error",
							retryable: true,
							requestId,
						});
			// Before the append actually starts (owner-context READ failure,
			// spec §1.4 step 0) nothing was written, so event_count stays NULL.
			ledgerOutcome = { kind: "error", error: gatewayError, eventCount: executedEventCount };
		}
	}

	// ---- Derive terminal outcome (spec §4.2 matrix) ---------------------------
	let outcome: RunEnvelopeOutcome;
	let freshDeltaCount: number | null;
	let writeKey: string | null = null;
	let commentId: string | null = null;
	let commentUrl: string | null = null;
	let ledgerStatus: RunEnvelopeLedgerStatus;
	if (ledgerOutcome.kind === "heartbeat") {
		outcome = "SILENT";
		freshDeltaCount = 0;
		eventCount = 0;
		ledgerStatus = "SKIPPED_HEARTBEAT";
	} else if (ledgerOutcome.kind === "executed") {
		writeKey = ledgerOutcome.result.write_key;
		commentId = ledgerOutcome.result.comment_id;
		commentUrl = ledgerOutcome.result.url;
		if (ledgerOutcome.result.status === "PERSISTED") {
			outcome = "COMPLETED";
			freshDeltaCount = 1;
			ledgerStatus = "PERSISTED";
		} else {
			outcome = "SILENT";
			freshDeltaCount = 0;
			ledgerStatus = "IDEMPOTENT_REPLAY";
		}
	} else {
		const error = ledgerOutcome.error;
		outcome = outcomeForGatewayError(error);
		freshDeltaCount = null;
		// event_count follows what the ledger actually wrote: NULL when the
		// append never started (spec §3.3), the executed count otherwise.
		eventCount = ledgerOutcome.eventCount;
		ledgerStatus = null;
	}
	const blockerCode =
		ledgerOutcome.kind === "error"
			? `${ledgerOutcome.error.code}:${ledgerOutcome.error.phase}`
			: null;

	const updatedAt = new Date().toISOString();
	await updateRunV3Row({
		db: input.db,
		row: {
			task_name: taskName,
			run_id: runId,
			envelope_key: envelopeKey,
			channel: null,
			write_key: null,
			as_of: null,
			received_at: receivedAt,
			slot: binding?.slot ?? null,
			slot_date: binding?.slot_date ?? null,
			fresh_delta_count: null,
			event_count: null,
			outcome: "UNKNOWN",
			blocker_code: null,
			summary: envelope.summary,
			created_at: receivedAt,
			updated_at: receivedAt,
		},
		channel,
		writeKey,
		asOf,
		slot: binding?.slot ?? null,
		slotDate: binding?.slot_date ?? null,
		freshDeltaCount,
		eventCount,
		outcome,
		blockerCode,
		summary: envelope.summary,
		collectorBuildSha: input.collectorBuildSha ?? null,
		cloudflareVersionId: input.cloudflareVersionId ?? null,
		updatedAt,
	});

	if (ledgerOutcome.kind === "error") {
		const error = ledgerOutcome.error;
		throw runEnvelopeErrorFor(error, { runId, envelopeKey, outcome });
	}

	return {
		status: "ENVELOPE_RECORDED",
		run_id: runId,
		task_name: taskName,
		outcome,
		envelope_key: envelopeKey,
		slot: binding?.slot ?? null,
		slot_date: binding?.slot_date ?? null,
		ledger: {
			status: ledgerStatus,
			channel,
			write_key: writeKey,
			comment_id: commentId,
			url: commentUrl,
		},
		fresh_delta_count: freshDeltaCount,
		event_count: eventCount,
		notification_required: (freshDeltaCount ?? 0) > 0,
		notification_semantics: "SERVER_DERIVED_FLOOR",
		delivery: "MODEL_DELIVERY_UNVERIFIED",
		timeliness: computeTimeliness(asOf, receivedAtMs, windowMinutesFor(taskName)),
	};
}
