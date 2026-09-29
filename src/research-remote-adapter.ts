/**
 * C6 read-only adapter over the Collector-owned D1/R2 replica.
 *
 * This is deliberately independent from Research's local SQLite adapter: it
 * receives only the validated outbound-v2 projection previously persisted by
 * C5, and it has no filesystem, LIVE, QMT, or write-plane capability.
 *
 * Shared read-plane contract (SPEC-C8 §3.2/§3.3/§3.4; the RESEARCH producer
 * side mirrors the same five points):
 *
 * 1. Projection role constant: "text_extraction".  A text-extraction
 *    projection travels as an attachment on the document_version payload with
 *    attachment_locator "urn:riws:text-extraction:<version_id>",
 *    attachment_status "FETCHED", media_type "text/plain", and the extracted
 *    text bytes addressed by content_sha256.
 * 2. Servable media_type whitelist (readableMediaType below): media_type
 *    lowercased starts with "text/", or is exactly application/json,
 *    application/xml, or application/xhtml+xml.
 * 3. readable semantics (effective value; stored payload_json is never
 *    rewritten): a version is servable iff
 *      revision_kind != "WITHDRAWAL"
 *      AND ( (whitelisted own media_type AND 64-hex own content_sha256)
 *            OR (exists attachment with role "text_extraction" AND
 *                attachment_status "FETCHED" AND whitelisted media_type AND
 *                64-hex content_sha256) ).
 *    Both the list face (searchDocuments) and the detail face (getDocument)
 *    present this same effective value; WITHDRAWAL versions are never
 *    servable.
 * 4. getDocument determinism: every version row of a document_id is fetched
 *    and ordered by version_number DESC with record_key (version_id)
 *    lexicographic ASC as tiebreak; the first servable version is served,
 *    own body bytes preferred over its projection.
 * 5. Failure model: served bytes are SHA-256 re-verified (mismatch ->
 *    INTEGRITY_FAILED immediately, no fallback); a candidate object missing
 *    in R2 falls through to the next servable version; every candidate
 *    object missing -> STORE_UNAVAILABLE; no servable version at all ->
 *    UNSUPPORTED_OPERATION.  Successful responses add
 *    body_source: "own" | "projection" and present version.readable === true.
 */
import type { ResearchReplicaStorage } from "./research-replica.ts";
import { ResearchBoundaryError } from "./research-outbound-v2.ts";
import { classifyResearchReadBackendError } from "./research-read-retry.ts";
import { FTS_TRIGRAM_MIN, ftsPhraseQuery } from "./research-fts.ts";
import {
	searchPublicDocumentsSemantic,
	type SemanticIndexDeps,
	type SemanticSearchResult,
} from "./research-semantic-index.ts";

export type ResearchReadVisibility = "PUBLIC" | "PRIVATE";

/** Shared contract constant (SPEC-C8 §3.4): the text-extraction projection role. */
const TEXT_EXTRACTION_ROLE = "text_extraction";

type ReplicaRecordRow = {
	record_type: string;
	record_key: string;
	message_id: string;
	visibility: ResearchReadVisibility;
	schema_version: string;
	payload_json: string;
	generated_at: string | null;
	updated_at: string;
};

type RemoteAdapterOptions = {
	/** Exactly one research-read scope; PUBLIC never falls through to PRIVATE. */
	visibility?: ResearchReadVisibility;
};

function fail(code: "NOT_FOUND" | "STORE_UNAVAILABLE" | "INTEGRITY_FAILED" | "UNSUPPORTED_OPERATION"): never {
	throw new ResearchBoundaryError(code);
}

function failMissingReplicaObject(): never {
	throw new ResearchBoundaryError("STORE_UNAVAILABLE", undefined, {
		retryable: false,
		safeMessage: "research replica object is unavailable; retry is not advised",
	});
}

function boundedLimit(value: number | undefined): number {
	if (value === undefined) return 50;
	if (!Number.isInteger(value) || value < 1 || value > 100) fail("INTEGRITY_FAILED");
	return value;
}

function parsePayload(row: { payload_json: string }): Record<string, unknown> {
	try {
		const payload = JSON.parse(row.payload_json);
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("INTEGRITY_FAILED");
		return payload as Record<string, unknown>;
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		fail("INTEGRITY_FAILED");
	}
}

function recordView(row: ReplicaRecordRow): Record<string, unknown> {
	return {
		record_type: row.record_type,
		record_key: row.record_key,
		message_id: row.message_id,
		visibility: row.visibility,
		schema_version: row.schema_version,
		payload: parsePayload(row),
		generated_at: row.generated_at,
		updated_at: row.updated_at,
		source: "COLLECTOR_REPLICA",
	};
}

function objectKey(contentSha256: string): string {
	return `research-objects/sha256/${contentSha256}`;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", value);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readableMediaType(value: unknown): boolean {
	let mediaType = String(value ?? "").toLowerCase();
	// Media type parameters (e.g. "; charset=utf-8") do not change servability;
	// strip them before the exact matches so "application/json; charset=utf-8"
	// stays servable on both sides (the Collector is deliberately the wider
	// side of the readable=true => get_document implication).  The "text/"
	// prefix branch is unaffected either way.
	const parameterStart = mediaType.indexOf(";");
	if (parameterStart >= 0) mediaType = mediaType.slice(0, parameterStart).trimEnd();
	return mediaType.startsWith("text/") || /^(application\/json|application\/xml|application\/xhtml\+xml)$/.test(mediaType);
}

function isHexSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Retention (owner ruling 2026-09-29): a document marked EXPIRED in
 * `research_document_retention` is logically invalidated - it is invisible to
 * search_documents and get_document from the moment it is marked, before any
 * R2/D1 byte is deleted, and it stays invisible through the purge window.
 * PURGED tombstones never hide anything: a re-ingested document starts a fresh
 * lifecycle.
 */
const NOT_EXPIRED_BY_RETENTION =
	"NOT EXISTS (SELECT 1 FROM research_document_retention ret WHERE ret.document_id=json_extract(research_records.payload_json, '$.document.document_id') AND ret.status='EXPIRED')";

/**
 * The servable body of one document_version payload: its own bytes when the
 * own media_type is whitelisted and its reference hash is well-formed,
 * otherwise its text-extraction projection attachment.  Returns null when the
 * version is not servable at all (WITHDRAWAL never is; see the module header
 * for the authoritative formula).
 */
type ServableBody = { bodySource: "own" | "projection"; contentSha256: string };

/**
 * Exported for the Collector PUBLIC semantic index (task D), which must apply
 * exactly this servability rule when it decides whether a version can be
 * indexed and when it re-validates a vector candidate.  Keeping one predicate
 * means `readable=true`, `get_document` and the semantic hit filter can never
 * disagree.
 */
export function servableBody(payload: Record<string, unknown>): ServableBody | null {
	const version = payload.version as Record<string, unknown> | undefined;
	if (!version || typeof version !== "object" || version.revision_kind === "WITHDRAWAL") {
		return null;
	}
	const ownSha256 = version.content_sha256;
	if (readableMediaType(version.media_type) && isHexSha256(ownSha256)) {
		return { bodySource: "own", contentSha256: ownSha256 };
	}
	const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
	for (const attachment of attachments) {
		if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) continue;
		const record = attachment as Record<string, unknown>;
		const projectionSha256 = record.content_sha256;
		if (
			record.role === TEXT_EXTRACTION_ROLE &&
			record.attachment_status === "FETCHED" &&
			readableMediaType(record.media_type) &&
			isHexSha256(projectionSha256)
		) {
			return { bodySource: "projection", contentSha256: projectionSha256 };
		}
	}
	return null;
}

/**
 * Shared servable predicate behind both the list face and the detail face:
 * readable = servable (SPEC-C8 §3.2).  Purely derived from the already parsed
 * payload; it never mutates the stored record.  Exported for the semantic
 * index (task D) so both faces share one definition.
 */
export function isVersionServable(payload: Record<string, unknown>): boolean {
	return servableBody(payload) !== null;
}

function numericVersionNumber(version: Record<string, unknown>): number {
	const value = Number(version.version_number);
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/**
 * The only remote research adapter used by the ChatGPT-facing Collector.
 * C7 will expose its methods as tools; this class itself performs no request
 * routing and does not share any market/LIVE authorization state.
 */
export class CollectorResearchRemoteAdapter {
	readonly visibility: ResearchReadVisibility;
	private readonly storage: ResearchReplicaStorage;

	constructor(
		storage: ResearchReplicaStorage,
		options: RemoteAdapterOptions = {},
	) {
		this.storage = storage;
		this.visibility = options.visibility ?? "PUBLIC";
		if (this.visibility !== "PUBLIC" && this.visibility !== "PRIVATE") fail("INTEGRITY_FAILED");
	}

	private async guarded<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof ResearchBoundaryError) throw error;
			throw classifyResearchReadBackendError(error);
		}
	}

	private async records(recordType: string, limit?: number): Promise<ReplicaRecordRow[]> {
		return this.guarded(async () => {
			const result = await this.storage.db
				.prepare(
					"SELECT record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at FROM research_records WHERE record_type=? AND visibility=? ORDER BY updated_at DESC LIMIT ?",
				)
				.bind(recordType, this.visibility, boundedLimit(limit))
				.all<ReplicaRecordRow>();
			return result.results ?? [];
		});
	}

	private async recordByKey(recordType: string, recordKey: string): Promise<ReplicaRecordRow> {
		if (!recordKey) fail("INTEGRITY_FAILED");
		return this.guarded(async () => {
			const row = await this.storage.db
				.prepare(
					"SELECT record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at FROM research_records WHERE record_type=? AND record_key=? AND visibility=? LIMIT 1",
				)
				.bind(recordType, recordKey, this.visibility)
				.first<ReplicaRecordRow>();
			if (!row) fail("NOT_FOUND");
			return row;
		});
	}

	/**
	 * Return the semantic-current accumulator for one subject.  Accumulator
	 * snapshots are immutable facts, so the replica's receive/update time is
	 * deliberately not a state ordering signal.  The producer defines
	 * payload.created_at as the UTC calculation time; snapshot_id is the stable
	 * lexicographic tiebreak when two calculations have the same instant.
	 *
	 * This is intentionally a subject-scoped query rather than records(100): a
	 * busy unrelated accumulator stream must not hide an older subject row.
	 * Existing v2/v3/v4 rows remain readable because created_at has been part
	 * of the frozen accumulator payload since v2.
	 */
	private async currentAccumulator(subjectKey: string): Promise<ReplicaRecordRow> {
		if (typeof subjectKey !== "string" || subjectKey.trim().length === 0) fail("INTEGRITY_FAILED");
		return this.guarded(async () => {
			const row = await this.storage.db
				.prepare(
					"SELECT record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at FROM research_records WHERE record_type='accumulator' AND visibility=? AND accumulator_subject_key=? ORDER BY accumulator_created_at DESC, record_key DESC LIMIT 1",
				)
				.bind(this.visibility, subjectKey)
				.first<ReplicaRecordRow>();
			if (!row) fail("NOT_FOUND");
			return row;
		});
	}

	async searchDocuments(query?: string, limit?: number): Promise<Array<Record<string, unknown>>> {
		const needle = query?.trim() ?? "";
		// Apply a requested title filter in D1 before LIMIT.  Fetching the most
		// recently received N documents and filtering in memory made a matching
		// older document disappear as the replica grew (the 960 / Hi-ONE official
		// backfill is a production example).  LIMIT belongs to search results,
		// not to an unrelated arrival-time window.
		//
		// 2026-09-28 (issue #10 方案①): queries of >= 3 characters run through the
		// FTS5 trigram index instead of a lower(...) LIKE full-table scan — the
		// scan cost 25k row reads per search and blew the D1 free-tier daily row
		// budget.  The FTS table is only a hit accelerator: visibility, retention
		// and payload stay owned by the research_records join, so results cannot
		// widen.  Shorter needles (trigram cannot match them) keep the LIKE path.
		const useFts = needle.trim().length >= FTS_TRIGRAM_MIN;
		const rows = await this.guarded(async () => {
			const base = `SELECT record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at FROM research_records WHERE record_type='document_version' AND visibility=? AND ${NOT_EXPIRED_BY_RETENTION}`;
			const statement = useFts
				? this.storage.db
						.prepare(
							`${base} AND record_key IN (SELECT record_key FROM research_documents_fts WHERE research_documents_fts MATCH ?) ORDER BY updated_at DESC LIMIT ?`,
						)
						.bind(this.visibility, ftsPhraseQuery(needle), boundedLimit(limit))
				: needle
					? this.storage.db
							.prepare(`${base} AND lower(json_extract(payload_json, '$.document.title')) LIKE ? ORDER BY updated_at DESC LIMIT ?`)
							.bind(this.visibility, `%${needle.toLocaleLowerCase()}%`, boundedLimit(limit))
					: this.storage.db
							.prepare(`${base} ORDER BY updated_at DESC LIMIT ?`)
							.bind(this.visibility, boundedLimit(limit));
			const result = await statement.all<ReplicaRecordRow>();
			return result.results ?? [];
		});
		return rows
			.map((row) => {
				const view = recordView(row);
				// Effective readable (SPEC-C8 §3.3): recomputed from the same
				// servable predicate the detail face uses, so readable=true always
				// means getDocument can actually serve a body.  The view holds a
				// freshly parsed object; the stored payload_json stays untouched.
				const payload = view.payload as Record<string, unknown>;
				const version = payload.version as Record<string, unknown> | undefined;
				if (version && typeof version === "object") {
					version.readable = isVersionServable(payload);
				}
				return view;
			});
	}

	/**
	 * Task D: semantic search over the Collector PUBLIC vector index.  The
	 * PUBLIC visibility of this adapter is the only visibility the index
	 * serves; a PRIVATE adapter instance refuses instead of degrading.
	 */
	async searchDocumentsSemantic(
		query: string,
		options: { limit?: number; deps: SemanticIndexDeps },
	): Promise<SemanticSearchResult> {
		if (this.visibility !== "PUBLIC") fail("UNSUPPORTED_OPERATION");
		return this.guarded(async () =>
			searchPublicDocumentsSemantic(
				this.storage,
				options.deps,
				{ query, limit: options.limit },
			),
		);
	}

	async getDocument(documentId: string): Promise<Record<string, unknown>> {
		if (!documentId) fail("INTEGRITY_FAILED");
		const rows = await this.guarded(async () => {
			const result = await this.storage.db
				.prepare(
					`SELECT record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at FROM research_records WHERE record_type='document_version' AND visibility=? AND json_extract(payload_json, '$.document.document_id')=? AND ${NOT_EXPIRED_BY_RETENTION}`,
				)
				.bind(this.visibility, documentId)
				.all<ReplicaRecordRow>();
			return result.results ?? [];
		});
		if (rows.length === 0) fail("NOT_FOUND");
		const candidates = rows.map((row) => {
			const payload = parsePayload(row);
			const document = payload.document as Record<string, unknown>;
			const version = payload.version as Record<string, unknown>;
			if (!document || !version || document.document_id !== documentId) fail("INTEGRITY_FAILED");
			return { row, payload, version };
		});
		// Deterministic order (SPEC-C8 §3.3): version_number DESC, record_key
		// (version_id) lexicographic ASC as tiebreak.
		candidates.sort((a, b) => {
			const delta = numericVersionNumber(b.version) - numericVersionNumber(a.version);
			if (delta !== 0) return delta;
			if (a.row.record_key < b.row.record_key) return -1;
			if (a.row.record_key > b.row.record_key) return 1;
			return 0;
		});
		let sawServable = false;
		for (const candidate of candidates) {
			const body = servableBody(candidate.payload);
			if (!body) continue;
			sawServable = true;
			const object = await this.guarded(() => this.storage.objects.get(objectKey(body.contentSha256)));
			// Candidate object missing in R2: fall through to the next servable
			// version (missing bytes is a retryable availability problem).
			if (!object) continue;
			const bytes = await this.guarded(() => object.arrayBuffer());
			// Corrupted bytes must be exposed, never silently skipped.
			if ((await sha256Hex(bytes)) !== body.contentSha256) fail("INTEGRITY_FAILED");
			return {
				document: candidate.payload.document,
				version: { ...candidate.version, readable: true },
				attachments: candidate.payload.attachments,
				body_text: new TextDecoder().decode(bytes),
				body_source: body.bodySource,
				source: "COLLECTOR_REPLICA",
			};
		}
		if (sawServable) failMissingReplicaObject();
		fail("UNSUPPORTED_OPERATION");
	}

	async searchEvidence(limit?: number): Promise<Array<Record<string, unknown>>> {
		return (await this.records("evidence", limit)).map(recordView);
	}

	async getEvidence(evidenceId: string): Promise<Record<string, unknown>> {
		const row = await this.recordByKey("evidence", evidenceId);
		const view = recordView(row);
		if (row.schema_version !== "collector-outbound-v4") {
			// v2/v3 remain readable but cannot claim the v4 immutable-source
			// guarantee.  This marker prevents a caller from treating legacy
			// metadata as a complete Evidence provenance record.
			return { ...view, source_reference_status: "UNAVAILABLE_LEGACY" };
		}
		const payload = view.payload as Record<string, unknown>;
		const reference = payload.source_reference;
		if (!reference || typeof reference !== "object" || Array.isArray(reference)) fail("INTEGRITY_FAILED");
		const sourceReference = reference as Record<string, unknown>;
		const documentId = String(sourceReference.document_id ?? "");
		const versionId = String(sourceReference.document_version_id ?? "");
		const contentSha256 = String(sourceReference.content_sha256 ?? "");
		const start = sourceReference.byte_start;
		const end = sourceReference.byte_end;
		const spanSha256 = String(sourceReference.span_sha256 ?? "");
		if (!documentId || !versionId || !isHexSha256(contentSha256) || !isHexSha256(spanSha256) ||
			typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) ||
			!Number.isInteger(end) || start < 0 || end <= start) fail("INTEGRITY_FAILED");
		const versionRow = await this.recordByKey("document_version", versionId);
		const versionPayload = parsePayload(versionRow);
		const document = versionPayload.document as Record<string, unknown> | undefined;
		const version = versionPayload.version as Record<string, unknown> | undefined;
		if (!document || !version || document.document_id !== documentId ||
			version.version_id !== versionId || version.document_id !== documentId) fail("INTEGRITY_FAILED");
		let referencedHash = String(version.content_sha256 ?? "");
		const attachmentId = sourceReference.attachment_id;
		if (attachmentId !== null) {
			if (typeof attachmentId !== "string") fail("INTEGRITY_FAILED");
			const attachments = Array.isArray(versionPayload.attachments) ? versionPayload.attachments : [];
			const attachment = attachments.find((item) =>
				item && typeof item === "object" && !Array.isArray(item) &&
				(item as Record<string, unknown>).attachment_id === attachmentId,
			) as Record<string, unknown> | undefined;
			if (!attachment) fail("INTEGRITY_FAILED");
			referencedHash = String(attachment.content_sha256 ?? "");
		}
		if (referencedHash !== contentSha256) fail("INTEGRITY_FAILED");
		const object = await this.guarded(() => this.storage.objects.get(objectKey(contentSha256)));
		if (!object) failMissingReplicaObject();
		const bytes = await this.guarded(() => object.arrayBuffer());
		if ((await sha256Hex(bytes)) !== contentSha256) fail("INTEGRITY_FAILED");
		const slice = new Uint8Array(bytes).slice(start, end);
		if (slice.byteLength !== end - start || (await sha256Hex(slice.buffer)) !== spanSha256) fail("INTEGRITY_FAILED");
		return { ...view, source_reference_status: "VERIFIED" };
	}

	async getThemeAccumulator(subjectKey: string): Promise<Record<string, unknown>> {
		return recordView(await this.currentAccumulator(subjectKey));
	}

	async getCompanyEvidenceState(company: string): Promise<Record<string, unknown>> {
		return this.getThemeAccumulator(company);
	}

	async getCoverageStatus(limit?: number): Promise<Array<Record<string, unknown>>> {
		return (await this.records("coverage", limit)).map(recordView);
	}

	/**
	 * §A6: source health is a first-class outbound record type (v3), so the
	 * adapter serves the real `source_health` row set instead of a stub.
	 */
	async getSourceHealth(limit?: number): Promise<Array<Record<string, unknown>>> {
		return (await this.records("source_health", limit)).map(recordView);
	}

	/**
	 * Market signals have their own latest-state record type. They never reuse
	 * the D/S/M/E/P/C Evidence accumulator. An absent record is honest NO_DATA.
	 */
	async getMarketSignalState(subjectKey: string): Promise<Record<string, unknown>> {
		if (typeof subjectKey !== "string" || subjectKey.trim().length === 0) fail("INTEGRITY_FAILED");
		const normalized = subjectKey.startsWith("market:")
			? subjectKey
			: `market:${subjectKey.trim()}`;
		try {
			const row = await this.recordByKey("market_signal", normalized);
			return { ...recordView(row), subject_kind: "MARKET", signal_kind: "R3_R4_PRICE_INPUT" };
		} catch (error) {
			if (!(error instanceof ResearchBoundaryError) || error.error_code !== "NOT_FOUND") throw error;
		}
		return {
			status: "NO_DATA",
			subject_key: normalized,
			source: "COLLECTOR_REPLICA",
			note: "MARKET_SIGNAL_NOT_AVAILABLE",
		};
	}

	/**
	 * §A7/§5.3 server-side job state derived as terminal > unexpired lease >
	 * record.  The lease query selects only owner/expiry columns; the claim
	 * token never leaves the lease row.
	 */
	private async jobServerState(jobId: string): Promise<Record<string, unknown>> {
		const terminal = await this.guarded(() =>
			this.storage.db
				.prepare(
					"SELECT terminal_status FROM research_job_terminal WHERE job_id=? LIMIT 1",
				)
				.bind(jobId)
				.first<{ terminal_status: string }>(),
		);
		if (terminal) {
			return {
				effective_status: terminal.terminal_status === "COMPLETED" ? "COMPLETED" : "QUEUED",
				lease_owner: null,
				lease_expires_at: null,
			};
		}
		const lease = await this.guarded(() =>
			this.storage.db
				.prepare("SELECT lease_owner, lease_expires_at FROM research_job_leases WHERE job_id=? LIMIT 1")
				.bind(jobId)
				.first<{ lease_owner: string; lease_expires_at: string }>(),
		);
		const now = new Date().toISOString();
		if (lease && lease.lease_expires_at > now) {
			return {
				effective_status: "CLAIMED",
				lease_owner: lease.lease_owner,
				lease_expires_at: lease.lease_expires_at,
			};
		}
		return { effective_status: "QUEUED", lease_owner: null, lease_expires_at: null };
	}

	private async jobProposals(jobId: string): Promise<Array<Record<string, unknown>>> {
		const result = await this.guarded(() =>
			this.storage.db
				.prepare(
					"SELECT proposal_id, origin, status, created_at, payload_json FROM research_proposals WHERE job_id=? ORDER BY created_at ASC",
				)
				.bind(jobId)
				.all<{ proposal_id: string; origin: string; status: string; created_at: string; payload_json: string }>(),
		);
		return (result.results ?? []).map((row) => ({
			proposal_id: row.proposal_id,
			origin: row.origin,
			status: row.status,
			created_at: row.created_at,
			payload: parsePayload({ payload_json: row.payload_json }),
		}));
	}

	async listResearchJobs(
		limit?: number,
		options: { claimableOnly?: boolean } = {},
	): Promise<Array<Record<string, unknown>>> {
		const jobs: Array<Record<string, unknown>> = [];
		for (const row of await this.records("job", limit)) {
			const view = { ...recordView(row), server_state: await this.jobServerState(row.record_key) };
			if (options.claimableOnly && view.server_state.effective_status !== "QUEUED") continue;
			jobs.push(view);
		}
		return jobs;
	}

	async getResearchJobContext(jobId: string): Promise<Record<string, unknown>> {
		const view = recordView(await this.recordByKey("job", jobId));
		return {
			...view,
			server_state: await this.jobServerState(jobId),
			proposals: await this.jobProposals(jobId),
		};
	}
}
