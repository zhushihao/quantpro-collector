// #50 production health snapshot: one bounded read-only call covering the six
// registered automation tasks, replacing the observer's per-round fan-out of
// six get_automation_run_history scans. Observational only: it adds no new
// eligibility state — every field is either a stored fact (run row), a plain
// projection of the existing schedule-slot window, or null when D1 holds no
// evidence. This entry point NEVER creates tables: on a not-yet-seeded ledger
// it reports NOT_SEEDED honestly instead of lazily bootstrapping writes.

import { AUTOMATION_REGISTRY_KEYS } from "./automation-run-ledger.ts";

const RUNS_V3_TABLE = "automation_runs_v3";

export type ProductionHealthTask = {
	registry_key: string;
	latest_run_id: string | null;
	latest_received_at: string | null;
	outcome: "COMPLETED" | "SILENT" | "BLOCKED" | "FAILED" | "UNKNOWN" | null;
	blocker_code: string | null;
	/** The stored prompt_version fact for the latest run (run-v3: the
	 * envelope's actual MARKET production_ref; null when absent). No
	 * eligibility judgement is attached to it. */
	prompt_version: string | null;
	event_count: number | null;
	fresh_delta_count: number | null;
	slot: string | null;
	slot_date: string | null;
	cloudflare_version_id: string | null;
	/** Whether the latest stored row sits inside its task's schedule window
	 * (the same [slot, slot+window) contract the ledger derives with).
	 * IN_WINDOW / OUT_OF_WINDOW are facts of stored rows vs schedule rows;
	 * NOT_APPLICABLE = no slot bound; UNKNOWN = no stored row or no schedule. */
	schedule_basis: "IN_WINDOW" | "OUT_OF_WINDOW" | "NOT_APPLICABLE" | "UNKNOWN";
};

export type ProductionHealthSnapshot = {
	status: "OK" | "STATE_UNAVAILABLE" | "NOT_SEEDED";
	as_of: string;
	cloudflare_version_id: string | null;
	/** Latest run-v3 row per registered task, in registry order. */
	tasks: ProductionHealthTask[];
	message?: string;
};

function text(value: unknown): string | null {
	return value == null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
	return value == null ? null : Number(value);
}

function slotMinutes(slot: string): number | null {
	const [hour, minute] = slot.split(":").map(Number);
	if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
	return hour * 60 + minute;
}

async function tableExists(db: D1Database, table: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?1`)
		.bind(table)
		.first<Record<string, unknown>>();
	return row != null;
}

/**
 * Fixed six-task, read-only snapshot. One bounded query per table
 * (v3-latest-per-task plus the six-row schedule table); no DDL, no writes,
 * no history expansion. Costs are verified via D1 `meta.rows_read`.
 */
export async function getProductionHealthSnapshot(input: {
	db: D1Database;
	cloudflareVersionId?: string | null;
}): Promise<ProductionHealthSnapshot> {
	const asOf = new Date().toISOString();
	try {
		if (!(await tableExists(input.db, RUNS_V3_TABLE))) {
			return {
				status: "NOT_SEEDED",
				as_of: asOf,
				cloudflare_version_id: input.cloudflareVersionId ?? null,
				tasks: [],
				message: "automation_runs_v3 is not present; nothing was created by this read",
			};
		}
		const keys = AUTOMATION_REGISTRY_KEYS;
		// One indexed read for the latest run per task. The (task_name,
		// received_at DESC) index makes this six short scans, not table reads.
		const v3Result = await input.db
			.prepare(
				`SELECT task_name, run_id, received_at, slot, slot_date,
						outcome, blocker_code, summary, prompt_version,
						fresh_delta_count, event_count, cloudflare_version_id
				 FROM ${RUNS_V3_TABLE}
				 WHERE received_at IN (
					SELECT MAX(received_at) FROM ${RUNS_V3_TABLE}
					WHERE task_name IN (${keys.map(() => "?").join(",")})
					GROUP BY task_name
				 )`,
			)
			.bind(...keys)
			.all<Record<string, unknown>>();
		const scheduleResult = await (await tableExists(input.db, "automation_schedule_v1")
			? input.db
					.prepare(
						`SELECT task_name, slot_times, weekdays, window_minutes, enabled
						 FROM automation_schedule_v1
						 WHERE enabled=1`,
					)
					.all<Record<string, unknown>>()
			: Promise.resolve({ results: [] as Record<string, unknown>[] }));

		const latestByTask = new Map<string, Record<string, unknown>>();
		for (const row of v3Result.results ?? []) {
			const taskName = text(row.task_name);
			if (!taskName) continue;
			const incumbent = latestByTask.get(taskName);
			if (!incumbent || String(row.received_at ?? "") > String(incumbent.received_at ?? "")) {
				latestByTask.set(taskName, row);
			}
		}

		const scheduleByTask = new Map<string, { slots: Array<{ slot: string; minutes: number | null }>; window: number }>();
		for (const row of scheduleResult.results ?? []) {
			const taskName = text(row.task_name);
			if (!taskName) continue;
			let slots: Array<{ slot: string; minutes: number | null }> = [];
			try {
				const parsed = JSON.parse(String(row.slot_times ?? "[]"));
				if (Array.isArray(parsed)) {
					slots = parsed
						.filter((value): value is string => typeof value === "string")
						.map((slot) => ({ slot, minutes: slotMinutes(slot) }));
				}
			} catch {
				slots = [];
			}
			scheduleByTask.set(taskName, {
				slots,
				window: numberOrNull(row.window_minutes) ?? 40,
			});
		}

		const tasks: ProductionHealthTask[] = [];
		for (const registryKey of keys) {
			const row = latestByTask.get(registryKey);
			if (!row) {
				// Honest absence: no stored fact to project, no new state.
				tasks.push({
					registry_key: registryKey,
					latest_run_id: null,
					latest_received_at: null,
					outcome: null,
					blocker_code: null,
					prompt_version: null,
					event_count: null,
					fresh_delta_count: null,
					slot: null,
					slot_date: null,
					cloudflare_version_id: null,
					schedule_basis: "UNKNOWN",
				});
				continue;
			}
			const schedule = scheduleByTask.get(registryKey);
			const rowSlot = text(row.slot);
			const rowDateKey = text(row.slot_date);
			const receivedMs = Date.parse(text(row.received_at) ?? "");
			let basis: ProductionHealthTask["schedule_basis"] = "NOT_APPLICABLE";
			if (!schedule) {
				basis = "UNKNOWN";
			} else if (rowSlot == null || rowDateKey == null || Number.isNaN(receivedMs)) {
				basis = "NOT_APPLICABLE";
			} else {
				const slotEntry = schedule.slots.find((entry) => entry.slot === rowSlot);
				const startMinutes = slotEntry?.minutes;
				if (startMinutes == null) {
					basis = "UNKNOWN";
				} else {
					// Shanghai wall minutes of received_at (fixed +08:00, same
					// convention as the schedule module).
					const shifted = new Date(receivedMs + 8 * 60 * 60 * 1000);
					const sameDay =
						`${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}` ===
						rowDateKey;
					if (!sameDay) {
						basis = "OUT_OF_WINDOW";
					} else {
						const receivedMinutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
						const wrapped =
							receivedMinutes >= startMinutes
								? receivedMinutes - startMinutes
								: receivedMinutes + 1440 - startMinutes;
						basis = wrapped < schedule.window ? "IN_WINDOW" : "OUT_OF_WINDOW";
					}
				}
			}
			tasks.push({
				registry_key: registryKey,
				latest_run_id: text(row.run_id),
				latest_received_at: text(row.received_at),
				outcome: text(row.outcome) as ProductionHealthTask["outcome"],
				blocker_code: text(row.blocker_code),
				prompt_version: text(row.prompt_version),
				event_count: numberOrNull(row.event_count),
				fresh_delta_count: numberOrNull(row.fresh_delta_count),
				slot: rowSlot,
				slot_date: rowDateKey,
				cloudflare_version_id: text(row.cloudflare_version_id),
				schedule_basis: basis,
			});
		}

		return {
			status: "OK",
			as_of: asOf,
			cloudflare_version_id: input.cloudflareVersionId ?? null,
			tasks,
		};
	} catch {
		// Storage unavailable is a fact about the audit face, never six FAILED
		// tasks: the observer must be able to tell them apart.
		return {
			status: "STATE_UNAVAILABLE",
			as_of: asOf,
			cloudflare_version_id: input.cloudflareVersionId ?? null,
			tasks: [],
			message: "automation run storage is not readable (no tables created by this call)",
		};
	}
}
