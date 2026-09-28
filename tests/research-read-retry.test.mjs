import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { ResearchBoundaryError } = await import("../src/research-outbound-v2.ts");
const {
	RESEARCH_READ_RETRY_DELAYS_MS,
	classifyResearchReadBackendError,
	shouldRetryResearchRead,
	withResearchReadRetry,
} = await import("../src/research-read-retry.ts");

test("research read retries only a positively identified transient native failure then succeeds", async () => {
	let attempts = 0;
	const sleeps = [];
	const events = [];
	const result = await withResearchReadRetry(
		async () => {
			attempts += 1;
			if (attempts < 3) throw new Error("D1_ERROR: Network connection lost.");
			return "ok";
		},
		{
			delaysMs: [1, 2],
			sleep: async (delayMs) => sleeps.push(delayMs),
			requestId: "req-transient-success",
			tool: "search_documents",
			onFailure: (event) => events.push(event),
		},
	);

	assert.equal(result, "ok");
	assert.equal(attempts, 3);
	assert.deepEqual(sleeps, [1, 2]);
	assert.equal(events.length, 2);
	assert.ok(events.every((event) => event.request_id === "req-transient-success"));
	assert.ok(events.every((event) => event.failure_class === "TRANSIENT"));
	assert.ok(events.every((event) => event.diagnostic_code === "TRANSIENT_BACKEND_IO"));
	assert.deepEqual(
		events.map((event) => event.will_retry),
		[true, true],
	);
});

test("persistent transient read failure has a bounded retry budget and one stable request id", async () => {
	let attempts = 0;
	const sleeps = [];
	const events = [];
	await assert.rejects(
		withResearchReadRetry(
			async () => {
				attempts += 1;
				throw new Error("socket connection reset by peer");
			},
			{
				delaysMs: [1, 2],
				sleep: async (delayMs) => sleeps.push(delayMs),
				requestId: "req-transient-final",
				tool: "search_documents",
				onFailure: (event) => events.push(event),
			},
		),
		(error) =>
			error instanceof ResearchBoundaryError &&
			error.error_code === "STORE_UNAVAILABLE" &&
			error.retryable === true &&
			error.request_id === "req-transient-final" &&
			error.safe_message === "research read backend unavailable; retry later",
	);
	assert.equal(attempts, 3);
	assert.deepEqual(sleeps, [1, 2]);
	assert.deepEqual(
		events.map((event) => event.attempt),
		[1, 2, 3],
	);
	assert.deepEqual(
		events.map((event) => event.will_retry),
		[true, true, false],
	);
});

test("missing-table and SQL-syntax failures are deterministic and never blindly retried", async () => {
	for (const [label, message] of [
		["missing-table", "D1_ERROR: no such table: research_records"],
		["sql-syntax", "D1_ERROR: near SELECT: syntax error"],
	]) {
		let attempts = 0;
		let sleeps = 0;
		const events = [];
		await assert.rejects(
			withResearchReadRetry(
				async () => {
					attempts += 1;
					throw new Error(message);
				},
				{
					delaysMs: [1, 2],
					sleep: async () => {
						sleeps += 1;
					},
					requestId: "req-" + label,
					tool: "search_documents",
					onFailure: (event) => events.push(event),
				},
			),
			(error) =>
				error instanceof ResearchBoundaryError &&
				error.error_code === "STORE_UNAVAILABLE" &&
				error.retryable === false &&
				error.request_id === "req-" + label &&
				error.safe_message === "research read backend failed; retry is not advised",
		);
		assert.equal(attempts, 1, label);
		assert.equal(sleeps, 0, label);
		assert.equal(events.length, 1, label);
		assert.equal(events[0].failure_class, "DETERMINISTIC", label);
		assert.equal(events[0].diagnostic_code, "DETERMINISTIC_BACKEND_QUERY_OR_CONFIG", label);
		assert.equal(shouldRetryResearchRead(new Error(message)), false, label);
	}
});

test("unknown native read error gets one short retry and diagnostics omit raw message", async () => {
	const rawMarker = "opaque failure with private-looking payload=DO_NOT_LOG";
	const events = [];
	let attempts = 0;
	await assert.rejects(
		withResearchReadRetry(
			async () => {
				attempts += 1;
				throw new Error(rawMarker);
			},
			{
				delaysMs: [1, 2],
				sleep: async () => {},
				requestId: "req-unknown",
				tool: "search_documents",
				onFailure: (event) => events.push(event),
			},
		),
		(error) =>
			error instanceof ResearchBoundaryError &&
			error.retryable === true &&
			error.request_id === "req-unknown",
	);
	assert.equal(attempts, 2);
	assert.equal(events[0].failure_class, "UNKNOWN");
	assert.equal(events[0].diagnostic_code, "UNKNOWN_BACKEND_READ_ERROR");
	assert.deepEqual(events.map((event) => event.will_retry), [true, false]);
	assert.equal(JSON.stringify(events).includes(rawMarker), false);
});

test("unknown native read failure can recover on its second attempt", async () => {
	let attempts = 0;
	const result = await withResearchReadRetry(async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("opaque D1 read failure");
		return [];
	}, { delaysMs: [1, 2], sleep: async () => {}, tool: "search_documents" });
	assert.deepEqual(result, []);
	assert.equal(attempts, 2);
});

test("classifier inspects a bounded cause chain for wrapped D1 transient errors", () => {
	const inner = new Error("D1_ERROR: Network connection lost.");
	const outer = new Error("D1 query failed", { cause: inner });
	const classified = classifyResearchReadBackendError(outer);
	assert.equal(classified.failure_class, "TRANSIENT");
	assert.equal(classified.diagnostic_code, "TRANSIENT_BACKEND_IO");
	assert.equal(classified.cause, outer);
});

test("explicit STORE_UNAVAILABLE boundary remains retryable for compatibility", async () => {
	const error = new ResearchBoundaryError("STORE_UNAVAILABLE");
	assert.equal(shouldRetryResearchRead(error), true);
	assert.deepEqual([...RESEARCH_READ_RETRY_DELAYS_MS], [500, 1500]);
});

test("research read does not retry non-storage boundary errors", async () => {
	for (const code of ["INTEGRITY_FAILED", "NOT_FOUND", "RATE_LIMITED"]) {
		const error = new ResearchBoundaryError(code);
		let attempts = 0;
		let sleeps = 0;
		await assert.rejects(
			withResearchReadRetry(
				async () => {
					attempts += 1;
					throw error;
				},
				{
					sleep: async () => {
						sleeps += 1;
					},
				},
			),
			(thrown) => thrown === error,
		);
		assert.equal(attempts, 1, code);
		assert.equal(sleeps, 0, code);
		assert.equal(shouldRetryResearchRead(error), false, code);
	}
});

test("normal empty search result stays a success and emits no failure event", async () => {
	const events = [];
	const result = await withResearchReadRetry(async () => [], {
		requestId: "req-empty",
		tool: "search_documents",
		onFailure: (event) => events.push(event),
	});
	assert.deepEqual(result, []);
	assert.deepEqual(events, []);
});

test("classifier retains a non-enumerable cause for debugging but exposes only safe metadata", () => {
	const raw = new Error("D1_ERROR: no such table: secret_named_table");
	const classified = classifyResearchReadBackendError(raw);
	assert.equal(classified.failure_class, "DETERMINISTIC");
	assert.equal(classified.diagnostic_code, "DETERMINISTIC_BACKEND_QUERY_OR_CONFIG");
	assert.equal(classified.cause, raw);
	assert.equal(JSON.stringify(classified).includes("secret_named_table"), false);
});

test("research read diagnostics are wired per tool while writes stay on researchWrite", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /event: "research_read_failure"/);
	assert.match(source, /researchRead\("search_documents"/);
	assert.match(source, /const researchWrite = researchDomain;/);

	for (const [tool, nextTool] of [
		["claim_research_job", "submit_research_result_proposal"],
		["submit_research_result_proposal", "defer_research_job"],
		["defer_research_job", "return server;"],
	]) {
		const start = source.indexOf(`"${tool}"`);
		const end = source.indexOf(
			nextTool === "return server;" ? nextTool : `"${nextTool}"`,
			start + 1,
		);
		assert.ok(start >= 0 && end > start, `${tool} section must exist`);
		const section = source.slice(start, end);
		assert.match(section, /return researchWrite\(/, `${tool} must use researchWrite`);
		assert.doesNotMatch(
			section,
			/return researchRead\(/,
			`${tool} must not use retrying researchRead`,
		);
	}
});
