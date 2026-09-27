import assert from "node:assert/strict";
import test from "node:test";

import {
	fetchStateLedgerReadWithRetry,
	isRetryableStateLedgerReadStatus,
	jitterStateLedgerReadDelay,
	STATE_LEDGER_READ_RETRY_DELAYS_MS,
} from "../src/state-ledger-read-retry.ts";

test("state ledger read retry absorbs transient network failures with bounded backoff", async () => {
	let attempts = 0;
	const sleeps = [];
	const response = await fetchStateLedgerReadWithRetry(
		async () => {
			attempts += 1;
			if (attempts < 3) throw new Error("temporary network failure");
			return new Response("ok", { status: 200 });
		},
		{
			sleep: async (delayMs) => sleeps.push(delayMs),
			random: () => 0.5,
		},
	);

	assert.equal(response.status, 200);
	assert.equal(attempts, 3);
	assert.deepEqual(sleeps, [...STATE_LEDGER_READ_RETRY_DELAYS_MS]);
});

test("state ledger read retry handles 429 and 5xx, then succeeds", async () => {
	const statuses = [429, 503, 200];
	const sleeps = [];
	const response = await fetchStateLedgerReadWithRetry(
		async () => new Response("x", { status: statuses.shift() }),
		{
			sleep: async (delayMs) => sleeps.push(delayMs),
			random: () => 0.5,
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(sleeps, [...STATE_LEDGER_READ_RETRY_DELAYS_MS]);
});

test("state ledger read retry never retries auth or ordinary client errors", async () => {
	for (const status of [400, 401, 403, 404, 409, 422]) {
		let attempts = 0;
		let sleeps = 0;
		const response = await fetchStateLedgerReadWithRetry(
			async () => {
				attempts += 1;
				return new Response("x", { status });
			},
			{
				sleep: async () => {
					sleeps += 1;
				},
			},
		);
		assert.equal(response.status, status);
		assert.equal(attempts, 1, String(status));
		assert.equal(sleeps, 0, String(status));
		assert.equal(isRetryableStateLedgerReadStatus(status), false, String(status));
	}
});

test("state ledger read retry returns final retryable HTTP response after its short budget", async () => {
	let attempts = 0;
	const response = await fetchStateLedgerReadWithRetry(
		async () => {
			attempts += 1;
			return new Response("busy", { status: 503 });
		},
		{ delaysMs: [1, 2], sleep: async () => {}, random: () => 0.5 },
	);
	assert.equal(response.status, 503);
	assert.equal(attempts, 3);
});

test("state ledger retry jitter stays within plus or minus twenty percent", () => {
	assert.equal(
		jitterStateLedgerReadDelay(100, () => 0),
		80,
	);
	assert.equal(
		jitterStateLedgerReadDelay(100, () => 0.5),
		100,
	);
	assert.equal(
		jitterStateLedgerReadDelay(100, () => 1),
		120,
	);
	assert.equal(isRetryableStateLedgerReadStatus(408), true);
	assert.equal(isRetryableStateLedgerReadStatus(425), true);
	assert.equal(isRetryableStateLedgerReadStatus(429), true);
	assert.equal(isRetryableStateLedgerReadStatus(500), true);
	assert.equal(isRetryableStateLedgerReadStatus(599), true);
	assert.equal(isRetryableStateLedgerReadStatus(600), false);
});
