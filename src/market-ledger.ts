import { z } from "zod";

export const MARKET_LEDGER_REPOSITORY = "zhushihao/quantpro-collector";
export const MARKET_LEDGER_ISSUE_NUMBER = 2;
export const MARKET_LEDGER_SLOTS = [
	"09:10",
	"09:50",
	"10:50",
	"11:50",
	"13:50",
	"14:50",
	"16:45",
] as const;
export const MARKET_LEDGER_SLOT_SCHEMA = z.enum(MARKET_LEDGER_SLOTS);

const CHECKPOINT_RECORD_SCHEMA = z.record(z.string().min(1), z.unknown());

const UNIVERSE_TRANSITION_SCHEMA = z
	.object({
		status: z.enum(["BASELINE", "UNCHANGED", "MEMBERSHIP_CHANGED", "METADATA_CHANGED"]),
		previous_live_universe_hash: z.union([z.string().min(1).max(256), z.null()]),
		current_live_universe_hash: z.string().min(1).max(256),
		hash_changed: z.boolean(),
		membership_changed: z.boolean(),
		added_active: z.array(z.string().min(1).max(128)).max(512),
		removed_active: z.array(z.string().min(1).max(128)).max(512),
	})
	.strict();

const MARKET_CHECKPOINT_BASE_SHAPE = {
	schema_version: z.enum(["premarket_plan_batch_v1", "market_observation_batch_v1"]),
	prompt_id: z.literal("holding-assistant"),
	production_ref: z.string().regex(/^[0-9a-f]{40}$/i),
	portfolio_version: z.string().min(1).max(512),
	event_id: z.string().min(1).max(512),
	idempotency_key: z.string().min(1).max(256),
	trading_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	as_of: z.string().min(1).max(128),
	scheduled_slot: MARKET_LEDGER_SLOT_SCHEMA,
	producer: z.literal("holding-assistant"),
	observation_type: z.enum(["PREMARKET", "INTRADAY", "CLOSE"]),
	previous_checkpoint_comment_id: z.union([z.string().min(1).max(64), z.null()]),
	preopen_comment_id: z.union([z.string().min(1).max(64), z.null()]),
	live_universe_hash: z.string().min(1).max(256),
	source_task: z.string().min(1).max(128),
	records: z.array(CHECKPOINT_RECORD_SCHEMA).max(512),
} as const;

// Caller-facing append contract stays narrow. universe_transition is server-owned
// audit metadata and cannot be supplied by Scheduled Tasks or MCP clients.
export const MARKET_CHECKPOINT_INPUT_SCHEMA = z
	.object(MARKET_CHECKPOINT_BASE_SHAPE)
	.strict();

export const MARKET_CHECKPOINT_SCHEMA = z
	.object({
		...MARKET_CHECKPOINT_BASE_SHAPE,
		universe_transition: UNIVERSE_TRANSITION_SCHEMA.optional(),
	})
	.strict();

export type MarketCheckpointInputPayload = z.infer<typeof MARKET_CHECKPOINT_INPUT_SCHEMA>;
export type MarketCheckpointPayload = z.infer<typeof MARKET_CHECKPOINT_SCHEMA>;
export type MarketLedgerSlot = z.infer<typeof MARKET_LEDGER_SLOT_SCHEMA>;

export type MarketCheckpointComment = {
	comment_id: string;
	url: string;
	created_at: string;
	payload: MarketCheckpointPayload;
};

export type MarketCheckpointState = {
	status: "OK" | "CHECKPOINT_CONFLICT";
	trading_date: string;
	scheduled_slot: MarketLedgerSlot;
	preopen: MarketCheckpointComment | null;
	previous_checkpoint: MarketCheckpointComment | null;
	previous_close: MarketCheckpointComment | null;
	current_slot: MarketCheckpointComment | null;
	current_day_checkpoints: MarketCheckpointComment[];
	conflicts: Array<{
		idempotency_key: string;
		comment_ids: string[];
	}>;
};

export type MarketCheckpointAppendResult = {
	status: "PERSISTED" | "IDEMPOTENT_REPLAY";
	persisted: true;
	comment_id: string;
	url: string;
	created_at: string;
	checkpoint: MarketCheckpointPayload;
};

type GithubIssueComment = {
	id?: number | string;
	html_url?: string;
	url?: string;
	created_at?: string;
	body?: string | null;
};

const GITHUB_API_VERSION = "2022-11-28";
const JSON_BLOCK_PATTERN = /\`\`\`json\s*([\s\S]*?)\s*\`\`\`/i;
const MAX_COMMENT_PAGES = 100;
const RECENT_LOOKBACK_DAYS = 60;

export class MarketLedgerError extends Error {
	readonly code:
		| "MARKET_LEDGER_UNAVAILABLE"
		| "CHECKPOINT_VALIDATION_FAILED"
		| "CHECKPOINT_CONFLICT"
		| "CHECKPOINT_CHAIN_MISMATCH"
		| "CHECKPOINT_READBACK_FAILED";
	readonly httpStatus: number | null;

	constructor(
		code: MarketLedgerError["code"],
		message: string,
		httpStatus: number | null = null,
	) {
		super(message);
		this.name = "MarketLedgerError";
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

function githubHeaders(token: string, jsonBody = false): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": "quantpro-collector/market-ledger",
		...(jsonBody ? { "Content-Type": "application/json" } : {}),
	};
}

function commentsUrl(): string {
	return `https://api.github.com/repos/${MARKET_LEDGER_REPOSITORY}/issues/${MARKET_LEDGER_ISSUE_NUMBER}/comments`;
}

function commentUrl(commentId: string): string {
	return `https://api.github.com/repos/${MARKET_LEDGER_REPOSITORY}/issues/comments/${encodeURIComponent(commentId)}`;
}

function parseNextLink(link: string | null): string | null {
	if (!link) return null;
	for (const part of link.split(",")) {
		const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
		if (match?.[2] === "next") return match[1];
	}
	return null;
}

function recentSince(tradingDate: string): string {
	const date = new Date(`${tradingDate}T00:00:00+08:00`);
	if (Number.isNaN(date.getTime())) {
		throw new MarketLedgerError(
			"CHECKPOINT_VALIDATION_FAILED",
			"trading_date is not a valid calendar date",
		);
	}
	date.setUTCDate(date.getUTCDate() - RECENT_LOOKBACK_DAYS);
	return date.toISOString();
}

async function fetchComments(
	token: string,
	options: { since?: string; fetchImpl?: typeof fetch } = {},
): Promise<GithubIssueComment[]> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const initial = new URL(commentsUrl());
	initial.searchParams.set("per_page", "100");
	initial.searchParams.set("sort", "created");
	initial.searchParams.set("direction", "asc");
	if (options.since) initial.searchParams.set("since", options.since);

	let next: string | null = initial.toString();
	const comments: GithubIssueComment[] = [];
	let page = 0;
	while (next !== null) {
		page += 1;
		if (page > MAX_COMMENT_PAGES) {
			throw new MarketLedgerError(
				"MARKET_LEDGER_UNAVAILABLE",
				"GitHub issue comment pagination exceeded the safety limit",
			);
		}
		let response: Response;
		try {
			response = await fetchImpl(next, {
				method: "GET",
				headers: githubHeaders(token),
			});
		} catch {
			throw new MarketLedgerError(
				"MARKET_LEDGER_UNAVAILABLE",
				"GitHub issue comment read request failed",
			);
		}
		if (!response.ok) {
			throw new MarketLedgerError(
				"MARKET_LEDGER_UNAVAILABLE",
				`GitHub issue comment read failed with HTTP ${response.status}`,
				response.status,
			);
		}
		const payload = (await response.json()) as unknown;
		if (!Array.isArray(payload)) {
			throw new MarketLedgerError(
				"MARKET_LEDGER_UNAVAILABLE",
				"GitHub issue comment response is not an array",
			);
		}
		comments.push(...(payload as GithubIssueComment[]));
		next = parseNextLink(response.headers.get("Link"));
	}
	return comments;
}

function parseCheckpointPayload(body: string | null | undefined): MarketCheckpointPayload | null {
	if (!body) return null;
	const match = body.match(JSON_BLOCK_PATTERN);
	if (!match) return null;
	let value: unknown;
	try {
		value = JSON.parse(match[1]);
	} catch {
		return null;
	}
	const parsed = MARKET_CHECKPOINT_SCHEMA.safeParse(value);
	if (!parsed.success) return null;
	try {
		validateCheckpointRelations(parsed.data);
		return parsed.data;
	} catch {
		return null;
	}
}

function toCheckpointComment(comment: GithubIssueComment): MarketCheckpointComment | null {
	const payload = parseCheckpointPayload(comment.body);
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
	return {
		comment_id: commentId,
		url,
		created_at: createdAt,
		payload,
	};
}

function slotIndex(slot: MarketLedgerSlot): number {
	return MARKET_LEDGER_SLOTS.indexOf(slot);
}

function compareCheckpointOrder(a: MarketCheckpointComment, b: MarketCheckpointComment): number {
	const dateCompare = a.payload.trading_date.localeCompare(b.payload.trading_date);
	if (dateCompare !== 0) return dateCompare;
	const slotCompare = slotIndex(a.payload.scheduled_slot) - slotIndex(b.payload.scheduled_slot);
	if (slotCompare !== 0) return slotCompare;
	const timeCompare = a.created_at.localeCompare(b.created_at);
	if (timeCompare !== 0) return timeCompare;
	return a.comment_id.localeCompare(b.comment_id);
}

function buildState(
	rawComments: GithubIssueComment[],
	tradingDate: string,
	scheduledSlot: MarketLedgerSlot,
): MarketCheckpointState {
	const valid = rawComments
		.map(toCheckpointComment)
		.filter((item): item is MarketCheckpointComment => item !== null)
		.sort(compareCheckpointOrder);

	const byKey = new Map<string, MarketCheckpointComment[]>();
	for (const checkpoint of valid) {
		const group = byKey.get(checkpoint.payload.idempotency_key) ?? [];
		group.push(checkpoint);
		byKey.set(checkpoint.payload.idempotency_key, group);
	}
	const conflicts = [...byKey.entries()]
		.filter(([, comments]) => comments.length > 1)
		.map(([idempotency_key, comments]) => ({
			idempotency_key,
			comment_ids: comments.map((comment) => comment.comment_id),
		}));

	const currentDay = valid.filter(
		(checkpoint) => checkpoint.payload.trading_date === tradingDate,
	);
	const requestedIndex = slotIndex(scheduledSlot);
	const previousCandidates = [...currentDay]
		.filter((checkpoint) => slotIndex(checkpoint.payload.scheduled_slot) < requestedIndex)
		.sort(compareCheckpointOrder);
	const previousCheckpoint =
		previousCandidates[previousCandidates.length - 1] ?? null;
	const preopen =
		currentDay.find((checkpoint) => checkpoint.payload.scheduled_slot === "09:10") ?? null;
	const currentKey = `holding-assistant:${tradingDate}:${scheduledSlot}`;
	const currentSlot = byKey.get(currentKey)?.[0] ?? null;
	const previousCloseCandidates = [...valid]
		.filter(
			(checkpoint) =>
				checkpoint.payload.trading_date < tradingDate &&
				checkpoint.payload.observation_type === "CLOSE",
		)
		.sort(compareCheckpointOrder);
	const previousClose =
		previousCloseCandidates[previousCloseCandidates.length - 1] ?? null;

	return {
		status: conflicts.length > 0 ? "CHECKPOINT_CONFLICT" : "OK",
		trading_date: tradingDate,
		scheduled_slot: scheduledSlot,
		preopen,
		previous_checkpoint: previousCheckpoint,
		previous_close: previousClose,
		current_slot: currentSlot,
		current_day_checkpoints: currentDay,
		conflicts,
	};
}

export function validateCheckpointRelations(checkpoint: MarketCheckpointPayload): void {
	const expectedKey =
		`holding-assistant:${checkpoint.trading_date}:${checkpoint.scheduled_slot}`;
	if (checkpoint.idempotency_key !== expectedKey) {
		throw new MarketLedgerError(
			"CHECKPOINT_VALIDATION_FAILED",
			"idempotency_key does not match trading_date and scheduled_slot",
		);
	}
	if (Number.isNaN(Date.parse(checkpoint.as_of))) {
		throw new MarketLedgerError(
			"CHECKPOINT_VALIDATION_FAILED",
			"as_of is not a valid ISO date-time",
		);
	}

	if (checkpoint.scheduled_slot === "09:10") {
		if (
			checkpoint.schema_version !== "premarket_plan_batch_v1" ||
			checkpoint.observation_type !== "PREMARKET"
		) {
			throw new MarketLedgerError(
				"CHECKPOINT_VALIDATION_FAILED",
				"09:10 checkpoint must use PREMARKET contract",
			);
		}
		if (
			checkpoint.previous_checkpoint_comment_id !== null ||
			checkpoint.preopen_comment_id !== null
		) {
			throw new MarketLedgerError(
				"CHECKPOINT_VALIDATION_FAILED",
				"PREMARKET checkpoint cannot reference earlier same-day comments",
			);
		}
		return;
	}

	if (checkpoint.schema_version !== "market_observation_batch_v1") {
		throw new MarketLedgerError(
			"CHECKPOINT_VALIDATION_FAILED",
			"non-PREMARKET checkpoint must use market_observation_batch_v1",
		);
	}
	const expectedObservation =
		checkpoint.scheduled_slot === "16:45" ? "CLOSE" : "INTRADAY";
	if (checkpoint.observation_type !== expectedObservation) {
		throw new MarketLedgerError(
			"CHECKPOINT_VALIDATION_FAILED",
			`${checkpoint.scheduled_slot} checkpoint observation_type must be ${expectedObservation}`,
		);
	}
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

function checkpointEquals(
	left: MarketCheckpointPayload,
	right: MarketCheckpointPayload,
): boolean {
	return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function activeSubjectKeys(checkpoint: MarketCheckpointPayload): string[] {
	const keys = new Set<string>();
	for (const record of checkpoint.records) {
		if (
			record.holding_status === "ACTIVE" &&
			typeof record.subject_key === "string" &&
			record.subject_key.length > 0
		) {
			keys.add(record.subject_key);
		}
	}
	return [...keys].sort();
}

function withUniverseTransition(
	checkpoint: MarketCheckpointPayload,
	previousCheckpoint: MarketCheckpointPayload | null,
): MarketCheckpointPayload {
	if (checkpoint.scheduled_slot === "09:10" || previousCheckpoint === null) {
		return {
			...checkpoint,
			universe_transition: {
				status: "BASELINE",
				previous_live_universe_hash: null,
				current_live_universe_hash: checkpoint.live_universe_hash,
				hash_changed: false,
				membership_changed: false,
				added_active: [],
				removed_active: [],
			},
		};
	}

	const previousActive = activeSubjectKeys(previousCheckpoint);
	const currentActive = activeSubjectKeys(checkpoint);
	const previousSet = new Set(previousActive);
	const currentSet = new Set(currentActive);
	const addedActive = currentActive.filter((key) => !previousSet.has(key));
	const removedActive = previousActive.filter((key) => !currentSet.has(key));
	const membershipChanged = addedActive.length > 0 || removedActive.length > 0;
	const hashChanged =
		checkpoint.live_universe_hash !== previousCheckpoint.live_universe_hash;

	if (membershipChanged && !hashChanged) {
		throw new MarketLedgerError(
			"CHECKPOINT_VALIDATION_FAILED",
			"ACTIVE membership changed without a corresponding live_universe_hash change",
		);
	}

	const status = membershipChanged
		? "MEMBERSHIP_CHANGED"
		: hashChanged
			? "METADATA_CHANGED"
			: "UNCHANGED";

	return {
		...checkpoint,
		universe_transition: {
			status,
			previous_live_universe_hash: previousCheckpoint.live_universe_hash,
			current_live_universe_hash: checkpoint.live_universe_hash,
			hash_changed: hashChanged,
			membership_changed: membershipChanged,
			added_active: addedActive,
			removed_active: removedActive,
		},
	};
}

function checkpointBody(checkpoint: MarketCheckpointPayload): string {
	return `\`\`\`json\n${JSON.stringify(checkpoint, null, 2)}\n\`\`\``;
}

export async function getMarketCheckpoints(input: {
	token: string;
	tradingDate: string;
	scheduledSlot: MarketLedgerSlot;
	fetchImpl?: typeof fetch;
}): Promise<MarketCheckpointState> {
	if (!input.token) {
		throw new MarketLedgerError(
			"MARKET_LEDGER_UNAVAILABLE",
			"GitHub ledger credential is not configured",
		);
	}
	const recent = await fetchComments(input.token, {
		since: recentSince(input.tradingDate),
		fetchImpl: input.fetchImpl,
	});
	let state = buildState(recent, input.tradingDate, input.scheduledSlot);
	if (state.previous_close !== null) return state;

	// Long market closures or first use can fall outside the bounded lookback.
	// Fall back to full pagination server-side; the model never has to page GitHub.
	const all = await fetchComments(input.token, { fetchImpl: input.fetchImpl });
	state = buildState(all, input.tradingDate, input.scheduledSlot);
	return state;
}

export async function appendMarketCheckpoint(input: {
	token: string;
	checkpoint: MarketCheckpointInputPayload;
	fetchImpl?: typeof fetch;
}): Promise<MarketCheckpointAppendResult> {
	const parsed = MARKET_CHECKPOINT_INPUT_SCHEMA.safeParse(input.checkpoint);
	if (!parsed.success) {
		throw new MarketLedgerError(
			"CHECKPOINT_VALIDATION_FAILED",
			"checkpoint does not match the exact market ledger schema",
		);
	}
	const submittedCheckpoint = parsed.data;
	validateCheckpointRelations(submittedCheckpoint);

	const state = await getMarketCheckpoints({
		token: input.token,
		tradingDate: submittedCheckpoint.trading_date,
		scheduledSlot: submittedCheckpoint.scheduled_slot,
		fetchImpl: input.fetchImpl,
	});
	if (state.status === "CHECKPOINT_CONFLICT") {
		throw new MarketLedgerError(
			"CHECKPOINT_CONFLICT",
			"market ledger already contains duplicate checkpoint keys",
		);
	}
	const checkpoint = withUniverseTransition(
		submittedCheckpoint,
		state.previous_checkpoint?.payload ?? null,
	);
	validateCheckpointRelations(checkpoint);

	if (state.current_slot) {
		if (
			checkpointEquals(submittedCheckpoint, state.current_slot.payload) ||
			checkpointEquals(checkpoint, state.current_slot.payload)
		) {
			return {
				status: "IDEMPOTENT_REPLAY",
				persisted: true,
				comment_id: state.current_slot.comment_id,
				url: state.current_slot.url,
				created_at: state.current_slot.created_at,
				checkpoint: state.current_slot.payload,
			};
		}
		throw new MarketLedgerError(
			"CHECKPOINT_CONFLICT",
			"same checkpoint idempotency key already exists with different content",
		);
	}

	const expectedPrevious = state.previous_checkpoint?.comment_id ?? null;
	if (checkpoint.previous_checkpoint_comment_id !== expectedPrevious) {
		throw new MarketLedgerError(
			"CHECKPOINT_CHAIN_MISMATCH",
			"previous_checkpoint_comment_id does not match the server-side ledger state",
		);
	}
	const expectedPreopen =
		checkpoint.scheduled_slot === "09:10" ? null : state.preopen?.comment_id ?? null;
	if (checkpoint.preopen_comment_id !== expectedPreopen) {
		throw new MarketLedgerError(
			"CHECKPOINT_CHAIN_MISMATCH",
			"preopen_comment_id does not match the server-side ledger state",
		);
	}
	if (
		checkpoint.scheduled_slot !== "09:10" &&
		state.preopen &&
		checkpoint.production_ref !== state.preopen.payload.production_ref
	) {
		throw new MarketLedgerError(
			"CHECKPOINT_CHAIN_MISMATCH",
			"production_ref drifted from PREMARKET",
		);
	}

	const fetchImpl = input.fetchImpl ?? fetch;
	let createResponse: Response;
	try {
		createResponse = await fetchImpl(commentsUrl(), {
			method: "POST",
			headers: githubHeaders(input.token, true),
			body: JSON.stringify({ body: checkpointBody(checkpoint) }),
		});
	} catch {
		throw new MarketLedgerError(
			"MARKET_LEDGER_UNAVAILABLE",
			"GitHub issue comment append request failed",
		);
	}
	if (!createResponse.ok) {
		throw new MarketLedgerError(
			"MARKET_LEDGER_UNAVAILABLE",
			`GitHub issue comment append failed with HTTP ${createResponse.status}`,
			createResponse.status,
		);
	}
	const created = (await createResponse.json()) as GithubIssueComment;
	const createdId = created.id == null ? "" : String(created.id);
	if (!createdId) {
		throw new MarketLedgerError(
			"CHECKPOINT_READBACK_FAILED",
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
		throw new MarketLedgerError(
			"CHECKPOINT_READBACK_FAILED",
			"GitHub checkpoint readback request failed",
		);
	}
	if (!readbackResponse.ok) {
		throw new MarketLedgerError(
			"CHECKPOINT_READBACK_FAILED",
			`GitHub checkpoint readback failed with HTTP ${readbackResponse.status}`,
			readbackResponse.status,
		);
	}
	const readback = toCheckpointComment(
		(await readbackResponse.json()) as GithubIssueComment,
	);
	if (!readback || !checkpointEquals(readback.payload, checkpoint)) {
		throw new MarketLedgerError(
			"CHECKPOINT_READBACK_FAILED",
			"persisted checkpoint does not match the submitted checkpoint",
		);
	}
	return {
		status: "PERSISTED",
		persisted: true,
		comment_id: readback.comment_id,
		url: readback.url,
		created_at: readback.created_at,
		checkpoint: readback.payload,
	};
}
