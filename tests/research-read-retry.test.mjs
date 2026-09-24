import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { ResearchBoundaryError } = await import("../src/research-outbound-v2.ts");
const { RESEARCH_READ_RETRY_DELAYS_MS, shouldRetryResearchRead, withResearchReadRetry } =
	await import("../src/research-read-retry.ts");

test("research read retries transient storage failures with short backoff then succeeds", async () => {
	let attempts = 0;
	const sleeps = [];
	const result = await withResearchReadRetry(
		async () => {
			attempts += 1;
			if (attempts < 3) throw new ResearchBoundaryError("STORE_UNAVAILABLE");
			return "ok";
		},
		{ sleep: async (delayMs) => sleeps.push(delayMs) },
	);

	assert.equal(result, "ok");
	assert.equal(attempts, 3);
	assert.deepEqual(sleeps, [...RESEARCH_READ_RETRY_DELAYS_MS]);
});

test("research read retries unclassified native storage errors but preserves final failure", async () => {
	const nativeError = new Error("synthetic d1 unavailable");
	let attempts = 0;
	const sleeps = [];

	await assert.rejects(
		withResearchReadRetry(
			async () => {
				attempts += 1;
				throw nativeError;
			},
			{ delaysMs: [1, 2], sleep: async (delayMs) => sleeps.push(delayMs) },
		),
		(error) => error === nativeError,
	);
	assert.equal(attempts, 3);
	assert.deepEqual(sleeps, [1, 2]);
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
				{ sleep: async () => { sleeps += 1; } },
			),
			(thrown) => thrown === error,
		);
		assert.equal(attempts, 1, code);
		assert.equal(sleeps, 0, code);
		assert.equal(shouldRetryResearchRead(error), false, code);
	}
});

test("research write tools stay on the non-retrying researchWrite path", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /const researchWrite = researchDomain;/);

	for (const [tool, nextTool] of [
		["claim_research_job", "submit_research_result_proposal"],
		["submit_research_result_proposal", "defer_research_job"],
		["defer_research_job", "return server;"],
	]) {
		const start = source.indexOf(`\"${tool}\"`);
		const end = source.indexOf(nextTool === "return server;" ? nextTool : `\"${nextTool}\"`, start + 1);
		assert.ok(start >= 0 && end > start, `${tool} section must exist`);
		const section = source.slice(start, end);
		assert.match(section, /return researchWrite\(/, `${tool} must use researchWrite`);
		assert.doesNotMatch(section, /return researchRead\(/, `${tool} must not use retrying researchRead`);
	}
});
