/**
 * Read-only billing baseline tests (SDD CQ spec P0-A).
 *
 * The adapter must never turn doubt into usable evidence: 403/empty/partial/wrong
 * unit/stale/missing mapping all have to end in a non-VERIFIED state, and a
 * "verified" read still carries `gate_authority: "NONE"` because an operator must
 * register the unobserved-tail upper bound.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	interpretBillableUsage,
	storageAdmissionUnits,
	threshold95,
} from "../src/quota-breaker.ts";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const ACCOUNT = "acct-1";
const PERIOD = {
	period_start: "2026-09-14T00:00:00.000Z",
	period_end: "2026-10-14T00:00:00.000Z",
};
const MAPPING = [
	{
		provider_usage_type: "d1_rows_read",
		dimension_key: "d1.rows_read",
		scale: 1,
		evidence: "synthetic test mapping",
	},
];

function input(overrides = {}) {
	return {
		http_status: 200,
		fetched_at: "2026-09-20T11:55:00.000Z",
		account_id: ACCOUNT,
		expected_period: PERIOD,
		pagination_complete: true,
		coverage_end: "2026-09-20T11:00:00.000Z",
		max_age_ms: 24 * 3600 * 1000,
		now: NOW,
		body: {
			success: true,
			result: {
				account_id: ACCOUNT,
				currency: "USD",
				billing_cycle_start: PERIOD.period_start,
				billing_cycle_end: PERIOD.period_end,
				usage: [{ usage_type: "d1_rows_read", value: 12345 }],
			},
		},
		...overrides,
	};
}

test("403 is DENIED and never read as zero usage", () => {
	const result = interpretBillableUsage(input({ http_status: 403, body: null }), MAPPING);
	assert.equal(result.state, "DENIED");
	assert.deepEqual(result.observations, []);
	assert.match(result.reasons[0], /denied with HTTP 403/);
});

test("429/5xx and empty bodies are INCOMPLETE, not zero", () => {
	for (const status of [0, 429, 500, 502]) {
		const result = interpretBillableUsage(input({ http_status: status, body: null }), MAPPING);
		assert.equal(result.state, "INCOMPLETE", `status ${status}`);
		assert.equal(result.observations.length, 0);
	}
	const empty = interpretBillableUsage(
		input({ body: { success: true, result: { usage: [] } } }),
		MAPPING,
	);
	assert.equal(empty.state, "INCOMPLETE");
});

test("real billable-usage array shape is partial evidence, never a full admission baseline", () => {
	const result = interpretBillableUsage(input({
		body: {
			success: true,
			result: [{
				ServiceFamilyName: "R2",
				ServiceName: "R2 Storage Class A Operations",
				BillingPeriodStart: PERIOD.period_start,
				ConsumedQuantity: 5,
				PricingUnit: "Count",
			}],
		},
	}));
	assert.equal(result.state, "INCOMPLETE");
	assert.equal(result.gate_authority, "NONE");
	assert.deepEqual(result.observations, []);
});

test("a billing read without a registered dimension mapping cannot produce evidence", () => {
	// The registry is intentionally empty until an authorised verified read exists.
	const result = interpretBillableUsage(input());
	assert.equal(result.state, "INCOMPLETE");
	assert.match(result.reasons.join(" "), /no verified provider-to-dimension mapping/);
});

test("an unmapped provider usage type makes the whole read INCOMPLETE", () => {
	const result = interpretBillableUsage(
		input({
			body: {
				success: true,
				result: {
					account_id: ACCOUNT,
					billing_cycle_start: PERIOD.period_start,
					billing_cycle_end: PERIOD.period_end,
					usage: [
						{ usage_type: "d1_rows_read", value: 10 },
						{ usage_type: "surprise_usage", value: 10 },
					],
				},
			},
		}),
		MAPPING,
	);
	assert.equal(result.state, "INCOMPLETE");
	assert.match(result.reasons.join(" "), /unmapped provider usage type/);
});

test("a period window mismatch against the verified anchor is INCOMPLETE", () => {
	const result = interpretBillableUsage(
		input({
			body: {
				success: true,
				result: {
					account_id: ACCOUNT,
					billing_cycle_start: "2026-09-01T00:00:00.000Z",
					billing_cycle_end: "2026-10-01T00:00:00.000Z",
					usage: [{ usage_type: "d1_rows_read", value: 1 }],
				},
			},
		}),
		MAPPING,
	);
	assert.equal(result.state, "INCOMPLETE");
	assert.match(result.reasons.join(" "), /does not match the verified account anchor/);
});

test("an unverified account anchor blocks the read entirely", () => {
	const result = interpretBillableUsage(input({ expected_period: null }), MAPPING);
	assert.equal(result.state, "INCOMPLETE");
	assert.match(result.reasons.join(" "), /anchor is not verified/);
});

test("stale coverage is reported STALE, and complete pagination is required", () => {
	const stale = interpretBillableUsage(
		input({ coverage_end: "2026-09-15T00:00:00.000Z" }),
		MAPPING,
	);
	assert.equal(stale.state, "STALE");
	const partial = interpretBillableUsage(input({ pagination_complete: false }), MAPPING);
	assert.equal(partial.state, "INCOMPLETE");
	assert.match(partial.reasons.join(" "), /pagination is not proven complete/);
	const noCoverage = interpretBillableUsage(input({ coverage_end: null }), MAPPING);
	assert.equal(noCoverage.state, "INCOMPLETE");
});

test("a verified read carries the cycle period key but no gate authority", () => {
	const result = interpretBillableUsage(input(), MAPPING);
	assert.equal(result.state, "VERIFIED");
	assert.equal(result.period_key, `cycle:${PERIOD.period_start}..${PERIOD.period_end}`);
	assert.equal(result.gate_authority, "NONE", "the adapter can never authorise admission alone");
	assert.equal(result.observations.length, 1);
	const observation = result.observations[0];
	assert.equal(observation.dimension_key, "d1.rows_read");
	assert.equal(observation.used, 12345);
	assert.equal(observation.state, "VERIFIED");
	assert.equal(observation.coverage_end, "2026-09-20T11:00:00.000Z");
});

test("a wrong-unit or non-numeric usage value is INCOMPLETE", () => {
	const result = interpretBillableUsage(
		input({
			body: {
				success: true,
				result: {
					account_id: ACCOUNT,
					billing_cycle_start: PERIOD.period_start,
					billing_cycle_end: PERIOD.period_end,
					usage: [{ usage_type: "d1_rows_read", value: "12345 rows" }],
				},
			},
		}),
		MAPPING,
	);
	assert.equal(result.state, "INCOMPLETE");
	assert.match(result.reasons.join(" "), /not a non-negative number/);
});

test("account identity must match and success must be true", () => {
	const wrongAccount = interpretBillableUsage(
		input({
			body: {
				success: true,
				result: {
					account_id: "someone-else",
					billing_cycle_start: PERIOD.period_start,
					billing_cycle_end: PERIOD.period_end,
					usage: [{ usage_type: "d1_rows_read", value: 1 }],
				},
			},
		}),
		MAPPING,
	);
	assert.equal(wrongAccount.state, "INCOMPLETE");
	const failed = interpretBillableUsage(
		input({ body: { success: false, errors: [{}] } }),
		MAPPING,
	);
	assert.equal(failed.state, "DENIED");
});

test("thresholds are floor(95% of the official allowance) and storage is scaled to milli-GB-month", () => {
	assert.equal(threshold95(10_000_000), 9_500_000);
	assert.equal(threshold95(25_000_000_000), 23_750_000_000);
	assert.equal(threshold95(10_000), 9_500);
	assert.equal(threshold95(5), 4, "floor, never rounded up");
	assert.equal(storageAdmissionUnits(1_000_000_000), 1000);
	assert.equal(storageAdmissionUnits(1_500_000_000), 1500);
	assert.equal(storageAdmissionUnits(1), 1, "any nonzero byte count reserves at least one unit");
});
