export const STATE_LEDGER_READ_RETRY_DELAYS_MS = [100, 250] as const;

type Sleep = (delayMs: number) => Promise<void>;
type Random = () => number;

type StateLedgerReadRetryOptions = {
	delaysMs?: readonly number[];
	sleep?: Sleep;
	random?: Random;
};

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isRetryableStateLedgerReadStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function jitterStateLedgerReadDelay(
	baseDelayMs: number,
	random: Random = Math.random,
): number {
	const sample = Math.min(1, Math.max(0, random()));
	return Math.max(0, Math.round(baseDelayMs * (0.8 + 0.4 * sample)));
}

/**
 * Retry only side-effect-free ledger reads. Callers must never wrap POST/append
 * operations with this helper.
 */
export async function fetchStateLedgerReadWithRetry(
	operation: () => Promise<Response>,
	options: StateLedgerReadRetryOptions = {},
): Promise<Response> {
	const delaysMs = options.delaysMs ?? STATE_LEDGER_READ_RETRY_DELAYS_MS;
	const sleep = options.sleep ?? defaultSleep;
	const random = options.random ?? Math.random;

	for (let attempt = 0; ; attempt += 1) {
		let response: Response;
		try {
			response = await operation();
		} catch (error) {
			if (attempt >= delaysMs.length) throw error;
			await sleep(jitterStateLedgerReadDelay(delaysMs[attempt]!, random));
			continue;
		}

		if (
			response.ok ||
			!isRetryableStateLedgerReadStatus(response.status) ||
			attempt >= delaysMs.length
		) {
			return response;
		}

		await sleep(jitterStateLedgerReadDelay(delaysMs[attempt]!, random));
	}
}
