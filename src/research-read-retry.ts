import { ResearchBoundaryError } from "./research-outbound-v2.ts";

/**
 * PUBLIC Research replica reads are side-effect free, so a very small retry
 * budget can absorb transient D1/R2 failures without changing write-plane
 * semantics or materially extending Scheduled Task latency.
 */
export const RESEARCH_READ_RETRY_DELAYS_MS = [75, 150] as const;

type Sleep = (delayMs: number) => Promise<void>;

type ResearchReadRetryOptions = {
	delaysMs?: readonly number[];
	sleep?: Sleep;
};

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function shouldRetryResearchRead(error: unknown): boolean {
	if (error instanceof ResearchBoundaryError) {
		return error.error_code === "STORE_UNAVAILABLE" && error.retryable;
	}

	// The research boundary historically maps unclassified adapter/storage
	// exceptions to STORE_UNAVAILABLE. Retrying them here preserves that final
	// error contract while absorbing transient native D1/R2 failures.
	return true;
}

export async function withResearchReadRetry<T>(
	operation: () => Promise<T>,
	options: ResearchReadRetryOptions = {},
): Promise<T> {
	const delaysMs = options.delaysMs ?? RESEARCH_READ_RETRY_DELAYS_MS;
	const sleep = options.sleep ?? defaultSleep;

	for (let attempt = 0; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (!shouldRetryResearchRead(error) || attempt >= delaysMs.length) throw error;
			await sleep(delaysMs[attempt]!);
		}
	}
}
