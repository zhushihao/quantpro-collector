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
		RESEARCH_OBJECTS: {},
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
		if (response.status !== 400) {
			console.log("DEBUG refusal:", await response.json());
		}
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
		RESEARCH_OBJECTS: {},
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
