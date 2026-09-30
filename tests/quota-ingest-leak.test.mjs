// Issue #48 regression (2026-09-30 incident): an ingest call that exits
// without settlement used to leak its live-row slot; the global live-row scan
// cap (256) then refused EVERY heavy route platform-wide, including
// submit_run_envelope. Enforce-mode ingest refusals must charge the declared
// bound on every exit, leaving zero live rows behind.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {}
		}
		return nextResolve(specifier, context);
	},
});

const worker = (await import("../src/index.ts")).default;
const { QUOTA_ACCOUNT_TAG, QUOTA_DIMENSIONS, recordAccountPeriod, recordBaseline } = await import(
	"../src/quota-breaker.ts"
);
const { createResearchWorkflowDb } = await import("./helpers/d1-sqlite-shim.mjs");

test("enforce-mode ingest refusals never leak their live-row slot (#48)", async () => {
	const db = createResearchWorkflowDb();
	const anchorStart = "2026-09-13T15:01:34.000Z";
	const anchorEnd = "2026-10-13T00:00:00.000Z";
	await recordAccountPeriod(db, {
		account_id: QUOTA_ACCOUNT_TAG,
		period_start: anchorStart,
		period_end: anchorEnd,
		anchor_kind: "subscription_renewal",
		source: "test",
		source_version: "test@1",
		verified_at: anchorStart,
	});
	const now = new Date();
	const cycleKey = `cycle:${anchorStart}..${anchorEnd}`;
	for (const entry of QUOTA_DIMENSIONS) {
		if (!entry.provable || entry.threshold_95 === null) continue;
		await recordBaseline(db, {
			dimension_key: entry.key,
			period_key:
				entry.period === "utc_day" ? `utc-day:${now.toISOString().slice(0, 10)}` : cycleKey,
			state: "VERIFIED",
			used: 0,
			unobserved_upper_bound: 0,
			source: "test",
			source_version: "test@1",
			as_of: now.toISOString(),
			coverage_end: now.toISOString(),
		});
	}

	const env = {
		RESEARCH_REPLICA: db,
		RESEARCH_OBJECTS: { put: async () => undefined, get: async () => undefined },
		RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
		QUOTA_ADMISSION_MODE: "enforce",
	};

	// Malformed JSON reaches admission (after the token gate) and then fails
	// parsing — the exact refusal class that used to leak the slot.
	for (const body of ["{{{not-json", JSON.stringify({ bogus_key: true })]) {
		const response = await worker.fetch(
			new Request("https://worker.example/internal/research-replica/v2/ingest", {
				method: "POST",
				headers: {
					Authorization: "Bearer internal-token",
					"Content-Type": "application/json",
				},
				body,
			}),
			env,
			{},
		);
		assert.equal(response.status, 400);
	}
	const count = await db
		.prepare(`SELECT COUNT(*) AS n FROM quota_reservations`)
		.first();
	assert.equal(count?.n ?? 0, 0, "every admission must be settled on refusal exits");
});

// The 2026-09-30 02:35-07:00 recurrence: the NEW precomputed-vector ingest
// (ad742e2) leaked its slot on every REJECTED early-return (content-sha
// mismatch / stale version) and jammed the cap again. Same discipline, now
// covered by a regression test.
test("enforce-mode vector ingest REJECTED results never leak their live-row slot (#48)", async () => {
	const db = createResearchWorkflowDb();
	const anchorStart = "2026-09-13T15:01:34.000Z";
	const anchorEnd = "2026-10-13T00:00:00.000Z";
	await recordAccountPeriod(db, {
		account_id: QUOTA_ACCOUNT_TAG,
		period_start: anchorStart,
		period_end: anchorEnd,
		anchor_kind: "subscription_renewal",
		source: "test",
		source_version: "test@1",
		verified_at: anchorStart,
	});
	const now = new Date();
	const cycleKey = `cycle:${anchorStart}..${anchorEnd}`;
	for (const entry of QUOTA_DIMENSIONS) {
		if (!entry.provable || entry.threshold_95 === null) continue;
		await recordBaseline(db, {
			dimension_key: entry.key,
			period_key:
				entry.period === "utc_day" ? `utc-day:${now.toISOString().slice(0, 10)}` : cycleKey,
			state: "VERIFIED",
			used: 0,
			unobserved_upper_bound: 0,
			source: "test",
			source_version: "test@1",
			as_of: now.toISOString(),
			coverage_end: now.toISOString(),
		});
	}
	const env = {
		RESEARCH_REPLICA: db,
		RESEARCH_OBJECTS: { put: async () => undefined, get: async () => undefined },
		RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
		QUOTA_ADMISSION_MODE: "enforce",
		AI: {},
		RESEARCH_PUBLIC_INDEX: {},
	};
	// Unknown document => REJECTED before any D1 write: the exact early-return
	// that used to leak.
	for (const body of [
		JSON.stringify({
			document_id: "doc_missing",
			version_id: "ver_missing",
			content_sha256: "0".repeat(64),
			vectors: [{ ordinal: 0, values: [0.1, 0.2] }],
		}),
	]) {
		const response = await worker.fetch(
			new Request("https://worker.example/internal/research-semantic-index/ingest-vectors", {
				method: "POST",
				headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
				body,
			}),
			env,
			{},
		);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).status, "REJECTED");
	}
	const count = await db.prepare(`SELECT COUNT(*) AS n FROM quota_reservations`).first();
	assert.equal(count?.n ?? 0, 0, "REJECTED vector ingests must settle their reservation");
});

// The 2026-09-30 morning outage: the guarded wrapper required usage metadata
// on D1 first(), but D1 first() returns the row itself without meta — so
// every bounded SELECT (isReplay) threw and the whole C5 ingest surface
// returned STORE_UNAVAILABLE. first() must run the bounded all() instead.
test("enforce-mode ingest with a valid market_signal record applies through the guarded reads (#48)", async () => {
	const db = createResearchWorkflowDb();
	const anchorStart = "2026-09-13T15:01:34.000Z";
	const anchorEnd = "2026-10-13T00:00:00.000Z";
	await recordAccountPeriod(db, {
		account_id: QUOTA_ACCOUNT_TAG,
		period_start: anchorStart,
		period_end: anchorEnd,
		anchor_kind: "subscription_renewal",
		source: "test",
		source_version: "test@1",
		verified_at: anchorStart,
	});
	const now = new Date();
	const cycleKey = `cycle:${anchorStart}..${anchorEnd}`;
	for (const entry of QUOTA_DIMENSIONS) {
		if (!entry.provable || entry.threshold_95 === null) continue;
		await recordBaseline(db, {
			dimension_key: entry.key,
			period_key:
				entry.period === "utc_day" ? `utc-day:${now.toISOString().slice(0, 10)}` : cycleKey,
			state: "VERIFIED",
			used: 0,
			unobserved_upper_bound: 0,
			source: "test",
			source_version: "test@1",
			as_of: now.toISOString(),
			coverage_end: now.toISOString(),
		});
	}
	const env = {
		RESEARCH_REPLICA: db,
		RESEARCH_OBJECTS: { put: async () => undefined, get: async () => undefined },
		RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
		QUOTA_ADMISSION_MODE: "enforce",
	};
	const payload = {
		subject_key: "market:000001.SZ",
		as_of: "2026-09-16",
		status: "READY",
		benchmark_mapping_version: "market-benchmarks.v1",
		mapping_id: "cn-a-share-stock-v1",
		primary_benchmark: "510300.SH",
		secondary_benchmark: "510500.SH",
		source: { provider: "amazingdata", snapshot_hash: "a".repeat(64), snapshot_as_of: "2026-09-16T17:44:28+08:00" },
		quality: { valid_trading_days: 10, required_trading_days: 10, future_rows_dropped: 0, missing_sessions: 0 },
		returns: Object.fromEntries([1, 3, 5, 10].map((window) => [`${window}D`, { window_complete: true, valid_trading_days: window, subject_return: 0.1, primary_benchmark_return: 0.05, secondary_benchmark_return: 0.04 }])),
		relative_strength: { primary_pct_points: { "1D": 5, "3D": 5, "5D": 5, "10D": 5 }, secondary_pct_points: { "1D": 6, "3D": 6, "5D": 6, "10D": 6 } },
		volume_price_structure: { up_volume_ratio_5d: 1.25, pullback_volume_ratio_5d: null, volume_up: true, pullback_volume_contraction: false },
		continuous_market_structure: { required_sessions: 3, observed_sessions: 3, relative_positive_sessions: 3, status: "CONFIRMED" },
		visibility: "PUBLIC",
	};
	const record = {
		record_type: "market_signal",
		message_id: "",
		schema_version: "collector-market-signal-v1",
		policy_version: "market-signal-v1",
		visibility: "PUBLIC",
		payload,
		generated_at: "2026-09-16T18:00:00Z",
	};
	const { computeOutboundV2MessageId } = await import("../src/research-outbound-v2.ts");
	record.message_id = await computeOutboundV2MessageId(record);

	const response = await worker.fetch(
		new Request("https://worker.example/internal/research-replica/v2/ingest", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: JSON.stringify({ record }),
		}),
		env,
		{},
	);
	const body = await response.text();
	assert.equal(response.status, 200, body);
	assert.equal(JSON.parse(body).status, "APPLIED");
	const count = await db.prepare(`SELECT COUNT(*) AS n FROM quota_reservations`).first();
	assert.equal(count?.n ?? 0, 0, "the success path settles its reservation too");
});
