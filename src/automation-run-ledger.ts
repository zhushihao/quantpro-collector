import { z } from "zod";

export const AUTOMATION_RUN_PHASES = ["STARTED", "FINAL"] as const;
export const AUTOMATION_RUN_STATUSES = [
	"STARTED",
	"COMPLETED",
	"SILENT",
	"BLOCKED",
	"FAILED",
] as const;
export const AUTOMATION_RUN_OUTCOMES = [
	"COMPLETED",
	"SILENT",
	"BLOCKED",
	"FAILED",
] as const;
export const AUTOMATION_REGISTRY_KEYS = [
	"holding-assistant-intraday",
	"holding-assistant-preclose",
	"industry-research",
	"company-facts",
	"central-policy",
	"ai-financing-rates",
] as const;

export type AutomationRunPhase = (typeof AUTOMATION_RUN_PHASES)[number];
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];
export type AutomationRunOutcome = (typeof AUTOMATION_RUN_OUTCOMES)[number];

const OPTIONAL_TEXT_128 = z.union([z.string().min(1).max(128), z.null()]).optional();
const OPTIONAL_TEXT_192 = z.union([z.string().min(1).max(192), z.null()]).optional();
const OPTIONAL_TEXT_256 = z.union([z.string().min(1).max(256), z.null()]).optional();
const OPTIONAL_SUMMARY = z.union([z.string().min(1).max(1200), z.null()]).optional();

export const AUTOMATION_RUN_EVENT_INPUT_SCHEMA = z
	.object({
		task_name: z.string().min(1).max(128),
		run_id: z.string().min(8).max(192).regex(/^[A-Za-z0-9:._-]+$/),
		phase: z.enum(AUTOMATION_RUN_PHASES),
		status: z.enum(AUTOMATION_RUN_STATUSES),
		scheduled_for: OPTIONAL_TEXT_128,
		occurred_at: z.string().min(1).max(128),
		notification_sent: z.union([z.boolean(), z.null()]).optional(),
		fresh_delta_count: z.union([z.number().int().min(0).max(10000), z.null()]).optional(),
		blocker_code: OPTIONAL_TEXT_128,
		trace_id: OPTIONAL_TEXT_128,
		prompt_version: OPTIONAL_TEXT_256,
		safe_summary: OPTIONAL_SUMMARY,
	})
	.strict();

export const AUTOMATION_RUN_BEGIN_INPUT_SCHEMA = z
	.object({
		task: z.enum(AUTOMATION_REGISTRY_KEYS),
		invocation_key: OPTIONAL_TEXT_192,
		prompt_version: OPTIONAL_TEXT_256,
	})
	.catchall(z.unknown());

export const AUTOMATION_RUN_END_INPUT_SCHEMA = z
	.object({
		run_id: z.string().min(8).max(192),
		outcome: z.enum(AUTOMATION_RUN_OUTCOMES),
		fresh_delta_count: z.number().int().min(0).max(10000),
		notification_intended: z.boolean(),
		reason: OPTIONAL_SUMMARY,
	})
	.catchall(z.unknown());

export const AUTOMATION_RUN_HISTORY_INPUT_SCHEMA = z
	.object({
		task_name: z.string().min(1).max(128).optional(),
		since: z.string().min(1).max(128).optional(),
		limit: z.number().int().min(1).max(100).optional(),
	})
	.strict();

export type AutomationRunEventInput = z.infer<typeof AUTOMATION_RUN_EVENT_INPUT_SCHEMA>;
export type AutomationRunBeginInput = z.infer<typeof AUTOMATION_RUN_BEGIN_INPUT_SCHEMA>;
export type AutomationRunEndInput = z.infer<typeof AUTOMATION_RUN_END_INPUT_SCHEMA>;

export class AutomationRunLedgerError extends Error {
	readonly code:
		| "AUTOMATION_RUN_VALIDATION_FAILED"
		| "AUTOMATION_RUN_CONFLICT"
		| "AUTOMATION_RUN_NOT_FOUND"
		| "AUTOMATION_RUN_UNAVAILABLE";
	readonly retryable: boolean;
	readonly requestId: string;

	constructor(
		code: AutomationRunLedgerError["code"],
		message: string,
		options: { retryable?: boolean; requestId?: string } = {},
	) {
		super(message);
		this.name = "AutomationRunLedgerError";
		this.code = code;
		this.retryable = options.retryable ?? code === "AUTOMATION_RUN_UNAVAILABLE";
		this.requestId = options.requestId ?? crypto.randomUUID().replaceAll("-", "");
	}
}

type StoredAutomationRun = {
	task_name: string;
	run_id: string;
	principal: string | null;
	invocation_key: string | null;
	scheduled_for: string | null;
	started_at: string | null;
	finished_at: string | null;
	outcome: AutomationRunOutcome | null;
	fresh_delta_count: number | null;
	notification_intended: number | null;
	notification_sent_legacy: number | null;
	reason: string | null;
	prompt_version: string | null;
	collector_build_sha: string | null;
	cloudflare_version_id: string | null;
	source_contract: "run-v2" | "legacy-event-v1";
	legacy_trace_id: string | null;
	legacy_started_sha256: string | null;
	legacy_final_sha256: string | null;
	final_payload_sha256: string | null;
	created_at: string;
	updated_at: string;
};

const TABLE = "automation_runs_v2";
const LEGACY_TABLE = "automation_run_events_v1";
const readyByDb = new WeakMap<object, Promise<void>>();

function validIso(value: string | null | undefined): boolean {
	return value == null || !Number.isNaN(Date.parse(value));
}

function validationSummary(error: z.ZodError): string {
	return error.issues
		.slice(0, 8)
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
			return `${path}:${issue.code}`;
		})
		.join("; ");
}

function parseLegacyEvent(input: unknown): AutomationRunEventInput {
	const parsed = AUTOMATION_RUN_EVENT_INPUT_SCHEMA.safeParse(input);
	if (!parsed.success) {
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_VALIDATION_FAILED",
			`automation run event does not match exact schema: ${validationSummary(parsed.error)}`,
		);
	}
	const value = parsed.data;
	if (!validIso(value.occurred_at) || !validIso(value.scheduled_for)) {
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_VALIDATION_FAILED",
			"automation run timestamps must be valid ISO date-times",
		);
	}
	if (value.phase === "STARTED") {
		if (value.status !== "STARTED") {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_VALIDATION_FAILED",
				"STARTED phase requires status=STARTED",
			);
		}
		if (
			value.notification_sent != null ||
			value.fresh_delta_count != null ||
			value.blocker_code != null
		) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_VALIDATION_FAILED",
				"STARTED phase cannot declare final outcome fields",
			);
		}
	} else {
		if (value.status === "STARTED") {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_VALIDATION_FAILED",
				"FINAL phase requires a terminal status",
			);
		}
		if (typeof value.notification_sent !== "boolean") {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_VALIDATION_FAILED",
				"FINAL phase requires notification_sent",
			);
		}
		if (!Number.isInteger(value.fresh_delta_count)) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_VALIDATION_FAILED",
				"FINAL phase requires fresh_delta_count",
			);
		}
		if ((value.status === "BLOCKED" || value.status === "FAILED") && !value.blocker_code) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_VALIDATION_FAILED",
				"BLOCKED/FAILED final status requires blocker_code",
			);
		}
		if (!value.safe_summary) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_VALIDATION_FAILED",
				"FINAL phase requires safe_summary",
			);
		}
	}
	return value;
}

function parseBegin(input: unknown): AutomationRunBeginInput {
	const parsed = AUTOMATION_RUN_BEGIN_INPUT_SCHEMA.safeParse(input);
	if (!parsed.success) {
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_VALIDATION_FAILED",
			`begin_run does not match schema: ${validationSummary(parsed.error)}`,
		);
	}
	return {
		task: parsed.data.task,
		invocation_key: parsed.data.invocation_key ?? null,
		prompt_version: parsed.data.prompt_version ?? null,
	};
}

function parseEnd(input: unknown): AutomationRunEndInput {
	const parsed = AUTOMATION_RUN_END_INPUT_SCHEMA.safeParse(input);
	if (!parsed.success) {
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_VALIDATION_FAILED",
			`end_run does not match schema: ${validationSummary(parsed.error)}`,
		);
	}
	return {
		...parsed.data,
		reason: parsed.data.reason ?? null,
	};
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

async function tableExists(db: D1Database, table: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?1")
		.bind(table)
		.first<Record<string, unknown>>();
	return row?.name === table;
}

async function ensureAutomationRunsTableInner(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS ${TABLE} (
				task_name TEXT NOT NULL,
				run_id TEXT NOT NULL,
				principal TEXT,
				invocation_key TEXT,
				scheduled_for TEXT,
				started_at TEXT,
				finished_at TEXT,
				outcome TEXT CHECK (outcome IS NULL OR outcome IN ('COMPLETED','SILENT','BLOCKED','FAILED')),
				fresh_delta_count INTEGER CHECK (fresh_delta_count IS NULL OR fresh_delta_count >= 0),
				notification_intended INTEGER CHECK (notification_intended IS NULL OR notification_intended IN (0,1)),
				notification_sent_legacy INTEGER CHECK (notification_sent_legacy IS NULL OR notification_sent_legacy IN (0,1)),
				reason TEXT,
				prompt_version TEXT,
				collector_build_sha TEXT,
				cloudflare_version_id TEXT,
				source_contract TEXT NOT NULL CHECK (source_contract IN ('run-v2','legacy-event-v1')),
				legacy_trace_id TEXT,
				legacy_started_sha256 TEXT,
				legacy_final_sha256 TEXT,
				final_payload_sha256 TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (task_name, run_id)
			) WITHOUT ROWID`,
		)
		.run();
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_v2_invocation
			ON ${TABLE} (principal, task_name, invocation_key)
			WHERE principal IS NOT NULL AND invocation_key IS NOT NULL`,
		)
		.run();
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS automation_runs_v2_task_time
			ON ${TABLE} (task_name, started_at DESC, finished_at DESC)`,
		)
		.run();
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS automation_runs_v2_time
			ON ${TABLE} (started_at DESC, finished_at DESC)`,
		)
		.run();

	if (!(await tableExists(db, LEGACY_TABLE))) return;
	await db
		.prepare(
			`INSERT OR IGNORE INTO ${TABLE} (
				task_name, run_id, principal, invocation_key, scheduled_for,
				started_at, finished_at, outcome, fresh_delta_count,
				notification_intended, notification_sent_legacy, reason, prompt_version,
				collector_build_sha, cloudflare_version_id, source_contract,
				legacy_trace_id, legacy_started_sha256, legacy_final_sha256,
				final_payload_sha256, created_at, updated_at
			)
			SELECT
				task_name,
				run_id,
				NULL,
				NULL,
				MAX(scheduled_for),
				MAX(CASE WHEN phase='STARTED' THEN occurred_at END),
				MAX(CASE WHEN phase='FINAL' THEN occurred_at END),
				MAX(CASE WHEN phase='FINAL' THEN status END),
				MAX(CASE WHEN phase='FINAL' THEN fresh_delta_count END),
				NULL,
				MAX(CASE WHEN phase='FINAL' THEN notification_sent END),
				COALESCE(
					MAX(CASE WHEN phase='FINAL' THEN blocker_code END),
					MAX(CASE WHEN phase='FINAL' THEN safe_summary END)
				),
				COALESCE(
					MAX(CASE WHEN phase='FINAL' THEN prompt_version END),
					MAX(CASE WHEN phase='STARTED' THEN prompt_version END)
				),
				COALESCE(
					MAX(CASE WHEN phase='FINAL' THEN collector_build_sha END),
					MAX(CASE WHEN phase='STARTED' THEN collector_build_sha END)
				),
				COALESCE(
					MAX(CASE WHEN phase='FINAL' THEN cloudflare_version_id END),
					MAX(CASE WHEN phase='STARTED' THEN cloudflare_version_id END)
				),
				'legacy-event-v1',
				COALESCE(
					MAX(CASE WHEN phase='FINAL' THEN trace_id END),
					MAX(CASE WHEN phase='STARTED' THEN trace_id END)
				),
				MAX(CASE WHEN phase='STARTED' THEN payload_sha256 END),
				MAX(CASE WHEN phase='FINAL' THEN payload_sha256 END),
				NULL,
				MIN(created_at),
				MAX(created_at)
			FROM ${LEGACY_TABLE}
			GROUP BY task_name, run_id`,
		)
		.run();
}

async function ensureAutomationRunsTable(db: D1Database): Promise<void> {
	const existing = readyByDb.get(db as object);
	if (existing) return existing;
	const ready = ensureAutomationRunsTableInner(db);
	readyByDb.set(db as object, ready);
	try {
		await ready;
	} catch (error) {
		readyByDb.delete(db as object);
		throw error;
	}
}

function normalizeRow(row: Record<string, unknown> | null): StoredAutomationRun | null {
	if (!row) return null;
	return {
		task_name: String(row.task_name ?? ""),
		run_id: String(row.run_id ?? ""),
		principal: row.principal == null ? null : String(row.principal),
		invocation_key: row.invocation_key == null ? null : String(row.invocation_key),
		scheduled_for: row.scheduled_for == null ? null : String(row.scheduled_for),
		started_at: row.started_at == null ? null : String(row.started_at),
		finished_at: row.finished_at == null ? null : String(row.finished_at),
		outcome: row.outcome == null ? null : (String(row.outcome) as AutomationRunOutcome),
		fresh_delta_count:
			row.fresh_delta_count == null ? null : Number(row.fresh_delta_count),
		notification_intended:
			row.notification_intended == null ? null : Number(row.notification_intended),
		notification_sent_legacy:
			row.notification_sent_legacy == null ? null : Number(row.notification_sent_legacy),
		reason: row.reason == null ? null : String(row.reason),
		prompt_version: row.prompt_version == null ? null : String(row.prompt_version),
		collector_build_sha:
			row.collector_build_sha == null ? null : String(row.collector_build_sha),
		cloudflare_version_id:
			row.cloudflare_version_id == null ? null : String(row.cloudflare_version_id),
		source_contract: String(row.source_contract) as StoredAutomationRun["source_contract"],
		legacy_trace_id:
			row.legacy_trace_id == null ? null : String(row.legacy_trace_id),
		legacy_started_sha256:
			row.legacy_started_sha256 == null ? null : String(row.legacy_started_sha256),
		legacy_final_sha256:
			row.legacy_final_sha256 == null ? null : String(row.legacy_final_sha256),
		final_payload_sha256:
			row.final_payload_sha256 == null ? null : String(row.final_payload_sha256),
		created_at: String(row.created_at ?? ""),
		updated_at: String(row.updated_at ?? ""),
	};
}

async function readRun(
	db: D1Database,
	taskName: string,
	runId: string,
): Promise<StoredAutomationRun | null> {
	return normalizeRow(
		await db
			.prepare(`SELECT * FROM ${TABLE} WHERE task_name=?1 AND run_id=?2`)
			.bind(taskName, runId)
			.first<Record<string, unknown>>(),
	);
}

export async function beginAutomationRun(input: {
	db: D1Database;
	begin: unknown;
	principal: string;
	collectorBuildSha?: string | null;
	cloudflareVersionId?: string | null;
	now?: string;
	requestId?: string;
}): Promise<{
	status: "RECORDED" | "IDEMPOTENT_REPLAY";
	run_id: string;
	task_name: string;
	audit_status: "OK";
}> {
	const requestId = input.requestId ?? crypto.randomUUID().replaceAll("-", "");
	const begin = parseBegin(input.begin);
	const now = input.now ?? new Date().toISOString();
	if (!validIso(now)) {
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_VALIDATION_FAILED",
			"server run timestamp is invalid",
			{ requestId },
		);
	}
	try {
		await ensureAutomationRunsTable(input.db);
		if (begin.invocation_key) {
			const existing = normalizeRow(
				await input.db
					.prepare(
						`SELECT * FROM ${TABLE}
						WHERE principal=?1 AND task_name=?2 AND invocation_key=?3`,
					)
					.bind(input.principal, begin.task, begin.invocation_key)
					.first<Record<string, unknown>>(),
			);
			if (existing) {
				return {
					status: "IDEMPOTENT_REPLAY",
					run_id: existing.run_id,
					task_name: existing.task_name,
					audit_status: "OK",
				};
			}
		}

		const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
		const insert = await input.db
			.prepare(
				`INSERT OR IGNORE INTO ${TABLE} (
					task_name, run_id, principal, invocation_key, scheduled_for,
					started_at, finished_at, outcome, fresh_delta_count,
					notification_intended, notification_sent_legacy, reason, prompt_version,
					collector_build_sha, cloudflare_version_id, source_contract,
					legacy_trace_id, legacy_started_sha256, legacy_final_sha256,
					final_payload_sha256, created_at, updated_at
				) VALUES (
					?1, ?2, ?3, ?4, NULL,
					?5, NULL, NULL, NULL,
					NULL, NULL, NULL, ?6,
					?7, ?8, 'run-v2',
					NULL, NULL, NULL,
					NULL, ?5, ?5
				)`,
			)
			.bind(
				begin.task,
				runId,
				input.principal,
				begin.invocation_key ?? null,
				now,
				begin.prompt_version ?? null,
				input.collectorBuildSha ?? null,
				input.cloudflareVersionId ?? null,
			)
			.run();
		if (Number(insert.meta?.changes ?? 0) > 0) {
			return { status: "RECORDED", run_id: runId, task_name: begin.task, audit_status: "OK" };
		}
		if (begin.invocation_key) {
			const replay = normalizeRow(
				await input.db
					.prepare(
						`SELECT * FROM ${TABLE}
						WHERE principal=?1 AND task_name=?2 AND invocation_key=?3`,
					)
					.bind(input.principal, begin.task, begin.invocation_key)
					.first<Record<string, unknown>>(),
			);
			if (replay) {
				return {
					status: "IDEMPOTENT_REPLAY",
					run_id: replay.run_id,
					task_name: replay.task_name,
					audit_status: "OK",
				};
			}
		}
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_UNAVAILABLE",
			"begin_run insert/read failed",
			{ retryable: true, requestId },
		);
	} catch (error) {
		if (error instanceof AutomationRunLedgerError) throw error;
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_UNAVAILABLE",
			"automation run audit storage is unavailable",
			{ retryable: true, requestId },
		);
	}
}

export async function endAutomationRun(input: {
	db: D1Database;
	end: unknown;
	now?: string;
	requestId?: string;
}): Promise<{
	status: "RECORDED" | "IDEMPOTENT_REPLAY";
	run_id: string;
	task_name: string;
	outcome: AutomationRunOutcome;
	audit_status: "OK";
}> {
	const requestId = input.requestId ?? crypto.randomUUID().replaceAll("-", "");
	const end = parseEnd(input.end);
	const now = input.now ?? new Date().toISOString();
	const finalPayload = {
		outcome: end.outcome,
		fresh_delta_count: end.fresh_delta_count,
		notification_intended: end.notification_intended,
		reason: end.reason ?? null,
	};
	const finalHash = await sha256Hex(finalPayload);
	try {
		await ensureAutomationRunsTable(input.db);
		const rows = await input.db
			.prepare(`SELECT * FROM ${TABLE} WHERE run_id=?1 AND source_contract='run-v2'`)
			.bind(end.run_id)
			.all<Record<string, unknown>>();
		const candidates = (rows.results ?? []).map((row) => normalizeRow(row)!);
		if (candidates.length === 0) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_NOT_FOUND",
				"run_id was not found",
				{ requestId },
			);
		}
		if (candidates.length !== 1) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_CONFLICT",
				"run_id is not unique",
				{ requestId },
			);
		}
		const existing = candidates[0];
		if (existing.final_payload_sha256) {
			if (existing.final_payload_sha256 !== finalHash) {
				throw new AutomationRunLedgerError(
					"AUTOMATION_RUN_CONFLICT",
					"run already has a different terminal outcome",
					{ requestId },
				);
			}
			return {
				status: "IDEMPOTENT_REPLAY",
				run_id: existing.run_id,
				task_name: existing.task_name,
				outcome: existing.outcome!,
				audit_status: "OK",
			};
		}

		await input.db
			.prepare(
				`UPDATE ${TABLE}
				SET finished_at=?3,
					outcome=?4,
					fresh_delta_count=?5,
					notification_intended=?6,
					reason=?7,
					final_payload_sha256=?8,
					updated_at=?3
				WHERE task_name=?1 AND run_id=?2
					AND source_contract='run-v2'
					AND final_payload_sha256 IS NULL`,
			)
			.bind(
				existing.task_name,
				existing.run_id,
				now,
				end.outcome,
				end.fresh_delta_count,
				end.notification_intended ? 1 : 0,
				end.reason ?? null,
				finalHash,
			)
			.run();

		const finished = await readRun(input.db, existing.task_name, existing.run_id);
		if (!finished?.final_payload_sha256) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_UNAVAILABLE",
				"end_run update/read failed",
				{ retryable: true, requestId },
			);
		}
		if (finished.final_payload_sha256 !== finalHash) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_CONFLICT",
				"run already has a different terminal outcome",
				{ requestId },
			);
		}
		return {
			status: "RECORDED",
			run_id: finished.run_id,
			task_name: finished.task_name,
			outcome: finished.outcome!,
			audit_status: "OK",
		};
	} catch (error) {
		if (error instanceof AutomationRunLedgerError) throw error;
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_UNAVAILABLE",
			"automation run audit storage is unavailable",
			{ retryable: true, requestId },
		);
	}
}

export async function recordAutomationRunEvent(input: {
	db: D1Database;
	event: unknown;
	collectorBuildSha?: string | null;
	cloudflareVersionId?: string | null;
	now?: string;
	requestId?: string;
}): Promise<{
	status: "RECORDED" | "IDEMPOTENT_REPLAY";
	task_name: string;
	run_id: string;
	phase: AutomationRunPhase;
	event_status: AutomationRunStatus;
	payload_sha256: string;
}> {
	const requestId = input.requestId ?? crypto.randomUUID().replaceAll("-", "");
	const event = parseLegacyEvent(input.event);
	const now = input.now ?? new Date().toISOString();
	const callerPayload = {
		...event,
		scheduled_for: event.scheduled_for ?? null,
		notification_sent: event.notification_sent ?? null,
		fresh_delta_count: event.fresh_delta_count ?? null,
		blocker_code: event.blocker_code ?? null,
		trace_id: event.trace_id ?? null,
		prompt_version: event.prompt_version ?? null,
		safe_summary: event.safe_summary ?? null,
	};
	const payloadSha256 = await sha256Hex(callerPayload);
	try {
		await ensureAutomationRunsTable(input.db);
		let existing = await readRun(input.db, event.task_name, event.run_id);
		if (existing && existing.source_contract !== "legacy-event-v1") {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_CONFLICT",
				"legacy run key collides with a v2 run",
				{ requestId },
			);
		}
		const hashField =
			event.phase === "STARTED" ? existing?.legacy_started_sha256 : existing?.legacy_final_sha256;
		if (hashField) {
			if (hashField !== payloadSha256) {
				throw new AutomationRunLedgerError(
					"AUTOMATION_RUN_CONFLICT",
					"automation run event key already exists with different payload",
					{ requestId },
				);
			}
			return {
				status: "IDEMPOTENT_REPLAY",
				task_name: event.task_name,
				run_id: event.run_id,
				phase: event.phase,
				event_status: event.status,
				payload_sha256: payloadSha256,
			};
		}

		if (!existing) {
			await input.db
				.prepare(
					`INSERT OR IGNORE INTO ${TABLE} (
						task_name, run_id, principal, invocation_key, scheduled_for,
						started_at, finished_at, outcome, fresh_delta_count,
						notification_intended, notification_sent_legacy, reason, prompt_version,
						collector_build_sha, cloudflare_version_id, source_contract,
						legacy_trace_id, legacy_started_sha256, legacy_final_sha256,
						final_payload_sha256, created_at, updated_at
					) VALUES (
						?1, ?2, NULL, NULL, ?3,
						?4, ?5, ?6, ?7,
						NULL, ?8, ?9, ?10,
						?11, ?12, 'legacy-event-v1',
						?13, ?14, ?15,
						NULL, ?16, ?16
					)`,
				)
				.bind(
					event.task_name,
					event.run_id,
					event.scheduled_for ?? null,
					event.phase === "STARTED" ? event.occurred_at : null,
					event.phase === "FINAL" ? event.occurred_at : null,
					event.phase === "FINAL" ? event.status : null,
					event.phase === "FINAL" ? event.fresh_delta_count ?? null : null,
					event.phase === "FINAL" && typeof event.notification_sent === "boolean"
						? event.notification_sent
							? 1
							: 0
						: null,
					event.phase === "FINAL"
						? event.blocker_code ?? event.safe_summary ?? null
						: null,
					event.prompt_version ?? null,
					input.collectorBuildSha ?? null,
					input.cloudflareVersionId ?? null,
					event.trace_id ?? null,
					event.phase === "STARTED" ? payloadSha256 : null,
					event.phase === "FINAL" ? payloadSha256 : null,
					now,
				)
				.run();
		} else if (event.phase === "STARTED") {
			await input.db
				.prepare(
					`UPDATE ${TABLE}
					SET scheduled_for=COALESCE(scheduled_for, ?3),
						started_at=COALESCE(started_at, ?4),
						prompt_version=COALESCE(prompt_version, ?5),
						collector_build_sha=COALESCE(collector_build_sha, ?6),
						cloudflare_version_id=COALESCE(cloudflare_version_id, ?7),
						legacy_trace_id=COALESCE(legacy_trace_id, ?8),
						legacy_started_sha256=?9,
						updated_at=?10
					WHERE task_name=?1 AND run_id=?2
						AND source_contract='legacy-event-v1'
						AND legacy_started_sha256 IS NULL`,
				)
				.bind(
					event.task_name,
					event.run_id,
					event.scheduled_for ?? null,
					event.occurred_at,
					event.prompt_version ?? null,
					input.collectorBuildSha ?? null,
					input.cloudflareVersionId ?? null,
					event.trace_id ?? null,
					payloadSha256,
					now,
				)
				.run();
		} else {
			await input.db
				.prepare(
					`UPDATE ${TABLE}
					SET scheduled_for=COALESCE(scheduled_for, ?3),
						finished_at=?4,
						outcome=?5,
						fresh_delta_count=?6,
						notification_sent_legacy=?7,
						reason=?8,
						prompt_version=COALESCE(?9, prompt_version),
						collector_build_sha=COALESCE(?10, collector_build_sha),
						cloudflare_version_id=COALESCE(?11, cloudflare_version_id),
						legacy_trace_id=COALESCE(?12, legacy_trace_id),
						legacy_final_sha256=?13,
						updated_at=?14
					WHERE task_name=?1 AND run_id=?2
						AND source_contract='legacy-event-v1'
						AND legacy_final_sha256 IS NULL`,
				)
				.bind(
					event.task_name,
					event.run_id,
					event.scheduled_for ?? null,
					event.occurred_at,
					event.status,
					event.fresh_delta_count ?? null,
					event.notification_sent ? 1 : 0,
					event.blocker_code ?? event.safe_summary ?? null,
					event.prompt_version ?? null,
					input.collectorBuildSha ?? null,
					input.cloudflareVersionId ?? null,
					event.trace_id ?? null,
					payloadSha256,
					now,
				)
				.run();
		}

		existing = await readRun(input.db, event.task_name, event.run_id);
		const persistedHash =
			event.phase === "STARTED"
				? existing?.legacy_started_sha256
				: existing?.legacy_final_sha256;
		if (persistedHash !== payloadSha256) {
			throw new AutomationRunLedgerError(
				persistedHash
					? "AUTOMATION_RUN_CONFLICT"
					: "AUTOMATION_RUN_UNAVAILABLE",
				persistedHash
					? "automation run event key already exists with different payload"
					: "automation run event insert/read failed",
				{ retryable: !persistedHash, requestId },
			);
		}
		return {
			status: "RECORDED",
			task_name: event.task_name,
			run_id: event.run_id,
			phase: event.phase,
			event_status: event.status,
			payload_sha256: payloadSha256,
		};
	} catch (error) {
		if (error instanceof AutomationRunLedgerError) throw error;
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_UNAVAILABLE",
			"automation run audit storage is unavailable",
			{ retryable: true, requestId },
		);
	}
}

export async function getAutomationRunHistory(input: {
	db: D1Database;
	taskName?: string;
	since?: string;
	limit?: number;
	requestId?: string;
}): Promise<{
	status: "OK";
	task_name: string | null;
	since: string | null;
	runs: Array<Record<string, unknown>>;
}> {
	const requestId = input.requestId ?? crypto.randomUUID().replaceAll("-", "");
	const taskName = input.taskName?.trim() || null;
	const since = input.since?.trim() || null;
	const limit = Math.max(1, Math.min(100, input.limit ?? 20));
	if (since && !validIso(since)) {
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_VALIDATION_FAILED",
			"since must be a valid ISO date-time",
			{ requestId },
		);
	}

	try {
		await ensureAutomationRunsTable(input.db);
		const clauses: string[] = [];
		const binds: unknown[] = [];
		if (taskName) {
			binds.push(taskName);
			clauses.push(`task_name=?${binds.length}`);
		}
		if (since) {
			binds.push(since);
			clauses.push(
				`COALESCE(finished_at, started_at, updated_at)>=?${binds.length}`,
			);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		binds.push(limit);
		const result = await input.db
			.prepare(
				`SELECT * FROM ${TABLE}${where}
				ORDER BY COALESCE(finished_at, started_at, updated_at) DESC
				LIMIT ?${binds.length}`,
			)
			.bind(...binds)
			.all<Record<string, unknown>>();
		const runs = (result.results ?? []).map((raw) => {
			const row = normalizeRow(raw)!;
			const legacy = row.source_contract === "legacy-event-v1";
			return {
				task_name: row.task_name,
				run_id: row.run_id,
				scheduled_for: row.scheduled_for,
				started_at: row.started_at,
				finished_at: row.finished_at,
				effective_status: row.outcome ?? "IN_PROGRESS",
				final_recorded: row.outcome !== null,
				result_semantics: row.outcome === null ? "RESULT_UNKNOWN" : "TERMINAL_RECORDED",
				notification_sent:
					legacy && row.notification_sent_legacy != null
						? Boolean(row.notification_sent_legacy)
						: null,
				notification_intended:
					!legacy && row.notification_intended != null
						? Boolean(row.notification_intended)
						: null,
				notification_semantics: legacy
					? "CALLER_REPORTED_SENT"
					: "INTENDED_ONLY",
				fresh_delta_count: row.fresh_delta_count,
				fresh_delta_semantics: "CALLER_REPORTED",
				blocker_code:
					row.outcome === "BLOCKED" || row.outcome === "FAILED" ? row.reason : null,
				trace_id: legacy ? row.legacy_trace_id : row.run_id,
				collector_build_sha: row.collector_build_sha,
				cloudflare_version_id: row.cloudflare_version_id,
				prompt_version: row.prompt_version,
				safe_summary: row.reason,
				source_contract: row.source_contract,
			};
		});
		return { status: "OK", task_name: taskName, since, runs };
	} catch (error) {
		if (error instanceof AutomationRunLedgerError) throw error;
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_UNAVAILABLE",
			"automation run audit storage is unavailable",
			{ retryable: true, requestId },
		);
	}
}
