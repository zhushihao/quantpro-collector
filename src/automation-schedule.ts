// Automation schedule table + MISSED_SLOT read-time derivation
// (spec docs/specs/2026-09-29-envelope-spec.md §4.1/§6/§6.3).
//
// This module intentionally avoids importing automation-run-ledger.ts:
// run-envelope.ts needs AUTOMATION_REGISTRY_KEYS at module-evaluation time for
// z.enum(...), so any cycle through this module would risk a TDZ failure
// depending on entry order. Seed rows below carry the registry keys literally
// and stay identical to migrations/0014_automation_runs_v3.sql (spec §6.1,
// review F3).

export const SCHEDULE_TABLE = "automation_schedule_v1";
export const RUNS_V3_TABLE = "automation_runs_v3";
export const SCHEDULE_SEED_UPDATED_AT = "2026-09-29T00:00:00Z";
export const DEFAULT_WINDOW_MINUTES = 40;
/** Synthetic MISSED_SLOT rows are capped to keep history responses bounded. */
export const MISSED_SLOT_MAX_ROWS = 200;
/** How far back MISSED_SLOT derivation looks by default. */
export const MISSED_SLOT_LOOKBACK_DAYS = 7;
/** as_of more than this far in the future is treated as a clock error (spec §2.4). */
export const STALE_FUTURE_TOLERANCE_MINUTES = 5;

export const HOURLY_45_SLOTS = Array.from({ length: 24 }, (_, hour) =>
	`${String(hour).padStart(2, "0")}:45`,
);
export const HOURLY_00_SLOTS = Array.from({ length: 24 }, (_, hour) =>
	`${String(hour).padStart(2, "0")}:00`,
);
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const TRADING_WEEKDAYS = [1, 2, 3, 4, 5];

export type ScheduleSeed = {
	task_name: string;
	slot_times: string[];
	weekdays: number[];
	window_minutes: number;
	enabled: 0 | 1;
};

/**
 * Six production schedule rows matching automation/control/production.json.
 * Keep byte-identical (modulo formatting) with migrations/0013 seeds.
 */
export const SCHEDULE_SEEDS: ScheduleSeed[] = [
	{
		task_name: "holding-assistant-preclose",
		slot_times: ["09:10", "10:10", "16:45"],
		weekdays: TRADING_WEEKDAYS,
		window_minutes: DEFAULT_WINDOW_MINUTES,
		enabled: 1,
	},
	{
		task_name: "holding-assistant-intraday",
		slot_times: ["09:50", "10:50", "11:50", "13:50", "14:50"],
		weekdays: TRADING_WEEKDAYS,
		window_minutes: DEFAULT_WINDOW_MINUTES,
		enabled: 1,
	},
	{
		task_name: "industry-research",
		slot_times: HOURLY_45_SLOTS,
		weekdays: ALL_WEEKDAYS,
		window_minutes: DEFAULT_WINDOW_MINUTES,
		enabled: 1,
	},
	{
		task_name: "company-facts",
		slot_times: HOURLY_00_SLOTS,
		weekdays: ALL_WEEKDAYS,
		window_minutes: DEFAULT_WINDOW_MINUTES,
		enabled: 1,
	},
	{
		task_name: "central-policy",
		slot_times: HOURLY_00_SLOTS,
		weekdays: ALL_WEEKDAYS,
		window_minutes: DEFAULT_WINDOW_MINUTES,
		enabled: 1,
	},
	{
		task_name: "ai-financing-rates",
		slot_times: ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"],
		weekdays: ALL_WEEKDAYS,
		window_minutes: DEFAULT_WINDOW_MINUTES,
		enabled: 1,
	},
];

export type ScheduleRow = {
	task_name: string;
	slot_times: string[];
	weekdays: number[];
	window_minutes: number;
	enabled: boolean;
};

const readyByDb = new WeakMap<object, Promise<void>>();

function insertSeedSql(): string {
	const values = SCHEDULE_SEEDS.map(
		(seed) =>
			`('${seed.task_name}', '${JSON.stringify(seed.slot_times)}', '${JSON.stringify(
				seed.weekdays,
			)}', ${seed.window_minutes}, ${seed.enabled}, '${SCHEDULE_SEED_UPDATED_AT}')`,
	);
	return `INSERT OR IGNORE INTO ${SCHEDULE_TABLE} (task_name, slot_times, weekdays, window_minutes, enabled, updated_at) VALUES ${values.join(", ")}`;
}

/**
 * Runtime lazy bootstrap for the run-envelope contract: automation_runs_v3,
 * automation_schedule_v1, and the six schedule seeds (review F3 — without the
 * seeds, a migration-less environment would silently disable slot binding and
 * MISSED_SLOT derivation). Idempotent; cached per D1 database.
 */
export function ensureRunEnvelopeTables(db: D1Database): Promise<void> {
	const existing = readyByDb.get(db as object);
	if (existing) return existing;
	const ready = (async () => {
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS ${RUNS_V3_TABLE} (
					task_name TEXT NOT NULL,
					run_id TEXT NOT NULL,
					envelope_key TEXT NOT NULL,
					channel TEXT,
					write_key TEXT,
					as_of TEXT,
					received_at TEXT NOT NULL,
					slot TEXT,
					slot_date TEXT,
					fresh_delta_count INTEGER CHECK (fresh_delta_count IS NULL OR fresh_delta_count >= 0),
					event_count INTEGER CHECK (event_count IS NULL OR event_count >= 0),
					outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETED','SILENT','BLOCKED','FAILED','UNKNOWN')),
					blocker_code TEXT,
					summary TEXT,
					prompt_version TEXT,
					collector_build_sha TEXT,
					cloudflare_version_id TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (task_name, run_id)
				) WITHOUT ROWID`,
			)
			.run();
		await db
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_v3_envelope
				ON ${RUNS_V3_TABLE} (task_name, envelope_key)`,
			)
			.run();
		await db
			.prepare(
				`CREATE INDEX IF NOT EXISTS automation_runs_v3_task_time
				ON ${RUNS_V3_TABLE} (task_name, received_at DESC)`,
			)
			.run();
		await db
			.prepare(
				`CREATE INDEX IF NOT EXISTS automation_runs_v3_time
				ON ${RUNS_V3_TABLE} (received_at DESC)`,
			)
			.run();
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS ${SCHEDULE_TABLE} (
					task_name TEXT PRIMARY KEY,
					slot_times TEXT NOT NULL,
					weekdays TEXT NOT NULL,
					window_minutes INTEGER NOT NULL DEFAULT 40,
					enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
					updated_at TEXT NOT NULL
				) WITHOUT ROWID`,
			)
			.run();
		await db.prepare(insertSeedSql()).run();
	})();
	readyByDb.set(db as object, ready);
	ready.catch(() => {
		readyByDb.delete(db as object);
	});
	return ready;
}

function normalizeScheduleRow(row: Record<string, unknown>): ScheduleRow | null {
	if (!row?.task_name) return null;
	let slotTimes: string[] = [];
	let weekdays: number[] = [];
	try {
		const parsedSlots = JSON.parse(String(row.slot_times ?? "[]"));
		if (Array.isArray(parsedSlots)) {
			slotTimes = parsedSlots.filter((value): value is string => typeof value === "string");
		}
	} catch {
		slotTimes = [];
	}
	try {
		const parsedWeekdays = JSON.parse(String(row.weekdays ?? "[]"));
		if (Array.isArray(parsedWeekdays)) {
			weekdays = parsedWeekdays
				.filter((value): value is number => typeof value === "number")
				.filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
		}
	} catch {
		weekdays = [];
	}
	return {
		task_name: String(row.task_name),
		slot_times: slotTimes,
		weekdays,
		window_minutes: Number(row.window_minutes ?? DEFAULT_WINDOW_MINUTES),
		enabled: Number(row.enabled ?? 0) === 1,
	};
}

/** Read the schedule rows once per derivation/history call (spec §6.2 query shape). */
export async function readScheduleRows(
	db: D1Database,
	options: { enabledOnly?: boolean } = {},
): Promise<ScheduleRow[]> {
	const rows = await db
		.prepare(`SELECT * FROM ${SCHEDULE_TABLE}${options.enabledOnly === false ? "" : " WHERE enabled=1"}`)
		.all<Record<string, unknown>>();
	return (rows.results ?? [])
		.map(normalizeScheduleRow)
		.filter((row): row is ScheduleRow => row !== null && row.slot_times.length > 0);
}

/** Fixed +08:00 conversion (China has no DST; spec §6.1 forbids Intl deps). */
export function shanghaiParts(epochMs: number): {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	weekday: number;
	minutesOfDay: number;
	dateKey: string;
} {
	const shifted = new Date(epochMs + 8 * 60 * 60 * 1000);
	const year = shifted.getUTCFullYear();
	const month = shifted.getUTCMonth() + 1;
	const day = shifted.getUTCDate();
	const hour = shifted.getUTCHours();
	const minute = shifted.getUTCMinutes();
	return {
		year,
		month,
		day,
		hour,
		minute,
		weekday: shifted.getUTCDay(),
		minutesOfDay: hour * 60 + minute,
		dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
	};
}

function shanghaiEpochMs(dateKey: string, slot: string): number {
	const [year, month, day] = dateKey.split("-").map(Number);
	const [hour, minute] = slot.split(":").map(Number);
	return Date.UTC(year, month - 1, day, hour, minute) - 8 * 60 * 60 * 1000;
}

export type SlotBinding = {
	slot: string;
	slot_date: string;
	window_minutes: number;
};

/**
 * Resolve the schedule slot whose [slot, slot+window) contains received_at in
 * Asia/Shanghai (spec §1.4 step 4 / §6.1). Returns null outside every window
 * or when the task has no enabled schedule row.
 */
export function resolveSlotBinding(
	rows: ScheduleRow[],
	taskName: string,
	receivedAtMs: number,
): SlotBinding | null {
	const row = rows.find((candidate) => candidate.task_name === taskName && candidate.enabled);
	if (!row) return null;
	const received = shanghaiParts(receivedAtMs);
	if (!row.weekdays.includes(received.weekday)) return null;
	const windowMinutes = row.window_minutes;
	for (const slot of row.slot_times) {
		const [hour, minute] = slot.split(":").map(Number);
		if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
		const startMinutes = hour * 60 + minute;
		// Wrap-aware offset: a late-evening window may cross midnight, in which
		// case the slot_date is the previous Shanghai day.
		const wrapped =
			received.minutesOfDay >= startMinutes
				? received.minutesOfDay - startMinutes
				: received.minutesOfDay + 1440 - startMinutes;
		if (wrapped >= 0 && wrapped < windowMinutes) {
			const slotDate =
				received.minutesOfDay >= startMinutes
					? received.dateKey
					: shanghaiParts(receivedAtMs - wrapped * 60 * 1000).dateKey;
			return { slot, slot_date: slotDate, window_minutes: windowMinutes };
		}
	}
	return null;
}

/** STALE marking (spec §2.4): W = the task's schedule window_minutes (F7). */
export function computeTimeliness(
	asOf: string | null,
	receivedAtMs: number,
	windowMinutes: number | null,
): "FRESH" | "STALE" {
	if (!asOf) return "FRESH";
	const asOfMs = Date.parse(asOf);
	if (Number.isNaN(asOfMs)) return "STALE";
	const delta = receivedAtMs - asOfMs;
	const width = (windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60 * 1000;
	if (delta > width) return "STALE";
	if (-delta > STALE_FUTURE_TOLERANCE_MINUTES * 60 * 1000) return "STALE";
	return "FRESH";
}

export type MissedSlotRow = {
	task_name: string;
	effective_status: "MISSED_SLOT";
	slot: string;
	slot_date: string;
	window: string;
	window_end: string;
	derivation: "SCHEDULE_WINDOW";
	source_contract: "schedule-derivation";
};

export type DerivationRowSource = {
	task_name: string;
	v3_received_at: string | null;
	v2_time_key: string | null;
};

/** Time-ordered merge key shared by the history merger and derivation. */
export function v2RowTimeKey(row: {
	finished_at?: string | null;
	started_at?: string | null;
	updated_at?: string | null;
}): string | null {
	return row.finished_at ?? row.started_at ?? row.updated_at ?? null;
}

function isSatisfied(
	rowSource: DerivationRowSource,
	windowStartMs: number,
	windowEndMs: number,
): boolean {
	const stamp = rowSource.v3_received_at ?? rowSource.v2_time_key;
	if (!stamp) return false;
	const ms = Date.parse(stamp);
	if (Number.isNaN(ms)) return false;
	return ms >= windowStartMs && ms < windowEndMs;
}

/**
 * Pure MISSED_SLOT derivation over pre-fetched rows (review F6: callers issue
 * at most one time-range SELECT per (task, table) and bucket in JS — never one
 * query per window). Windows count as satisfied by any v3 `received_at` or
 * v2/legacy time key inside them (transition-period dual acceptance).
 */
export function deriveMissedSlotsFromRows(input: {
	scheduleRows: ScheduleRow[];
	rowSources: DerivationRowSource[];
	taskName?: string | null;
	derivationStartMs: number;
	nowMs: number;
	maxRows?: number;
}): { missed: MissedSlotRow[]; truncated: boolean } {
	const maxRows = input.maxRows ?? MISSED_SLOT_MAX_ROWS;
	const now = shanghaiParts(input.nowMs);
	const start = shanghaiParts(input.derivationStartMs);
	const candidates: MissedSlotRow[] = [];
	const cursor = { year: start.year, month: start.month, day: start.day };
	for (let guard = 0; guard < 40; guard += 1) {
		const dayEpoch = Date.UTC(cursor.year, cursor.month - 1, cursor.day);
		const parts = shanghaiParts(dayEpoch);
		for (const schedule of input.scheduleRows) {
			if (input.taskName && schedule.task_name !== input.taskName) continue;
			if (!schedule.enabled || !schedule.weekdays.includes(parts.weekday)) continue;
			for (const slot of schedule.slot_times) {
				const [hour, minute] = slot.split(":").map(Number);
				if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
				const windowStartMs =
					Date.UTC(cursor.year, cursor.month - 1, cursor.day, hour, minute) -
					8 * 60 * 60 * 1000;
				const windowEndMs = windowStartMs + schedule.window_minutes * 60 * 1000;
				// Only completed windows are judged; an in-progress window is not
				// yet a miss.
				if (windowStartMs < input.derivationStartMs) continue;
				if (windowEndMs > input.nowMs) continue;
				const satisfied = input.rowSources.some((rowSource) =>
					rowSource.task_name === schedule.task_name
						? isSatisfied(rowSource, windowStartMs, windowEndMs)
						: false,
				);
				if (satisfied) continue;
				const endParts = shanghaiParts(windowEndMs);
				candidates.push({
					task_name: schedule.task_name,
					effective_status: "MISSED_SLOT",
					slot,
					slot_date: parts.dateKey,
					window: `${slot}..${String(endParts.hour).padStart(2, "0")}:${String(endParts.minute).padStart(2, "0")}`,
					window_end: new Date(windowEndMs).toISOString(),
					derivation: "SCHEDULE_WINDOW",
					source_contract: "schedule-derivation",
				});
			}
		}
		if (cursor.year === now.year && cursor.month === now.month && cursor.day === now.day) {
			break;
		}
		const next = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day + 1));
		cursor.year = next.getUTCFullYear();
		cursor.month = next.getUTCMonth() + 1;
		cursor.day = next.getUTCDate();
	}
	// Ascending by window end; keep the most recent maxRows, truncating the
	// earliest when over cap (spec §6.2).
	candidates.sort((left, right) => left.window_end.localeCompare(right.window_end));
	const truncated = candidates.length > maxRows;
	return { missed: truncated ? candidates.slice(candidates.length - maxRows) : candidates, truncated };
}

function rowSourcesFromRaw(
	v3Rows: Array<Record<string, unknown>>,
	v2Rows: Array<Record<string, unknown>>,
): DerivationRowSource[] {
	const sources: DerivationRowSource[] = [];
	for (const row of v3Rows) {
		sources.push({
			task_name: String(row.task_name ?? ""),
			v3_received_at: row.received_at == null ? null : String(row.received_at),
			v2_time_key: null,
		});
	}
	for (const row of v2Rows) {
		sources.push({
			task_name: String(row.task_name ?? ""),
			v3_received_at: null,
			v2_time_key: v2RowTimeKey({
				finished_at: row.finished_at == null ? null : String(row.finished_at),
				started_at: row.started_at == null ? null : String(row.started_at),
				updated_at: row.updated_at == null ? null : String(row.updated_at),
			}),
		});
	}
	return sources;
}

/**
 * MISSED_SLOT derivation straight from raw history rows: the caller fetches
 * each table once (review F6) and this function buckets in pure JS.
 */
export function deriveMissedSlotsFromRawRows(input: {
	scheduleRows: ScheduleRow[];
	v3Rows: Array<Record<string, unknown>>;
	v2Rows: Array<Record<string, unknown>>;
	taskName?: string | null;
	derivationStartMs: number;
	nowMs: number;
	maxRows?: number;
}): { missed: MissedSlotRow[]; truncated: boolean } {
	return deriveMissedSlotsFromRows({
		scheduleRows: input.scheduleRows,
		rowSources: rowSourcesFromRaw(input.v3Rows, input.v2Rows),
		taskName: input.taskName ?? null,
		derivationStartMs: input.derivationStartMs,
		nowMs: input.nowMs,
		maxRows: input.maxRows,
	});
}

/** One-shot derivation for the scheduled reconciliation lane (spec §6.3). */
export async function deriveMissedSlots(
	db: D1Database,
	options: {
		taskName?: string | null;
		since?: string | null;
		now?: string;
		lookbackDays?: number;
		maxRows?: number;
	} = {},
): Promise<{ missed: MissedSlotRow[]; truncated: boolean }> {
	await ensureRunEnvelopeTables(db);
	const nowMs = Date.parse(options.now ?? new Date().toISOString());
	const lookbackMs = (options.lookbackDays ?? MISSED_SLOT_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
	const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
	const derivationStartMs = Math.max(
		nowMs - lookbackMs,
		Number.isNaN(sinceMs) ? nowMs - lookbackMs : sinceMs,
	);
	const v3Clauses: string[] = [];
	const v3Binds: unknown[] = [];
	if (options.taskName) {
		v3Binds.push(options.taskName);
		v3Clauses.push(`task_name=?${v3Binds.length}`);
	}
	v3Binds.push(new Date(derivationStartMs).toISOString());
	v3Clauses.push(`received_at>=?${v3Binds.length}`);
	const v3Rows = await db
		.prepare(
			`SELECT task_name, received_at FROM ${RUNS_V3_TABLE} WHERE ${v3Clauses.join(" AND ")}`,
		)
		.bind(...v3Binds)
		.all<Record<string, unknown>>();
	const v2Clauses: string[] = [];
	const v2Binds: unknown[] = [];
	if (options.taskName) {
		v2Binds.push(options.taskName);
		v2Clauses.push(`task_name=?${v2Binds.length}`);
	}
	v2Binds.push(new Date(derivationStartMs).toISOString());
	v2Clauses.push(`COALESCE(finished_at, started_at, updated_at)>=?${v2Binds.length}`);
	const v2Rows = await db
		.prepare(
			`SELECT task_name, started_at, finished_at, updated_at FROM automation_runs_v2
			WHERE ${v2Clauses.join(" AND ")}`,
		)
		.bind(...v2Binds)
		.all<Record<string, unknown>>();
	const scheduleRows = await readScheduleRows(db);
	return deriveMissedSlotsFromRows({
		scheduleRows,
		rowSources: rowSourcesFromRaw(v3Rows.results ?? [], v2Rows.results ?? []),
		taskName: options.taskName ?? null,
		derivationStartMs,
		nowMs,
		maxRows: options.maxRows,
	});
}

/**
 * Scheduled-lane reconciliation (spec §6.3): derive MISSED_SLOT for the last
 * 24h and emit one observability log line per miss. Never rethrows — the
 * caller's `finally` must not turn a reconciliation hiccup into a bridge
 * failure, nor swallow one.
 */
export async function runScheduleReconciliation(
	env: { RESEARCH_REPLICA?: D1Database | null },
	context: { runId?: string } | null,
	options: { now?: string; lookbackHours?: number } = {},
): Promise<void> {
	try {
		const db = env?.RESEARCH_REPLICA;
		if (!db) return;
		const nowMs = Date.parse(options.now ?? new Date().toISOString());
		const lookbackHours = options.lookbackHours ?? 24;
		const { missed } = await deriveMissedSlots(db, {
			now: new Date(nowMs).toISOString(),
			lookbackDays: Math.max(1, Math.ceil(lookbackHours / 24)),
		});
		for (const row of missed) {
			console.log(
				JSON.stringify({
					event: "automation_missed_slot",
					run_id: context?.runId ?? null,
					...row,
				}),
			);
		}
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: "automation_schedule_reconciliation_failed",
				run_id: context?.runId ?? null,
				message: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}
