import { z } from "zod";

export const AUTOMATION_RUN_PHASES = ["STARTED", "FINAL"] as const;
export const AUTOMATION_RUN_STATUSES = [
	"STARTED",
	"COMPLETED",
	"SILENT",
	"BLOCKED",
	"FAILED",
] as const;

export type AutomationRunPhase = (typeof AUTOMATION_RUN_PHASES)[number];
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

const OPTIONAL_TEXT_128 = z.union([z.string().min(1).max(128), z.null()]).optional();
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

export type AutomationRunEventInput = z.infer<typeof AUTOMATION_RUN_EVENT_INPUT_SCHEMA>;

export const AUTOMATION_RUN_HISTORY_INPUT_SCHEMA = z
	.object({
		task_name: z.string().min(1).max(128).optional(),
		since: z.string().min(1).max(128).optional(),
		limit: z.number().int().min(1).max(100).optional(),
	})
	.strict();

export class AutomationRunLedgerError extends Error {
	readonly code:
		| "AUTOMATION_RUN_VALIDATION_FAILED"
		| "AUTOMATION_RUN_CONFLICT"
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

type StoredAutomationRunEvent = {
	task_name: string;
	run_id: string;
	phase: AutomationRunPhase;
	status: AutomationRunStatus;
	scheduled_for: string | null;
	occurred_at: string;
	notification_sent: number | null;
	fresh_delta_count: number | null;
	blocker_code: string | null;
	trace_id: string | null;
	collector_build_sha: string | null;
	cloudflare_version_id: string | null;
	prompt_version: string | null;
	safe_summary: string | null;
	payload_sha256: string;
	created_at: string;
};

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

function validateEvent(input: unknown): AutomationRunEventInput {
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
		if (value.status === "BLOCKED" || value.status === "FAILED") {
			if (!value.blocker_code) {
				throw new AutomationRunLedgerError(
					"AUTOMATION_RUN_VALIDATION_FAILED",
					"BLOCKED/FAILED final status requires blocker_code",
				);
			}
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
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRow(row: Record<string, unknown>): StoredAutomationRunEvent {
	return {
		task_name: String(row.task_name ?? ""),
		run_id: String(row.run_id ?? ""),
		phase: String(row.phase ?? "") as AutomationRunPhase,
		status: String(row.status ?? "") as AutomationRunStatus,
		scheduled_for: row.scheduled_for == null ? null : String(row.scheduled_for),
		occurred_at: String(row.occurred_at ?? ""),
		notification_sent: row.notification_sent == null ? null : Number(row.notification_sent),
		fresh_delta_count: row.fresh_delta_count == null ? null : Number(row.fresh_delta_count),
		blocker_code: row.blocker_code == null ? null : String(row.blocker_code),
		trace_id: row.trace_id == null ? null : String(row.trace_id),
		collector_build_sha:
			row.collector_build_sha == null ? null : String(row.collector_build_sha),
		cloudflare_version_id:
			row.cloudflare_version_id == null ? null : String(row.cloudflare_version_id),
		prompt_version: row.prompt_version == null ? null : String(row.prompt_version),
		safe_summary: row.safe_summary == null ? null : String(row.safe_summary),
		payload_sha256: String(row.payload_sha256 ?? ""),
		created_at: String(row.created_at ?? ""),
	};
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
	const event = validateEvent(input.event);
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
	const stored = {
		...callerPayload,
		collector_build_sha: input.collectorBuildSha ?? null,
		cloudflare_version_id: input.cloudflareVersionId ?? null,
	};
	// Idempotency is defined by the caller-owned event only. A Collector deploy
	// between retries must not turn the same STARTED/FINAL event into a conflict.
	const payloadSha256 = await sha256Hex(callerPayload);

	try {
		const insert = await input.db
			.prepare(
				`INSERT OR IGNORE INTO automation_run_events_v1 (
					task_name, run_id, phase, status, scheduled_for, occurred_at,
					notification_sent, fresh_delta_count, blocker_code, trace_id,
					collector_build_sha, cloudflare_version_id, prompt_version, safe_summary,
					payload_sha256, created_at
				) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
			)
			.bind(
				event.task_name,
				event.run_id,
				event.phase,
				event.status,
				stored.scheduled_for,
				event.occurred_at,
				stored.notification_sent == null ? null : stored.notification_sent ? 1 : 0,
				stored.fresh_delta_count,
				stored.blocker_code,
				stored.trace_id,
				stored.collector_build_sha,
				stored.cloudflare_version_id,
				stored.prompt_version,
				stored.safe_summary,
				payloadSha256,
				now,
			)
			.run();

		const existing = await input.db
			.prepare(
				"SELECT payload_sha256 FROM automation_run_events_v1 WHERE task_name=?1 AND run_id=?2 AND phase=?3",
			)
			.bind(event.task_name, event.run_id, event.phase)
			.first<Record<string, unknown>>();
		if (!existing) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_UNAVAILABLE",
				"automation run event insert/read failed",
				{ retryable: true, requestId },
			);
		}
		if (String(existing.payload_sha256 ?? "") !== payloadSha256) {
			throw new AutomationRunLedgerError(
				"AUTOMATION_RUN_CONFLICT",
				"automation run event key already exists with different payload",
				{ requestId },
			);
		}
		const inserted = Number(insert.meta?.changes ?? 0) > 0;
		return {
			status: inserted ? "RECORDED" : "IDEMPOTENT_REPLAY",
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

	const clauses: string[] = [];
	const binds: unknown[] = [];
	if (taskName) {
		binds.push(taskName);
		clauses.push(`task_name=?${binds.length}`);
	}
	if (since) {
		binds.push(since);
		clauses.push(`occurred_at>=?${binds.length}`);
	}
	const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
	const rowLimit = Math.min(400, limit * 4 + 20);
	binds.push(rowLimit);
	const sql =
		"SELECT * FROM automation_run_events_v1" +
		where +
		` ORDER BY occurred_at DESC LIMIT ?${binds.length}`;

	let rows: StoredAutomationRunEvent[];
	try {
		const statement = input.db.prepare(sql).bind(...binds);
		const result = await statement.all<Record<string, unknown>>();
		rows = (result.results ?? []).map(normalizeRow);
	} catch {
		throw new AutomationRunLedgerError(
			"AUTOMATION_RUN_UNAVAILABLE",
			"automation run audit storage is unavailable",
			{ retryable: true, requestId },
		);
	}

	const grouped = new Map<string, { start?: StoredAutomationRunEvent; final?: StoredAutomationRunEvent }>();
	for (const row of rows) {
		const key = `${row.task_name}\u0000${row.run_id}`;
		const group = grouped.get(key) ?? {};
		if (row.phase === "STARTED") group.start ??= row;
		else group.final ??= row;
		grouped.set(key, group);
	}

	const runs = [...grouped.values()]
		.map((group) => {
			const start = group.start;
			const final = group.final;
			const latest = final ?? start!;
			return {
				task_name: latest.task_name,
				run_id: latest.run_id,
				scheduled_for: final?.scheduled_for ?? start?.scheduled_for ?? null,
				started_at: start?.occurred_at ?? null,
				finished_at: final?.occurred_at ?? null,
				effective_status: final?.status ?? "IN_PROGRESS",
				final_recorded: Boolean(final),
				notification_sent:
					final?.notification_sent == null ? null : Boolean(final.notification_sent),
				fresh_delta_count: final?.fresh_delta_count ?? null,
				blocker_code: final?.blocker_code ?? null,
				trace_id: final?.trace_id ?? start?.trace_id ?? null,
				collector_build_sha:
					final?.collector_build_sha ?? start?.collector_build_sha ?? null,
				cloudflare_version_id:
					final?.cloudflare_version_id ?? start?.cloudflare_version_id ?? null,
				prompt_version: final?.prompt_version ?? start?.prompt_version ?? null,
				safe_summary: final?.safe_summary ?? start?.safe_summary ?? null,
				latest_at: latest.occurred_at,
			};
		})
		.sort((left, right) => String(right.latest_at).localeCompare(String(left.latest_at)))
		.slice(0, limit)
		.map(({ latest_at: _latestAt, ...run }) => run);

	return { status: "OK", task_name: taskName, since, runs };
}
