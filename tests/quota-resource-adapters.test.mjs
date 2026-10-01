/**
 * Pure resource observer tests (quota redesign 2026-10-02, spec section 1.1).
 *
 * The observers are the OPPOSITE of the old guarded adapters: a call is never
 * refused, never re-ordered and never re-judged.  Every test pins the same
 * two-sided contract -- (1) the underlying call passes through untouched, and
 * (2) the platform-reported practical usage lands in the observation -- with
 * special attention to the 2026-09-30 C5 failure mode: missing usage metadata
 * must never throw and never change the business result.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	UsageObserver,
	createObservedD1,
	createObservedR2,
} from "../src/quota-breaker.ts";

function fakeD1(meta = { rows_read: 3, rows_written: 1 }) {
	const calls = [];
	return {
		calls,
		prepare(sql) {
			const statement = {
				sql,
				bind(...values) {
					calls.push(["bind", sql, values]);
					return this;
				},
				async run() {
					calls.push(["run", sql]);
					return { meta };
				},
				async all() {
					calls.push(["all", sql]);
					return { results: [{ id: 1 }], meta };
				},
				async raw() {
					calls.push(["raw", sql]);
					return [[1]];
				},
				async first(...args) {
					calls.push(["first", sql, args]);
					return { id: 1 };
				},
			};
			return statement;
		},
		async batch(statements) {
			calls.push(["batch", statements.length]);
			return statements.map(() => ({ meta }));
		},
	};
}

function totals(observer) {
	return new Map(observer.totals().map((entry) => [entry.dimension_key, entry.units]));
}

test("D1 statements pass through unmodified and their measured usage is observed", async () => {
	const observer = new UsageObserver();
	const fake = fakeD1({ rows_read: 40, rows_written: 4 });
	const observed = createObservedD1(fake, observer);
	const bound = observed.prepare("SELECT * FROM t WHERE id = ?").bind(7);
	const result = await bound.all();
	assert.deepEqual(result.results, [{ id: 1 }], "the business result is untouched");
	assert.deepEqual(fake.calls[0], ["bind", "SELECT * FROM t WHERE id = ?", [7]]);
	assert.deepEqual(fake.calls[1], ["all", "SELECT * FROM t WHERE id = ?"]);
	const seen = totals(observer);
	assert.equal(seen.get("d1.rows_read"), 40);
	assert.equal(seen.get("d1.rows_written"), 4);
});

test("run/raw/batch/first all execute once; first() is observed via the bounded all() projection", async () => {
	const observer = new UsageObserver();
	const fake = fakeD1({ rows_read: 5, rows_written: 2 });
	const observed = createObservedD1(fake, observer);
	const row = await observed.prepare("SELECT 1").first("id");
	assert.equal(row, 1, "the column-name variant of first() is preserved");
	const full = await observed.prepare("SELECT 2").first();
	assert.deepEqual(full, { id: 1 }, "the plain variant of first() is preserved");
	await observed.prepare("INSERT INTO t VALUES (1)").run();
	await observed.batch([observed.prepare("SELECT 1"), observed.prepare("SELECT 2")]);
	const kinds = fake.calls.map((entry) => entry[0]);
	// first() executes via all() exactly once (the C5 fix); the native first is
	// never reached on the happy path.
	assert.deepEqual(kinds, ["all", "all", "run", "batch"]);
	const seen = totals(observer);
	// first(5) + first(5) + run(5) + batch(2 x 5); raw() not called in this test.
	assert.equal(seen.get("d1.rows_read"), 25);
	assert.equal(seen.get("d1.rows_written"), 2 * 5);
});

test("first() falls back to the native call when the projection fails, never changing the outcome", async () => {
	const observer = new UsageObserver();
	let allCalls = 0;
	let firstCalls = 0;
	const failing = {
		prepare() {
			return {
				bind() {
					return this;
				},
				async all() {
					allCalls += 1;
					throw new Error("driver rejected all()");
				},
				async first() {
					firstCalls += 1;
					return { id: 42 };
				},
			};
		},
		async batch(statements) {
			return statements.map(() => ({ meta: {} }));
		},
	};
	const observed = createObservedD1(failing, observer);
	const row = await observed.prepare("SELECT 1").first();
	assert.deepEqual(row, { id: 42 }, "the native first() answer wins");
	assert.equal(allCalls, 1);
	assert.equal(firstCalls, 1);
	assert.deepEqual(observer.totals(), [], "the failed projection records nothing");
});

test("missing usage metadata never throws and never fabricates a measurement", async () => {
	const observer = new UsageObserver();
	const observed = createObservedD1(fakeD1({}), observer);
	const result = await observed.prepare("SELECT 1").all();
	assert.deepEqual(result.results, [{ id: 1 }], "the call succeeds with no meta at all");
	assert.deepEqual(observer.totals(), [], "unknown usage is recorded as nothing, never a guess");
});

test("a throwing statement propagates the business error unchanged", async () => {
	const observer = new UsageObserver();
	const failing = {
		prepare() {
			return {
				bind() {
					return this;
				},
				async all() {
					throw new Error("syntax error near FROM");
				},
			};
		},
		async batch(statements) {
			return statements.map(() => ({ meta: {} }));
		},
	};
	const observed = createObservedD1(failing, observer);
	await assert.rejects(observed.prepare("SELECT nope").all(), /syntax error near FROM/);
	assert.deepEqual(observer.totals(), []);
});

test("an observer without an explicit UsageObserver still passes everything through", async () => {
	const observed = createObservedD1(fakeD1({ rows_read: 9, rows_written: 0 }));
	const result = await observed.prepare("SELECT 1").all();
	assert.deepEqual(result.results, [{ id: 1 }]);
});

test("R2 operations pass through and bill the official classes; delete stays free", async () => {
	const calls = [];
	const bucket = {
		async put(key) {
			calls.push(["put", key]);
			return {};
		},
		async get(key) {
			calls.push(["get", key]);
			return null;
		},
		async head(key) {
			calls.push(["head", key]);
			return null;
		},
		async delete(key) {
			calls.push(["delete", key]);
			return undefined;
		},
		async list() {
			calls.push(["list"]);
			return { objects: [] };
		},
	};
	const observer = new UsageObserver();
	const observed = createObservedR2(bucket, observer);
	await observed.put("a", "body");
	await observed.get("a");
	await observed.delete("a", {});
	await observed.list();
	assert.deepEqual(calls, [
		["put", "a"],
		["get", "a"],
		["delete", "a"],
		["list"],
	]);
	const seen = totals(observer);
	assert.equal(seen.get("r2.class_a"), 2, "put + list are Class A");
	assert.equal(seen.get("r2.class_b"), 1, "get is Class B");
});

test("a throwing sink can never break or re-judge the business call", async () => {
	const observer = new UsageObserver();
	const observed = createObservedD1(fakeD1({ rows_read: 11, rows_written: 0 }), observer);
	await observed.prepare("SELECT 1").all();
	let sinkCalls = 0;
	await observer.report({
		observe() {
			sinkCalls += 1;
			throw new Error("accounting backend down");
		},
	});
	assert.equal(sinkCalls, 1);
	await assert.doesNotReject(observed.prepare("SELECT 2").all());
	const seen = totals(observer);
	assert.equal(seen.get("d1.rows_read"), 22);
});

test("report() delivers the observed totals to the sink once per request", async () => {
	const observer = new UsageObserver();
	const observed = createObservedD1(fakeD1({ rows_read: 3, rows_written: 7 }), observer);
	await observed.prepare("SELECT 1").all();
	await observed.prepare("INSERT INTO t VALUES (1)").run();
	const delivered = [];
	await observer.report({ observe: (snapshot) => delivered.push(snapshot) });
	assert.deepEqual(delivered, [
		[
			{ dimension_key: "d1.rows_read", units: 6 },
			{ dimension_key: "d1.rows_written", units: 14 },
		],
	]);
});

test("non-finite and non-positive readings are ignored, never booked", () => {
	const observer = new UsageObserver();
	observer.record("d1.rows_read", Number.NaN);
	observer.record("d1.rows_read", 0);
	observer.record("d1.rows_read", -5);
	observer.record("d1.rows_written", 2.9);
	assert.deepEqual(totals(observer), new Map([["d1.rows_written", 2]]));
});
