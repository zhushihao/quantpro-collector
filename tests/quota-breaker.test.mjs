/**
 * Contract-surface tests for the quota entry module (post gate-removal,
 * 2026-10-02 quota redesign).
 *
 * These pin the parts a reviewer must be able to check without a database: the
 * abolished admission switch, the inert legacy flag, the 95% catalog
 * arithmetic, the natural-period resolution (renewal anchor / UTC day /
 * storage integral) and the guarantee boundary text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	QUOTA_CATALOG_VERSION,
	QUOTA_DIMENSIONS,
	admissionCeiling,
	dimensionSpec,
	isVerifiedAnchor,
	legacyBreakerFlag,
	legacyPrototypeGatesWork,
	resolvePeriod,
	storageIntegralUnits,
	threshold95,
} from "../src/quota-breaker.ts";

const ANCHOR = {
	account_id: "acct",
	period_start: "2026-09-14T00:00:00.000Z",
	period_end: "2026-10-14T00:00:00.000Z",
	anchor_kind: "subscription_renewal",
	source: "operator",
	source_version: "billing-portal@2026-09-14",
	verified_at: "2026-09-14T00:00:00.000Z",
};

test("the admission switch is abolished: no admissionMode export exists any more", async () => {
	const facade = await import("../src/quota-breaker.ts");
	assert.equal("admissionMode" in facade, false, "the enforce/off switch must not survive");
	assert.equal("QuotaAdmissionMode" in facade, false);
});

test("the legacy daily flag is reported but can never gate work", () => {
	assert.deepEqual(legacyBreakerFlag(undefined), {
		flag: "QUOTA_BREAKER_ENABLED",
		present: false,
		prototype_state: "disabled",
	});
	assert.equal(legacyBreakerFlag({ QUOTA_BREAKER_ENABLED: "true" }).present, true);
	assert.equal(legacyPrototypeGatesWork(), false);
});

test("catalog thresholds are floor(95% of the official allowance)", () => {
	const byKey = new Map(QUOTA_DIMENSIONS.map((entry) => [entry.key, entry]));
	assert.equal(byKey.get("workers.requests").threshold_95, 9_500_000);
	assert.equal(byKey.get("workers.cpu_ms").threshold_95, 28_500_000);
	assert.equal(byKey.get("d1.rows_read").threshold_95, 23_750_000_000);
	assert.equal(byKey.get("d1.rows_written").threshold_95, 47_500_000);
	assert.equal(byKey.get("d1.storage_gb_month").threshold_95, 4_750);
	assert.equal(byKey.get("kv.storage_gb_month").threshold_95, 950);
	assert.equal(byKey.get("kv.reads").threshold_95, 9_500_000);
	assert.equal(byKey.get("kv.writes").threshold_95, 950_000);
	assert.equal(byKey.get("r2.class_a").threshold_95, 950_000);
	assert.equal(byKey.get("r2.class_b").threshold_95, 9_500_000);
	assert.equal(byKey.get("r2.storage_gb_month").threshold_95, 9_500);
	assert.equal(byKey.get("ai.neurons").threshold_95, 10_000, "zero-cost line = full free allowance");
	assert.equal(byKey.get("ai.neurons").period, "utc_day");
	assert.equal(byKey.get("vectorize.queried_dims").threshold_95, 47_500_000);
	assert.equal(byKey.get("vectorize.stored_dims").threshold_95, 9_500_000);
	assert.equal(threshold95(10_000_000), 9_500_000);
	assert.equal(admissionCeiling("r2.class_a"), 950_000);
});

test("dimensions without a provable bound are marked unprovable", () => {
	for (const key of [
		"workers.requests",
		"workers.cpu_ms",
		"d1.storage_gb_month",
		"kv.storage_gb_month",
		"r2.storage_gb_month",
		"vectorize.stored_dims",
		"r2.ia_class_a",
		"r2.ia_storage_gb_month",
	]) {
		assert.equal(dimensionSpec(key)?.provable, false, `${key} must not claim a bound`);
	}
	for (const key of [
		"d1.rows_read",
		"d1.rows_written",
		"r2.class_a",
		"r2.class_b",
		"kv.reads",
		"ai.neurons",
	]) {
		assert.equal(dimensionSpec(key)?.provable, true, `${key} must declare a provable bound`);
	}
});

test("billing-cycle periods require a verified renewal anchor, never a UTC month", () => {
	const d1 = dimensionSpec("d1.rows_read");
	const now = new Date("2026-09-20T00:00:00.000Z");
	assert.equal(resolvePeriod(d1, { anchor: null, now }), null);
	assert.equal(resolvePeriod(d1, { anchor: { ...ANCHOR, anchor_kind: "unknown" }, now }), null);
	assert.equal(
		resolvePeriod(d1, { anchor: { ...ANCHOR, verified_at: "not-a-date" }, now }),
		null,
	);
	const resolved = resolvePeriod(d1, { anchor: ANCHOR, now });
	assert.equal(resolved.period_key, `cycle:${ANCHOR.period_start}..${ANCHOR.period_end}`);
	assert.equal(resolved.period_kind, "billing_cycle");
	assert.equal(isVerifiedAnchor(ANCHOR), true);
});

test("billing-cycle admission rejects a stale, future or not-yet-verified anchor", () => {
	const d1 = dimensionSpec("d1.rows_read");
	const atStart = new Date(ANCHOR.period_start);
	assert.notEqual(resolvePeriod(d1, { anchor: ANCHOR, now: atStart }), null);
	for (const now of [
		new Date("2026-09-13T23:59:59.999Z"),
		new Date(ANCHOR.period_end),
		new Date("2026-10-15T00:00:00.000Z"),
	]) {
		assert.equal(resolvePeriod(d1, { anchor: ANCHOR, now }), null);
	}
	assert.equal(
		resolvePeriod(d1, {
			anchor: { ...ANCHOR, verified_at: "2026-09-25T00:00:00.000Z" },
			now: new Date("2026-09-20T00:00:00.000Z"),
		}),
		null,
	);
});

test("the AI neuron period is the official UTC day", () => {
	const neurons = dimensionSpec("ai.neurons");
	const resolved = resolvePeriod(neurons, {
		anchor: null,
		now: new Date("2026-09-20T23:59:59.000Z"),
	});
	assert.equal(resolved.period_kind, "utc_day");
	assert.equal(resolved.period_key, "utc-day:2026-09-20");
	assert.equal(resolved.period_start, "2026-09-20T00:00:00.000Z");
	assert.equal(resolved.period_end, "2026-09-21T00:00:00.000Z");
});

test("storage risk is a time integral over the remaining cycle, not a flat capacity", () => {
	const halfCycle = storageIntegralUnits(10_000_000_000, {
		period_start: "2026-09-01T00:00:00.000Z",
		period_end: "2026-10-01T00:00:00.000Z",
		now: new Date("2026-09-16T00:00:00.000Z"),
	});
	assert.equal(halfCycle, 5, "10 decimal GB held for half of a 30-day cycle is 5 GB-month");
	assert.equal(
		storageIntegralUnits(10_000_000_000, {
			period_start: "2026-09-01T00:00:00.000Z",
			period_end: "2026-10-01T00:00:00.000Z",
			now: new Date("2026-08-01T00:00:00.000Z"),
		}),
		null,
		"a timestamp outside the cycle cannot be integrated",
	);
	assert.equal(
		storageIntegralUnits(-1, {
			period_start: "2026-09-01T00:00:00.000Z",
			period_end: "2026-10-01T00:00:00.000Z",
			now: new Date("2026-09-16T00:00:00.000Z"),
		}),
		null,
	);
});

test("the catalog version is pinned and the post-removal boundary is stated in code", async () => {
	assert.equal(QUOTA_CATALOG_VERSION, "quota-catalog/2026-09-30.5");
	assert.equal(QUOTA_DIMENSIONS.length, 19);
	const { readFile } = await import("node:fs/promises");
	const text = await readFile(new URL("../src/quota-breaker.ts", import.meta.url), "utf8");
	assert.match(text, /nothing here gates work any more/);
	assert.match(text, /is inert/);
});
