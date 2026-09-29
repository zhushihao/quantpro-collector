/**
 * Consumer-side contract for the immutable RIWS `collector-outbound-v2` and
 * `collector-outbound-v3` streams.  This module intentionally owns validation
 * only: it has no access to Research SQLite, local paths, LIVE, QMT, or any
 * write-plane operation.
 *
 * v3 = v2 + two frozen increments (2026-09-15 research-backend design §5.1):
 *   1. record_type "source_health" (ten-field exact whitelist, record key =
 *      source_id, latest-state projection, no float fields);
 *   2. job payload gains "trigger_evidence_ids" (string array).
 * v2 keeps its original byte-frozen semantics inside the compatibility
 * window; a v2 envelope carrying source_health is UNSUPPORTED_OPERATION, and
 * the v2 job key set rejects trigger_evidence_ids via exact-keys.
 * The module file name is kept for history; the version is a constant.
 */

export const OUTBOUND_V2_SCHEMA_VERSION = "collector-outbound-v2";
export const OUTBOUND_V3_SCHEMA_VERSION = "collector-outbound-v3";
export const OUTBOUND_V4_SCHEMA_VERSION = "collector-outbound-v4";
/** Independently versioned numeric price-signal record; not an Evidence stream. */
export const MARKET_SIGNAL_SCHEMA_VERSION = "collector-market-signal-v1";

/** Ingest compatibility window: both generations are accepted (§5.1). */
export const ACCEPTED_OUTBOUND_SCHEMA_VERSIONS = new Set([
	OUTBOUND_V2_SCHEMA_VERSION,
	OUTBOUND_V3_SCHEMA_VERSION,
	OUTBOUND_V4_SCHEMA_VERSION,
	MARKET_SIGNAL_SCHEMA_VERSION,
]);

/** Producer-side current schema version (RESEARCH outbound.py mirrors this). */
export const OUTBOUND_SCHEMA_VERSION = OUTBOUND_V4_SCHEMA_VERSION;

const RECORD_TYPES = new Set([
	"source",
	"document_version",
	"evidence",
	"coverage",
	"accumulator",
	"job",
	"object",
]);
const MARKET_SIGNAL_RECORD_TYPE = "market_signal";

/** v3-only record type (§A6). Bucketed per schema version in validate. */
const V3_RECORD_TYPES = new Set(["source_health"]);

const SOURCE_HEALTH_OUTCOMES = new Set([
	"OK",
	"NO_NEW_CONTENT",
	"PARTIAL",
	"BLOCKED",
	"AUTH_REQUIRED",
	"RATE_LIMITED",
	"UNAVAILABLE",
	"UNSUPPORTED",
]);

const SOURCE_HEALTH_FAILURE_CLASSES = new Set([
	"HTTP_401",
	"HTTP_403",
	"HTTP_429",
	"CAPTCHA",
	"LOGIN_EXPIRED",
	"ROBOTS_TOS",
	"TLS",
	"TIMEOUT",
	"DNS",
	"CONNECT",
	"HTTP_5XX",
	"HTTP_404_ROUTE_MISSING",
	"UNSUPPORTED_MEDIA",
	"TRUNCATED",
]);
const VISIBILITIES = new Set(["PUBLIC", "PRIVATE"]);
const ERROR_CODES = new Set([
	"NOT_FOUND",
	"FILTERED",
	"STORE_UNAVAILABLE",
	"INTEGRITY_FAILED",
	"UNSUPPORTED_OPERATION",
	"RATE_LIMITED",
]);
const SAFE_MESSAGES: Record<string, string> = {
	NOT_FOUND: "requested record was not found",
	FILTERED: "request filtered by visibility or validation policy",
	STORE_UNAVAILABLE: "local store is temporarily unavailable",
	INTEGRITY_FAILED: "integrity verification failed",
	UNSUPPORTED_OPERATION: "operation is not supported by this boundary",
	RATE_LIMITED: "rate limited; retry later",
	// SDD CQ spec §5: a quota refusal must not promise a UTC-day reset.  The paid
	// allowance follows the account's subscription period and re-opening it needs
	// an operator-verified baseline, so no automated recovery instant is offered.
	QUOTA_CIRCUIT_OPEN:
		"platform usage budget circuit is open; heavy work is paused until an operator verifies the account baseline",
	QUOTA_GUARD_UNAVAILABLE:
		"usage guard cannot prove a safe upper bound; heavy work is paused until the guard is available",
};
const HIDDEN_KEYS = new Set([
	"object_key",
	"path",
	"absolute_path",
	"local_path",
	"file_path",
	"text",
	"excerpt",
	"raw_content",
	"content",
	"token",
	"access_token",
	"refresh_token",
	"cookie",
	"set-cookie",
	"authorization",
	"chatgpt_identity",
	"lease_owner_hash",
]);
const RESPONSE_HEADERS = new Set(["content-type", "etag", "last-modified", "content-length"]);
const ENVELOPE_KEYS = [
	"record_type",
	"message_id",
	"schema_version",
	"policy_version",
	"visibility",
	"payload",
	"generated_at",
];

const SOURCE_HEALTH_KEYS = [
	// §A6 ten-field whitelist (review-passed): transport-level provider health
	// only. No detail/metadata_json opaque strings, no float fields, record
	// key = source_id (latest-state projection; re-send overwrites).
	"source_id",
	"provider",
	"checked_at",
	"reachable",
	"outcome",
	"failure_class",
	"consecutive_failures",
	"last_success_at",
	"last_error_code",
	"visibility",
];

/** v2 job payload (frozen; exact-keys rejects trigger_evidence_ids here). */
const JOB_V2_KEYS = [
	"job_id",
	"dedupe_key",
	"status",
	"priority",
	"theme",
	"company",
	"question",
	"missing_dimensions_json",
	"counter_evidence_request",
	"accumulator_snapshot_id",
	"coverage_gap_json",
	"priority_reason",
	"deadline",
	"recheck_at",
	"budget_hint",
	"historical_backfill",
	"created_at",
	"updated_at",
	"policy_version",
	"visibility",
];

/** v3 job payload adds structured trigger evidence ids (§5.1 increment 2). */
const JOB_V3_KEYS = [...JOB_V2_KEYS, "trigger_evidence_ids"];

const PAYLOAD_KEYS: Record<string, readonly string[]> = {
	source: [
		"source_id",
		"name",
		"provider",
		"source_kind",
		"canonical_base",
		"visibility",
		"lifecycle",
		"check_frequency_seconds",
		"policy_version",
		"last_health_at",
	],
	coverage: [
		"coverage_id",
		"source_id",
		"subject",
		"metric_type",
		"rule_key",
		"status",
		"alternative_coverage_id",
		"next_check_at",
		"visibility",
		"updated_at",
	],
	accumulator: [
		"snapshot_id",
		"subject_key",
		"evidence_ids",
		"total_weight",
		"dimensions",
		"independent_cluster_count",
		"unknown_cluster_count",
		"conflict_count",
		"last_evidence_at",
		"rule_version",
		"status",
		"created_at",
		"visibility",
	],
	job: JOB_V3_KEYS,
	object: [
		"object_id",
		"content_sha256",
		"media_type",
		"byte_size",
		"visibility",
		"encoding",
		"chunking",
		"manifest_message_id",
	],
};
const DOCUMENT_KEYS = [
	"document_id",
	"source_id",
	"source_identity_key",
	"canonical_locator",
	"origin_locator",
	"first_seen_at",
	"title",
	"source_kind",
	"visibility",
	"historical_backfill",
];
const VERSION_KEYS = [
	"version_id",
	"document_id",
	"version_number",
	"content_sha256",
	"byte_size",
	"media_type",
	"ingested_at",
	"published_at",
	"event_time",
	"source_updated_at",
	"response_headers",
	"revision_kind",
	"corrects_version_id",
	"historical_backfill",
	// `readable` is producer-declared metadata.  The read plane never consumes
	// it as stored: it recomputes the effective value via isVersionServable
	// (WITHDRAWAL excluded; whitelisted own media_type OR a FETCHED
	// text_extraction projection) and only overrides the presented view,
	// leaving the stored payload_json byte-for-byte untouched.  See the
	// header comment of research-remote-adapter.ts for the full formula.
	"readable",
];
const ATTACHMENT_KEYS = [
	// Contract note (SPEC-C8 §3.4): `role` is a free-form string, but the only
	// role the read plane consumes today is the RESEARCH text-extraction
	// projection: role = "text_extraction", attachment_locator =
	// "urn:riws:text-extraction:<version_id>", attachment_status = "FETCHED",
	// media_type "text/plain" (inside the servable whitelist).  No extra or
	// restricted keys exist for it; this stays a comment-only contract point.

	"attachment_id",
	"attachment_locator",
	"content_sha256",
	"byte_size",
	"media_type",
	"display_name",
	"role",
	"attachment_status",
	"outcome",
	"failure_class",
];
const EVIDENCE_KEYS = [
	"evidence_id",
	"claim_id",
	"evidence_type",
	"direction",
	"fact_root_id",
	"independence_cluster_id",
	"duplicate_of_evidence_id",
	"source_id",
	"theme",
	"company",
	"confidence",
	"visibility",
	"decay_policy",
	"validity",
	"created_at",
	"policy_version",
	"independence_status",
	"historical_backfill",
	"claim",
];
const MARKET_SIGNAL_KEYS = [
	"subject_key", "as_of", "status", "benchmark_mapping_version", "mapping_id",
	"primary_benchmark", "secondary_benchmark", "source", "quality", "returns",
	"relative_strength", "volume_price_structure", "continuous_market_structure", "visibility",
];
const MARKET_SIGNAL_SOURCE_KEYS = ["provider", "snapshot_hash", "snapshot_as_of"];
const MARKET_SIGNAL_QUALITY_KEYS = ["valid_trading_days", "required_trading_days", "future_rows_dropped", "missing_sessions"];
const MARKET_SIGNAL_RETURN_KEYS = ["window_complete", "valid_trading_days", "subject_return", "primary_benchmark_return", "secondary_benchmark_return"];
const MARKET_SIGNAL_RELATIVE_KEYS = ["primary_pct_points", "secondary_pct_points"];
const MARKET_SIGNAL_VOLUME_KEYS = ["up_volume_ratio_5d", "pullback_volume_ratio_5d", "volume_up", "pullback_volume_contraction"];
const MARKET_SIGNAL_CONTINUOUS_KEYS = ["required_sessions", "observed_sessions", "relative_positive_sessions", "status"];
const MARKET_SIGNAL_STATUSES = new Set(["READY", "INSUFFICIENT_HISTORY", "NO_VALID_BENCHMARK", "QUALITY_FAILED"]);
const EVIDENCE_V4_KEYS = [
	...EVIDENCE_KEYS,
	"source_reference",
	"event_time",
	"published_at",
	"first_seen_at",
	"ingested_at",
];
const SOURCE_REFERENCE_KEYS = [
	"document_id",
	"document_version_id",
	"attachment_id",
	"content_sha256",
	"byte_start",
	"byte_end",
	"span_sha256",
];
const CLAIM_KEYS = [
	"subject",
	"predicate",
	"value",
	"unit",
	"scope",
	"methodology",
	"event_time",
	"extraction_method",
	"extraction_confidence",
	"source_span_hash",
];

export type ResearchErrorCode = keyof typeof SAFE_MESSAGES;
export type ResearchError = {
	error_code: ResearchErrorCode;
	safe_message: string;
	retryable: boolean;
	request_id: string;
};
export type OutboundV2Record = {
	record_type: string;
	message_id: string;
	schema_version: string;
	policy_version: string;
	visibility: "PUBLIC" | "PRIVATE";
	payload: Record<string, unknown>;
	generated_at: string | null;
};

export class ResearchBoundaryError extends Error implements ResearchError {
	readonly error_code: ResearchErrorCode;
	readonly safe_message: string;
	readonly retryable: boolean;
	readonly request_id: string;

	constructor(
		errorCode: ResearchErrorCode,
		requestId = crypto.randomUUID().replaceAll("-", ""),
		options: { retryable?: boolean; safeMessage?: string } = {},
	) {
		const safeMessage = options.safeMessage ?? SAFE_MESSAGES[errorCode];
		super(safeMessage);
		this.name = "ResearchBoundaryError";
		this.error_code = errorCode;
		this.safe_message = safeMessage;
		this.retryable =
			options.retryable ?? (errorCode === "STORE_UNAVAILABLE" || errorCode === "RATE_LIMITED");
		this.request_id = requestId;
	}

	asError(): ResearchError {
		return {
			error_code: this.error_code,
			safe_message: this.safe_message,
			retryable: this.retryable,
			request_id: this.request_id,
		};
	}
}

function fail(errorCode: ResearchErrorCode): never {
	throw new ResearchBoundaryError(errorCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
	const keys = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (
		keys.length !== sortedExpected.length ||
		keys.some((key, index) => key !== sortedExpected[index])
	) {
		fail("INTEGRITY_FAILED");
	}
}

function stringField(value: unknown): string {
	if (typeof value !== "string" || !value) fail("INTEGRITY_FAILED");
	return value;
}

function visibilityField(value: unknown): "PUBLIC" | "PRIVATE" {
	if (typeof value !== "string" || !VISIBILITIES.has(value)) fail("FILTERED");
	return value as "PUBLIC" | "PRIVATE";
}

function hexField(value: unknown): string {
	const text = stringField(value);
	if (!/^[0-9a-f]{64}$/.test(text)) fail("INTEGRITY_FAILED");
	return text;
}

function nullableIsoField(value: unknown): void {
	if (value === null) return;
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail("INTEGRITY_FAILED");
}

/** Reject a payload that would expose hidden body, credentials, or local paths. */
export function assertOutboundV2PayloadSafe(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) assertOutboundV2PayloadSafe(item);
		return;
	}
	if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			const normalized = key.toLowerCase();
			if (HIDDEN_KEYS.has(normalized)) fail("INTEGRITY_FAILED");
			if (normalized === "response_headers" && isRecord(item)) {
				for (const header of Object.keys(item)) {
					if (!RESPONSE_HEADERS.has(header.toLowerCase())) fail("INTEGRITY_FAILED");
				}
			}
			assertOutboundV2PayloadSafe(item);
		}
		return;
	}
	if (
		typeof value === "string" &&
		(/^[A-Za-z]:[\\/]/.test(value) || value.includes("/home/") || value.includes("/Users/"))
	) {
		fail("INTEGRITY_FAILED");
	}
}

export function assertResearchVisibility(value: unknown): "PUBLIC" | "PRIVATE" {
	return visibilityField(value);
}

/**
 * The producer is Python.  Its typed float fields preserve a trailing `.0`
 * (for example, `extraction_confidence: 1.0`) in the canonical material used
 * to derive a message id.  JSON.parse loses that distinction, so restore it
 * only for the float fields defined by outbound-v2.
 */
const PYTHON_FLOAT_PATHS = new Set([
	"confidence",
	"claim.extraction_confidence",
	"total_weight",
	// collector-market-signal-v1 is generated by Python.  JSON.parse erases
	// the 0.0/1.0 spelling, so every typed floating-price field is listed
	// explicitly.  Integer quality/session counters are intentionally absent.
	...(["1D", "3D", "5D", "10D"] as const).flatMap((window) => [
		`returns.${window}.subject_return`,
		`returns.${window}.primary_benchmark_return`,
		`returns.${window}.secondary_benchmark_return`,
		`relative_strength.primary_pct_points.${window}`,
		`relative_strength.secondary_pct_points.${window}`,
	]),
	"volume_price_structure.up_volume_ratio_5d",
	"volume_price_structure.pullback_volume_ratio_5d",
]);

/**
 * Match CPython's JSON spelling for the explicitly typed Python float paths.
 *
 * Both runtimes use shortest-roundtrip digits, but their presentation rules
 * differ: Python keeps ``.0`` on integral floats and switches to scientific
 * notation when the decimal exponent is below -4 or at least 16.  JavaScript
 * drops ``.0`` and keeps values such as 1e-5 in fixed notation.  Since the
 * spelling participates in the immutable message id, the consumer restores
 * Python's representation only on this closed path whitelist.
 */
function pythonFloatJson(value: number): string {
	if (Object.is(value, -0)) return "-0.0";
	const absolute = Math.abs(value);
	if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e16)) {
		const [mantissa, rawExponent] = value.toExponential().split("e");
		const exponent = Number(rawExponent);
		const sign = exponent < 0 ? "-" : "+";
		return `${mantissa}e${sign}${Math.abs(exponent).toString().padStart(2, "0")}`;
	}
	if (Number.isInteger(value)) return `${value}.0`;
	return JSON.stringify(value);
}

function canonicalJson(value: unknown, path: readonly string[] = []): string {
	if (Array.isArray(value))
		return `[${value.map((item) => canonicalJson(item, path)).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], [...path, key])}`)
			.join(",")}}`;
	}
	if (typeof value === "number" && PYTHON_FLOAT_PATHS.has(path.join("."))) {
		return pythonFloatJson(value);
	}
	return JSON.stringify(value);
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function outboundV2RecordKey(record: OutboundV2Record): string {
	const payload = record.payload;
	switch (record.record_type) {
		case "object":
			return hexField(payload.content_sha256);
		case "source":
			return stringField(payload.source_id);
		case "document_version":
			return stringField((payload.version as Record<string, unknown>)?.version_id);
		case "evidence":
			return stringField(payload.evidence_id);
		case "coverage":
			return stringField(payload.coverage_id);
		case "accumulator":
			return stringField(payload.snapshot_id);
		case "job":
			return stringField(payload.job_id);
		case "source_health":
			return stringField(payload.source_id);
		case MARKET_SIGNAL_RECORD_TYPE:
			return stringField(payload.subject_key);
		default:
			return fail("UNSUPPORTED_OPERATION");
	}
}

export async function computeOutboundV2MessageId(record: OutboundV2Record): Promise<string> {
	const material =
		record.record_type === "object"
			? Object.fromEntries(
					Object.entries(record.payload).filter(([key]) => key !== "manifest_message_id"),
				)
			: record.payload;
	const input = [
		record.schema_version,
		record.record_type,
		outboundV2RecordKey(record),
		canonicalJson(material),
	].join("\x1f");
	return `outbound_${(await sha256Hex(input)).slice(0, 40)}`;
}

/**
 * §A6 source_health payload: ten-field exact whitelist, closed-set enums,
 * and a hard no-float rule (canonical JSON `.0` path-table maintenance stays
 * out of scope for this record type by design).
 */
function validateSourceHealthPayload(payload: Record<string, unknown>): void {
	exactKeys(payload, SOURCE_HEALTH_KEYS);
	stringField(payload.source_id);
	stringField(payload.provider);
	stringField(payload.checked_at);
	if (typeof payload.reachable !== "boolean") fail("INTEGRITY_FAILED");
	if (typeof payload.outcome !== "string" || !SOURCE_HEALTH_OUTCOMES.has(payload.outcome)) {
		fail("INTEGRITY_FAILED");
	}
	if (
		payload.failure_class !== null &&
		(typeof payload.failure_class !== "string" ||
			!SOURCE_HEALTH_FAILURE_CLASSES.has(payload.failure_class))
	) {
		fail("INTEGRITY_FAILED");
	}
	if (
		typeof payload.consecutive_failures !== "number" ||
		!Number.isInteger(payload.consecutive_failures) ||
		payload.consecutive_failures < 0
	) {
		fail("INTEGRITY_FAILED");
	}
	if (payload.last_success_at !== null && typeof payload.last_success_at !== "string") {
		fail("INTEGRITY_FAILED");
	}
	if (
		payload.last_error_code !== null &&
		(typeof payload.last_error_code !== "string" || !payload.last_error_code)
	) {
		fail("INTEGRITY_FAILED");
	}
}

function finiteOrNull(value: unknown): void {
	if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) fail("INTEGRITY_FAILED");
}

/** Closed schema for numeric R3/R4 inputs. It contains no Evidence/R1/R2 fields. */
function validateMarketSignalPayload(payload: Record<string, unknown>): void {
	exactKeys(payload, MARKET_SIGNAL_KEYS);
	stringField(payload.subject_key);
	if (!String(payload.subject_key).startsWith("market:")) fail("INTEGRITY_FAILED");
	if (payload.as_of !== null && (typeof payload.as_of !== "string" || Number.isNaN(Date.parse(payload.as_of)))) fail("INTEGRITY_FAILED");
	if (typeof payload.status !== "string" || !MARKET_SIGNAL_STATUSES.has(payload.status)) fail("INTEGRITY_FAILED");
	for (const key of ["benchmark_mapping_version", "mapping_id", "primary_benchmark", "secondary_benchmark"]) if (payload[key] !== null && typeof payload[key] !== "string") fail("INTEGRITY_FAILED");
	if (!isRecord(payload.source) || !isRecord(payload.quality) || !isRecord(payload.returns) || !isRecord(payload.relative_strength) || !isRecord(payload.volume_price_structure) || !isRecord(payload.continuous_market_structure)) fail("INTEGRITY_FAILED");
	exactKeys(payload.source, MARKET_SIGNAL_SOURCE_KEYS);
	exactKeys(payload.quality, MARKET_SIGNAL_QUALITY_KEYS);
	exactKeys(payload.relative_strength, MARKET_SIGNAL_RELATIVE_KEYS);
	exactKeys(payload.volume_price_structure, MARKET_SIGNAL_VOLUME_KEYS);
	exactKeys(payload.continuous_market_structure, MARKET_SIGNAL_CONTINUOUS_KEYS);
	if (typeof payload.source.provider !== "string") fail("INTEGRITY_FAILED");
	for (const key of ["snapshot_hash", "snapshot_as_of"]) if (payload.source[key] !== null && typeof payload.source[key] !== "string") fail("INTEGRITY_FAILED");
	for (const key of MARKET_SIGNAL_QUALITY_KEYS) if (typeof payload.quality[key] !== "number" || !Number.isInteger(payload.quality[key]) || payload.quality[key] < 0) fail("INTEGRITY_FAILED");
	const relative = payload.relative_strength as Record<string, Record<string, unknown>>;
	if (!isRecord(relative.primary_pct_points) || !isRecord(relative.secondary_pct_points)) {
		fail("INTEGRITY_FAILED");
	}
	const legacyNoBenchmark = payload.status === "NO_VALID_BENCHMARK";
	for (const window of ["1D", "3D", "5D", "10D"]) {
		const value = payload.returns[window];
		if (!isRecord(value)) fail("INTEGRITY_FAILED");
		exactKeys(value, MARKET_SIGNAL_RETURN_KEYS);
		if (typeof value.window_complete !== "boolean" || typeof value.valid_trading_days !== "number" || !Number.isInteger(value.valid_trading_days) || value.valid_trading_days < 0) fail("INTEGRITY_FAILED");
		for (const key of ["subject_return", "primary_benchmark_return", "secondary_benchmark_return"]) finiteOrNull(value[key]);
		const primaryRelative = relative.primary_pct_points[window];
		const secondaryRelative = relative.secondary_pct_points[window];
		// Early v1 NO_VALID_BENCHMARK records used empty relative maps.  The
		// current producer emits explicit nulls for all four windows, but those
		// historical immutable messages remain semantically equivalent.  Keep
		// this compatibility limited to the no-benchmark downgrade state.
		if (!(legacyNoBenchmark && primaryRelative === undefined)) finiteOrNull(primaryRelative);
		if (!(legacyNoBenchmark && secondaryRelative === undefined)) finiteOrNull(secondaryRelative);
	}
	for (const key of ["up_volume_ratio_5d", "pullback_volume_ratio_5d"]) finiteOrNull(payload.volume_price_structure[key]);
	for (const key of ["volume_up", "pullback_volume_contraction"]) if (payload.volume_price_structure[key] !== null && typeof payload.volume_price_structure[key] !== "boolean") fail("INTEGRITY_FAILED");
	for (const key of ["required_sessions", "observed_sessions", "relative_positive_sessions"]) if (typeof payload.continuous_market_structure[key] !== "number" || !Number.isInteger(payload.continuous_market_structure[key]) || payload.continuous_market_structure[key] < 0) fail("INTEGRITY_FAILED");
	if (!["CONFIRMED", "NOT_CONFIRMED", "INSUFFICIENT_HISTORY"].includes(String(payload.continuous_market_structure.status))) fail("INTEGRITY_FAILED");
}

function validateNestedPayload(record: OutboundV2Record): void {
	const payload = record.payload;
	if (record.record_type === "document_version") {
		exactKeys(payload, ["document", "version", "attachments"]);
		if (
			!isRecord(payload.document) ||
			!isRecord(payload.version) ||
			!Array.isArray(payload.attachments)
		) {
			fail("INTEGRITY_FAILED");
		}
		exactKeys(payload.document, DOCUMENT_KEYS);
		exactKeys(payload.version, VERSION_KEYS);
		for (const attachment of payload.attachments) {
			if (!isRecord(attachment)) fail("INTEGRITY_FAILED");
			exactKeys(attachment, ATTACHMENT_KEYS);
		}
		if (visibilityField(payload.document.visibility) !== record.visibility) fail("FILTERED");
		return;
	}
	if (record.record_type === "evidence") {
		const v4 = record.schema_version === OUTBOUND_V4_SCHEMA_VERSION;
		exactKeys(payload, v4 ? EVIDENCE_V4_KEYS : EVIDENCE_KEYS);
		if (!isRecord(payload.claim)) fail("INTEGRITY_FAILED");
		exactKeys(payload.claim, CLAIM_KEYS);
		if (v4) {
			if (!isRecord(payload.source_reference)) fail("INTEGRITY_FAILED");
			const reference = payload.source_reference;
			exactKeys(reference, SOURCE_REFERENCE_KEYS);
			stringField(reference.document_id);
			stringField(reference.document_version_id);
			if (reference.attachment_id !== null && typeof reference.attachment_id !== "string")
				fail("INTEGRITY_FAILED");
			hexField(reference.content_sha256);
			if (
				typeof reference.byte_start !== "number" ||
				typeof reference.byte_end !== "number" ||
				!Number.isInteger(reference.byte_start) ||
				!Number.isInteger(reference.byte_end) ||
				reference.byte_start < 0 ||
				reference.byte_end <= reference.byte_start
			)
				fail("INTEGRITY_FAILED");
			hexField(reference.span_sha256);
			nullableIsoField(payload.event_time);
			nullableIsoField(payload.published_at);
			nullableIsoField(payload.first_seen_at);
			nullableIsoField(payload.ingested_at);
		}
	}
	if (record.record_type === "accumulator") {
		exactKeys(payload, PAYLOAD_KEYS.accumulator);
		if (!isRecord(payload.dimensions)) fail("INTEGRITY_FAILED");
		exactKeys(payload.dimensions, ["D", "S", "M", "E", "P", "C"]);
	}
	if (record.record_type === "job") {
		// Version-bucketed exact-keys: v2 jobs stay byte-frozen without
		// trigger_evidence_ids; only v3 jobs may carry it (§5.1).
		exactKeys(payload, record.schema_version === OUTBOUND_V2_SCHEMA_VERSION ? JOB_V2_KEYS : JOB_V3_KEYS);
		if (payload.status !== "QUEUED") fail("FILTERED");
		if (record.schema_version !== OUTBOUND_V2_SCHEMA_VERSION) {
			const triggerEvidenceIds = payload.trigger_evidence_ids;
			if (!Array.isArray(triggerEvidenceIds)) fail("INTEGRITY_FAILED");
			for (const id of triggerEvidenceIds) {
				if (typeof id !== "string" || !id) fail("INTEGRITY_FAILED");
			}
		}
	}
	if (record.record_type === "source_health") {
		validateSourceHealthPayload(payload);
	}
	if (record.record_type === MARKET_SIGNAL_RECORD_TYPE) validateMarketSignalPayload(payload);
	if (record.record_type === "object") {
		exactKeys(payload, PAYLOAD_KEYS.object);
		if (payload.object_id !== payload.content_sha256 || payload.encoding !== "identity") {
			fail("INTEGRITY_FAILED");
		}
		if (!isRecord(payload.chunking)) fail("INTEGRITY_FAILED");
		exactKeys(payload.chunking, ["chunked", "chunk_size", "total_chunks", "chunk_sha256"]);
		if (!Array.isArray(payload.chunking.chunk_sha256)) fail("INTEGRITY_FAILED");
		if (payload.chunking.total_chunks !== payload.chunking.chunk_sha256.length)
			fail("INTEGRITY_FAILED");
		if (payload.manifest_message_id !== record.message_id) fail("INTEGRITY_FAILED");
	}
	if (
		record.record_type in PAYLOAD_KEYS &&
		record.record_type !== "accumulator" &&
		record.record_type !== "job" &&
		record.record_type !== "object"
	) {
		exactKeys(payload, PAYLOAD_KEYS[record.record_type]);
	}
	if (
		record.record_type !== "document_version" &&
		visibilityField(payload.visibility) !== record.visibility
	) {
		fail("FILTERED");
	}
}

export function validateOutboundV2Record(value: unknown): OutboundV2Record {
	if (!isRecord(value)) fail("INTEGRITY_FAILED");
	exactKeys(value, ENVELOPE_KEYS);
	// Compatibility window (§5.1): accept both frozen generations.
	if (
		typeof value.schema_version !== "string" ||
		!ACCEPTED_OUTBOUND_SCHEMA_VERSIONS.has(value.schema_version)
	) {
		fail("UNSUPPORTED_OPERATION");
	}
	const schemaVersion = value.schema_version;
	// Record types are bucketed per schema version: source_health is v3-only,
	// so a v2 envelope carrying it is rejected as UNSUPPORTED_OPERATION.
	const recordTypeAllowed =
		typeof value.record_type === "string" &&
		(RECORD_TYPES.has(value.record_type) ||
			(schemaVersion !== OUTBOUND_V2_SCHEMA_VERSION && V3_RECORD_TYPES.has(value.record_type)));
	const marketSignalAllowed = schemaVersion === MARKET_SIGNAL_SCHEMA_VERSION && value.record_type === MARKET_SIGNAL_RECORD_TYPE;
	if (!recordTypeAllowed && !marketSignalAllowed) fail("UNSUPPORTED_OPERATION");
	if (!/^outbound_[0-9a-f]{40}$/.test(stringField(value.message_id))) fail("INTEGRITY_FAILED");
	stringField(value.policy_version);
	if (value.generated_at !== null && typeof value.generated_at !== "string")
		fail("INTEGRITY_FAILED");
	if (!isRecord(value.payload)) fail("INTEGRITY_FAILED");
	const record: OutboundV2Record = {
		record_type: stringField(value.record_type),
		message_id: stringField(value.message_id),
		schema_version: schemaVersion,
		policy_version: stringField(value.policy_version),
		visibility: visibilityField(value.visibility),
		payload: value.payload,
		generated_at: value.generated_at,
	};
	assertOutboundV2PayloadSafe(record.payload);
	validateNestedPayload(record);
	return record;
}

export async function verifyOutboundV2Record(value: unknown): Promise<OutboundV2Record> {
	const record = validateOutboundV2Record(value);
	if ((await computeOutboundV2MessageId(record)) !== record.message_id) fail("INTEGRITY_FAILED");
	return record;
}

export async function verifyOutboundV2ObjectChunks(
	value: unknown,
	chunks: Iterable<Uint8Array>,
): Promise<OutboundV2Record> {
	const record = await verifyOutboundV2Record(value);
	if (record.record_type !== "object") fail("UNSUPPORTED_OPERATION");
	const manifest = record.payload.chunking as Record<string, unknown>;
	const supplied = [...chunks].map((chunk) => new Uint8Array(chunk));
	const expected = manifest.chunk_sha256 as unknown[];
	if (supplied.length !== expected.length) fail("INTEGRITY_FAILED");
	for (let index = 0; index < supplied.length; index += 1) {
		if ((await sha256Hex(supplied[index])) !== expected[index]) fail("INTEGRITY_FAILED");
	}
	const total = supplied.reduce((size, chunk) => size + chunk.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of supplied) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (
		(await sha256Hex(joined)) !== record.payload.content_sha256 ||
		total !== record.payload.byte_size
	) {
		fail("INTEGRITY_FAILED");
	}
	return record;
}

export function validateResearchError(value: unknown): ResearchError {
	if (!isRecord(value)) fail("INTEGRITY_FAILED");
	exactKeys(value, ["error_code", "safe_message", "retryable", "request_id"]);
	if (typeof value.error_code !== "string" || !ERROR_CODES.has(value.error_code))
		fail("INTEGRITY_FAILED");
	if (value.safe_message !== SAFE_MESSAGES[value.error_code]) fail("INTEGRITY_FAILED");
	if (
		typeof value.retryable !== "boolean" ||
		!/^[0-9a-f]{32}$/.test(stringField(value.request_id))
	) {
		fail("INTEGRITY_FAILED");
	}
	return value as ResearchError;
}
