import { ResearchBoundaryError } from "./research-outbound-v2.ts";

/**
 * PUBLIC Research replica reads are side-effect free, but D1 already retries
 * some failures internally. Keep the application retry budget small and only
 * spend it on errors that are positively identified as transient.
 */
export const RESEARCH_READ_RETRY_DELAYS_MS = [500, 1500] as const;

export type ResearchReadFailureClass = "TRANSIENT" | "DETERMINISTIC" | "UNKNOWN";

export type ResearchReadFailureEvent = {
	request_id: string;
	tool: string;
	stage: "research_read";
	attempt: number;
	max_attempts: number;
	will_retry: boolean;
	failure_class: ResearchReadFailureClass;
	diagnostic_code: string;
	source_error_name: string;
};

export class ResearchReadBackendError extends Error {
	readonly failure_class: ResearchReadFailureClass;
	readonly diagnostic_code: string;
	readonly source_error_name: string;

	constructor(
		failureClass: ResearchReadFailureClass,
		diagnosticCode: string,
		sourceErrorName: string,
		cause?: unknown,
	) {
		super("research read backend failure");
		this.name = "ResearchReadBackendError";
		this.failure_class = failureClass;
		this.diagnostic_code = diagnosticCode;
		this.source_error_name = sourceErrorName;
		if (cause !== undefined) {
			Object.defineProperty(this, "cause", {
				value: cause,
				enumerable: false,
				configurable: false,
				writable: false,
			});
		}
	}
}

type Sleep = (delayMs: number) => Promise<void>;

type ResearchReadRetryOptions = {
	delaysMs?: readonly number[];
	sleep?: Sleep;
	requestId?: string;
	tool?: string;
	onFailure?: (event: ResearchReadFailureEvent) => void;
};

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

const SAFE_SOURCE_ERROR_NAMES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"DOMException",
	"NetworkError",
	"AbortError",
	"D1Error",
]);

function safeErrorName(error: unknown): string {
	const candidate =
		typeof error === "object" && error !== null && "name" in error
			? String((error as { name?: unknown }).name ?? "")
			: "";
	return SAFE_SOURCE_ERROR_NAMES.has(candidate) ? candidate : "Error";
}

function directErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "message" in error) {
		return String((error as { message?: unknown }).message ?? "");
	}
	return "";
}

function errorMessage(error: unknown): string {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current != null; depth += 1) {
		const message = directErrorMessage(current).trim();
		if (message) messages.push(message);
		current =
			typeof current === "object" && current !== null && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return messages.join("\n").slice(0, 2048);
}

export function classifyResearchReadBackendError(error: unknown): ResearchReadBackendError {
	if (error instanceof ResearchReadBackendError) return error;

	const message = errorMessage(error);
	const sourceErrorName = safeErrorName(error);

	if (
		/no such (?:table|column)|syntax error|malformed database schema|invalid sql|sql logic error|misuse of|binding.*(?:missing|not found|undefined)|not configured/i.test(
			message,
		)
	) {
		return new ResearchReadBackendError(
			"DETERMINISTIC",
			"DETERMINISTIC_BACKEND_QUERY_OR_CONFIG",
			sourceErrorName,
			error,
		);
	}

	if (
		/(?:network|socket|fetch).*(?:fail|lost|reset|closed)|connection.*(?:fail|lost|reset|closed)|(?:timed?\s*out|timeout)|temporar(?:y|ily)|service unavailable|database is (?:locked|busy)|reset by peer/i.test(
			message,
		)
	) {
		return new ResearchReadBackendError(
			"TRANSIENT",
			"TRANSIENT_BACKEND_IO",
			sourceErrorName,
			error,
		);
	}

	return new ResearchReadBackendError(
		"UNKNOWN",
		"UNKNOWN_BACKEND_READ_ERROR",
		sourceErrorName,
		error,
	);
}

function failureMetadata(error: unknown): {
	failureClass: ResearchReadFailureClass;
	diagnosticCode: string;
	sourceErrorName: string;
} {
	if (error instanceof ResearchBoundaryError) {
		return {
			failureClass:
				error.error_code === "STORE_UNAVAILABLE" && error.retryable
					? "TRANSIENT"
					: "DETERMINISTIC",
			diagnosticCode: "BOUNDARY_" + error.error_code,
			sourceErrorName: error.name,
		};
	}
	const backend = classifyResearchReadBackendError(error);
	return {
		failureClass: backend.failure_class,
		diagnosticCode: backend.diagnostic_code,
		sourceErrorName: backend.source_error_name,
	};
}

export function shouldRetryResearchRead(error: unknown): boolean {
	if (error instanceof ResearchBoundaryError) {
		return error.error_code === "STORE_UNAVAILABLE" && error.retryable;
	}
	return classifyResearchReadBackendError(error).failure_class === "TRANSIENT";
}

export async function withResearchReadRetry<T>(
	operation: () => Promise<T>,
	options: ResearchReadRetryOptions = {},
): Promise<T> {
	const delaysMs = options.delaysMs ?? RESEARCH_READ_RETRY_DELAYS_MS;
	const sleep = options.sleep ?? defaultSleep;
	const requestId = options.requestId ?? crypto.randomUUID().replaceAll("-", "");
	const tool = options.tool ?? "research_read";
	const maxAttempts = delaysMs.length + 1;

	for (let attemptIndex = 0; ; attemptIndex += 1) {
		try {
			return await operation();
		} catch (error) {
			const retryable = shouldRetryResearchRead(error);
			const willRetry = retryable && attemptIndex < delaysMs.length;
			const metadata = failureMetadata(error);
			options.onFailure?.({
				request_id: requestId,
				tool,
				stage: "research_read",
				attempt: attemptIndex + 1,
				max_attempts: maxAttempts,
				will_retry: willRetry,
				failure_class: metadata.failureClass,
				diagnostic_code: metadata.diagnosticCode,
				source_error_name: metadata.sourceErrorName,
			});

			if (willRetry) {
				await sleep(delaysMs[attemptIndex]!);
				continue;
			}

			if (error instanceof ResearchBoundaryError) {
				if (error.error_code === "STORE_UNAVAILABLE") {
					throw new ResearchBoundaryError("STORE_UNAVAILABLE", requestId, {
						retryable: error.retryable,
						safeMessage: error.safe_message,
					});
				}
				throw error;
			}

			const backend = classifyResearchReadBackendError(error);
			throw new ResearchBoundaryError("STORE_UNAVAILABLE", requestId, {
				retryable: backend.failure_class === "TRANSIENT",
				safeMessage:
					backend.failure_class === "TRANSIENT"
						? "research read backend unavailable; retry later"
						: "research read backend failed; retry is not advised",
			});
		}
	}
}
