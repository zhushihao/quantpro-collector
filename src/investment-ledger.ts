import { z } from "zod";

export const INVESTMENT_LEDGER_REPOSITORY = "zhushihao/quantpro-collector";
export const INVESTMENT_LEDGER_ISSUE_NUMBER = 3;

export const INVESTMENT_LEDGER_ROLES = ["industry", "company", "close"] as const;
export type InvestmentLedgerRole = (typeof INVESTMENT_LEDGER_ROLES)[number];

const ROLE_CONFIG = {
	industry: {
		producer: "industry_trend",
		dimension: "INDUSTRY",
		sourceTask: "产业趋势与研究",
		allowedRProposals: new Set(["R0", "R1"]),
	},
	company: {
		producer: "company_validation",
		dimension: "COMPANY",
		sourceTask: "公司事实监控",
		allowedRProposals: new Set(["R2"]),
	},
	close: {
		producer: "close_review",
		dimension: "CLOSE",
		sourceTask: "持仓助手｜收盘",
		allowedRProposals: new Set<string>(),
	},
} as const;

const EVIDENCE_TYPE_SCHEMA = z.enum(["D", "S", "M", "E", "P", "C"]);
const EVENT_TYPE_SCHEMA = z.enum([
	"STATE_SET",
	"STATE_CHANGE",
	"COUNTER_EVIDENCE",
	"CONFIRMATION",
	"EVIDENCE_ADD",
	"EVIDENCE_UPDATE",
	"CORRECTION",
]);
const OPTIONAL_TEXT = z.union([z.string().max(16000), z.null()]).optional();

export const INVESTMENT_LEDGER_EVENT_INPUT_SCHEMA = z
	.object({
		symbol: z.string().regex(/^(?:CN:\d{6}|HK:\d{5})$/),
		event_type: EVENT_TYPE_SCHEMA,
		research_priority: z.union([z.enum(["P0", "P1", "P2"]), z.null()]).optional(),
		industry_thesis: OPTIONAL_TEXT,
		company_thesis: OPTIONAL_TEXT,
		company_validation: OPTIONAL_TEXT,
		r_proposal: z.union([z.enum(["R0", "R1", "R2"]), z.null()]).optional(),
		effective_r_state: z
			.union([z.enum(["R0", "R1", "R2", "R3", "R4"]), z.null()])
			.optional(),
		market_confirmation: OPTIONAL_TEXT,
		r4_candidate: z.union([z.boolean(), z.null()]).optional(),
		close_thesis_view: OPTIONAL_TEXT,
		evidence_types: z.array(EVIDENCE_TYPE_SCHEMA).max(6),
		evidence_keys: z.array(z.string().min(1).max(512)).max(100),
		counter_evidence: z.array(z.string().min(1).max(4000)).max(20),
		confidence: z.number().min(0).max(1),
		next_validation: z.union([z.string().max(8000), z.null()]),
	})
	.strict();

export const INVESTMENT_LEDGER_BATCH_INPUT_SCHEMA = z
	.object({
		schema_version: z.literal("investment_state_batch_v1"),
		portfolio_version: z.string().min(1).max(512),
		event_id: z.string().min(1).max(512),
		as_of: z.string().min(1).max(128),
		events: z.array(INVESTMENT_LEDGER_EVENT_INPUT_SCHEMA).min(1).max(128),
	})
	.strict();

export type InvestmentLedgerBatchInput = z.infer<typeof INVESTMENT_LEDGER_BATCH_INPUT_SCHEMA>;
export type InvestmentLedgerEventInput = z.infer<typeof INVESTMENT_LEDGER_EVENT_INPUT_SCHEMA>;

export type PersistedInvestmentEvent = InvestmentLedgerEventInput & {
	dimension: "INDUSTRY" | "COMPANY" | "CLOSE";
};

export type PersistedInvestmentBatch = InvestmentLedgerBatchInput & {
	producer: "industry_trend" | "company_validation" | "close_review";
	source_task: "产业趋势与研究" | "公司事实监控" | "持仓助手｜收盘";
	events: PersistedInvestmentEvent[];
};

type GithubIssueComment = {
	id?: number | string;
	html_url?: string;
	url?: string;
	created_at?: string;
	body?: string | null;
};

export type InvestmentLedgerComment = {
	comment_id: string;
	url: string;
	created_at: string;
	payload: PersistedInvestmentBatch;
};

export type InvestmentLedgerState = {
	status: "OK";
	producer: string;
	dimension: "INDUSTRY" | "COMPANY" | "CLOSE";
	fully_paginated: true;
	symbols: string[];
	latest_by_symbol: Record<
		string,
		{
			comment_id: string;
			created_at: string;
			as_of: string;
			event: PersistedInvestmentEvent;
		} | null
	>;
	latest_r_proposal_by_symbol: Record<string, "R0" | "R1" | "R2" | null>;
	history_by_symbol: Record<
		string,
		Array<{
			comment_id: string;
			created_at: string;
			as_of: string;
			event: PersistedInvestmentEvent;
		}>
	>;
	evidence_keys_by_symbol: Record<string, string[]>;
	event_count_by_symbol: Record<string, number>;
};

export type InvestmentLedgerAppendResult = {
	status: "PERSISTED" | "IDEMPOTENT_REPLAY";
	persisted: true;
	comment_id: string;
	url: string;
	created_at: string;
	batch: PersistedInvestmentBatch;
};

const GITHUB_API_VERSION = "2022-11-28";
const MAX_COMMENT_PAGES = 100;
const JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)\s*```/i;

export class InvestmentLedgerError extends Error {
	readonly code:
		| "INVESTMENT_LEDGER_UNAVAILABLE"
		| "INVESTMENT_LEDGER_VALIDATION_FAILED"
		| "INVESTMENT_LEDGER_EVENT_ID_CONFLICT"
		| "INVESTMENT_LEDGER_READBACK_FAILED";
	readonly httpStatus: number | null;

	constructor(
		code: InvestmentLedgerError["code"],
		message: string,
		httpStatus: number | null = null,
	) {
		super(message);
		this.name = "InvestmentLedgerError";
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

function githubHeaders(token: string, jsonBody = false): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": "quantpro-research/investment-ledger",
		...(jsonBody ? { "Content-Type": "application/json" } : {}),
	};
}

function commentsUrl(): string {
	return `https://api.github.com/repos/${INVESTMENT_LEDGER_REPOSITORY}/issues/${INVESTMENT_LEDGER_ISSUE_NUMBER}/comments`;
}

function commentUrl(commentId: string): string {
	return `https://api.github.com/repos/${INVESTMENT_LEDGER_REPOSITORY}/issues/comments/${encodeURIComponent(commentId)}`;
}

function parseNextLink(link: string | null): string | null {
	if (!link) return null;
	for (const part of link.split(",")) {
		const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
		if (match?.[2] === "next") return match[1];
	}
	return null;
}

function validationSummary(error: z.ZodError): string {
	return error.issues
		.slice(0, 10)
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
			const keys = issue.code === "unrecognized_keys" ? ` keys=${issue.keys.join(",")}` : "";
			return `${path}:${issue.code}${keys}`;
		})
		.join("; ");
}

function roleConfig(role: InvestmentLedgerRole) {
	return ROLE_CONFIG[role];
}

export function validateRoleSemantics(
	role: InvestmentLedgerRole,
	batch: InvestmentLedgerBatchInput,
): void {
	const config = roleConfig(role);
	if (Number.isNaN(Date.parse(batch.as_of))) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_VALIDATION_FAILED",
			"as_of is not a valid ISO date-time",
		);
	}
	const eventIdPattern = new RegExp(`^\\d{8}T\\d{6}\\+08\\|${config.producer}\\|BATCH$`);
	if (!eventIdPattern.test(batch.event_id)) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_VALIDATION_FAILED",
			"event_id does not match the fixed producer contract",
		);
	}
	for (const event of batch.events) {
		if (
			event.r_proposal !== undefined &&
			event.r_proposal !== null &&
			!config.allowedRProposals.has(event.r_proposal)
		) {
			throw new InvestmentLedgerError(
				"INVESTMENT_LEDGER_VALIDATION_FAILED",
				"r_proposal is outside the role write boundary",
			);
		}
		if (role === "industry") {
			if (
				event.company_thesis != null ||
				event.company_validation != null ||
				event.effective_r_state != null ||
				event.market_confirmation != null ||
				event.r4_candidate != null ||
				event.close_thesis_view != null
			) {
				throw new InvestmentLedgerError(
					"INVESTMENT_LEDGER_VALIDATION_FAILED",
					"industry writer cannot persist company or close fields",
				);
			}
		} else if (role === "company") {
			if (
				event.industry_thesis != null ||
				event.effective_r_state != null ||
				event.market_confirmation != null ||
				event.r4_candidate != null ||
				event.close_thesis_view != null
			) {
				throw new InvestmentLedgerError(
					"INVESTMENT_LEDGER_VALIDATION_FAILED",
					"company writer cannot persist industry or close fields",
				);
			}
		} else {
			if (
				event.research_priority != null ||
				event.industry_thesis != null ||
				event.company_thesis != null ||
				event.company_validation != null ||
				event.r_proposal != null
			) {
				throw new InvestmentLedgerError(
					"INVESTMENT_LEDGER_VALIDATION_FAILED",
					"close writer cannot persist industry/company ownership fields",
				);
			}
			if (
				event.effective_r_state == null &&
				event.market_confirmation == null &&
				event.r4_candidate == null &&
				event.close_thesis_view == null &&
				event.next_validation == null
			) {
				throw new InvestmentLedgerError(
					"INVESTMENT_LEDGER_VALIDATION_FAILED",
					"close writer must persist at least one close-owned field",
				);
			}
		}
	}
}

function enrichBatch(
	role: InvestmentLedgerRole,
	input: InvestmentLedgerBatchInput,
): PersistedInvestmentBatch {
	const config = roleConfig(role);
	return {
		...input,
		producer: config.producer,
		source_task: config.sourceTask,
		events: input.events.map((event) => ({ ...event, dimension: config.dimension })),
	} as PersistedInvestmentBatch;
}

function parseExistingPayload(body: string | null | undefined): PersistedInvestmentBatch | null {
	if (!body) return null;
	const block = body.match(JSON_BLOCK_PATTERN);
	const raw = block?.[1] ?? body.trim();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const object = value as Record<string, unknown>;
	if (object.schema_version !== "investment_state_batch_v1") return null;
	if (
		object.producer !== "industry_trend" &&
		object.producer !== "company_validation" &&
		object.producer !== "close_review"
	)
		return null;
	if (!Array.isArray(object.events)) return null;
	const events = object.events.filter((event): event is PersistedInvestmentEvent => {
		if (!event || typeof event !== "object" || Array.isArray(event)) return false;
		const candidate = event as Record<string, unknown>;
		return (
			typeof candidate.symbol === "string" &&
			(candidate.dimension === "INDUSTRY" ||
				candidate.dimension === "COMPANY" ||
				candidate.dimension === "CLOSE")
		);
	});
	if (events.length === 0) return null;
	return { ...(object as unknown as PersistedInvestmentBatch), events };
}

function toLedgerComment(comment: GithubIssueComment): InvestmentLedgerComment | null {
	const payload = parseExistingPayload(comment.body);
	if (!payload) return null;
	const commentId = comment.id == null ? "" : String(comment.id);
	const createdAt = typeof comment.created_at === "string" ? comment.created_at : "";
	const url =
		typeof comment.html_url === "string"
			? comment.html_url
			: typeof comment.url === "string"
				? comment.url
				: "";
	if (!commentId || !createdAt || !url) return null;
	return { comment_id: commentId, url, created_at: createdAt, payload };
}

async function fetchAllComments(
	token: string,
	fetchImpl: typeof fetch,
): Promise<GithubIssueComment[]> {
	const initial = new URL(commentsUrl());
	initial.searchParams.set("per_page", "100");
	initial.searchParams.set("sort", "created");
	initial.searchParams.set("direction", "asc");
	let next: string | null = initial.toString();
	const comments: GithubIssueComment[] = [];
	let page = 0;
	while (next !== null) {
		page += 1;
		if (page > MAX_COMMENT_PAGES) {
			throw new InvestmentLedgerError(
				"INVESTMENT_LEDGER_UNAVAILABLE",
				"GitHub issue comment pagination exceeded the safety limit",
			);
		}
		let response: Response;
		try {
			response = await fetchImpl(next, { method: "GET", headers: githubHeaders(token) });
		} catch {
			throw new InvestmentLedgerError(
				"INVESTMENT_LEDGER_UNAVAILABLE",
				"GitHub issue comment read request failed",
			);
		}
		if (!response.ok) {
			throw new InvestmentLedgerError(
				"INVESTMENT_LEDGER_UNAVAILABLE",
				`GitHub issue comment read failed with HTTP ${response.status}`,
				response.status,
			);
		}
		const payload = (await response.json()) as unknown;
		if (!Array.isArray(payload)) {
			throw new InvestmentLedgerError(
				"INVESTMENT_LEDGER_UNAVAILABLE",
				"GitHub issue comment response is not an array",
			);
		}
		comments.push(...(payload as GithubIssueComment[]));
		next = parseNextLink(response.headers.get("Link"));
	}
	return comments;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(object)
				.sort()
				.map((key) => [key, canonicalize(object[key])]),
		);
	}
	return value;
}

function batchEquals(left: PersistedInvestmentBatch, right: PersistedInvestmentBatch): boolean {
	return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function batchBody(batch: PersistedInvestmentBatch): string {
	return `\`\`\`json\n${JSON.stringify(batch, null, 2)}\n\`\`\``;
}

function validRoleComments(
	comments: GithubIssueComment[],
	role: InvestmentLedgerRole,
): InvestmentLedgerComment[] {
	const config = roleConfig(role);
	return comments
		.map(toLedgerComment)
		.filter((comment): comment is InvestmentLedgerComment => comment !== null)
		.filter((comment) => comment.payload.producer === config.producer)
		.sort((left, right) => {
			const asOf = String(left.payload.as_of ?? "").localeCompare(
				String(right.payload.as_of ?? ""),
			);
			if (asOf !== 0) return asOf;
			const created = left.created_at.localeCompare(right.created_at);
			if (created !== 0) return created;
			return left.comment_id.localeCompare(right.comment_id);
		});
}

export async function getInvestmentLedgerState(input: {
	token: string;
	role: InvestmentLedgerRole;
	symbols: string[];
	historyLimit?: number;
	fetchImpl?: typeof fetch;
}): Promise<InvestmentLedgerState> {
	if (!input.token) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_UNAVAILABLE",
			"RESEARCH GitHub credential is unavailable",
		);
	}
	const symbols = [...new Set(input.symbols)];
	if (
		symbols.length < 1 ||
		symbols.length > 512 ||
		symbols.some((symbol) => !/^(?:CN:\d{6}|HK:\d{5})$/.test(symbol))
	) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_VALIDATION_FAILED",
			"symbols must contain 1-512 canonical CN:/HK: instrument keys",
		);
	}
	const config = roleConfig(input.role);
	const raw = await fetchAllComments(input.token, input.fetchImpl ?? fetch);
	const comments = validRoleComments(raw, input.role);
	const latestBySymbol: InvestmentLedgerState["latest_by_symbol"] = {};
	const latestRProposalBySymbol: InvestmentLedgerState["latest_r_proposal_by_symbol"] = {};
	const historyBySymbol: InvestmentLedgerState["history_by_symbol"] = {};
	const evidenceBySymbol: InvestmentLedgerState["evidence_keys_by_symbol"] = {};
	const countBySymbol: InvestmentLedgerState["event_count_by_symbol"] = {};
	for (const symbol of symbols) {
		latestBySymbol[symbol] = null;
		latestRProposalBySymbol[symbol] = null;
		historyBySymbol[symbol] = [];
		evidenceBySymbol[symbol] = [];
		countBySymbol[symbol] = 0;
	}
	const evidenceSets = Object.fromEntries(symbols.map((symbol) => [symbol, new Set<string>()]));
	for (const comment of comments) {
		for (const event of comment.payload.events) {
			if (!symbols.includes(event.symbol) || event.dimension !== config.dimension) continue;
			countBySymbol[event.symbol] += 1;
			for (const key of Array.isArray(event.evidence_keys) ? event.evidence_keys : []) {
				if (typeof key === "string" && key) evidenceSets[event.symbol].add(key);
			}
			latestBySymbol[event.symbol] = {
				comment_id: comment.comment_id,
				created_at: comment.created_at,
				as_of: String(comment.payload.as_of ?? ""),
				event,
			};
			if (event.r_proposal === "R0" || event.r_proposal === "R1" || event.r_proposal === "R2") {
				latestRProposalBySymbol[event.symbol] = event.r_proposal;
			}
			historyBySymbol[event.symbol].push({
				comment_id: comment.comment_id,
				created_at: comment.created_at,
				as_of: String(comment.payload.as_of ?? ""),
				event,
			});
		}
	}
	const historyLimit = Math.max(0, Math.min(20, input.historyLimit ?? 0));
	for (const symbol of symbols) {
		if (historyLimit === 0) historyBySymbol[symbol] = [];
		else historyBySymbol[symbol] = historyBySymbol[symbol].slice(-historyLimit);
		evidenceBySymbol[symbol] = [...evidenceSets[symbol]].sort();
	}
	return {
		status: "OK",
		producer: config.producer,
		dimension: config.dimension,
		fully_paginated: true,
		symbols,
		latest_by_symbol: latestBySymbol,
		latest_r_proposal_by_symbol: latestRProposalBySymbol,
		history_by_symbol: historyBySymbol,
		evidence_keys_by_symbol: evidenceBySymbol,
		event_count_by_symbol: countBySymbol,
	};
}

export async function appendInvestmentLedgerBatch(input: {
	token: string;
	role: InvestmentLedgerRole;
	batch: unknown;
	fetchImpl?: typeof fetch;
}): Promise<InvestmentLedgerAppendResult> {
	const parsed = INVESTMENT_LEDGER_BATCH_INPUT_SCHEMA.safeParse(input.batch);
	if (!parsed.success) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_VALIDATION_FAILED",
			`batch does not match the exact investment ledger schema: ${validationSummary(parsed.error)}`,
		);
	}
	validateRoleSemantics(input.role, parsed.data);
	if (!input.token) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_UNAVAILABLE",
			"RESEARCH GitHub credential is unavailable",
		);
	}
	const batch = enrichBatch(input.role, parsed.data);
	const fetchImpl = input.fetchImpl ?? fetch;
	const comments = validRoleComments(await fetchAllComments(input.token, fetchImpl), input.role);
	const sameEventId = comments.filter((comment) => comment.payload.event_id === batch.event_id);
	if (sameEventId.length > 0) {
		if (sameEventId.length === 1 && batchEquals(sameEventId[0].payload, batch)) {
			const existing = sameEventId[0];
			return {
				status: "IDEMPOTENT_REPLAY",
				persisted: true,
				comment_id: existing.comment_id,
				url: existing.url,
				created_at: existing.created_at,
				batch: existing.payload,
			};
		}
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_EVENT_ID_CONFLICT",
			"event_id already exists with different or duplicate content",
		);
	}

	let createResponse: Response;
	try {
		createResponse = await fetchImpl(commentsUrl(), {
			method: "POST",
			headers: githubHeaders(input.token, true),
			body: JSON.stringify({ body: batchBody(batch) }),
		});
	} catch {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_UNAVAILABLE",
			"GitHub issue comment append request failed",
		);
	}
	if (!createResponse.ok) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_UNAVAILABLE",
			`GitHub issue comment append failed with HTTP ${createResponse.status}`,
			createResponse.status,
		);
	}
	const created = (await createResponse.json()) as GithubIssueComment;
	const createdId = created.id == null ? "" : String(created.id);
	if (!createdId) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_READBACK_FAILED",
			"GitHub append response did not contain a comment id",
		);
	}

	let readbackResponse: Response;
	try {
		readbackResponse = await fetchImpl(commentUrl(createdId), {
			method: "GET",
			headers: githubHeaders(input.token),
		});
	} catch {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_READBACK_FAILED",
			"GitHub investment ledger readback request failed",
		);
	}
	if (!readbackResponse.ok) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_READBACK_FAILED",
			`GitHub investment ledger readback failed with HTTP ${readbackResponse.status}`,
			readbackResponse.status,
		);
	}
	const readback = toLedgerComment((await readbackResponse.json()) as GithubIssueComment);
	if (!readback || !batchEquals(readback.payload, batch)) {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_READBACK_FAILED",
			"persisted investment batch does not match the submitted batch",
		);
	}
	return {
		status: "PERSISTED",
		persisted: true,
		comment_id: readback.comment_id,
		url: readback.url,
		created_at: readback.created_at,
		batch: readback.payload,
	};
}
