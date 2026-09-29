#!/usr/bin/env node
// Local concurrency evidence for the quota admission ledger, against the REAL D1
// engine (workerd via `wrangler dev --local`) and the REAL production modules.
//
//   node --experimental-strip-types scripts/quota_d1_concurrency_check.mjs
//
// Nothing leaves the machine; `--remote` is refused.  A temporary directory (OS
// temp, outside the repo) receives:
//   - copies of `src/quota-admission.ts` + `src/quota-dimensions.ts` (hashes are
//     printed so the evidence can be tied to the exact source), and
//   - a probe worker that calls the production `admitOperation` /
//     `settleReservation` / `recordBaseline` implementations over a real D1
//     binding, plus its own wrangler config.
//
// What it proves:
//   1. sequential multi-call (production TS, real D1): two `admit -> settle` cycles
//      of 400k on a 950k dimension leave the third 400k DENIED — the S1 escape
//      (settlement returning headroom to the live-row guard) is closed end to end;
//   2. in-isolate concurrency: 20 concurrent 1M admits on a 9.5M dimension admit
//      exactly 9 (9M booked, no over-admit), and after settling every one of them a
//      second concurrent round of 20 admits is admitted 0 times — settled spend
//      still blocks, even under concurrency;
//   3. cross-request concurrency: parallel HTTP requests racing for the same
//      headroom never exceed the ceiling;
//   4. the booked accumulator equals the admitted units and is never decremented by
//      settlement.
//
// Exit codes: 0 all checks passed; 1 a check failed; 2 the local dev server could
// not be started (NOT_RUN — never reported as a pass).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const WRANGLER = join(REPO, "node_modules", "wrangler", "bin", "wrangler.js");
const DB_NAME = "quota-probe-db";
const DATABASE_ID = "11111111-2222-3333-4444-555555555555";
const ACCOUNT = "probe-account";
const PERIOD = {
	period_start: "2026-09-14T00:00:00.000Z",
	period_end: "2026-10-14T00:00:00.000Z",
};
const PERIOD_KEY = `cycle:${PERIOD.period_start}..${PERIOD.period_end}`;
const NOW = "2026-09-20T00:00:00.000Z";

if (process.argv.includes("--remote")) {
	console.error(
		"quota_d1_concurrency_check: refusing to run with --remote; this script is local-only",
	);
	process.exit(2);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const checks = [];
function check(name, condition, detail) {
	checks.push({ name, pass: Boolean(condition), detail });
	if (!condition) console.error(`✖ ${name}: ${detail}`);
	else console.log(`✔ ${name}`);
}

// ---------------------------------------------------------------------------
// Temporary probe project: production modules + a D1-shaped probe worker
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), "quota-conc-"));
const persistDir = join(workDir, "persist");
const srcDir = join(workDir, "src");
mkdirSync(srcDir, { recursive: true });
copyFileSync(join(REPO, "src", "quota-admission.ts"), join(srcDir, "quota-admission.ts"));
copyFileSync(join(REPO, "src", "quota-dimensions.ts"), join(srcDir, "quota-dimensions.ts"));
console.log(
	JSON.stringify(
		{
			probe_dir: workDir,
			source_sha256: {
				"src/quota-admission.ts": sha256(join(REPO, "src", "quota-admission.ts")),
				"src/quota-dimensions.ts": sha256(join(REPO, "src", "quota-dimensions.ts")),
			},
		},
		null,
		2,
	),
);

writeFileSync(
	join(workDir, "wrangler.jsonc"),
	JSON.stringify(
		{
			name: "quota-probe",
			main: "src/probe-worker.ts",
			compatibility_date: "2026-07-02",
			compatibility_flags: ["nodejs_compat"],
			observability: { enabled: false },
			d1_databases: [
				{ binding: "RESEARCH_REPLICA", database_name: DB_NAME, database_id: DATABASE_ID },
			],
		},
		null,
		2,
	),
	"utf8",
);

writeFileSync(
	join(srcDir, "probe-worker.ts"),
	`import {
	admitOperation,
	readBookedUsage,
	recordAccountPeriod,
	recordBaseline,
	settleReservation,
	syncDimensionCatalog,
} from "./quota-admission.ts";
import { QUOTA_DIMENSIONS } from "./quota-dimensions.ts";

interface Env {
	RESEARCH_REPLICA: D1Database;
}

const PROVABLE = QUOTA_DIMENSIONS.filter(
	(dimension) => dimension.provable && dimension.threshold_95 !== null,
);

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function periodKey(period: { period_start: string; period_end: string }): string {
	return \`cycle:\${period.period_start}..\${period.period_end}\`;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const body = (request.method === "POST" ? await request.json().catch(() => null) : null) as any;
		try {
			if (url.pathname === "/health") return json({ ok: true });
			if (url.pathname === "/seed") {
				await syncDimensionCatalog(env.RESEARCH_REPLICA, QUOTA_DIMENSIONS);
				await recordAccountPeriod(env.RESEARCH_REPLICA, {
					account_id: body.account_id,
					period_start: body.period.period_start,
					period_end: body.period.period_end,
					anchor_kind: "subscription_renewal",
					source: "probe",
					source_version: "probe@1",
					verified_at: body.period.period_start,
				});
				for (const dimension of PROVABLE) {
					await recordBaseline(env.RESEARCH_REPLICA, {
						dimension_key: dimension.key,
						period_key: periodKey(body.period),
						state: "VERIFIED",
						used: 0,
						unobserved_upper_bound: 0,
						source: "probe",
						source_version: "probe@1",
						as_of: body.now,
						coverage_end: body.now,
					});
				}
				return json({ ok: true, dimensions: PROVABLE.length });
			}
			if (url.pathname === "/admit") {
				// Concurrent: every request in the list runs without awaiting the others,
				// exactly like parallel callers hitting the same ceiling.
				const results = await Promise.all(
					(body.requests ?? []).map((entry: any) =>
						admitOperation(
							env.RESEARCH_REPLICA,
							{
								operation_id: entry.operation_id,
								fingerprint: entry.fingerprint,
								route: entry.route,
								dimensions: entry.dimensions,
							},
							{ account_id: body.account_id, now: new Date(body.now) },
						),
					),
				);
				return json({ results });
			}
			if (url.pathname === "/settle-all") {
				const outcomes = [];
				for (const reservationId of body.reservation_ids ?? []) {
					const units = await env.RESEARCH_REPLICA.prepare(
						"SELECT dimension_key, units FROM quota_reservation_units WHERE reservation_id = ?",
					)
						.bind(reservationId)
						.all();
					const observed = (units.results ?? []).map((row: any) => ({
						dimension_key: row.dimension_key,
						units: Number(row.units),
					}));
					outcomes.push(
						await settleReservation(env.RESEARCH_REPLICA, {
							reservation_id: reservationId,
							observed,
							reason: "probe",
							now: new Date(body.now),
						}),
					);
				}
				return json({ outcomes });
			}
			if (url.pathname === "/state") {
				const booked = await readBookedUsage(
					env.RESEARCH_REPLICA,
					body.dimension_key,
					body.period_key,
				);
				const live = await env.RESEARCH_REPLICA.prepare(
					"SELECT COUNT(*) AS rows_live, COALESCE(SUM(units), 0) AS units_live FROM quota_reservation_units WHERE dimension_key = ? AND period_key = ?",
				)
					.bind(body.dimension_key, body.period_key)
					.first();
				const journal = await env.RESEARCH_REPLICA.prepare(
					"SELECT outcome, COUNT(*) AS n FROM quota_reservation_journal GROUP BY outcome",
				).all();
				return json({ booked, live, journal: journal.results ?? [] });
			}
			return json({ error: "not found" }, 404);
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : String(error) },
				500,
			);
		}
	},
};
`,
	"utf8",
);

// ---------------------------------------------------------------------------
// Migrations + seed against the same local persist directory
// ---------------------------------------------------------------------------

function runD1(sqlFile) {
	return spawnSync(
		process.execPath,
		[
			WRANGLER,
			"d1",
			"execute",
			DB_NAME,
			"--local",
			"--persist-to",
			persistDir,
			"--file",
			sqlFile,
			"--json",
		],
		{ cwd: workDir, encoding: "utf8", env: { ...process.env, CI: "1" } },
	);
}

for (const migration of ["0017_quota_admission.sql", "0018_quota_booked_usage.sql"]) {
	const result = runD1(join(REPO, "migrations", migration));
	check(
		`${migration} applies to the probe database`,
		result.status === 0,
		(result.stdout ?? "")
			.concat(result.stderr ?? "")
			.trim()
			.slice(0, 300),
	);
}

// ---------------------------------------------------------------------------
// Start the real local dev server
// ---------------------------------------------------------------------------

const port = 8790 + Math.floor(Math.random() * 90);
const server = spawn(
	process.execPath,
	[
		WRANGLER,
		"dev",
		"--local",
		"--ip",
		"127.0.0.1",
		"--port",
		String(port),
		"--persist-to",
		persistDir,
	],
	{
		cwd: workDir,
		env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
		stdio: ["ignore", "pipe", "pipe"],
	},
);
let serverLog = "";
server.stdout.on("data", (chunk) => {
	serverLog += chunk.toString();
});
server.stderr.on("data", (chunk) => {
	serverLog += chunk.toString();
});

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(timeoutMs = 180_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${base}/health`);
			if (response.ok) return true;
		} catch {
			// not listening yet
		}
		await sleep(1000);
	}
	return false;
}

async function post(path, body) {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
	return response.json();
}

function stopServer() {
	try {
		if (process.platform === "win32" && server.pid) {
			spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			server.kill("SIGTERM");
		}
	} catch {
		// best effort
	}
}

try {
	const ready = await waitForServer();
	if (!ready) {
		console.error("quota_d1_concurrency_check: local wrangler dev server did not become ready");
		console.error(serverLog.slice(-2000));
		stopServer();
		console.log(
			JSON.stringify({ checks: checks.length, failed: 0, state: "NOT_RUN" }, null, 2),
		);
		process.exit(2);
	}

	const seeded = await post("/seed", { account_id: ACCOUNT, period: PERIOD, now: NOW });
	check("probe database seeded through recordBaseline/recordAccountPeriod", seeded.ok === true);

	const admit = (requests) => post("/admit", { account_id: ACCOUNT, now: NOW, requests });
	const state = (dimension_key) => post("/state", { dimension_key, period_key: PERIOD_KEY });
	const settle = (reservation_ids) => post("/settle-all", { reservation_ids, now: NOW });
	const request = (operationId, dimensionKey, units, fingerprintSeed) => ({
		operation_id: operationId,
		fingerprint: fingerprintSeed.repeat(32).slice(0, 32),
		route: "http:/internal/research-replica/v2/ingest",
		dimensions: [{ dimension_key: dimensionKey, units }],
	});

	// 1. Sequential multi-call through the production admission path.
	const firstRound = await admit([request("probe-seq-1", "r2.class_a", 400_000, "1")]);
	const firstAdmitted = firstRound.results[0];
	check(
		"sequential cycle 1 admits 400k on the 950k dimension",
		firstAdmitted.status === "ADMITTED",
		JSON.stringify(firstAdmitted),
	);
	const firstSettle = await settle([firstAdmitted.reservation_id]);
	const secondRound = await admit([request("probe-seq-2", "r2.class_a", 400_000, "2")]);
	const secondAdmitted = secondRound.results[0];
	check(
		"sequential cycle 2 admits 400k again (800k booked)",
		secondAdmitted.status === "ADMITTED",
		JSON.stringify(secondAdmitted),
	);
	const secondSettle = await settle([secondAdmitted.reservation_id]);
	const thirdRound = await admit([request("probe-seq-3", "r2.class_a", 400_000, "3")]);
	const thirdDenied = thirdRound.results[0];
	const afterSequential = await state("r2.class_a");
	check(
		"both settled cycles report SETTLED",
		firstSettle.outcomes[0].status === "SETTLED" &&
			secondSettle.outcomes[0].status === "SETTLED",
		JSON.stringify({ firstSettle, secondSettle }),
	);
	check(
		"the third 400k admit is DENIED (S1): settled spend still occupies the ceiling",
		thirdDenied.status === "DENIED" && thirdDenied.reason === "limit",
		JSON.stringify(thirdDenied),
	);
	check(
		"the booked accumulator holds the two settled cycles and no live rows remain",
		afterSequential.booked === 800_000 && Number(afterSequential.live.rows_live) === 0,
		JSON.stringify(afterSequential),
	);

	// 2. In-isolate concurrency: 20 racing admits against a 9.5M dimension.
	const concurrencyUnits = 1_000_000;
	const concurrencyCeiling = 9_500_000;
	const raceOne = await admit(
		Array.from({ length: 20 }, (_, index) =>
			request(`probe-race-1-${index}`, "r2.class_b", concurrencyUnits, "a"),
		),
	);
	const admittedOne = raceOne.results.filter((result) => result.status === "ADMITTED");
	const afterRaceOne = await state("r2.class_b");
	check(
		"20 concurrent admits of 1M on a 9.5M dimension admit exactly 9 (no over-admit)",
		admittedOne.length === 9 &&
			afterRaceOne.booked === 9 * concurrencyUnits &&
			afterRaceOne.booked <= concurrencyCeiling,
		JSON.stringify({ admitted: admittedOne.length, state: afterRaceOne }),
	);

	const settledRaceOne = await settle(admittedOne.map((result) => result.reservation_id));
	const afterSettleRaceOne = await state("r2.class_b");
	check(
		"settling every admitted reservation releases the live rows but keeps 9M booked",
		settledRaceOne.outcomes.every((outcome) => outcome.status === "SETTLED") &&
			afterSettleRaceOne.booked === 9 * concurrencyUnits &&
			Number(afterSettleRaceOne.live.rows_live) === 0,
		JSON.stringify({ settled: settledRaceOne.outcomes.length, state: afterSettleRaceOne }),
	);

	const raceTwo = await admit(
		Array.from({ length: 20 }, (_, index) =>
			request(`probe-race-2-${index}`, "r2.class_b", concurrencyUnits, "b"),
		),
	);
	const admittedTwo = raceTwo.results.filter((result) => result.status === "ADMITTED");
	const afterRaceTwo = await state("r2.class_b");
	check(
		"after settling, a second concurrent round is admitted 0 times (settled spend still blocks)",
		admittedTwo.length === 0 &&
			afterRaceTwo.booked === 9 * concurrencyUnits &&
			raceTwo.results.every((result) => result.reason === "limit"),
		JSON.stringify({
			admitted: admittedTwo.length,
			state: afterRaceTwo,
			sample: raceTwo.results[0],
		}),
	);

	// 3. Cross-request concurrency: parallel HTTP calls racing for the same headroom.
	const crossUnits = 200_000;
	const crossCeiling = 950_000;
	const crossResults = await Promise.all(
		Array.from({ length: 6 }, (_, index) =>
			admit([request(`probe-cross-${index}`, "kv.writes", crossUnits, "c")]),
		),
	);
	const crossAdmitted = crossResults
		.map((payload) => payload.results[0])
		.filter((result) => result.status === "ADMITTED");
	const afterCross = await state("kv.writes");
	check(
		"6 parallel requests of 200k on a 950k dimension admit exactly 4 and never exceed the ceiling",
		crossAdmitted.length === 4 &&
			afterCross.booked === 4 * crossUnits &&
			afterCross.booked <= crossCeiling,
		JSON.stringify({ admitted: crossAdmitted.length, state: afterCross }),
	);

	// 4. Replay of a settled operation under the production path must not re-book.
	const replay = await admit([request("probe-seq-1", "r2.class_a", 400_000, "1")]);
	const afterReplay = await state("r2.class_a");
	check(
		"a completed operation replays as REPLAY without a second booking",
		replay.results[0].status === "REPLAY" && afterReplay.booked === 800_000,
		JSON.stringify({ replay: replay.results[0], state: afterReplay }),
	);
} finally {
	stopServer();
	// Windows keeps a handle on the workerd files for a moment after the kill;
	// cleanup is best effort and never turns a passing run into a failure.
	await sleep(2000);
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			rmSync(workDir, { recursive: true, force: true });
			break;
		} catch {
			await sleep(1000);
		}
	}
}

const failed = checks.filter((entry) => !entry.pass);
console.log(
	JSON.stringify(
		{
			checks: checks.length,
			failed: failed.length,
			authority: "local-only; this run cannot prove account usage",
		},
		null,
		2,
	),
);
process.exit(failed.length === 0 ? 0 : 1);
