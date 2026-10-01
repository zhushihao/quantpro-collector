// #50 production health snapshot: one bounded read-only call covering the six
// registered automation tasks, replacing the observer's per-round fan-out of
// six get_automation_run_history scans. Receipt facts only: missing receipts
// do not prove missed host runs. Legacy inferred slots and unverifiable Prompt
// versions are projected as unknown without rewriting historical records.
// This entry point NEVER creates tables: on a not-yet-seeded ledger
// it reports NOT_SEEDED honestly instead of lazily bootstrapping writes.

import { AUTOMATION_REGISTRY_KEYS, receiptPromptVersion } from "./automation-run-ledger.ts";

const RUNS_V3_TABLE = "automation_runs_v3";

export type ProductionHealthTask = {
	registry_key: string;
	latest_run_id: string | null;
	latest_received_at: string | null;
	/** Elapsed server-clock seconds, not a missed-run or scan-completion claim. */
	seconds_since_last_received: number | null;
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
	/** Compatibility field only: Collector does not know host scheduling. */
	schedule_basis: "UNKNOWN";
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

async function tableExists(db: D1Database, table: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?1`)
		.bind(table)
		.first<Record<string, unknown>>();
	return row != null;
}

/**
 * Fixed six-task, read-only receipt snapshot. No schedule table, no DDL,
 * no writes, no history expansion. Costs are verified via D1 meta.rows_read.
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
				`SELECT task_name, run_id, envelope_key, received_at,
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
		const latestByTask = new Map<string, Record<string, unknown>>();
		for (const row of v3Result.results ?? []) {
			const taskName = text(row.task_name);
			if (!taskName) continue;
			const incumbent = latestByTask.get(taskName);
			if (!incumbent || String(row.received_at ?? "") > String(incumbent.received_at ?? "")) {
				latestByTask.set(taskName, row);
			}
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
					seconds_since_last_received: null,
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
			const receivedMs = Date.parse(text(row.received_at) ?? "");
			const ageMs = Date.parse(asOf) - receivedMs;
			tasks.push({
				registry_key: registryKey,
				latest_run_id: text(row.run_id),
				latest_received_at: text(row.received_at),
				seconds_since_last_received: Number.isFinite(ageMs) && ageMs >= 0 ? Math.floor(ageMs / 1000) : null,
				outcome: text(row.outcome) as ProductionHealthTask["outcome"],
				blocker_code: text(row.blocker_code),
				prompt_version: receiptPromptVersion(row),
				event_count: numberOrNull(row.event_count),
				fresh_delta_count: numberOrNull(row.fresh_delta_count),
				slot: null,
				slot_date: null,
				cloudflare_version_id: text(row.cloudflare_version_id),
				schedule_basis: "UNKNOWN",
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
