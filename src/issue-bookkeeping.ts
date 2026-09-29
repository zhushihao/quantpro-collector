// Controlled GitHub issue bookkeeping sink (issue #52, 2026-09-30).
//
// Scheduled tasks must not treat GitHub as an arbitrary external write tool:
// the host safety preflight can refuse the request before it leaves the host,
// leaving no receipt and no request id (the 09-29 rejection family). This
// module is the narrow alternative — the task submits a bookkeeping INTENT
// (symbolic target from a server-side whitelist, COMMENT|CLOSE only, required
// idempotency key) and this server performs the GitHub side effect, keeps a
// dedupe row, and returns one of five honest statuses. No arbitrary repo, no
// issue creation/deletion, no label/assignee, no shell passthrough. A failed
// or unknown GitHub delivery never changes any business run's outcome.
import { z } from "zod";

import { AUTOMATION_REGISTRY_KEYS } from "./automation-run-ledger.ts";
import { StateGatewayError } from "./state-gateway.ts";

const TABLE = "issue_bookkeeping";

export const ISSUE_BOOKKEEPING_INPUT_SCHEMA = z
	.object({
		source_task: z.enum([...AUTOMATION_REGISTRY_KEYS, "production-observer"]),
		target_key: z.string().regex(/^[a-z0-9_-]{1,64}$/),
		operation: z.enum(["COMMENT", "CLOSE"]),
		dedupe_key: z.string().regex(/^[A-Za-z0-9:._-]{8,128}$/),
		body: z.string().min(1).max(8000).optional(),
		evidence_refs: z.array(z.string().min(1).max(128)).max(16).optional(),
	})
	.strict();

export type IssueBookkeepingStatus =
	| "PERSISTED"
	| "IDEMPOTENT_REPLAY"
	| "DELIVERY_BLOCKED"
	| "OUTCOME_UNKNOWN"
	| "REJECTED_TARGET";

export type IssueBookkeepingReceipt = {
	status: IssueBookkeepingStatus;
	dedupe_key: string;
	source_task: string;
	target_key: string;
	operation: "COMMENT" | "CLOSE";
	target: { repo: string; issue: number } | null;
	issue_comment_id: string | null;
	url: string | null;
	detail: string | null;
	occurred_at: string;
};

type BookkeepingTarget = { repo: string; issue: number };

function parseTargets(raw: string | null | undefined): Record<string, BookkeepingTarget> | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const targets: Record<string, BookkeepingTarget> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!/^[a-z0-9_-]{1,64}$/.test(key)) return null;
			if (!value || typeof value !== "object") return null;
			const entry = value as Record<string, unknown>;
			if (typeof entry.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo)) {
				return null;
			}
			if (typeof entry.issue !== "number" || !Number.isInteger(entry.issue) || entry.issue < 1) {
				return null;
			}
			targets[key] = { repo: entry.repo, issue: entry.issue };
		}
		return targets;
	} catch {
		return null;
	}
}

/**
 * Runtime lazy bootstrap for the dedupe table; mirrors the run-envelope
 * ensure pattern (idempotent, cached per D1 database). Same DDL as
 * migrations/0019_issue_bookkeeping.sql.
 */
const readyByDb = new WeakMap<object, Promise<void>>();

export function ensureIssueBookkeepingTable(db: D1Database): Promise<void> {
	const existing = readyByDb.get(db as object);
	if (existing) return existing;
	const ready = (async () => {
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS ${TABLE} (
					dedupe_key TEXT PRIMARY KEY,
					source_task TEXT NOT NULL,
					target_key TEXT NOT NULL,
					operation TEXT NOT NULL CHECK (operation IN ('COMMENT','CLOSE')),
					status TEXT NOT NULL CHECK (status IN ('PERSISTED','DELIVERY_BLOCKED','OUTCOME_UNKNOWN')),
					issue_comment_id TEXT,
					url TEXT,
					detail TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				) WITHOUT ROWID`,
			)
			.run();
	})().catch((error) => {
		readyByDb.delete(db as object);
		throw error;
	});
	readyByDb.set(db as object, ready);
	return ready;
}

type StoredRow = {
	dedupe_key: string;
	source_task: string;
	target_key: string;
	operation: string;
	status: string;
	issue_comment_id: string | null;
	url: string | null;
	detail: string | null;
	occurred_at: string;
};

function normalizeRow(row: Record<string, unknown> | null): StoredRow | null {
	if (!row) return null;
	return {
		dedupe_key: String(row.dedupe_key ?? ""),
		source_task: String(row.source_task ?? ""),
		target_key: String(row.target_key ?? ""),
		operation: String(row.operation ?? ""),
		status: String(row.status ?? ""),
		issue_comment_id: row.issue_comment_id == null ? null : String(row.issue_comment_id),
		url: row.url == null ? null : String(row.url),
		detail: row.detail == null ? null : String(row.detail),
		occurred_at: String(row.updated_at ?? row.created_at ?? ""),
	};
}

function replayReceipt(row: StoredRow): IssueBookkeepingReceipt {
	return {
		status: "IDEMPOTENT_REPLAY",
		dedupe_key: row.dedupe_key,
		source_task: row.source_task,
		target_key: row.target_key,
		operation: row.operation as IssueBookkeepingReceipt["operation"],
		target: null,
		issue_comment_id: row.issue_comment_id,
		url: row.url,
		detail: row.detail,
		occurred_at: row.occurred_at,
	};
}

function rejected(
	command: { dedupe_key: string; source_task: string; target_key: string; operation: string },
	detail: string,
	occurredAt: string,
): IssueBookkeepingReceipt {
	return {
		status: "REJECTED_TARGET",
		dedupe_key: command.dedupe_key,
		source_task: command.source_task,
		target_key: command.target_key,
		operation: command.operation as IssueBookkeepingReceipt["operation"],
		target: null,
		issue_comment_id: null,
		url: null,
		detail,
		occurred_at: occurredAt,
	};
}

/**
 * Core bookkeeping processor (directly callable for tests; the MCP tool
 * handler wraps it with the state:write scope gate). One dedupe_key is
 * attempted exactly once: an unknown GitHub outcome stays OUTCOME_UNKNOWN and
 * the same key replays that row instead of re-throwing at GitHub.
 */
export async function submitIssueBookkeeping(input: {
	db: D1Database;
	command: unknown;
	token: string | null | undefined;
	targetsRaw: string | null | undefined;
	fetchImpl?: typeof fetch;
	now?: string;
	requestId?: string;
}): Promise<IssueBookkeepingReceipt> {
	const occurredAt = input.now ?? new Date().toISOString();
	const fetchImpl = input.fetchImpl ?? fetch;
	const parsed = ISSUE_BOOKKEEPING_INPUT_SCHEMA.safeParse(input.command);
	if (!parsed.success) {
		throw new StateGatewayError({
			code: "STATE_VALIDATION_FAILED",
			phase: "VALIDATE",
			message: "issue bookkeeping command does not match the submit_issue_bookkeeping schema",
			retryable: false,
			requestId: input.requestId,
		});
	}
	const command = parsed.data;
	if (command.operation === "COMMENT" && !command.body) {
		throw new StateGatewayError({
			code: "STATE_VALIDATION_FAILED",
			phase: "VALIDATE",
			message: "operation COMMENT requires body",
			retryable: false,
			requestId: input.requestId,
		});
	}
	const targets = parseTargets(input.targetsRaw);
	if (!targets) {
		// Whitelist absent or malformed is a server configuration failure:
		// refuse deterministically, persist nothing, leak nothing.
		return rejected(command, "bookkeeping targets not configured", occurredAt);
	}
	const target = targets[command.target_key];
	if (!target) {
		return rejected(command, "target_key is not whitelisted", occurredAt);
	}

	await ensureIssueBookkeepingTable(input.db);
	const existing = normalizeRow(
		await input.db
			.prepare(`SELECT * FROM ${TABLE} WHERE dedupe_key=?1`)
			.bind(command.dedupe_key)
			.first<Record<string, unknown>>(),
	);
	if (existing) {
		return replayReceipt(existing);
	}
	await input.db
		.prepare(
			`INSERT INTO ${TABLE} (
				dedupe_key, source_task, target_key, operation, status,
				issue_comment_id, url, detail, created_at, updated_at
			) VALUES (?1, ?2, ?3, ?4, 'OUTCOME_UNKNOWN', NULL, NULL, NULL, ?5, ?5)
			ON CONFLICT(dedupe_key) DO NOTHING`,
		)
		.bind(
			command.dedupe_key,
			command.source_task,
			command.target_key,
			command.operation,
			occurredAt,
		)
		.run();
	const raced = normalizeRow(
		await input.db
			.prepare(`SELECT * FROM ${TABLE} WHERE dedupe_key=?1`)
			.bind(command.dedupe_key)
			.first<Record<string, unknown>>(),
	);
	if (!raced) {
		throw new StateGatewayError({
			code: "STATE_UNAVAILABLE",
			phase: "WRITE",
			message: "bookkeeping dedupe row could not be reserved",
			retryable: true,
			requestId: input.requestId,
		});
	}
	if (raced.occurred_at !== occurredAt) {
		// Loser of the insert race replays the winner verbatim (same discipline
		// as run-envelope review F2) — one dedupe_key, one delivery attempt.
		return replayReceipt(raced);
	}

	if (!input.token) {
		await updateRow(input.db, command.dedupe_key, "DELIVERY_BLOCKED", null, null, "token_not_configured", occurredAt);
		return {
			status: "DELIVERY_BLOCKED",
			dedupe_key: command.dedupe_key,
			source_task: command.source_task,
			target_key: command.target_key,
			operation: command.operation,
			target,
			issue_comment_id: null,
			url: null,
			detail: "token_not_configured",
			occurred_at: occurredAt,
		};
	}

	const apiBase = `https://api.github.com/repos/${target.repo}`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${input.token}`,
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "quantpro-collector/issue-bookkeeping",
	};
	let response: Response | null = null;
	let transportFailed = false;
	try {
		response = await fetchImpl(
			command.operation === "COMMENT"
				? `${apiBase}/issues/${target.issue}/comments`
				: `${apiBase}/issues/${target.issue}`,
			{
				method: command.operation === "COMMENT" ? "POST" : "PATCH",
				headers: {
					...headers,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(
					command.operation === "COMMENT"
						? // COMMENT without body was rejected at the schema gate above;
							// the fallback is unreachable and keeps types honest.
							{ body: assembleBody(command.body ?? "", command.evidence_refs ?? null) }
						: { state: "closed" },
				),
			},
		);
	} catch {
		transportFailed = true;
	}
	if (response && response.ok) {
		const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
		const commentId =
			payload && typeof payload.id !== "undefined" ? String(payload.id) : null;
		const url =
			payload && typeof payload.html_url === "string" ? payload.html_url : null;
		await updateRow(input.db, command.dedupe_key, "PERSISTED", commentId, url, null, occurredAt);
		return {
			status: "PERSISTED",
			dedupe_key: command.dedupe_key,
			source_task: command.source_task,
			target_key: command.target_key,
			operation: command.operation,
			target,
			issue_comment_id: commentId,
			url,
			detail: null,
			occurred_at: occurredAt,
		};
	}
	const detail = transportFailed
		? "transport_failed"
		: response && (response.status === 429 || response.status >= 500)
			? `github_http_${response.status}`
			: response
				? `github_refused_http_${response.status}`
				: "empty_response";
	const status: IssueBookkeepingStatus =
		transportFailed || !response || response.status === 429 || response.status >= 500
			? "OUTCOME_UNKNOWN"
			: "DELIVERY_BLOCKED";
	await updateRow(input.db, command.dedupe_key, status, null, null, detail, occurredAt);
	return {
		status,
		dedupe_key: command.dedupe_key,
		source_task: command.source_task,
		target_key: command.target_key,
		operation: command.operation,
		target,
		issue_comment_id: null,
		url: null,
		detail,
		occurred_at: occurredAt,
	};
}

function assembleBody(body: string, evidenceRefs: string[] | null): string {
	if (!evidenceRefs || evidenceRefs.length === 0) return body;
	return `${body}\n\n${evidenceRefs.map((ref) => `- ${ref}`).join("\n")}`;
}

async function updateRow(
	db: D1Database,
	dedupeKey: string,
	status: "PERSISTED" | "DELIVERY_BLOCKED" | "OUTCOME_UNKNOWN",
	commentId: string | null,
	url: string | null,
	detail: string | null,
	occurredAt: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE ${TABLE}
			SET status=?2, issue_comment_id=?3, url=?4, detail=?5, updated_at=?6
			WHERE dedupe_key=?1`,
		)
		.bind(dedupeKey, status, commentId, url, detail, occurredAt)
		.run();
}
