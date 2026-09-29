/**
 * Guarded resource adapter tests (SDD CQ spec P0-B test matrix).
 *
 * The wrappers must make an unguarded paid call impossible: no handle, no call;
 * dimension not reserved, no call; amplification past the reserved bound, no
 * call; unknown provider usage metadata keeps the reservation instead of
 * pretending the operation succeeded.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	NEURON_BOUND,
	QuotaGuardError,
	ReservationBudget,
	admissionHandle,
	createGuardedAi,
	createGuardedD1,
	createGuardedR2,
	createGuardedVectorize,
	neuronUpperBound,
} from "../src/quota-breaker.ts";

function handle(reserved) {
	return {
		reservation_id: "res-1",
		operation_id: "op-1",
		route: "http:/internal/research-replica/v2/ingest",
		reserved,
	};
}

function fakeD1(meta = { rows_read: 3, rows_written: 1 }) {
	return {
		prepare(sql) {
			const statement = {
				sql,
				bind() {
					return this;
				},
				async run() {
					return { meta };
				},
				async all() {
					return { results: [], meta };
				},
				async first() {
					return null;
				},
			};
			return statement;
		},
		async batch(statements) {
			return statements.map(() => ({ meta }));
		},
	};
}

test("a guarded D1 binding refuses to be constructed without an ADMITTED handle", () => {
	const budget = new ReservationBudget(handle([{ dimension_key: "d1.rows_read", units: 10 }]));
	assert.throws(
		() => createGuardedD1(fakeD1(), null, budget),
		(error) =>
			error instanceof QuotaGuardError && error.error_code === "QUOTA_GUARD_UNAVAILABLE",
	);
});

test("a guarded statement is refused when its dimension is not reserved", async () => {
	const budget = new ReservationBudget(handle([{ dimension_key: "d1.rows_read", units: 10 }]));
	const guarded = createGuardedD1(
		fakeD1(),
		handle([{ dimension_key: "d1.rows_read", units: 10 }]),
		budget,
	);
	await assert.rejects(
		guarded.prepare("INSERT INTO t VALUES (1)").run(),
		(error) =>
			error instanceof QuotaGuardError && error.error_code === "QUOTA_GUARD_UNAVAILABLE",
	);
});

test("amplification past the reserved bound is refused after the spend is accounted", async () => {
	const budget = new ReservationBudget(handle([{ dimension_key: "d1.rows_read", units: 3 }]));
	const guarded = createGuardedD1(
		fakeD1({ rows_read: 2, rows_written: 0 }),
		handle([{ dimension_key: "d1.rows_read", units: 3 }]),
		budget,
	);
	const first = await guarded.prepare("SELECT 1").all();
	assert.equal(first.results.length, 0);
	assert.equal(budget.spent("d1.rows_read"), 2);
	await assert.rejects(
		guarded.prepare("SELECT 2").all(),
		(error) => error instanceof QuotaGuardError && error.error_code === "QUOTA_CIRCUIT_OPEN",
	);
});

test("observed usage is metered into the settlement snapshot", async () => {
	const reserved = [
		{ dimension_key: "d1.rows_read", units: 100 },
		{ dimension_key: "d1.rows_written", units: 10 },
	];
	const budget = new ReservationBudget(handle(reserved));
	const guarded = createGuardedD1(
		fakeD1({ rows_read: 40, rows_written: 4 }),
		handle(reserved),
		budget,
	);
	await guarded.prepare("SELECT 1").all();
	const snapshot = new Map(budget.snapshot().map((entry) => [entry.dimension_key, entry.units]));
	assert.equal(snapshot.get("d1.rows_read"), 40);
	assert.equal(snapshot.get("d1.rows_written"), 4);
});

test("missing D1 usage metadata keeps the reservation and refuses the call", async () => {
	const reserved = [{ dimension_key: "d1.rows_read", units: 100 }];
	const budget = new ReservationBudget(handle(reserved));
	const guarded = createGuardedD1(fakeD1({}), handle(reserved), budget);
	await assert.rejects(
		guarded.prepare("SELECT 1").all(),
		(error) =>
			error instanceof QuotaGuardError && error.error_code === "QUOTA_GUARD_UNAVAILABLE",
	);
	assert.equal(budget.spent("d1.rows_read"), 0, "unknown usage never becomes a settlement claim");
});

test("R2 operations bill the official classes and delete stays free but guarded", async () => {
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
	const reserved = [
		{ dimension_key: "r2.class_a", units: 2 },
		{ dimension_key: "r2.class_b", units: 1 },
	];
	const budget = new ReservationBudget(handle(reserved));
	const guarded = createGuardedR2(bucket, handle(reserved), budget);
	await guarded.put("a", "body");
	await guarded.get("a");
	await guarded.delete("a", {});
	assert.deepEqual(calls, [
		["put", "a"],
		["get", "a"],
		["delete", "a"],
	]);
	const snapshot = new Map(budget.snapshot().map((entry) => [entry.dimension_key, entry.units]));
	assert.equal(snapshot.get("r2.class_a"), 1);
	assert.equal(snapshot.get("r2.class_b"), 1);

	// A second put is allowed (2 reserved) but the third is refused: the wrapper
	// enforces the declared per-operation bound instead of a guess.
	await guarded.put("b", "body");
	await assert.rejects(
		guarded.put("c", "body"),
		(error) => error instanceof QuotaGuardError && error.error_code === "QUOTA_CIRCUIT_OPEN",
	);
});

test("R2 Class B operations are refused when only Class A is reserved", async () => {
	const bucket = {
		async get() {
			return null;
		},
		async put() {
			return {};
		},
		async head() {
			return null;
		},
		async delete() {},
		async list() {
			return { objects: [] };
		},
	};
	const reserved = [{ dimension_key: "r2.class_a", units: 1 }];
	const budget = new ReservationBudget(handle(reserved));
	const guarded = createGuardedR2(bucket, handle(reserved), budget);
	await assert.rejects(
		guarded.get("a"),
		(error) =>
			error instanceof QuotaGuardError && error.error_code === "QUOTA_GUARD_UNAVAILABLE",
	);
});

test("Workers AI spends against the calibrated neuron bound and refuses over-budget calls", async () => {
	// The owner-approved daily budget (2026-09-30) proves the document cap:
	// 32 chunks x 1,350 chars at 1 char = 1 token => ceil(43_200 * 1_075 / 1e6).
	assert.equal(NEURON_BOUND.model, "@cf/baai/bge-m3");
	assert.equal(neuronUpperBound(), 47);
	assert.equal(
		neuronUpperBound({ model: "x", neurons_per_million_tokens: 0, max_input_tokens: 10 }),
		null,
	);
	assert.equal(
		neuronUpperBound({ model: "x", neurons_per_million_tokens: 1075, max_input_tokens: 1000 }),
		2,
	);
	const calls = [];
	const ai = {
		async run(model, input) {
			calls.push(model);
			return { embeddings: [] };
		},
	};
	const reserved = [{ dimension_key: "ai.neurons", units: 70 }];
	const budget = new ReservationBudget(handle(reserved));
	const guarded = createGuardedAi(ai, handle(reserved), budget);
	const result = await guarded.run("@cf/baai/bge-m3", {});
	assert.deepEqual(result, { embeddings: [] });
	assert.deepEqual(calls, ["@cf/baai/bge-m3"]);
	assert.equal(budget.spent("ai.neurons"), 47);
	// A second document call would cross the 70-unit reservation and is refused
	// before the provider call is made.
	await assert.rejects(
		guarded.run("@cf/baai/bge-m3", {}),
		(error) => error instanceof QuotaGuardError && error.error_code === "QUOTA_CIRCUIT_OPEN",
	);
	assert.deepEqual(calls, ["@cf/baai/bge-m3"], "the refused call never reached the provider");
});

test("Vectorize writes and queries stay CLOSED without verified stock semantics", async () => {
	const index = {
		async query() {
			throw new Error("must not be called");
		},
		async upsert() {
			throw new Error("must not be called");
		},
		async deleteByIds() {
			throw new Error("must not be called");
		},
	};
	const reserved = [{ dimension_key: "vectorize.queried_dims", units: 10 }];
	const budget = new ReservationBudget(handle(reserved));
	const guarded = createGuardedVectorize(index, handle(reserved), budget);
	await assert.rejects(guarded.query([]), (error) => error instanceof QuotaGuardError);
	await assert.rejects(guarded.upsert([]), (error) => error instanceof QuotaGuardError);
	await assert.rejects(guarded.deleteByIds(["a"]), (error) => error instanceof QuotaGuardError);
});

test("ReservationBudget refuses dimensions without a provable bound", () => {
	const budget = new ReservationBudget(handle([{ dimension_key: "d1.rows_read", units: 5 }]));
	assert.throws(
		() => budget.require("ai.neurons", 1, "embedding"),
		(error) =>
			error instanceof QuotaGuardError && error.error_code === "QUOTA_GUARD_UNAVAILABLE",
	);
	assert.throws(
		() => budget.require("kv.reads", 1, "kv get"),
		(error) =>
			error instanceof QuotaGuardError && error.error_code === "QUOTA_GUARD_UNAVAILABLE",
	);
});

test("admissionHandle only exists for ADMITTED results and merges the ledger self-cost", () => {
	assert.equal(
		admissionHandle(
			{ status: "DENIED", reason: "limit", dimension_key: null, detail: "", request_id: "x" },
			{ operation_id: "op", route: "r" },
		),
		null,
	);
	assert.equal(
		admissionHandle(
			{ status: "REPLAY", reservation_id: "r", outcome: "SETTLED", recorded_at: "t" },
			{ operation_id: "op", route: "r" },
		),
		null,
	);
	const admitted = {
		status: "ADMITTED",
		reservation_id: "res-9",
		admitted_at: "2026-09-20T00:00:00.000Z",
		expires_at: null,
		reserved: [{ dimension_key: "d1.rows_written", units: 12 }],
		self_cost: [{ dimension_key: "d1.rows_read", units: 4 }],
	};
	const handle2 = admissionHandle(admitted, { operation_id: "op", route: "r" });
	assert.equal(handle2.reservation_id, "res-9");
	const totals = new Map(handle2.reserved.map((entry) => [entry.dimension_key, entry.units]));
	assert.equal(totals.get("d1.rows_written"), 12);
	assert.equal(totals.get("d1.rows_read"), 4);
});
