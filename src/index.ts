import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { githubBearerToken, verifyGithubAccessToken } from "./github-auth";
import {
	readLiveUniverse,
	resolveLiveUniverseFreshness,
	writeLiveUniverse,
	type StoredLiveUniverse,
} from "./live-universe";
import { recordPortfolioUniverseObservation, type PortfolioDeltaState } from "./portfolio-delta";
import {
	LiveCoverageError,
	MARKET_READ_SCOPE,
	isLiveOverlayEnabled,
	projectCallerSnapshot,
	redactInstrumentCodes,
	resolveLiveOverlayStatus,
	resolveMarketReadLiveOverlayStatus,
	type LiveOverlayStatus,
} from "./live-overlay";
import {
	DynamicQuoteError,
	createTencentQuoteProvider,
	fetchDynamicQuoteRows,
	mergeDynamicQuoteRows,
} from "./dynamic-quotes";
import {
	PORTFOLIO_STATUS_MAX_PAYLOAD_BYTES,
	readPortfolioStatus,
	resolvePortfolioPresentation,
	writePortfolioStatus,
	type PortfolioAnchorView,
	type PortfolioPresentation,
	type StoredPortfolioStatus,
} from "./portfolio-status";
import { getSnapshotCounts, validateSnapshot, type QuoteSnapshot } from "./portfolio-validation";
import { toPublicQuoteSnapshot, type PublicQuoteSnapshot } from "./quote-projections";
import {
	fetchQuoteSnapshotFromCatalog,
	readQuoteCatalog,
	type StoredQuoteCatalog,
} from "./quote-catalog.ts";
import {
	FORWARDED_SCOPES_HEADER,
	FORWARDED_PRINCIPAL_HEADER,
	FORWARDED_ISSUER_HEADER,
	RESEARCH_CLAIM_SCOPE,
	RESEARCH_SUBMIT_SCOPE,
	resolveResearchScopes,
	resolveResearchPrincipal,
	resolveResearchIssuer,
	formalResearchOwner,
	permitsFormalResearchOperation,
} from "./research-scopes.ts";
import {
	claimResearchJob,
	deferResearchJob,
	listResearchJobReceipts,
	RESEARCH_IDEMPOTENCY_KEY_PATTERN,
	submitResearchResultProposal,
} from "./research-workflow.ts";
import { ingestResearchReplicaRecord, type ResearchReplicaStorage } from "./research-replica.ts";
import { CollectorResearchRemoteAdapter } from "./research-remote-adapter.ts";
import {
	RETENTION_CRON,
	runRetentionSweep,
	type RetentionDeps,
	type RetentionRunReport,
} from "./research-retention.ts";
import {
	ingestPrecomputedVectors,
	indexSemanticDocument,
	probeSemanticIndex,
	readSemanticIndexCoverage,
	runSemanticIndexBatch,
	SEMANTIC_BATCH_MAX_DOCS,
	SEMANTIC_QUERY_MAX_LIMIT,
	SEMANTIC_QUERY_MAX_QUERY_CHARS,
	type SemanticIndexDeps,
} from "./research-semantic-index.ts";
import { ResearchBoundaryError } from "./research-outbound-v2.ts";
import { ResearchReadBackendError, withResearchReadRetry } from "./research-read-retry.ts";
import {
	AUTOMATION_RUN_BEGIN_INPUT_SCHEMA,
	AUTOMATION_RUN_END_INPUT_SCHEMA,
	AUTOMATION_RUN_EVENT_INPUT_SCHEMA,
	AUTOMATION_RUN_HISTORY_INPUT_SCHEMA,
	AutomationRunLedgerError,
	beginAutomationRun,
	endAutomationRun,
	getAutomationRunHistory,
	recordAutomationRunEvent,
} from "./automation-run-ledger.ts";
import {
	getMarketCheckpoints,
	MARKET_CHECKPOINT_INPUT_SCHEMA,
	MARKET_LEDGER_SLOT_SCHEMA,
	MarketLedgerError,
} from "./market-ledger.ts";
import {
	appendStateBatch,
	getGatewayStatus,
	getStateSnapshot,
	getStateWriteReceipt,
	normalizeStateGatewayError,
	STATE_CHANNEL_SCHEMA,
	StateGatewayError,
	validateStateBatch,
	type StateGatewayPhase,
} from "./state-gateway.ts";
import {
	APPEND_CLOSE_EVENTS_INPUT_SCHEMA,
	APPEND_COMPANY_EVENTS_INPUT_SCHEMA,
	APPEND_INDUSTRY_EVENTS_INPUT_SCHEMA,
	APPEND_MARKET_OBSERVATION_INPUT_SCHEMA,
	appendInvestmentCommand,
	appendMarketObservation,
	isOwnedStateCommandPayload,
} from "./state-commands.ts";
import {
	RunEnvelopeError,
	SUBMIT_RUN_ENVELOPE_INPUT_SCHEMA,
	processRunEnvelope,
} from "./run-envelope.ts";
import {
	ISSUE_BOOKKEEPING_INPUT_SCHEMA,
	submitIssueBookkeeping,
} from "./issue-bookkeeping.ts";
import { runScheduleReconciliation } from "./automation-schedule.ts";
import { getProductionHealthSnapshot } from "./production-health.ts";
import {
	QUOTA_ACCOUNT_TAG,
	QUOTA_CATALOG_VERSION,
	admissionHandle,
	admissionMode,
	admitOperation,
	cronQuotaOutcome,
	legacyBreakerFlag,
	quotaHttpRefusal,
	quotaMcpRefusal,
	quotaStatus,
	QuotaGuardError,
	ReservationBudget,
	routeCostProfile,
	settleReservation,
	syncDimensionCatalog,
	createGuardedAi,
	createGuardedD1,
	createGuardedR2,
	QUOTA_DIMENSIONS,
} from "./quota-breaker.ts";
import { STATE_READ_SCOPE, STATE_WRITE_SCOPE } from "./state-scopes.ts";

const GITHUB_REPOSITORY = "zhushihao/quantpro-collector";
const GITHUB_ISSUE_NUMBER = 1;
const GITHUB_API_VERSION = "2022-11-28";

const RESEARCH_IDEMPOTENCY_KEY_SCHEMA = z
	.string()
	.min(8)
	.max(128)
	.regex(RESEARCH_IDEMPOTENCY_KEY_PATTERN);
const RESEARCH_IDEMPOTENCY_KEY_DESCRIPTION =
	" idempotency_key 必须为 8–128 个字符，仅允许 ASCII A-Z/a-z/0-9/:/_/-；`.`、`+` 和空格不合法。";

interface Env {
	GITHUB_TOKEN: string;
	PORTFOLIO_UNIVERSE?: KVNamespace;
	/** 内部 universe API / writer 保护 secret；不得作为 ChatGPT MCP client credential。 */
	PORTFOLIO_UNIVERSE_TOKEN?: string;
	/** 外部 QuantPro Collector MCP client credential（Cloudflare secret；不进入 Git / Prompt / tool schema）。 */
	COLLECTOR_MCP_CLIENT_TOKEN?: string;
	/** 该 credential 映射的非敏感生产 client identity，仅用于配置/审计说明。 */
	COLLECTOR_MCP_CLIENT_ID?: string;
	/** 空格或逗号分隔的批准 scopes；LIVE overlay 至少要求 market:read。 */
	COLLECTOR_MCP_CLIENT_SCOPES?: string;
	/** 静态直连客户端（无 OAuth 桥）登记的正式主体；未配置时保持旧行为（principal=null）。 */
	COLLECTOR_STATIC_CLIENT_PRINCIPAL?: string;
	/** 静态直连客户端登记的 issuer（origin URL）；仅参与 formal owner 哈希与审计。 */
	COLLECTOR_STATIC_CLIENT_ISSUER?: string;
	/** 转发主体头白名单（空格分隔，含桥身份）；未配置时保持旧行为（开放接受）。 */
	COLLECTOR_FORWARDABLE_PRINCIPALS?: string;
	RESEARCH_REPLICA?: D1Database;
	/** Multi-dimension 95% admission switch: `off` (default) | `enforce`. */
	QUOTA_ADMISSION_MODE?: string;
	/**
	 * Legacy 2026-09-29 daily prototype flag.  Inert by contract: it never opens
	 * a gate and is only reported so an operator cannot mistake it for protection.
	 */
	QUOTA_BREAKER_ENABLED?: string;
	CLOUDFLARE_API_TOKEN?: string;
	RESEARCH_OBJECTS?: R2Bucket;
	/**
	 * Task D bindings: Workers AI (`@cf/baai/bge-m3`) and the single PUBLIC
	 * Vectorize index `research-public-bge-m3-v1`.  Absent bindings disable the
	 * semantic surface with an explicit STORE_UNAVAILABLE; the lexical
	 * search_documents / get_document read face is unaffected.
	 */
	AI?: Ai;
	RESEARCH_PUBLIC_INDEX?: Vectorize;
	/** RESEARCH 私有 transport credential；ingest 与 receipts 共用，不与 market/research OAuth scopes 混用。 */
	RESEARCH_REPLICA_INGEST_TOKEN?: string;
	/** 非敏感部署标识；由发布命令注入，用于生产版本核验。 */
	DEPLOYED_GIT_SHA?: string;
	/** issue #52：受控记账白名单（JSON：target_key → {repo, issue}）；缺失/非法时全部 REJECTED_TARGET。 */
	COLLECTOR_BOOKKEEPING_TARGETS?: string;
	CF_VERSION_METADATA?: {
		id: string;
		tag: string;
		timestamp: string;
	};
}

/**
 * §A8 ingest 请求体尺寸门（2 MiB）：覆盖 1 MiB chunk 的 base64 形态
 * （≈1.4 MB）+ record 开销。Content-Length 预检 + 读体后 byteLength
 * 实测双道；超限 → 413 + RATE_LIMITED 信封。
 */
export const RESEARCH_INGEST_MAX_BODY_BYTES = 2 * 1024 * 1024;

type BridgePayload = {
	schema_version: "1.0";
	bridge: {
		last_attempt_at: string;
		last_attempt_status: "SUCCESS" | "FAIL";
		last_success_at: string | null;
		workflow_run_id: string;
		workflow_run_attempt: string;
		source: string;
		error: string | null;
	};
	snapshot: QuoteSnapshot | PublicQuoteSnapshot | null;
};

type GitHubIssue = {
	body?: string | null;
};

type UpstreamSnapshotResult = {
	snapshot: QuoteSnapshot;
	source: string;
};

type BridgeStageContext = {
	runId: string;
	cron: string;
};

class BridgeError extends Error {
	readonly stage: string;
	readonly httpStatus: number | null;

	constructor(stage: string, message: string, httpStatus: number | null = null) {
		super(message);
		this.name = "BridgeError";
		this.stage = stage;
		this.httpStatus = httpStatus;
	}
}

const JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)\s*```/i;

function parsePreviousBridge(body: string | null | undefined): {
	snapshot: QuoteSnapshot | PublicQuoteSnapshot | null;
	lastSuccessAt: string | null;
} {
	if (!body) {
		return { snapshot: null, lastSuccessAt: null };
	}

	const match = body.match(JSON_BLOCK_PATTERN);
	if (!match) {
		return { snapshot: null, lastSuccessAt: null };
	}

	try {
		const payload = JSON.parse(match[1]) as Partial<BridgePayload>;
		return {
			snapshot: payload.snapshot ?? null,
			lastSuccessAt: payload.bridge?.last_success_at ?? null,
		};
	} catch {
		return { snapshot: null, lastSuccessAt: null };
	}
}

function createIssueBody(payload: BridgePayload): string {
	return [
		"# A/H 行情计划任务数据桥",
		"",
		"> 机器数据。由 Cloudflare Worker Cron 自动刷新；GitHub Actions 仅用于手工补跑。本载荷为 quote-only（public_quote_snapshot/1），不含任何持仓身份/数量字段；LIVE 持仓真相由受鉴权 quote-universe/1 动态层承接；请勿手工编辑 JSON 区域。",
		"",
		"```json",
		JSON.stringify(payload, null, 2),
		"```",
	].join("\n");
}

function githubHeaders(token: string): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": "cn-hk-quotes-cloudflare-bridge/1.0",
	};
}

function bridgeContext(workflowRunId: string): BridgeStageContext {
	return {
		runId: workflowRunId,
		cron: workflowRunId.startsWith("cron:")
			? workflowRunId.slice("cron:".length) || "manual-test"
			: workflowRunId === "test:scheduled"
				? "manual-test"
				: "manual",
	};
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/authorization\s*:\s*[^,\s]+/gi, "authorization: [REDACTED]")
		.replace(/bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
		.slice(0, 500);
}

/**
 * 面向调用方的错误文本（issue #15 / D-1 要求 2）：
 *
 * 在 `safeErrorMessage()`（遮蔽凭据）之上再去掉证券代码形态——coverage 缺失、
 * identity、stale 等任何出口都不得带出真实代码，缺失**数量**保留。
 * `safeErrorMessage()` 本身仍是服务端日志口径（可保留明细）。
 */
function clientFacingErrorMessage(error: unknown): string {
	return redactInstrumentCodes(safeErrorMessage(error));
}

function logBridgeStage(
	context: BridgeStageContext,
	stage: string,
	details: Record<string, unknown> = {},
): void {
	console.log(
		JSON.stringify({
			event: "quote_bridge",
			timestamp: new Date().toISOString(),
			run_id: context.runId,
			cron: context.cron,
			stage,
			...details,
		}),
	);
}

function logBridgeFailure(
	context: BridgeStageContext,
	error: unknown,
	fallbackStage: string,
): void {
	const bridgeError = error instanceof BridgeError ? error : null;
	logBridgeStage(context, "bridge_failed", {
		failed_stage: bridgeError?.stage ?? fallbackStage,
		http_status: bridgeError?.httpStatus ?? null,
		error_type: error instanceof Error ? error.name : typeof error,
		error_message: safeErrorMessage(error),
	});
}

const MARKET_READ_AUTH_MODE = "BEARER_CLIENT_CREDENTIAL" as const;

/** Sanitized production-principal audit fields. Never contains a bearer/secret. */
function marketReadAuditFields(env: Env | undefined, liveOverlayStatus: LiveOverlayStatus) {
	const authenticated = isLiveOverlayEnabled(liveOverlayStatus);
	return {
		auth_mode: MARKET_READ_AUTH_MODE,
		authenticated,
		client_id: authenticated ? env?.COLLECTOR_MCP_CLIENT_ID?.trim() || null : null,
		scopes: authenticated ? [MARKET_READ_SCOPE] : [],
	};
}

/** KV 中的 LIVE 面（投影 + 状态件）与推导出的消费侧呈现口径。 */
type LivePresentation = {
	universe: StoredLiveUniverse | null;
	status: StoredPortfolioStatus | null;
	presentation: PortfolioPresentation;
};

async function readPortfolioStatusSafe(kv: KVNamespace): Promise<StoredPortfolioStatus | null> {
	try {
		return await readPortfolioStatus(kv);
	} catch {
		// 状态件损坏 / 非法 → 按「无件」口径保守呈现（C-3），不把消费面拖入硬失败。
		return null;
	}
}

/**
 * C-4/C-5 的单一出口：读 KV 的投影与状态件，解析双轨新鲜度锚，推导三态呈现口径。
 *
 * - `tolerateUnreadableUniverse`：诊断面（`/api/control-plane-status`）沿用既有
 *   「读失败 = present=false」口径；供数面保持 fail-closed（读失败向上抛，与迁移前一致）。
 */
async function resolveLivePresentation(
	kv: KVNamespace | undefined,
	now = new Date(),
	options: { tolerateUnreadableUniverse?: boolean } = {},
): Promise<LivePresentation> {
	if (!kv) {
		return {
			universe: null,
			status: null,
			presentation: resolvePortfolioPresentation({
				universePresent: false,
				universeContentHash: null,
				universeManifestHash: null,
				status: null,
				anchor: null,
				now,
			}),
		};
	}
	let universe: StoredLiveUniverse | null = null;
	if (options.tolerateUnreadableUniverse) {
		try {
			universe = await readLiveUniverse(kv);
		} catch {
			universe = null;
		}
	} else {
		universe = await readLiveUniverse(kv);
	}
	const status = await readPortfolioStatusSafe(kv);
	// LRCCA 缺失（无状态件 / 不可读 / 字段为空）→ generated_at 兜底锚（anchor_fallback=true）。
	let anchorView: PortfolioAnchorView | null = null;
	if (universe) {
		const anchor = resolveLiveUniverseFreshness(universe, {
			lrcca: status?.last_real_complete_confirmed_at ?? null,
			now,
		});
		anchorView = {
			anchor: anchor.anchor,
			anchor_fallback: anchor.anchor_fallback,
			fresh: anchor.fresh,
		};
	}
	const presentation = resolvePortfolioPresentation({
		universePresent: universe !== null,
		universeContentHash: universe?.content_hash ?? null,
		universeManifestHash: universe?.source_manifest_hash ?? null,
		status,
		anchor: anchorView,
		now,
	});
	return { universe, status, presentation };
}

/**
 * C1 dynamic quote completion is deliberately before the existing coverage
 * gate.  The gate remains the final authority: a provider error, malformed
 * code, or partial batch never contributes rows and therefore never turns an
 * incomplete LIVE universe into a successful response.
 */
async function completeMissingLiveQuotes(
	snapshot: QuoteSnapshot,
	universe: StoredLiveUniverse,
): Promise<QuoteSnapshot> {
	const catalogKeys = new Set(snapshot.stocks.map((row) => `${row.market}:${row.code}`));
	const missing = universe.active.filter(
		(identity) => !catalogKeys.has(`${identity.market}:${identity.code}`),
	);
	if (missing.length === 0) return snapshot;
	try {
		const batch = await fetchDynamicQuoteRows(missing, {
			fetchQuote: createTencentQuoteProvider(),
		});
		return mergeDynamicQuoteRows(snapshot, batch);
	} catch (error) {
		if (error instanceof DynamicQuoteError) {
			throw new BridgeError("dynamic_quote_fetch", error.code);
		}
		throw error;
	}
}

async function ensurePrivateQuoteCatalog(
	context: BridgeStageContext,
	env: Env,
): Promise<StoredQuoteCatalog> {
	if (!env.PORTFOLIO_UNIVERSE) {
		throw new BridgeError("quote_catalog", "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED");
	}
	const existing = await readQuoteCatalog(env.PORTFOLIO_UNIVERSE);
	if (!existing) throw new BridgeError("quote_catalog", "PRIVATE_QUOTE_CATALOG_MISSING");
	return existing;
}

async function fetchPrivateCatalogSnapshot(
	context: BridgeStageContext,
	env: Env,
	options: UpstreamFetchOptions = {},
): Promise<UpstreamSnapshotResult> {
	const catalog = await ensurePrivateQuoteCatalog(context, env);
	let snapshot: QuoteSnapshot;
	try {
		snapshot = await fetchQuoteSnapshotFromCatalog(catalog);
	} catch (error) {
		if (error instanceof DynamicQuoteError) {
			throw new BridgeError("dynamic_quote_fetch", error.code);
		}
		throw error;
	}

	const liveOverlayStatus = options.liveOverlayStatus ?? "SKIPPED_UNAUTHORIZED";
	let projectedSnapshot = snapshot;
	if (env.PORTFOLIO_UNIVERSE && isLiveOverlayEnabled(liveOverlayStatus)) {
		const live = await resolveLivePresentation(env.PORTFOLIO_UNIVERSE, new Date());
		const snapshotForOverlay =
			live.universe && live.presentation.apply_overlay
				? await completeMissingLiveQuotes(snapshot, live.universe)
				: snapshot;
		projectedSnapshot = projectCallerSnapshot({
			snapshot: snapshotForOverlay,
			liveOverlayStatus,
			universeBound: true,
			universe: live.universe,
			applyOverlay: live.presentation.apply_overlay,
		}).snapshot;
	}
	logBridgeStage(context, "private_catalog_quote_refresh", {
		catalog_rows: catalog.items.length,
		live_overlay_status: liveOverlayStatus,
	});
	return { snapshot: projectedSnapshot, source: "PRIVATE_KV_DIRECT_TENCENT" };
}

/** 私有 catalog 刷新默认不应用 LIVE overlay；只有显式 ENABLED 的调用方可叠加。 */
type UpstreamFetchOptions = {
	liveOverlayStatus?: LiveOverlayStatus;
};

async function fetchPublicQuoteSnapshot(
	context: BridgeStageContext,
	env?: Env,
): Promise<PublicQuoteSnapshot> {
	if (!env) throw new BridgeError("quote_catalog", "runtime env is required");
	const upstream = await fetchPrivateCatalogSnapshot(context, env);
	return toPublicQuoteSnapshot(upstream.snapshot);
}

const PUBLIC_QUOTES_UNAVAILABLE_MESSAGE = "Public quote snapshot is unavailable";

export async function updateQuoteBridge(
	env: Env,
	workflowRunId: string,
	workflowRunAttempt = "1",
): Promise<BridgePayload> {
	const context = bridgeContext(workflowRunId);

	if (!env.GITHUB_TOKEN) {
		throw new BridgeError("token_check", "GITHUB_TOKEN secret is not configured");
	}

	const issueUrl = `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${GITHUB_ISSUE_NUMBER}`;
	logBridgeStage(context, "issue_get_start");
	let currentResponse: Response;
	try {
		currentResponse = await fetch(issueUrl, {
			method: "GET",
			headers: githubHeaders(env.GITHUB_TOKEN),
		});
	} catch (error) {
		throw new BridgeError("issue_get", safeErrorMessage(error));
	}
	if (!currentResponse.ok) {
		throw new BridgeError(
			"issue_get",
			`GitHub issue read failed with HTTP ${currentResponse.status}`,
			currentResponse.status,
		);
	}
	logBridgeStage(context, "issue_get_success", {
		http_status: currentResponse.status,
	});

	const currentIssue = (await currentResponse.json()) as GitHubIssue;
	const previous = parsePreviousBridge(currentIssue.body);
	const now = new Date().toISOString();
	let payload: BridgePayload;
	let upstreamError: BridgeError | null = null;

	try {
		// env 仅用于受保护 quote proxy 的 Access 服务令牌；不传叠加门参，
		// 叠加（LIVE overlay / KV 读取）在 cron 路径结构上仍不可能发生。
		const upstream = await fetchPrivateCatalogSnapshot(context, env);
		payload = {
			schema_version: "1.0",
			bridge: {
				last_attempt_at: now,
				last_attempt_status: "SUCCESS",
				last_success_at: now,
				workflow_run_id: workflowRunId,
				workflow_run_attempt: workflowRunAttempt,
				source: upstream.source,
				error: null,
			},
			// Issue #1 是公开面（repo 为 public）：载荷一律投影为 quote-only。
			snapshot: toPublicQuoteSnapshot(upstream.snapshot),
		};
	} catch (error) {
		upstreamError =
			error instanceof BridgeError
				? error
				: new BridgeError("upstream_fetch", safeErrorMessage(error));
		payload = {
			schema_version: "1.0",
			bridge: {
				last_attempt_at: now,
				last_attempt_status: "FAIL",
				last_success_at: previous.lastSuccessAt,
				workflow_run_id: workflowRunId,
				workflow_run_attempt: workflowRunAttempt,
				source: "PRIVATE_KV_DIRECT_TENCENT",
				error: `${upstreamError.name}: ${upstreamError.message}`,
			},
			// 失败回退的历史快照同样投影，防止把身份字段重新写回公开 issue。
			snapshot: previous.snapshot ? toPublicQuoteSnapshot(previous.snapshot) : null,
		};
	}

	logBridgeStage(context, "issue_patch_start");
	let updateResponse: Response;
	try {
		updateResponse = await fetch(issueUrl, {
			method: "PATCH",
			headers: {
				...githubHeaders(env.GITHUB_TOKEN),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ body: createIssueBody(payload) }),
		});
	} catch (error) {
		throw new BridgeError("issue_patch", safeErrorMessage(error));
	}
	if (!updateResponse.ok) {
		throw new BridgeError(
			"issue_patch",
			`GitHub issue update failed with HTTP ${updateResponse.status}`,
			updateResponse.status,
		);
	}
	logBridgeStage(context, "issue_patch_success", {
		http_status: updateResponse.status,
	});

	if (upstreamError) {
		throw upstreamError;
	}

	logBridgeStage(context, "bridge_success", {
		// 旧（v4 富件）与新（public_quote_snapshot/1）两种载荷各自带版本字段。
		portfolio_version:
			payload.snapshot == null
				? null
				: "portfolio_version" in payload.snapshot
					? payload.snapshot.portfolio_version
					: payload.snapshot.schema_version,
		snapshot_time: payload.snapshot?.snapshot_time ?? null,
		stock_count: payload.snapshot?.stocks.length ?? 0,
	});

	return payload;
}

/** Server-owned billing account id for the admission ledger. */
function quotaAccountId(): string {
	return QUOTA_ACCOUNT_TAG;
}

/**
 * Multi-dimension admission (SDD CQ spec §"准入、原子性、异步和恢复合同").
 *
 * `off` (default) performs no gating.  `enforce` requires an ADMITTED
 * reservation for every `heavy_bounded` route and refuses every
 * `heavy_unbounded` route outright; with no verified account baseline the ledger
 * denies by construction, so the safe state is CLOSED rather than a modelled
 * "95% guarantee".
 */
async function admitHeavyRouteForEnv(
	env: Env | undefined,
	args: { route: string; operation_id: string; fingerprint: string },
): Promise<{
	handle: NonNullable<ReturnType<typeof admissionHandle>>;
	budget: ReservationBudget;
	result: { status: string; reservation_id?: string };
}> {
	const profile = routeCostProfile(args.route);
	if (!profile) {
		throw new QuotaGuardError(
			"QUOTA_GUARD_UNAVAILABLE",
			`route ${args.route} is not classified in the cost catalog`,
		);
	}
	if (profile.cost_class === "heavy_unbounded") {
		throw new QuotaGuardError(
			"QUOTA_GUARD_UNAVAILABLE",
			`route ${args.route} has no provable per-operation upper bound`,
		);
	}
	const db = env?.RESEARCH_REPLICA;
	if (!db)
		throw new QuotaGuardError("QUOTA_GUARD_UNAVAILABLE", "admission ledger binding is missing");
	const catalogOk = await ensureDimensionCatalog(db).then(
		() => true,
		() => false,
	);
	if (!catalogOk) {
		throw new QuotaGuardError(
			"QUOTA_GUARD_UNAVAILABLE",
			"dimension catalog is not synchronised",
		);
	}
	const result = await admitOperation(
		db,
		{
			operation_id: args.operation_id,
			fingerprint: args.fingerprint,
			route: args.route,
			dimensions: profile.dimensions,
		},
		{ account_id: quotaAccountId() },
	);
	if (result.status === "DENIED") {
		const code = result.reason === "limit" ? "QUOTA_CIRCUIT_OPEN" : "QUOTA_GUARD_UNAVAILABLE";
		// Operators can only fix what the logs name: the reason and refusing
		// dimension carry no secrets and are the sole signal for baseline repair.
		console.log(
			JSON.stringify({
				event: "quota_admission_denied",
				timestamp: new Date().toISOString(),
				route: args.route,
				operation_id: args.operation_id,
				reason: result.reason,
				dimension: result.dimension_key ?? null,
				detail: result.detail,
			}),
		);
		throw new QuotaGuardError(code, `admission denied (${result.reason}) for ${args.route}`);
	}
	if (result.status === "REPLAY") {
		throw new QuotaGuardError(
			"QUOTA_GUARD_UNAVAILABLE",
			`operation ${args.operation_id} already completed; refusing to repeat it`,
		);
	}
	const handle = admissionHandle(result, {
		operation_id: args.operation_id,
		route: args.route,
	});
	if (!handle) throw new QuotaGuardError("QUOTA_GUARD_UNAVAILABLE", "admission handle missing");
	return { handle, budget: new ReservationBudget(handle), result };
}

/**
 * Settle a reservation with the platform-observed practical usage.  Used by the
 * guarded ingest path; a rejection keeps the reservation (never a silent
 * "corrected" write).
 */
async function settleObserved(
	env: Env | undefined,
	reservationId: string,
	observed: { dimension_key: never; units: number }[],
	reason: string,
): Promise<void> {
	const db = env?.RESEARCH_REPLICA;
	if (!db || observed.length === 0) return;
	await settleReservation(db, {
		reservation_id: reservationId,
		observed,
		reason,
	}).catch(() => undefined);
}

/**
 * Declared-bound charge for routes whose internal calls are not yet metered per
 * dimension (MCP heavy tools).  Conservative: the whole declared bound is
 * charged, so a later settlement can never under-count; the residual gap is
 * reported in the implementation report.
 */
async function chargeDeclaredBoundForEnv(
	env: Env | undefined,
	result: { status: string; reservation_id?: string },
): Promise<void> {
	const db = env?.RESEARCH_REPLICA;
	if (!db || result.status !== "ADMITTED" || !result.reservation_id) return;
	const reserved = await db
		.prepare(
			`SELECT dimension_key, units FROM quota_reservation_units WHERE reservation_id = ?`,
		)
		.bind(result.reservation_id)
		.all<{ dimension_key: string; units: number }>();
	const observed = (reserved.results ?? []).map((row) => ({
		dimension_key: row.dimension_key as never,
		units: Number(row.units),
	}));
	await settleObserved(env, result.reservation_id, observed, "declared_bound_charged");
}

/**
 * Dimension-catalog synchronisation cache, keyed by the concrete D1 binding and
 * the catalog version.  The write is bounded (one row per catalog dimension, once
 * per isolate per version); a failure clears the entry so the next admission
 * retries instead of trusting a half-written catalog.  Catalog rows are copied
 * into D1 so the admission guard can reject a stale or edited ceiling.
 */
const dimensionCatalogReady = new WeakMap<D1Database, Map<string, Promise<void>>>();

function ensureDimensionCatalog(db: D1Database): Promise<void> {
	let byVersion = dimensionCatalogReady.get(db);
	if (!byVersion) {
		byVersion = new Map();
		dimensionCatalogReady.set(db, byVersion);
	}
	const key = QUOTA_CATALOG_VERSION;
	let ready = byVersion.get(key);
	if (!ready) {
		ready = syncDimensionCatalog(db, QUOTA_DIMENSIONS).catch((error) => {
			byVersion!.delete(key);
			throw error;
		});
		byVersion.set(key, ready);
	}
	return ready;
}

/**
 * MCP server 工厂（每个 HTTP 请求构造一次，`ctx.requestInfo` 即原始请求）。
 *
 * `liveOverlayStatus` 缺省 `SKIPPED_UNAUTHORIZED` 是**有意的 fail-closed**：
 * 只有 `fetch()` 路由把请求头判定结果显式传进来时才可能应用 LIVE 叠加。
 * `researchScopes` 由 `fetch()` 按 §A4 解析（凭据逐字节匹配 + 转发头 ∩ 配置
 * 上限），写工具各查各的 scope，无任何蕴含关系。`researchPrincipal` 是 OAuth
 * 桥从已验证 grant props 盖章的稳定业务主体（#19：不是动态 DCR client_id），
 * 仅在内部 bridge credential 匹配时被接受。
 */
export function createServer(
	env?: Env,
	liveOverlayStatus: LiveOverlayStatus = "SKIPPED_UNAUTHORIZED",
	researchScopes: ReadonlySet<string> = new Set(),
	researchPrincipal: string | null = null,
	researchIssuer: string | null = null,
) {
	const server = new McpServer({
		name: "QuantPro Collector",
		version: "1.3.1",
	});

	/**
	 * MCP tool registration wrapper: every registered tool is classified by the
	 * entrypoint cost catalog (`src/quota-entrypoints.ts`), and the coverage test
	 * fails when a new tool is not classified.
	 *
	 * Enforce mode:
	 *   - `heavy_unbounded` is refused outright with `isError: true` and the
	 *     machine-readable `QUOTA_GUARD_UNAVAILABLE` body (no provable bound):
	 *     AI embedding, semantic search and the retention sweep stay closed.
	 *   - `heavy_bounded` requires a VERIFIED per-dimension baseline and an
	 *     ADMITTED cap reservation before the first paid side effect; its
	 *     declared units are caps that exceed any real per-call cost, and
	 *     over-cap actuals keep the reservation and halt the route.
	 *   - `light_read` keeps its declared cap and is billed on arrival, never
	 *     refused by the guard. Control and zero-declared-cost paths remain
	 *     unguarded; the route catalog does not establish account-wide quota
	 *     coverage.
	 *
	 * A caller with no scope basis is refused before admission. A caller with
	 * insufficient tool-specific scope could otherwise reserve before the handler
	 * checks authorization; heavy admission therefore runs only for callers that
	 * carry a research scope or principal.
	 */
	const rawRegisterTool = server.registerTool.bind(server) as unknown as (
		name: string,
		config: unknown,
		handler: (...args: never[]) => unknown,
	) => unknown;
	const registerToolImplementation = (
		name: string,
		config: unknown,
		handler: (...args: never[]) => unknown,
	) => {
		const route = `mcp:${name}`;
		const guarded = async (...args: never[]) => {
			const profile = routeCostProfile(route);
			const requestId = crypto.randomUUID().replaceAll("-", "");
			if (!profile) {
				return quotaMcpRefusal("QUOTA_GUARD_UNAVAILABLE", requestId);
			}
			let admission: Awaited<ReturnType<typeof admitHeavyRoute>> | null = null;
			if (admissionMode(env) === "enforce") {
				if (profile.cost_class === "heavy_unbounded") {
					return quotaMcpRefusal("QUOTA_GUARD_UNAVAILABLE", requestId);
				}
				if (
					profile.cost_class === "heavy_bounded" &&
					researchScopes.size === 0 &&
					researchPrincipal === null
				) {
					// No scope basis at all: never run heavy work unguarded.  The
					// handler would deny on its scope check; refusing here also keeps
					// the paid path closed for an unauthenticated caller.
					return quotaMcpRefusal("QUOTA_GUARD_UNAVAILABLE", requestId);
				}
				if (
					profile.cost_class === "heavy_bounded" &&
					(researchScopes.size > 0 || researchPrincipal !== null)
				) {
					const digest = await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode([route, requestId].join("\u0000")),
					);
					const fingerprint = [...new Uint8Array(digest)]
						.map((byte) => byte.toString(16).padStart(2, "0"))
						.join("");
					try {
						admission = await admitHeavyRoute({
							route,
							operation_id: `${route}:${requestId}`,
							fingerprint,
						});
					} catch (error) {
						return quotaMcpRefusal(
							error instanceof QuotaGuardError
								? error.error_code
								: "QUOTA_GUARD_UNAVAILABLE",
							requestId,
						);
					}
				}
			}
			try {
				return await handler(...args);
			} finally {
				// The declared bound is charged once the handler settled: a scope
				// refusal still consumes the declared bound (conservative), and a
				// crashed handler leaves the reservation live instead of losing it.
				if (admission) await chargeDeclaredBound(admission.result);
			}
		};
		return rawRegisterTool(name, config, guarded);
	};
	/**
	 * Asserted to the SDK signature so call sites keep the schema-derived handler
	 * typing; the implementation above only adds the cost-catalog gate.
	 */
	const registerTool = registerToolImplementation as unknown as typeof server.registerTool;

	// 保留测试工具，确认 MCP 基础链路持续正常
	registerTool(
		"calculate",
		{
			description: "执行基础四则运算，仅用于 MCP 连通性测试",
			inputSchema: z.object({
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			}),
		},
		async ({ operation, a, b }) => {
			let result: number;

			switch (operation) {
				case "add":
					result = a + b;
					break;
				case "subtract":
					result = a - b;
					break;
				case "multiply":
					result = a * b;
					break;
				case "divide":
					if (b === 0) {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: "Error: Cannot divide by zero",
								},
							],
						};
					}
					result = a / b;
					break;
			}

			return {
				content: [{ type: "text", text: String(result) }],
			};
		},
	);

	// 正式行情工具
	registerTool(
		"get_portfolio_quotes",
		{
			description:
				"获取 A/H 结构化行情快照。LIVE 动态持仓由 Cloudflare quote-universe/1 层独立驱动，且仅对通过 QuantPro Collector MCP client credential 并获批 market:read scope 的调用方生效；该外部 credential 与内部 PORTFOLIO_UNIVERSE_TOKEN 解耦。匿名/未授权调用继续返回 quote-only 投影视图，不含任何持仓身份/数量字段，并在 control_plane_status.live_overlay_status 标注 SKIPPED_*。仅用于只读行情查询。",
			inputSchema: z.object({}),
		},
		async () => {
			const context = bridgeContext("mcp:get_portfolio_quotes");
			try {
				if (!env) throw new BridgeError("quote_catalog", "runtime env is required");
				const upstream = await fetchPrivateCatalogSnapshot(context, env, {
					liveOverlayStatus,
				});
				// 双契约（issue #7 Step 2）：有效 bearer 保留完整 LIVE 语义；
				// 匿名 / 未授权调用投影为 quote-only（白名单 + 精确键断言）。
				const displaySnapshot = isLiveOverlayEnabled(liveOverlayStatus)
					? upstream.snapshot
					: toPublicQuoteSnapshot(upstream.snapshot);
				const controlPlaneStatus = env
					? {
							...(await getControlPlaneStatus(env)),
							live_overlay_status: liveOverlayStatus,
							market_read_auth: marketReadAuditFields(env, liveOverlayStatus),
						}
					: {
							status: "DEGRADED",
							github_private_read: false,
							kv_bound: false,
							universe_present: false,
							universe_fresh: false,
							portfolio_state: "PORTFOLIO_UNKNOWN",
							stale: true,
							freshness_anchor: null,
							freshness_anchor_fallback: false,
							mode: "LEGACY_FALLBACK",
							live_overlay_status: liveOverlayStatus,
							market_read_auth: marketReadAuditFields(env, liveOverlayStatus),
						};
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ...displaySnapshot, control_plane_status: controlPlaneStatus },
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				logBridgeFailure(context, error, "upstream_fetch");
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: "UPSTREAM_FETCH_ERROR",
									message: clientFacingErrorMessage(error),
								},
								null,
								2,
							),
						},
					],
				};
			}
		},
	);

	registerTool(
		"get_public_quotes",
		{
			description: "获取不含持仓身份的 A/H 公开行情快照。仅返回行情、时间和质量字段。",
			inputSchema: z.object({}),
		},
		async () => {
			const context = bridgeContext("mcp:get_public_quotes");
			try {
				const snapshot = await fetchPublicQuoteSnapshot(context, env);
				return {
					content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
				};
			} catch (error) {
				logBridgeFailure(context, error, "public_quotes");
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: "UPSTREAM_UNAVAILABLE",
									message: PUBLIC_QUOTES_UNAVAILABLE_MESSAGE,
								},
								null,
								2,
							),
						},
					],
				};
			}
		},
	);

	registerTool(
		"get_control_plane_status",
		{
			description:
				"只读检查 LIVE 持仓私有控制面是否可用。仅返回私有 GitHub 可读、Cloudflare KV binding、universe 是否存在/新鲜、当前模式和本请求的 LIVE 叠加门判定（live_overlay_status）；不返回持仓代码、数量、hash 或凭据。",
			inputSchema: z.object({}),
		},
		async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							...(await getControlPlaneStatus(env ?? ({} as Env))),
							live_overlay_status: liveOverlayStatus,
							market_read_auth: marketReadAuditFields(env, liveOverlayStatus),
						},
						null,
						2,
					),
				},
			],
		}),
	);

	// C7: these tools deliberately use only the Collector-owned C5 replica.
	// They do not share market/LIVE authorization, and the default research
	// scope is PUBLIC.  PRIVATE remains unavailable until a separate future
	// research-read scope is wired; it never falls through from this surface.
	// 写面（claim/submit）各由独立 research scope 门控（§A4）；scope 缺失 →
	// isError + FILTERED 信封 + 服务端结构化日志（request_id + 主体）。
	const researchAdapter = () => {
		const storage = env ? researchReplicaStorage(env) : null;
		if (!storage) {
			throw new ResearchReadBackendError(
				"DETERMINISTIC",
				"REPLICA_BINDING_UNAVAILABLE",
				"ConfigurationError",
			);
		}
		return new CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	};
	const researchWorkflowDb = () => {
		const storage = env ? researchReplicaStorage(env) : null;
		if (!storage) throw new ResearchBoundaryError("STORE_UNAVAILABLE");
		return storage.db;
	};
	const quotaEnforced = () => admissionMode(env) === "enforce";
	const admitHeavyRoute = (args: { route: string; operation_id: string; fingerprint: string }) =>
		admitHeavyRouteForEnv(env, args);
	const chargeDeclaredBound = (result: { status: string; reservation_id?: string }) =>
		chargeDeclaredBoundForEnv(env, result);
	const researchDomain = async (operation: () => Promise<unknown>) => {
		try {
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) },
				],
			};
		} catch (error) {
			if (error instanceof QuotaGuardError) {
				return quotaMcpRefusal(error.error_code, crypto.randomUUID().replaceAll("-", ""));
			}
			const safe =
				error instanceof ResearchBoundaryError
					? error.asError()
					: new ResearchBoundaryError("STORE_UNAVAILABLE").asError();
			return {
				isError: true,
				content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
			};
		}
	};
	const researchRead = <T>(tool: string, operation: () => Promise<T>) => {
		const requestId = crypto.randomUUID().replaceAll("-", "");
		const gate = async () => {
			if (!quotaEnforced()) return;
			const profile = routeCostProfile(`mcp:${tool}`);
			// Read-only routes are billed on arrival and may degrade safely; only a
			// route the catalog cannot classify or that has no provable bound is
			// refused.  A local day counter is never treated as a 95% guarantee.
			if (profile && profile.cost_class !== "heavy_unbounded") return;
			throw new QuotaGuardError(
				"QUOTA_GUARD_UNAVAILABLE",
				`read tool ${tool} is not covered by a provable cost profile`,
			);
		};
		return researchDomain(async () => {
			await gate();
			return withResearchReadRetry(operation, {
				requestId,
				tool,
				onFailure: (failure) => {
					console.warn(
						JSON.stringify({
							event: "research_read_failure",
							timestamp: new Date().toISOString(),
							...failure,
						}),
					);
				},
			});
		});
	};
	const researchWrite = researchDomain;
	const callerPrincipal = (): Promise<string | null> =>
		formalResearchOwner(researchIssuer, researchPrincipal);
	const requireResearchScope = (scope: string, tool: string) => {
		if (researchScopes.has(scope)) return null;
		const safe = new ResearchBoundaryError("FILTERED").asError();
		// 结构化审计日志：仅 request_id 与主体名，绝无 token / claim_token。
		console.log(
			JSON.stringify({
				event: "research_tool_scope_denied",
				timestamp: new Date().toISOString(),
				tool,
				required_scope: scope,
				granted_scopes: [...researchScopes].sort(),
				principal: researchPrincipal ?? "unverified-principal",
				request_id: safe.request_id,
			}),
		);
		return {
			isError: true as const,
			content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
		};
	};
	const requireFormalResearchClient = (tool: string, requiredScope: string) => {
		// #19：正式身份 = 已验证 stable principal + issuer + 必需 scope；
		// Job eligibility 完全由服务端记录/租约状态裁决，job_id 格式不参与授权。
		if (
			permitsFormalResearchOperation({
				principal: researchPrincipal,
				issuer: researchIssuer,
				scopes: researchScopes,
				requiredScope,
			})
		)
			return null;
		const safe = new ResearchBoundaryError("FILTERED").asError();
		console.log(
			JSON.stringify({
				event: "research_tool_client_denied",
				tool,
				principal: researchPrincipal ?? null,
				request_id: safe.request_id,
			}),
		);
		return {
			isError: true as const,
			content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
		};
	};

	const stateGatewayErrorResponse = (
		error: unknown,
		context: {
			tool?: string;
			phase?: StateGatewayPhase;
			retryable?: boolean;
		} = {},
	) => {
		const wasUnclassified = !(error instanceof StateGatewayError);
		const normalized = normalizeStateGatewayError(error, {
			phase: context.phase ?? "READ",
			retryable: context.retryable ?? true,
		});
		if (wasUnclassified) {
			const candidateName =
				typeof error === "object" && error !== null && "name" in error
					? String((error as { name?: unknown }).name ?? "")
					: "";
			const sourceErrorName = new Set([
				"Error",
				"TypeError",
				"RangeError",
				"DOMException",
			]).has(candidateName)
				? candidateName
				: "Error";
			console.warn(
				JSON.stringify({
					event: "state_gateway_unclassified_error",
					timestamp: new Date().toISOString(),
					tool: context.tool ?? "state_gateway",
					phase: normalized.phase,
					request_id: normalized.requestId,
					source_error_name: sourceErrorName,
				}),
			);
		}
		const safe = {
			status: normalized.code,
			phase: normalized.phase,
			retryable: normalized.retryable,
			request_id: normalized.requestId,
			message: normalized.message,
			...(normalized.httpStatus == null ? {} : { http_status: normalized.httpStatus }),
		};
		return {
			isError: true as const,
			content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
		};
	};
	const isStateScopeAuthorized = (scope: string) => {
		const exact = permitsFormalResearchOperation({
			principal: researchPrincipal,
			issuer: researchIssuer,
			scopes: researchScopes,
			requiredScope: scope,
		});
		const compatibilityScope =
			scope === STATE_READ_SCOPE
				? MARKET_READ_SCOPE
				: scope === STATE_WRITE_SCOPE
					? RESEARCH_SUBMIT_SCOPE
					: null;
		const compatible =
			compatibilityScope !== null &&
			permitsFormalResearchOperation({
				principal: researchPrincipal,
				issuer: researchIssuer,
				scopes: researchScopes,
				requiredScope: compatibilityScope,
			});
		return { authorized: exact || compatible, exact, compatible, compatibilityScope };
	};

	const requireStateScope = (scope: string, tool: string) => {
		const { authorized, exact, compatible, compatibilityScope } = isStateScopeAuthorized(scope);
		if (authorized) {
			if (!exact && compatible) {
				console.log(
					JSON.stringify({
						event: "state_gateway_legacy_scope_compat",
						timestamp: new Date().toISOString(),
						tool,
						required_scope: scope,
						compatibility_scope: compatibilityScope,
						principal: researchPrincipal ?? null,
					}),
				);
			}
			return null;
		}
		const error = new StateGatewayError({
			code: "STATE_FORBIDDEN",
			phase: "AUTH",
			message: "state gateway scope or formal principal is not authorized",
		});
		console.log(
			JSON.stringify({
				event: "state_gateway_scope_denied",
				timestamp: new Date().toISOString(),
				tool,
				required_scope: scope,
				principal: researchPrincipal ?? null,
				request_id: error.requestId,
			}),
		);
		return stateGatewayErrorResponse(error);
	};

	registerTool(
		"get_state_snapshot",
		{
			description:
				"读取固定生产状态账本：MARKET 固定 Issue #2，INDUSTRY/COMPANY/CLOSE 固定 Issue #3。调用方不能指定外部目标。授权以 Collector 实际 state_read_authorized 判定为准；effective_scopes 仅用于诊断。",
			inputSchema: z.object({
				symbols: z.array(z.string().min(3).max(16)).min(1).max(512),
				include: z.array(STATE_CHANNEL_SCHEMA).min(1).max(4),
				trading_date: z.string().min(10).max(10).optional(),
				scheduled_slot: MARKET_LEDGER_SLOT_SCHEMA.optional(),
				history_limit: z.number().int().min(0).max(20).optional(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ symbols, include, trading_date, scheduled_slot, history_limit }) => {
			const denied = requireStateScope(STATE_READ_SCOPE, "get_state_snapshot");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "READ",
						message: "GitHub ledger credential is not configured",
					}),
				);
			}
			try {
				const result = await getStateSnapshot({
					token: env.GITHUB_TOKEN,
					symbols,
					include,
					tradingDate: trading_date,
					scheduledSlot: scheduled_slot,
					historyLimit: history_limit,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return stateGatewayErrorResponse(error);
			}
		},
	);

	registerTool(
		"read_state_snapshot",
		{
			description:
				"读取 QuantPro 固定生产状态账本的宿主兼容别名。MARKET 固定 Issue #2；INDUSTRY/COMPANY/CLOSE 固定 Issue #3。symbol/date 由 Collector 服务端 fail-closed 校验；授权以 Collector 实际 state_read_authorized 判定为准。",
			inputSchema: z.object({
				symbols: z.array(z.string().min(3).max(16)).min(1).max(512),
				include: z.array(STATE_CHANNEL_SCHEMA).min(1).max(4),
				trading_date: z.string().min(10).max(10).optional(),
				scheduled_slot: MARKET_LEDGER_SLOT_SCHEMA.optional(),
				history_limit: z.number().int().min(0).max(20).optional(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ symbols, include, trading_date, scheduled_slot, history_limit }) => {
			const denied = requireStateScope(STATE_READ_SCOPE, "read_state_snapshot");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "READ",
						message: "GitHub ledger credential is not configured",
					}),
				);
			}
			try {
				const result = await getStateSnapshot({
					token: env.GITHUB_TOKEN,
					symbols,
					include,
					tradingDate: trading_date,
					scheduledSlot: scheduled_slot,
					historyLimit: history_limit,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return stateGatewayErrorResponse(error);
			}
		},
	);

	registerTool(
		"read_state_snapshot_v2",
		{
			description:
				"读取 QuantPro 固定生产状态账本的新版本只读入口，用于绕开宿主对旧工具名的 schema 缓存。MARKET 固定 Issue #2；INDUSTRY/COMPANY/CLOSE 固定 Issue #3。symbol/date 由 Collector 服务端 fail-closed 校验；授权以 Collector 实际 state_read_authorized 判定为准。",
			inputSchema: z.object({
				symbols: z.array(z.string().min(3).max(16)).min(1).max(512),
				include: z.array(STATE_CHANNEL_SCHEMA).min(1).max(4),
				trading_date: z.string().min(10).max(10).optional(),
				scheduled_slot: MARKET_LEDGER_SLOT_SCHEMA.optional(),
				history_limit: z.number().int().min(0).max(20).optional(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ symbols, include, trading_date, scheduled_slot, history_limit }) => {
			const denied = requireStateScope(STATE_READ_SCOPE, "read_state_snapshot_v2");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "READ",
						message: "GitHub ledger credential is not configured",
					}),
				);
			}
			try {
				const result = await getStateSnapshot({
					token: env.GITHUB_TOKEN,
					symbols,
					include,
					tradingDate: trading_date,
					scheduledSlot: scheduled_slot,
					historyLimit: history_limit,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return stateGatewayErrorResponse(error);
			}
		},
	);

	const resolveOwnerCommandContext = async () => {
		if (!env?.PORTFOLIO_UNIVERSE) {
			throw new StateGatewayError({
				code: "STATE_UNAVAILABLE",
				phase: "READ",
				message: "LIVE universe storage is not configured",
				retryable: true,
			});
		}
		let universe: StoredLiveUniverse | null;
		try {
			universe = await readLiveUniverse(env.PORTFOLIO_UNIVERSE);
		} catch {
			throw new StateGatewayError({
				code: "STATE_UNAVAILABLE",
				phase: "READ",
				message: "LIVE universe is unreadable",
				retryable: true,
			});
		}
		if (!universe) {
			throw new StateGatewayError({
				code: "STATE_UNAVAILABLE",
				phase: "READ",
				message: "LIVE universe is unavailable",
				retryable: true,
			});
		}
		return {
			portfolioVersion: `live:${universe.content_hash}`,
			liveUniverseHash: universe.content_hash,
		};
	};

	const ownerCommandResponse = async (
		tool: string,
		runId: string | null | undefined,
		execute: (requestId: string) => Promise<Record<string, unknown>>,
	) => {
		const requestId = crypto.randomUUID().replaceAll("-", "");
		const startedAt = Date.now();
		try {
			const result = await execute(requestId);
			console.log(
				JSON.stringify({
					event: "collector_tool_operation",
					tool,
					request_id: requestId,
					run_id: runId ?? null,
					status: String(result.status ?? "OK"),
					duration_ms: Date.now() - startedAt,
					collector_build_sha:
						env?.DEPLOYED_GIT_SHA?.trim() || env?.CF_VERSION_METADATA?.tag || null,
				}),
			);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			};
		} catch (error) {
			const normalized = normalizeStateGatewayError(error, {
				phase: "VALIDATE",
				retryable: false,
				requestId,
			});
			console.warn(
				JSON.stringify({
					event: "collector_tool_operation",
					tool,
					request_id: normalized.requestId,
					run_id: runId ?? null,
					status: normalized.code,
					phase: normalized.phase,
					duration_ms: Date.now() - startedAt,
					collector_build_sha:
						env?.DEPLOYED_GIT_SHA?.trim() || env?.CF_VERSION_METADATA?.tag || null,
				}),
			);
			return stateGatewayErrorResponse(normalized);
		}
	};

	registerTool(
		"append_company_events",
		{
			description:
				"追加 COMPANY 公司事实事件。调用方只提供公司业务字段；其他 owner、系统字段和未知字段不参与落账。Collector 服务端补齐账本元数据并完成校验、幂等、写入与回读。",
			inputSchema: APPEND_COMPANY_EVENTS_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (command) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "append_company_events");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN || !env.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "AUTH",
						message: "State Gateway storage or ledger credential is not configured",
					}),
				);
			}
			return ownerCommandResponse(
				"append_company_events",
				command.run_id,
				async (requestId) => {
					const context = await resolveOwnerCommandContext();
					return (await appendInvestmentCommand({
						db: env.RESEARCH_REPLICA!,
						token: env.GITHUB_TOKEN,
						channel: "COMPANY",
						command,
						portfolioVersion: context.portfolioVersion,
						requestId,
					})) as unknown as Record<string, unknown>;
				},
			);
		},
	);

	registerTool(
		"append_industry_events",
		{
			description:
				"追加 INDUSTRY 产业事件。调用方只提供产业业务字段；其他 owner、系统字段和未知字段不参与落账。Collector 服务端补齐账本元数据并完成校验、幂等、写入与回读。",
			inputSchema: APPEND_INDUSTRY_EVENTS_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (command) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "append_industry_events");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN || !env.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "AUTH",
						message: "State Gateway storage or ledger credential is not configured",
					}),
				);
			}
			return ownerCommandResponse(
				"append_industry_events",
				command.run_id,
				async (requestId) => {
					const context = await resolveOwnerCommandContext();
					return (await appendInvestmentCommand({
						db: env.RESEARCH_REPLICA!,
						token: env.GITHUB_TOKEN,
						channel: "INDUSTRY",
						command,
						portfolioVersion: context.portfolioVersion,
						requestId,
					})) as unknown as Record<string, unknown>;
				},
			);
		},
	);

	registerTool(
		"append_close_events",
		{
			description:
				"追加 CLOSE 日终有效状态事件。调用方只提供 CLOSE-owned 业务字段；Collector 保留 COMPANY/INDUSTRY/MARKET 上游关系与 R4 持续确认硬门。",
			inputSchema: APPEND_CLOSE_EVENTS_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (command) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "append_close_events");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN || !env.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "AUTH",
						message: "State Gateway storage or ledger credential is not configured",
					}),
				);
			}
			return ownerCommandResponse(
				"append_close_events",
				command.run_id,
				async (requestId) => {
					const context = await resolveOwnerCommandContext();
					return (await appendInvestmentCommand({
						db: env.RESEARCH_REPLICA!,
						token: env.GITHUB_TOKEN,
						channel: "CLOSE",
						command,
						portfolioVersion: context.portfolioVersion,
						requestId,
					})) as unknown as Record<string, unknown>;
				},
			);
		},
	);

	registerTool(
		"append_market_observation",
		{
			description:
				"追加 holding-assistant MARKET 观察。调用方提供观察时点、已安装 production_ref 与 records；Collector 从 LIVE universe 和既有 MARKET 链补齐版本、hash、前序引用及固定账本元数据。",
			inputSchema: APPEND_MARKET_OBSERVATION_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (command) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "append_market_observation");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN || !env.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "AUTH",
						message: "State Gateway storage or ledger credential is not configured",
					}),
				);
			}
			return ownerCommandResponse(
				"append_market_observation",
				command.run_id,
				async (requestId) => {
					const context = await resolveOwnerCommandContext();
					return (await appendMarketObservation({
						db: env.RESEARCH_REPLICA!,
						token: env.GITHUB_TOKEN,
						command,
						portfolioVersion: context.portfolioVersion,
						liveUniverseHash: context.liveUniverseHash,
						requestId,
					})) as unknown as Record<string, unknown>;
				},
			);
		},
	);

	registerTool(
		"submit_run_envelope",
		{
			description:
				"定时任务单次交件：一次调用同时完成本轮登记与内容落账。提交 task_name + 人话 summary + 可选 channel_payload；无新增时省略 channel_payload（空包=心跳）。业务门禁在写入前拦下本轮时改交 blocked_by（窄枚举，服务端记 BLOCKED/PRE_WRITE:*）；只读任务用 observations.fresh_count 申报观察新增（服务端计入通知门）。两者均不得与 channel_payload 同交。Collector 服务端在一个调用内完成：幂等、通道校验、账本写入、运行终态派生、fresh 计数与通知门判定，并全部回执给模型。禁止携带 write_key/producer/schema_version/event_id 等服务器字段。",
			inputSchema: SUBMIT_RUN_ENVELOPE_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (envelope) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "submit_run_envelope");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN || !env.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "AUTH",
						message: "State Gateway storage or ledger credential is not configured",
					}),
				);
			}
			const requestId = crypto.randomUUID().replaceAll("-", "");
			const startedAt = Date.now();
			try {
				const result = await processRunEnvelope({
					db: env.RESEARCH_REPLICA,
					token: env.GITHUB_TOKEN,
					envelope,
					resolveOwnerContext: resolveOwnerCommandContext,
					collectorBuildSha:
						env.DEPLOYED_GIT_SHA?.trim() || env.CF_VERSION_METADATA?.tag || null,
					cloudflareVersionId: env.CF_VERSION_METADATA?.id ?? null,
					requestId,
				});
				console.log(
					JSON.stringify({
						event: "collector_tool_operation",
						tool: "submit_run_envelope",
						request_id: requestId,
						run_id: result.run_id,
						status: result.outcome,
						duration_ms: Date.now() - startedAt,
						collector_build_sha:
							env.DEPLOYED_GIT_SHA?.trim() || env.CF_VERSION_METADATA?.tag || null,
					}),
				);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				const normalized = normalizeStateGatewayError(error, {
					phase: "VALIDATE",
					retryable: false,
					requestId,
				});
				console.warn(
					JSON.stringify({
						event: "collector_tool_operation",
						tool: "submit_run_envelope",
						request_id: requestId,
						run_id: error instanceof RunEnvelopeError ? error.runId : null,
						status: normalized.code,
						phase: normalized.phase,
						duration_ms: Date.now() - startedAt,
						collector_build_sha:
							env.DEPLOYED_GIT_SHA?.trim() || env.CF_VERSION_METADATA?.tag || null,
					}),
				);
				const response = stateGatewayErrorResponse(normalized);
				if (error instanceof RunEnvelopeError) {
					const body = JSON.parse(response.content[0].text) as Record<string, unknown>;
					if (error.runId) body.run_id = error.runId;
					if (error.outcome) body.outcome = error.outcome;
					if (error.envelopeKey) body.envelope_key = error.envelopeKey;
					if (error.blockerCode) body.blocker_code = error.blockerCode;
					response.content[0].text = JSON.stringify(body, null, 2);
				}
				return response;
			}
		},
	);

	registerTool(
		"submit_issue_bookkeeping",
		{
			description:
				"受控 Issue 记账：定时任务只提交记账意图（服务端白名单 target_key + 仅 COMMENT/CLOSE + 必填幂等键），GitHub 副作用由 Collector 代做并返回回执（PERSISTED/IDEMPOTENT_REPLAY/DELIVERY_BLOCKED/OUTCOME_UNKNOWN/REJECTED_TARGET）。不做通用 GitHub API；结果未知时同 dedupe_key 重查，不改键重投；投递失败不改判任何业务运行。",
			inputSchema: ISSUE_BOOKKEEPING_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (command) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "submit_issue_bookkeeping");
			if (denied) return denied;
			if (!env?.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "AUTH",
						message: "State Gateway storage is not configured",
					}),
				);
			}
			const requestId = crypto.randomUUID().replaceAll("-", "");
			try {
				const receipt = await submitIssueBookkeeping({
					db: env.RESEARCH_REPLICA,
					command,
					token: env.GITHUB_TOKEN ?? null,
					targetsRaw: env.COLLECTOR_BOOKKEEPING_TARGETS ?? null,
					requestId,
				});
				console.log(
					JSON.stringify({
						event: "collector_tool_operation",
						tool: "submit_issue_bookkeeping",
						request_id: requestId,
						dedupe_key: receipt.dedupe_key,
						status: receipt.status,
					}),
				);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }],
				};
			} catch (error) {
				return stateGatewayErrorResponse(
					normalizeStateGatewayError(error, {
						phase: "VALIDATE",
						retryable: false,
						requestId,
					}),
				);
			}
		},
	);

	registerTool(
		"validate_state_batch",
		{
			description:
				"仅校验 State Gateway batch，不产生外部写入；返回 channel、write_key、schema version 与 canonical payload hash。授权以 get_gateway_status.state_read_authorized 为准。",
			inputSchema: z.object({ channel: STATE_CHANNEL_SCHEMA, batch: z.unknown() }),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async ({ channel, batch }) => {
			const denied = requireStateScope(STATE_READ_SCOPE, "validate_state_batch");
			if (denied) return denied;
			try {
				const result = await validateStateBatch(channel, batch);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									status: result.status,
									channel: result.channel,
									write_key: result.write_key,
									payload_sha256: result.payload_sha256,
									schema_version: result.schema_version,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return stateGatewayErrorResponse(error, {
					tool: "validate_state_batch",
					phase: "VALIDATE",
					retryable: false,
				});
			}
		},
	);

	registerTool(
		"append_state_batch",
		{
			description:
				"稳定 State Gateway 写入口。兼容旧 exact-schema batch，也接受 #37 最小业务 payload；当 batch 不含 schema_version 时按 channel 自动走 owner-scoped 新内核，由 Collector 补系统字段、执行幂等、关系校验、持久化回执与写后回读。调用方不能选择 repo、issue、URL、credential、producer 或 dimension。授权以 get_gateway_status.state_write_authorized 为准。",
			inputSchema: z.object({ channel: STATE_CHANNEL_SCHEMA, batch: z.unknown() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ channel, batch }) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "append_state_batch");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN || !env.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "AUTH",
						message: "State Gateway storage or ledger credential is not configured",
					}),
				);
			}

			if (isOwnedStateCommandPayload(channel, batch)) {
				const runId =
					batch && typeof batch === "object" && !Array.isArray(batch)
						? typeof (batch as Record<string, unknown>).run_id === "string"
							? String((batch as Record<string, unknown>).run_id)
							: null
						: null;
				return ownerCommandResponse("append_state_batch", runId, async (requestId) => {
					const context = await resolveOwnerCommandContext();
					if (channel === "MARKET") {
						return (await appendMarketObservation({
							db: env.RESEARCH_REPLICA!,
							token: env.GITHUB_TOKEN,
							command: batch,
							portfolioVersion: context.portfolioVersion,
							liveUniverseHash: context.liveUniverseHash,
							requestId,
						})) as unknown as Record<string, unknown>;
					}
					return (await appendInvestmentCommand({
						db: env.RESEARCH_REPLICA!,
						token: env.GITHUB_TOKEN,
						channel,
						command: batch,
						portfolioVersion: context.portfolioVersion,
						requestId,
					})) as unknown as Record<string, unknown>;
				});
			}

			try {
				const result = await appendStateBatch({
					db: env.RESEARCH_REPLICA,
					token: env.GITHUB_TOKEN,
					channel,
					batch,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return stateGatewayErrorResponse(error);
			}
		},
	);

	const automationRunErrorResponse = (error: unknown) => {
		const safe =
			error instanceof AutomationRunLedgerError
				? {
						status: error.code,
						retryable: error.retryable,
						request_id: error.requestId,
						message: error.message,
					}
				: {
						status: "AUTOMATION_RUN_UNAVAILABLE",
						retryable: true,
						request_id: crypto.randomUUID().replaceAll("-", ""),
						message: "automation run audit operation failed",
					};
		return {
			isError: true as const,
			content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
		};
	};

	registerTool(
		"begin_run",
		{
			description:
				"开始一次生产 Automation 运行审计。Collector 生成 run_id 与服务器时间；invocation_key 仅在宿主提供稳定调用身份时使用。审计仅写独立 D1 运维表。",
			inputSchema: AUTOMATION_RUN_BEGIN_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (begin) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "begin_run");
			if (denied) return denied;
			if (!env?.RESEARCH_REPLICA || !researchPrincipal) {
				return automationRunErrorResponse(
					new AutomationRunLedgerError(
						"AUTOMATION_RUN_UNAVAILABLE",
						"automation run audit storage or principal is unavailable",
						{ retryable: true },
					),
				);
			}
			try {
				const result = await beginAutomationRun({
					db: env.RESEARCH_REPLICA,
					begin,
					principal: researchPrincipal,
					collectorBuildSha:
						env.DEPLOYED_GIT_SHA?.trim() || env.CF_VERSION_METADATA?.tag || null,
					cloudflareVersionId: env.CF_VERSION_METADATA?.id ?? null,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return automationRunErrorResponse(error);
			}
		},
	);

	registerTool(
		"end_run",
		{
			description:
				"结束 begin_run 返回的运行。终态仅 COMPLETED/SILENT/BLOCKED/FAILED；notification_intended 表示准备通知，不宣称客户端实际送达。相同终态可安全重放。",
			inputSchema: AUTOMATION_RUN_END_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (end) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "end_run");
			if (denied) return denied;
			if (!env?.RESEARCH_REPLICA) {
				return automationRunErrorResponse(
					new AutomationRunLedgerError(
						"AUTOMATION_RUN_UNAVAILABLE",
						"automation run audit storage is not configured",
						{ retryable: true },
					),
				);
			}
			try {
				const result = await endAutomationRun({
					db: env.RESEARCH_REPLICA,
					end,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return automationRunErrorResponse(error);
			}
		},
	);

	registerTool(
		"record_automation_run",
		{
			description:
				"稳定 Automation 审计兼容入口。旧 STARTED/FINAL 合同继续可用；#37 新调用可用 run_id=SERVER_AUTO + occurred_at=SERVER 发起 START，由 Collector 生成真实 run_id，FINAL 使用返回 run_id 并由服务器记录时间。仅写 Collector D1，不写投资状态账本。授权以 state:write 为准。",
			inputSchema: AUTOMATION_RUN_EVENT_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (event) => {
			const denied = requireStateScope(STATE_WRITE_SCOPE, "record_automation_run");
			if (denied) return denied;
			if (!env?.RESEARCH_REPLICA) {
				return automationRunErrorResponse(
					new AutomationRunLedgerError(
						"AUTOMATION_RUN_UNAVAILABLE",
						"automation run audit storage is not configured",
						{ retryable: true },
					),
				);
			}
			try {
				if (event.run_id === "SERVER_AUTO" && event.phase === "STARTED") {
					if (!researchPrincipal) {
						throw new AutomationRunLedgerError(
							"AUTOMATION_RUN_UNAVAILABLE",
							"automation run principal is unavailable",
							{ retryable: true },
						);
					}
					const result = await beginAutomationRun({
						db: env.RESEARCH_REPLICA,
						begin: {
							task: event.task_name,
							prompt_version: event.prompt_version ?? null,
						},
						principal: researchPrincipal,
						collectorBuildSha:
							env.DEPLOYED_GIT_SHA?.trim() || env.CF_VERSION_METADATA?.tag || null,
						cloudflareVersionId: env.CF_VERSION_METADATA?.id ?? null,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										...result,
										phase: "STARTED",
										event_status: "STARTED",
										compat_contract: "run-v2",
									},
									null,
									2,
								),
							},
						],
					};
				}
				if (event.run_id.startsWith("run_") && event.phase === "FINAL") {
					if (event.status === "STARTED") {
						throw new AutomationRunLedgerError(
							"AUTOMATION_RUN_VALIDATION_FAILED",
							"FINAL phase requires a terminal status",
							{ retryable: false },
						);
					}
					const outcome = event.status;
					const reason = event.blocker_code ?? event.safe_summary ?? null;
					const result = await endAutomationRun({
						db: env.RESEARCH_REPLICA,
						end: {
							run_id: event.run_id,
							outcome,
							fresh_delta_count: event.fresh_delta_count ?? 0,
							notification_intended: Boolean(event.notification_sent),
							reason,
						},
					});
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										...result,
										phase: "FINAL",
										event_status: event.status,
										compat_contract: "run-v2",
									},
									null,
									2,
								),
							},
						],
					};
				}
				const result = await recordAutomationRunEvent({
					db: env.RESEARCH_REPLICA,
					event,
					collectorBuildSha:
						env.DEPLOYED_GIT_SHA?.trim() || env.CF_VERSION_METADATA?.tag || null,
					cloudflareVersionId: env.CF_VERSION_METADATA?.id ?? null,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return automationRunErrorResponse(error);
			}
		},
	);

	registerTool(
		"get_automation_run_history",
		{
			description:
				"查询 Collector Automation 运行审计，可按 task_name / since 读取最近运行；STARTED 无 FINAL 会显示 IN_PROGRESS，正常静默显示 SILENT，便于判断任务是否真正执行完成。授权以 state:read 为准。",
			inputSchema: AUTOMATION_RUN_HISTORY_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async ({ task_name, since, limit }) => {
			const denied = requireStateScope(STATE_READ_SCOPE, "get_automation_run_history");
			if (denied) return denied;
			if (!env?.RESEARCH_REPLICA) {
				return automationRunErrorResponse(
					new AutomationRunLedgerError(
						"AUTOMATION_RUN_UNAVAILABLE",
						"automation run audit storage is not configured",
						{ retryable: true },
					),
				);
			}
			try {
				const result = await getAutomationRunHistory({
					db: env.RESEARCH_REPLICA,
					taskName: task_name,
					since,
					limit,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return automationRunErrorResponse(error);
			}
		},
	);

	registerTool(
		"get_production_health_snapshot",
		{
			description:
				"#50 生产健康快照：一次只读调用覆盖六个固定生产任务（无 task_name/since/limit 参数），替代观察器每轮六次 history 扫描。字段为已存事实或既有槽位派生的观察投影，不新增资格判断；无可信数据时为 null。授权以 state:read 为准；D1 不可读时如实 STATE_UNAVAILABLE，不判任务失败。",
			inputSchema: z.object({}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async () => {
			const denied = requireStateScope(STATE_READ_SCOPE, "get_production_health_snapshot");
			if (denied) return denied;
			if (!env?.RESEARCH_REPLICA) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									status: "STATE_UNAVAILABLE",
									message: "automation run storage is not configured",
								},
								null,
								2,
							),
						},
					],
				};
			}
			try {
				const result = await getProductionHealthSnapshot({
					db: env.RESEARCH_REPLICA,
					cloudflareVersionId: env.CF_VERSION_METADATA?.id ?? null,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				return automationRunErrorResponse(error);
			}
		},
	);

	registerTool(
		"get_state_write_receipt",
		{
			description:
				"读取 State Gateway D1 持久化回执。只接受 channel + write_key，不返回 credential。授权以 get_gateway_status.state_read_authorized 为准。",
			inputSchema: z.object({
				channel: STATE_CHANNEL_SCHEMA,
				write_key: z.string().min(1).max(512),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async ({ channel, write_key }) => {
			const denied = requireStateScope(STATE_READ_SCOPE, "get_state_write_receipt");
			if (denied) return denied;
			if (!env?.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "READ",
						message: "State Gateway receipt storage is not configured",
					}),
				);
			}
			try {
				const receipt = await getStateWriteReceipt(env.RESEARCH_REPLICA, write_key);
				if (receipt && receipt.channel !== channel) {
					return stateGatewayErrorResponse(
						new StateGatewayError({
							code: "STATE_CONFLICT",
							phase: "READ",
							message: "write_key belongs to a different state channel",
						}),
					);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ status: receipt ? "OK" : "NOT_FOUND", receipt },
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return stateGatewayErrorResponse(error);
			}
		},
	);

	registerTool(
		"get_gateway_status",
		{
			description:
				"读取 Collector State Gateway 的版本、Channel、有效 scopes 与固定账本可达性，用于发现源码/部署/tools-list 漂移；不返回 secret。已认证正式主体持有 market:read 即可诊断。",
			inputSchema: z.object({}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async () => {
			const denied = requireStateScope(MARKET_READ_SCOPE, "get_gateway_status");
			if (denied) return denied;
			try {
				const result = await getGatewayStatus({
					token: env?.GITHUB_TOKEN,
					effectiveScopes: researchScopes,
					principalVerified: Boolean(researchPrincipal && researchIssuer),
					stateReadAuthorized: isStateScopeAuthorized(STATE_READ_SCOPE).authorized,
					stateWriteAuthorized: isStateScopeAuthorized(STATE_WRITE_SCOPE).authorized,
					deployedGitSha:
						env?.DEPLOYED_GIT_SHA?.trim() || env?.CF_VERSION_METADATA?.tag || null,
					cloudflareVersionId: env?.CF_VERSION_METADATA?.id ?? null,
					cloudflareVersionTimestamp: env?.CF_VERSION_METADATA?.timestamp ?? null,
					serviceVersion: "1.3.1",
					db: env?.RESEARCH_REPLICA,
				});
				// Quota admission exposure (SDD CQ spec §"用量/状态查询"): operators and
				// observers read the per-dimension CLOSED/OPEN/UNKNOWN state, the
				// verified period, the live reservation count and the explicit gaps.
				// No token, no document content. Fail-soft: an unavailable ledger is
				// reported as UNKNOWN, never as "safe".
				let quota: unknown = null;
				if (env?.RESEARCH_REPLICA) {
					try {
						quota = {
							...(await quotaStatus(env.RESEARCH_REPLICA, {
								account_id: quotaAccountId(),
								dimensions: QUOTA_DIMENSIONS,
							})),
							mode: admissionMode(env),
							legacy: legacyBreakerFlag(env),
							quantified_guarantee: false,
							uncovered: [
								"inbound Workers requests and CPU are billed before this code runs",
								"stored D1/KV/R2 GB-month keeps billing without any new write",
								"unobserved third-party traffic on the same account",
							],
						};
					} catch {
						quota = { state: "UNKNOWN", quantified_guarantee: false };
					}
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ ...result, quota }, null, 2),
						},
					],
				};
			} catch (error) {
				return stateGatewayErrorResponse(error);
			}
		},
	);

	const marketLedgerErrorResponse = (error: unknown) => {
		const code = error instanceof MarketLedgerError ? error.code : "MARKET_LEDGER_UNAVAILABLE";
		const message =
			error instanceof MarketLedgerError ? error.message : "Market ledger operation failed";
		return {
			isError: true as const,
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({ status: code, message }, null, 2),
				},
			],
		};
	};
	const requireMarketLedgerRead = (tool: string) => {
		if (isLiveOverlayEnabled(liveOverlayStatus) && researchScopes.has(MARKET_READ_SCOPE)) {
			return null;
		}
		console.log(
			JSON.stringify({
				event: "market_ledger_scope_denied",
				timestamp: new Date().toISOString(),
				tool,
				required_scope: MARKET_READ_SCOPE,
				principal: researchPrincipal ?? "unverified-principal",
			}),
		);
		return {
			isError: true as const,
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{
							status: "MARKET_LEDGER_FORBIDDEN",
							required_scope: MARKET_READ_SCOPE,
						},
						null,
						2,
					),
				},
			],
		};
	};
	const requireMarketLedgerAppend = (tool: string) => requireStateScope(STATE_WRITE_SCOPE, tool);

	registerTool(
		"get_market_checkpoints",
		{
			description:
				"读取 holding-assistant 市场状态检查点。Collector 服务端固定读取 zhushihao/quantpro-collector#2、完成 GitHub comments 分页/校验，并仅返回结构化 PREOPEN、上一检查点、上一交易日 CLOSE、当前 slot 与冲突状态；调用方不接触 GitHub token，也不需要 GitHub Plugin。",
			inputSchema: z.object({
				trading_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
				scheduled_slot: MARKET_LEDGER_SLOT_SCHEMA,
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ trading_date, scheduled_slot }) => {
			const denied = requireMarketLedgerRead("get_market_checkpoints");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN) {
				return marketLedgerErrorResponse(
					new MarketLedgerError(
						"MARKET_LEDGER_UNAVAILABLE",
						"GitHub ledger credential is not configured",
					),
				);
			}
			try {
				const state = await getMarketCheckpoints({
					token: env.GITHUB_TOKEN,
					tradingDate: trading_date,
					scheduledSlot: scheduled_slot,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
				};
			} catch (error) {
				return marketLedgerErrorResponse(error);
			}
		},
	);

	registerTool(
		"append_market_checkpoint",
		{
			description:
				"DEPRECATED 兼容入口：将 holding-assistant 检查点通过 State Gateway MARKET profile 持久化到固定 Issue #2。必须通过 state:write、D1 receipt、幂等、链校验和写后回读；不接受任意外部目标。",
			inputSchema: z.object({
				checkpoint: MARKET_CHECKPOINT_INPUT_SCHEMA,
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ checkpoint }) => {
			const denied = requireMarketLedgerAppend("append_market_checkpoint");
			if (denied) return denied;
			if (!env?.GITHUB_TOKEN || !env.RESEARCH_REPLICA) {
				return stateGatewayErrorResponse(
					new StateGatewayError({
						code: "STATE_UNAVAILABLE",
						phase: "AUTH",
						message: "State Gateway storage or ledger credential is not configured",
					}),
				);
			}
			try {
				const gatewayResult = await appendStateBatch({
					db: env.RESEARCH_REPLICA,
					token: env.GITHUB_TOKEN,
					channel: "MARKET",
					batch: checkpoint,
				});
				const state = await getMarketCheckpoints({
					token: env.GITHUB_TOKEN,
					tradingDate: checkpoint.trading_date,
					scheduledSlot: checkpoint.scheduled_slot,
				});
				const current = state.current_slot;
				if (!current || current.comment_id !== gatewayResult.comment_id) {
					throw new StateGatewayError({
						code: "STATE_READBACK_FAILED",
						phase: "READBACK",
						message: "legacy MARKET wrapper could not resolve the persisted checkpoint",
						retryable: true,
					});
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									status: gatewayResult.status,
									persisted: true,
									comment_id: current.comment_id,
									url: current.url,
									created_at: current.created_at,
									checkpoint: current.payload,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return stateGatewayErrorResponse(error);
			}
		},
	);

	registerTool(
		"search_documents",
		{
			description: "在 Collector 的 PUBLIC Research replica 中搜索文档元数据。",
			inputSchema: z.object({
				query: z.string().optional(),
				limit: z.number().int().min(1).max(100).optional(),
			}),
		},
		async ({ query, limit }) =>
			researchRead("search_documents", () => researchAdapter().searchDocuments(query, limit)),
	);
	registerTool(
		"get_document",
		{
			description: "读取 Collector replica 中经 SHA-256 校验的 PUBLIC 文档正文。",
			inputSchema: z.object({ document_id: z.string().min(1) }),
		},
		async ({ document_id }) =>
			researchRead("get_document", () => researchAdapter().getDocument(document_id)),
	);
	// Task D: the only semantic surface.  PUBLIC replica metadata only; a hit is
	// re-validated against D1/R2 before it is returned, so a stale or private
	// vector can never be served.  No visibility/source_id input exists here.
	registerTool(
		"search_documents_semantic",
		{
			description:
				"语义检索 Collector PUBLIC 文档（Workers AI bge-m3 向量索引）。返回 {matches, index_status}：matches 为文档级命中（document_id、version_id、title、score、snippet、source_kind、published_at），index_status 为 READY 或 PARTIAL（索引尚未完全构建）。索引不可用时报安全错误而非空结果；命中仅来自 PUBLIC 当前可读版本，正文请再调用 get_document。",
			inputSchema: z.object({
				query: z
					.string()
					.trim()
					.min(1)
					.max(SEMANTIC_QUERY_MAX_QUERY_CHARS)
					.describe("自然语言查询，trim 后 1–500 字符"),
				limit: z.number().int().min(1).max(SEMANTIC_QUERY_MAX_LIMIT).optional(),
			}),
		},
		async ({ query, limit }) =>
			researchRead("search_documents_semantic", () =>
				researchAdapter().searchDocumentsSemantic(query, {
					limit,
					deps: semanticIndexDeps(env),
				}),
			),
	);
	registerTool(
		"search_evidence",
		{
			description: "列出 Collector replica 中的 PUBLIC Evidence。",
			inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
		},
		async ({ limit }) =>
			researchRead("search_evidence", () => researchAdapter().searchEvidence(limit)),
	);
	registerTool(
		"get_evidence",
		{
			description: "读取 Collector replica 中指定的 PUBLIC Evidence。",
			inputSchema: z.object({ evidence_id: z.string().min(1) }),
		},
		async ({ evidence_id }) =>
			researchRead("get_evidence", () => researchAdapter().getEvidence(evidence_id)),
	);
	registerTool(
		"get_theme_accumulator",
		{
			description: "读取指定主题的 PUBLIC Evidence Accumulator。",
			inputSchema: z.object({ subject_key: z.string().min(1) }),
		},
		async ({ subject_key }) =>
			researchRead("get_theme_accumulator", () =>
				researchAdapter().getThemeAccumulator(subject_key),
			),
	);
	registerTool(
		"get_company_evidence_state",
		{
			description: "读取指定公司的 PUBLIC Evidence Accumulator 状态。",
			inputSchema: z.object({ company: z.string().min(1) }),
		},
		async ({ company }) =>
			researchRead("get_company_evidence_state", () =>
				researchAdapter().getCompanyEvidenceState(company),
			),
	);
	registerTool(
		"get_coverage_status",
		{
			description: "读取 Collector replica 中的 PUBLIC Research Coverage。",
			inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
		},
		async ({ limit }) =>
			researchRead("get_coverage_status", () => researchAdapter().getCoverageStatus(limit)),
	);
	registerTool(
		"get_source_health",
		{
			description:
				"读取 Research source health（outbound-v3 source_health 记录投影，实读 replica）。",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(100).optional(),
			}),
		},
		async ({ limit }) =>
			researchRead("get_source_health", () => researchAdapter().getSourceHealth(limit)),
	);
	registerTool(
		"get_market_signal_state",
		{
			description:
				"读取市场信号状态（独立 market_signal 数值记录，仅作 R3/R4 价格输入）。无记录时如实返回 NO_DATA，不报错也不伪造数据。",
			inputSchema: z.object({ subject_key: z.string().min(1).max(128) }),
		},
		async ({ subject_key }) =>
			researchRead("get_market_signal_state", () =>
				researchAdapter().getMarketSignalState(subject_key),
			),
	);
	registerTool(
		"list_research_jobs",
		{
			description:
				"列出 Collector replica 中的 PUBLIC Research Job，附服务端状态推导 server_state（terminal > 未过期 lease > record）。claimable_only=true 时仅返回 effective_status=QUEUED 的任务。",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(100).optional(),
				claimable_only: z.boolean().optional(),
			}),
		},
		async ({ limit, claimable_only }) =>
			researchRead("list_research_jobs", () =>
				researchAdapter().listResearchJobs(limit, { claimableOnly: claimable_only }),
			),
	);
	registerTool(
		"get_research_job_context",
		{
			description:
				"读取 Collector replica 中指定 PUBLIC Research Job 的上下文：job record（含触发证据）+ server_state + 提交历史 proposals。claim_token 永不出现在本面。",
			inputSchema: z.object({ job_id: z.string().min(1) }),
		},
		async ({ job_id }) =>
			researchRead("get_research_job_context", () =>
				researchAdapter().getResearchJobContext(job_id),
			),
	);
	registerTool(
		"claim_research_job",
		{
			description:
				"认领一个 PUBLIC QUEUED Research Job（服务端固定租约 3600 秒，原子抢占；同主体重复认领幂等返回原租约）。返回的 lease_generation 即后续 submit/defer 的 expected_generation。需要 research:claim scope。",
			inputSchema: z.object({ job_id: z.string().min(1) }),
		},
		async ({ job_id }) => {
			const denied = requireResearchScope(RESEARCH_CLAIM_SCOPE, "claim_research_job");
			if (denied) return denied;
			const clientDenied = requireFormalResearchClient(
				"claim_research_job",
				RESEARCH_CLAIM_SCOPE,
			);
			if (clientDenied) return clientDenied;
			// Belt-and-suspenders: the formal gate above already implies a non-null
			// principal and issuer, so callerPrincipal cannot return null here.
			const owner = await callerPrincipal();
			if (!owner)
				return requireFormalResearchClient("claim_research_job", RESEARCH_CLAIM_SCOPE)!;
			return researchWrite(async () =>
				claimResearchJob(researchWorkflowDb(), {
					jobId: job_id,
					leaseOwner: owner,
					requestId: crypto.randomUUID().replaceAll("-", ""),
					now: new Date().toISOString(),
				}),
			);
		},
	);
	registerTool(
		"submit_research_result_proposal",
		{
			description:
				"提交研究结果 proposal。正式（CHATGPT）提交被接受即 Job 终态 COMPLETED；非生产主体的 CHATGPT 声明一律降级为 SYNTHETIC 隔离存储（不完成 Job）。需要 research:submit scope。" +
				" proposal 是 exact-keys 对象——键集合必须与下面完全一致，多余/缺失/改名任一都会被拒（REJECTED=VALIDATION_FAILED）：" +
				" job_id（必须等于本工具的 job_id 参数）；summary（非空字符串，≤4000 字符）；" +
				' findings（数组 ≤50 项，每项恰为 {claim: 字符串 ≤2000, evidence_ids: 字符串数组且元素非空, confidence: "HIGH"|"MEDIUM"|"LOW", counter_evidence: null 或字符串 ≤2000}）；' +
				' recommendation_hint（枚举 "NONE"|"THESIS_REVIEW"|"COUNTER_EVIDENCE_FOUND"|"NO_SECOND_SOURCE"|"INSUFFICIENT_DATA"）；' +
				" sources_consulted（字符串数组 ≤100 项，每项 ≤500 字符，可为空数组）；completed_at（可解析的 ISO 时间字符串）；" +
				" 可选 tokens_used（非负整数）。禁止任何其他键；整体负载 ≤64KiB。" +
				" 写权限由服务端裁决：当前 OAuth 稳定主体必须是该 Job 现行租约的持有者，expected_generation 取 claim_research_job 返回的 lease_generation；不需要也不接受任何提交凭据。" +
				RESEARCH_IDEMPOTENCY_KEY_DESCRIPTION +
				" 稳定键格式示例：chatgpt_submit:<job_id>:g<lease_generation>。",
			inputSchema: z.object({
				job_id: z.string().min(1),
				expected_generation: z.number().int().min(1),
				idempotency_key: RESEARCH_IDEMPOTENCY_KEY_SCHEMA,
				origin: z.enum(["CHATGPT", "SYNTHETIC", "REPLAY"]).optional(),
				proposal: z.record(z.string(), z.unknown()),
			}),
		},
		async ({ job_id, expected_generation, idempotency_key, origin, proposal }) => {
			const denied = requireResearchScope(
				RESEARCH_SUBMIT_SCOPE,
				"submit_research_result_proposal",
			);
			if (denied) return denied;
			const clientDenied = requireFormalResearchClient(
				"submit_research_result_proposal",
				RESEARCH_SUBMIT_SCOPE,
			);
			if (clientDenied) return clientDenied;
			// Belt-and-suspenders: the formal gate above already implies a non-null
			// principal and issuer, so callerPrincipal cannot return null here.
			const owner = await callerPrincipal();
			if (!owner)
				return requireFormalResearchClient(
					"submit_research_result_proposal",
					RESEARCH_SUBMIT_SCOPE,
				)!;
			return researchWrite(async () =>
				submitResearchResultProposal(researchWorkflowDb(), {
					jobId: job_id,
					expectedGeneration: expected_generation,
					idempotencyKey: idempotency_key,
					origin,
					proposal,
					callerPrincipal: owner,
					requestId: crypto.randomUUID().replaceAll("-", ""),
					now: new Date().toISOString(),
				}),
			);
		},
	);
	registerTool(
		"defer_research_job",
		{
			description:
				"远端延期当前正式租约到指定 recheck 时刻并原子释放租约；defer 不产生完成终态，正式终态仅由提交 result proposal 产生。写权限与 submit 相同（服务端主体+generation 裁决，无需凭据）。需要 research:submit scope。" +
				RESEARCH_IDEMPOTENCY_KEY_DESCRIPTION +
				" 稳定键格式示例：chatgpt_defer:<job_id>:g<lease_generation>。",
			inputSchema: z.object({
				job_id: z.string().min(1),
				expected_generation: z.number().int().min(1),
				idempotency_key: RESEARCH_IDEMPOTENCY_KEY_SCHEMA,
				reason: z.enum(["RECHECK_REQUIRED", "UPSTREAM_UNAVAILABLE", "NEEDS_OWNER_INPUT"]),
				recheck_at: z.string().datetime(),
			}),
		},
		async ({ job_id, expected_generation, idempotency_key, reason, recheck_at }) => {
			const denied = requireResearchScope(RESEARCH_SUBMIT_SCOPE, "defer_research_job");
			if (denied) return denied;
			const clientDenied = requireFormalResearchClient(
				"defer_research_job",
				RESEARCH_SUBMIT_SCOPE,
			);
			if (clientDenied) return clientDenied;
			// Belt-and-suspenders: the formal gate above already implies a non-null
			// principal and issuer, so callerPrincipal cannot return null here.
			const owner = await callerPrincipal();
			if (!owner)
				return requireFormalResearchClient("defer_research_job", RESEARCH_SUBMIT_SCOPE)!;
			return researchWrite(async () =>
				deferResearchJob(researchWorkflowDb(), {
					jobId: job_id,
					expectedGeneration: expected_generation,
					idempotencyKey: idempotency_key,
					reason,
					recheckAt: recheck_at,
					callerPrincipal: owner,
					requestId: crypto.randomUUID().replaceAll("-", ""),
					now: new Date().toISOString(),
				}),
			);
		},
	);

	return server;
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function researchReplicaStorage(env: Env): ResearchReplicaStorage | null {
	return env.RESEARCH_REPLICA && env.RESEARCH_OBJECTS
		? { db: env.RESEARCH_REPLICA, objects: env.RESEARCH_OBJECTS }
		: null;
}

function researchReplicaAuthorized(request: Request, env: Env): boolean {
	const token = env.RESEARCH_REPLICA_INGEST_TOKEN;
	return Boolean(token && request.headers.get("Authorization") === `Bearer ${token}`);
}

function researchBoundaryResponse(error: unknown, status = 400): Response {
	const safe =
		error instanceof ResearchBoundaryError
			? error.asError()
			: new ResearchBoundaryError("STORE_UNAVAILABLE").asError();
	return jsonResponse(safe, status);
}

/**
 * Task D bindings or an explicit configuration failure.  A missing binding is
 * reported as a non-retryable STORE_UNAVAILABLE: the semantic tool must never
 * look like "no matches" when the index is simply not deployed.
 */
function semanticIndexDeps(env: Env | undefined): SemanticIndexDeps {
	if (!env?.AI || !env.RESEARCH_PUBLIC_INDEX) {
		throw new ResearchBoundaryError("STORE_UNAVAILABLE", undefined, {
			retryable: false,
			safeMessage:
				"semantic index bindings are unavailable; the lexical search surface remains available",
		});
	}
	return { ai: env.AI, index: env.RESEARCH_PUBLIC_INDEX };
}

/** Daily semantic indexing trigger (UTC 16:40 — off the backfill peak). */
export const SEMANTIC_INDEX_CRON = "40 16 * * *";
const SEMANTIC_CRON_MAX_BATCHES = 20;

/**
 * The scheduled half of the daily neuron budget: identical admission, guard and
 * settlement as `handleSemanticIndexRun`, looping batch by batch until the
 * ledger refuses (daily budget exhausted) or the queue drains.
 */
async function runSemanticIndexCron(env: Env, context: BridgeStageContext): Promise<void> {
	const storage = researchReplicaStorage(env);
	if (!storage || !env.RESEARCH_REPLICA_INGEST_TOKEN) {
		logBridgeStage(context, "scheduled_skipped", {
			task: "research_semantic_index",
			reason: "replica transport is not configured",
		});
		return;
	}
	const deps = semanticIndexDeps(env);
	for (let batch = 0; batch < SEMANTIC_CRON_MAX_BATCHES; batch += 1) {
		const requestId = crypto.randomUUID().replaceAll("-", "");
		let admission: {
			handle: ReturnType<typeof admissionHandle>;
			budget: ReservationBudget;
			result: { status: string; reservation_id?: string };
		};
		try {
			admission = await admitHeavyRouteForEnv(env, {
				route: "http:/internal/research-semantic-index/run",
				operation_id: `semantic-cron:${batch}:${requestId}`,
				fingerprint: crypto.randomUUID().replaceAll("-", ""),
			});
		} catch (error) {
			// The daily budget refusing admission is the designed stop, not a fault.
			logBridgeStage(context, "scheduled_stopped", {
				task: "research_semantic_index",
				batch,
				reason: error instanceof QuotaGuardError ? error.error_code : "admission_fault",
				detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
			});
			return;
		}
		try {
			const handle = admission.handle;
			if (!handle) throw new QuotaGuardError("QUOTA_GUARD_UNAVAILABLE", "admission handle missing");
			const guardedDeps: SemanticIndexDeps = {
				ai: createGuardedAi(deps.ai, handle, admission.budget) as typeof deps.ai,
				index: deps.index,
			};
			const report = await runSemanticIndexBatch(
				{ ...storage, db: createGuardedD1(storage.db, handle, admission.budget) },
				guardedDeps,
				{ maxDocs: SEMANTIC_BATCH_MAX_DOCS },
			);
			await settleReservation(env.RESEARCH_REPLICA!, {
				reservation_id: admission.result.reservation_id as string,
				observed: admission.budget.snapshot(),
				reason: "semantic_cron_batch",
			}).catch(() => undefined);
			logBridgeStage(context, "scheduled_batch_complete", {
				task: "research_semantic_index",
				batch,
				ready: report.ready,
				pending: report.pending,
				vectors_upserted: report.vectors_upserted,
			});
			if (report.pending === 0) {
				logBridgeStage(context, "scheduled_complete", {
					task: "research_semantic_index",
					batches: batch + 1,
					reason: "queue drained",
				});
				return;
			}
		} catch (error) {
			// Unknown outcome: the reservation stays reserved (fail-closed) and the
			// operator sees the batch failure in the logs.
			logBridgeFailure(context, error, `semantic_cron_batch_${batch}`);
			return;
		}
	}
	logBridgeStage(context, "scheduled_complete", {
		task: "research_semantic_index",
		batches: SEMANTIC_CRON_MAX_BATCHES,
		reason: "batch cap reached",
	});
}

/** Background work must never change the ingest receipt. */
function scheduleBackground(
	ctx: ExecutionContext | undefined,
	label: string,
	operation: () => Promise<unknown>,
): void {
	if (typeof ctx?.waitUntil !== "function") return;
	ctx.waitUntil(
		(async () => {
			try {
				await operation();
			} catch (error) {
				console.warn(
					JSON.stringify({
						event: "research_semantic_index_background_failure",
						timestamp: new Date().toISOString(),
						stage: label,
						error_code:
							error instanceof ResearchBoundaryError ? error.error_code : "UNKNOWN",
					}),
				);
			}
		})(),
	);
}

function decodeBase64Chunks(value: unknown): Uint8Array[] {
	if (!Array.isArray(value)) throw new ResearchBoundaryError("INTEGRITY_FAILED");
	try {
		return value.map((encoded) => {
			if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
				throw new Error("invalid base64");
			}
			const binary = atob(encoded);
			return Uint8Array.from(binary, (character) => character.charCodeAt(0));
		});
	} catch {
		throw new ResearchBoundaryError("INTEGRITY_FAILED");
	}
}

/**
 * HTTP refusal for the quota guard.  Always 503 (never 429: this is a budget
 * circuit, not rate limiting), with the fixed four-key body.  `Retry-After` is
 * only emitted when a recovery instant is provable — today no verified baseline
 * exists, so it is omitted.
 */
function quotaGuardResponse(error: unknown, requestId: string): Response {
	const code = error instanceof QuotaGuardError ? error.error_code : "QUOTA_GUARD_UNAVAILABLE";
	const refusal = quotaHttpRefusal(code, requestId, null);
	const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
	if (refusal.retry_after_seconds !== null) {
		headers.set("Retry-After", String(refusal.retry_after_seconds));
	}
	return new Response(JSON.stringify(refusal.body), { status: refusal.status, headers });
}

/**
 * C5 private one-way transport.  This is an internal ingestion endpoint, not
 * an MCP tool and not a RESEARCH database connection.  The separate secret is
 * deliberately unrelated to LIVE/market scopes and remains fail-closed until
 * configured.
 */
async function handleResearchReplicaIngest(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
): Promise<Response> {
	if (request.method !== "POST") {
		return researchBoundaryResponse(new ResearchBoundaryError("UNSUPPORTED_OPERATION"), 405);
	}
	const storage = researchReplicaStorage(env);
	if (!storage || !env.RESEARCH_REPLICA_INGEST_TOKEN) {
		return researchBoundaryResponse(new ResearchBoundaryError("STORE_UNAVAILABLE"), 503);
	}
	if (!researchReplicaAuthorized(request, env)) {
		return researchBoundaryResponse(new ResearchBoundaryError("FILTERED"), 401);
	}
	// Multi-dimension admission (SDD CQ spec §2): every heavy ingest must hold an
	// atomic multi-dimension reservation before its first paid side effect.  With
	// no verified account baseline the ledger denies, so enforce mode is CLOSED.
	const requestId = crypto.randomUUID().replaceAll("-", "");
	let admission: {
		handle: ReturnType<typeof admissionHandle>;
		budget: ReservationBudget;
		result: { status: string; reservation_id?: string };
	} | null = null;
	// The global live-row scan cap (256) is shared by every heavy route: an
	// admission that exits without settlement leaks one slot per call and, under
	// sustained ingest traffic, jams ingest + semantic + run envelopes platform
	// wide (2026-09-30 incident). Every exit after admission therefore settles
	// the declared bound; the success path marks admissionSettled first.
	let admissionSettled = false;
	const settleDeclaredOnLeak = (): Promise<void> =>
		admission && !admissionSettled
			? chargeDeclaredBoundForEnv(env, admission.result).catch(() => undefined)
			: Promise.resolve();
	if (admissionMode(env) === "enforce") {
		const profile = routeCostProfile("http:/internal/research-replica/v2/ingest");
		if (!profile || profile.cost_class !== "heavy_bounded") {
			return quotaGuardResponse(
				new QuotaGuardError("QUOTA_GUARD_UNAVAILABLE", "ingest route is not classified"),
				requestId,
			);
		}
		const operationId = `ingest:${requestId}`;
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				[
					profile.route,
					String(request.headers.get("Content-Length") ?? ""),
					String(request.headers.get("X-Collector-Message-Id") ?? ""),
					requestId,
				].join("\u0000"),
			),
		);
		const fingerprint = [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		try {
			admission = await admitHeavyRouteForEnv(env, {
				route: profile.route,
				operation_id: operationId,
				fingerprint,
			});
		} catch (error) {
			return quotaGuardResponse(error, requestId);
		}
	}
	const guarded: ResearchReplicaStorage =
		admission?.handle && admission.budget
			? {
					db: createGuardedD1(storage.db, admission.handle, admission.budget),
					objects: createGuardedR2(storage.objects, admission.handle, admission.budget),
				}
			: storage;
	// §A8 双道尺寸门：Content-Length 预检（缺失/非数值跳过）+ 读体后实测。
	const contentLength = Number(request.headers.get("Content-Length"));
	if (Number.isFinite(contentLength) && contentLength > RESEARCH_INGEST_MAX_BODY_BYTES) {
		await settleDeclaredOnLeak();
		return researchBoundaryResponse(new ResearchBoundaryError("RATE_LIMITED"), 413);
	}
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		await settleDeclaredOnLeak();
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	if (new TextEncoder().encode(raw).byteLength > RESEARCH_INGEST_MAX_BODY_BYTES) {
		await settleDeclaredOnLeak();
		return researchBoundaryResponse(new ResearchBoundaryError("RATE_LIMITED"), 413);
	}
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		await settleDeclaredOnLeak();
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	if (
		!body ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body as Record<string, unknown>).some(
			(key) => key !== "record" && key !== "object_chunks_base64",
		)
	) {
		await settleDeclaredOnLeak();
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	const transport = body as { record?: unknown; object_chunks_base64?: unknown };
	try {
		const objectChunks =
			transport.object_chunks_base64 === undefined
				? null
				: decodeBase64Chunks(transport.object_chunks_base64);
		const result = await ingestResearchReplicaRecord(guarded, transport.record, objectChunks);
		// Task D: the pending row was registered inside the ingest transaction,
		// so this hook is only the fast path - the bounded sweep converges
		// whatever the background task cannot finish.  The receipt below is
		// unchanged: embedding never blocks it.
		//
		// In enforce mode the embedding cannot be scheduled: Workers AI neurons
		// have no provable per-call upper bound, so the semantic index stays
		// pending (the documented CLOSED path) instead of spending unbounded
		// neurons.  The omission is logged, never silent.
		if (result.semantic_target && env.AI && env.RESEARCH_PUBLIC_INDEX) {
			if (admissionMode(env) === "enforce") {
				console.log(
					JSON.stringify({
						event: "semantic_index_deferred_closed",
						timestamp: new Date().toISOString(),
						reason: "QUOTA_GUARD_UNAVAILABLE",
						detail: "Workers AI neurons have no provable upper bound",
					}),
				);
			} else {
				const deps: SemanticIndexDeps = { ai: env.AI, index: env.RESEARCH_PUBLIC_INDEX };
				const target = result.semantic_target;
				scheduleBackground(ctx, "ingest_semantic_index", () =>
					indexSemanticDocument(guarded, deps, {
						documentId: target.documentId,
						versionId: target.versionId,
					}),
				);
			}
		}
		// Settle with the platform-reported practical usage observed by the guarded
		// adapters.  A settlement rejection keeps the reservation (over-bound actual
		// usage must not be "corrected" by an after-the-fact write).
		if (admission) {
			const budget = admission.budget;
			const settleOutcome = await settleReservation(env.RESEARCH_REPLICA!, {
				reservation_id: admission.result.reservation_id as string,
				observed: budget.snapshot(),
				reason: "ingest_completed",
			}).catch(() => undefined);
			if (settleOutcome?.status === "SETTLED") admissionSettled = true;
		}
		// Envelope pinned explicitly: the additive in-process fields
		// (semantic_target) never widen the frozen four-key transport response.
		return jsonResponse({
			status: result.status,
			message_id: result.message_id,
			record_type: result.record_type,
			content_sha256: result.content_sha256,
		});
	} catch (error) {
		// A refusal from inside the guarded region (amplification past the reserved
		// bound, or missing D1 usage metadata) is a quota refusal, not a store error.
		// The reservation used to be kept live here by design; that collided with
		// the global live-row scan cap — sustained traffic jammed every heavy route
		// platform wide (2026-09-30). Charging the declared bound is equally
		// conservative for the ceiling (booked is monotonic) and frees the slot.
		await settleDeclaredOnLeak();
		if (error instanceof QuotaGuardError) return quotaGuardResponse(error, requestId);
		return researchBoundaryResponse(
			error,
			error instanceof ResearchBoundaryError && error.retryable ? 503 : 400,
		);
	}
}

/**
 * Task D operations transport (internal, NOT an MCP tool): one bounded
 * indexing run and read-only coverage counters.  Same fail-closed credential
 * as the ingest/receipts transport; no PRIVATE capability is introduced and no
 * document ids leave this face.
 */
async function handleSemanticIndexRun(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") {
		return researchBoundaryResponse(new ResearchBoundaryError("UNSUPPORTED_OPERATION"), 405);
	}
	const storage = researchReplicaStorage(env);
	if (!storage || !env.RESEARCH_REPLICA_INGEST_TOKEN) {
		return researchBoundaryResponse(new ResearchBoundaryError("STORE_UNAVAILABLE"), 503);
	}
	if (!researchReplicaAuthorized(request, env)) {
		return researchBoundaryResponse(new ResearchBoundaryError("FILTERED"), 401);
	}
	// Daily neuron budget admission (owner approved 2026-09-30): in enforce mode
	// the run holds a cap reservation whose ai.neurons declaration covers the
	// directory's 10-document run cap with retry headroom; the UTC-day ledger
	// refuses runs once the 9,500 threshold would be crossed.  The AI binding is
	// guarded so every embedding call requires and spends against the cap.
	const requestId = crypto.randomUUID().replaceAll("-", "");
	const enforce = admissionMode(env) === "enforce";
	let admission: {
		handle: ReturnType<typeof admissionHandle>;
		budget: ReservationBudget;
		result: { status: string; reservation_id?: string };
	} | null = null;
	if (enforce) {
		try {
			admission = await admitHeavyRouteForEnv(env, {
				route: "http:/internal/research-semantic-index/run",
				operation_id: `semantic-run:${requestId}`,
				fingerprint: crypto.randomUUID().replaceAll("-", ""),
			});
		} catch (error) {
			return quotaGuardResponse(error, requestId);
		}
	}
	let body: unknown = {};
	try {
		const raw = await request.text();
		body = raw ? JSON.parse(raw) : {};
	} catch {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	const options = body as Record<string, unknown>;
	if (Object.keys(options).some((key) => key !== "max_docs" && key !== "max_register")) {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	// The declared ai.neurons reservation prices 10 documents: never let a caller
	// widen the batch past what the cap reservation covers.
	const maxDocs =
		typeof options.max_docs === "number" && Number.isFinite(options.max_docs)
			? Math.max(1, Math.min(Math.floor(options.max_docs), SEMANTIC_BATCH_MAX_DOCS))
			: SEMANTIC_BATCH_MAX_DOCS;
	try {
		const deps = semanticIndexDeps(env);
		const handle = admission?.handle;
		const guardedDeps: SemanticIndexDeps = handle
			? {
					ai: createGuardedAi(deps.ai, handle, admission!.budget) as typeof deps.ai,
					index: deps.index,
				}
			: deps;
		const report = await runSemanticIndexBatch(
			handle
				? { ...storage, db: createGuardedD1(storage.db, handle, admission!.budget) }
				: storage,
			guardedDeps,
			{ maxDocs, maxRegister: options.max_register as number | undefined },
		);
		if (admission) {
			await settleReservation(env.RESEARCH_REPLICA!, {
				reservation_id: admission.result.reservation_id as string,
				observed: admission.budget.snapshot(),
				reason: "semantic_index_run_completed",
			}).catch(() => undefined);
		}
		return jsonResponse(report);
	} catch (error) {
		if (error instanceof QuotaGuardError) return quotaGuardResponse(error, requestId);
		return researchBoundaryResponse(
			error,
			error instanceof ResearchBoundaryError && error.retryable ? 503 : 400,
		);
	}
}

async function handleSemanticVectorIngest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "POST") {
		return researchBoundaryResponse(new ResearchBoundaryError("UNSUPPORTED_OPERATION"), 405);
	}
	const storage = researchReplicaStorage(env);
	if (!storage || !env.RESEARCH_REPLICA_INGEST_TOKEN) {
		return researchBoundaryResponse(new ResearchBoundaryError("STORE_UNAVAILABLE"), 503);
	}
	if (!researchReplicaAuthorized(request, env)) {
		return researchBoundaryResponse(new ResearchBoundaryError("FILTERED"), 401);
	}
	// Locally-computed embeddings (owner approved 2026-09-30): zero Workers AI
	// cost - the admission reserves only the ledger's own D1 costs for the state
	// row read/write and the Vectorize upsert bookkeeping.
	const requestId = crypto.randomUUID().replaceAll("-", "");
	let admission: {
		handle: ReturnType<typeof admissionHandle>;
		budget: ReservationBudget;
		result: { status: string; reservation_id?: string };
	} | null = null;
	if (admissionMode(env) === "enforce") {
		try {
			admission = await admitHeavyRouteForEnv(env, {
				route: "http:/internal/research-semantic-index/ingest-vectors",
				operation_id: `semantic-vectors:${requestId}`,
				fingerprint: crypto.randomUUID().replaceAll("-", ""),
			});
		} catch (error) {
			return quotaGuardResponse(error, requestId);
		}
	}
	let payload: unknown;
	try {
		payload = JSON.parse(await request.text());
	} catch {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	try {
		const deps = semanticIndexDeps(env);
		const handle = admission?.handle ?? null;
		const budget = admission?.budget ?? null;
		const result = await ingestPrecomputedVectors(
			handle && budget
				? { ...storage, db: createGuardedD1(storage.db, handle, budget) }
				: storage,
			{ index: deps.index },
			payload as Parameters<typeof ingestPrecomputedVectors>[2],
		);
		if (admission && handle && budget) {
			await settleReservation(env.RESEARCH_REPLICA!, {
				reservation_id: admission.result.reservation_id as string,
				observed: budget.snapshot(),
				reason: "semantic_vector_ingest",
			}).catch(() => undefined);
		}
		return jsonResponse(result);
	} catch (error) {
		if (error instanceof QuotaGuardError) return quotaGuardResponse(error, requestId);
		return researchBoundaryResponse(
			error,
			error instanceof ResearchBoundaryError && error.retryable ? 503 : 400,
		);
	}
}

async function handleSemanticIndexStatus(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") {
		return researchBoundaryResponse(new ResearchBoundaryError("UNSUPPORTED_OPERATION"), 405);
	}
	const storage = researchReplicaStorage(env);
	if (!storage || !env.RESEARCH_REPLICA_INGEST_TOKEN) {
		return researchBoundaryResponse(new ResearchBoundaryError("STORE_UNAVAILABLE"), 503);
	}
	if (!researchReplicaAuthorized(request, env)) {
		return researchBoundaryResponse(new ResearchBoundaryError("FILTERED"), 401);
	}
	try {
		return jsonResponse(await readSemanticIndexCoverage(storage));
	} catch (error) {
		return researchBoundaryResponse(
			error,
			error instanceof ResearchBoundaryError && error.retryable ? 503 : 400,
		);
	}
}

/** Deployment probe (G3): real embedding dimensions plus index metadata. */
async function handleSemanticIndexProbe(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return researchBoundaryResponse(new ResearchBoundaryError("UNSUPPORTED_OPERATION"), 405);
	}
	if (!env.RESEARCH_REPLICA_INGEST_TOKEN) {
		return researchBoundaryResponse(new ResearchBoundaryError("STORE_UNAVAILABLE"), 503);
	}
	if (!researchReplicaAuthorized(request, env)) {
		return researchBoundaryResponse(new ResearchBoundaryError("FILTERED"), 401);
	}
	try {
		return jsonResponse(await probeSemanticIndex(semanticIndexDeps(env)));
	} catch (error) {
		return researchBoundaryResponse(
			error,
			error instanceof ResearchBoundaryError && error.retryable ? 503 : 400,
		);
	}
}

/**
 * PUBLIC 文档数据有效期运维通道（内部凭据门控，非 MCP 工具；owner 裁定
 * 2026-09-29：PUBLIC 副本保留 90 天，source_id='E02-gelonghui-live' 原文快照
 * 为历史违规存量全部清理）。POST 触发一轮有界、可续跑的 retention 编排；
 * `?dry_run=1` 只列超期清单与待清除积压、不删任何东西，供首轮清单核对。
 * 与 ingest/semantic 运维通道共用 RESEARCH transport credential，fail-closed。
 */
async function handleRetentionRun(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return researchBoundaryResponse(new ResearchBoundaryError("UNSUPPORTED_OPERATION"), 405);
	}
	const storage = researchReplicaStorage(env);
	if (!storage || !env.RESEARCH_REPLICA_INGEST_TOKEN) {
		return researchBoundaryResponse(new ResearchBoundaryError("STORE_UNAVAILABLE"), 503);
	}
	if (!researchReplicaAuthorized(request, env)) {
		return researchBoundaryResponse(new ResearchBoundaryError("FILTERED"), 401);
	}
	// Quota admission (SDD CQ spec §4): the retention sweep combines an unbounded
	// `research_records` scan with Vectorize stock deletion.  Neither has a
	// provable upper bound, so enforce mode refuses the run and reports the
	// compliance backlog instead of silently consuming the allowance.  The dry-run
	// listing remains available for the compliance remediation window.
	if (admissionMode(env) === "enforce") {
		const url = new URL(request.url);
		const dryRunParam = url.searchParams.get("dry_run");
		if (!(dryRunParam === "1" || dryRunParam === "true")) {
			return quotaGuardResponse(
				new QuotaGuardError(
					"QUOTA_GUARD_UNAVAILABLE",
					"retention sweep has no provable scan/vector upper bound; dry_run remains available",
				),
				crypto.randomUUID().replaceAll("-", ""),
			);
		}
	}
	const url = new URL(request.url);
	const dryRunParam = url.searchParams.get("dry_run");
	const dryRun = dryRunParam === "1" || dryRunParam === "true";
	if (dryRunParam !== null && !dryRun) {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	let body: unknown = {};
	try {
		const raw = await request.text();
		body = raw ? JSON.parse(raw) : {};
	} catch {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	const options = body as Record<string, unknown>;
	if (Object.keys(options).some((key) => key !== "max_mark" && key !== "max_purge")) {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	const deps: RetentionDeps = { index: env.RESEARCH_PUBLIC_INDEX ?? null };
	try {
		const report: RetentionRunReport = await runRetentionSweep(storage, deps, {
			trigger: "manual",
			dryRun,
			maxMark: options.max_mark as number | undefined,
			maxPurge: options.max_purge as number | undefined,
		});
		return jsonResponse(report);
	} catch (error) {
		return researchBoundaryResponse(
			error,
			error instanceof ResearchBoundaryError && error.retryable ? 503 : 400,
		);
	}
}

/**
 * §A1 receipts 只读回流端点（内部通道，非 MCP 工具）。与 ingest 共用现有
 * RESEARCH transport credential；未配置 → 503 fail-closed，token 不匹配 →
 * 401 FILTERED。响应为 §5.4 collector-receipts-v1 白名单，claim_token /
 * proposal 正文 / 客户端原始输入结构上不可能出现。
 */
async function handleResearchReplicaReceipts(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") {
		return researchBoundaryResponse(new ResearchBoundaryError("UNSUPPORTED_OPERATION"), 405);
	}
	const storage = researchReplicaStorage(env);
	if (!storage || !env.RESEARCH_REPLICA_INGEST_TOKEN) {
		return researchBoundaryResponse(new ResearchBoundaryError("STORE_UNAVAILABLE"), 503);
	}
	if (request.headers.get("Authorization") !== `Bearer ${env.RESEARCH_REPLICA_INGEST_TOKEN}`) {
		return researchBoundaryResponse(new ResearchBoundaryError("FILTERED"), 401);
	}
	const url = new URL(request.url);
	const since = url.searchParams.get("since");
	const limitParam = url.searchParams.get("limit");
	let limit: number | undefined;
	if (limitParam !== null) {
		limit = Number(limitParam);
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
			return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
		}
	}
	try {
		return jsonResponse(
			await listResearchJobReceipts(storage.db, {
				since,
				limit,
				now: new Date().toISOString(),
			}),
		);
	} catch (error) {
		return researchBoundaryResponse(
			error,
			error instanceof ResearchBoundaryError && error.retryable ? 503 : 400,
		);
	}
}

/** 内部 universe API / writer 鉴权；只认 PORTFOLIO_UNIVERSE_TOKEN。 */
function requestInternalUniverseStatus(request: Request | undefined, env: Env): LiveOverlayStatus {
	return resolveLiveOverlayStatus(
		request?.headers.get("Authorization") ?? null,
		env.PORTFOLIO_UNIVERSE_TOKEN,
	);
}

/**
 * 外部 ChatGPT / Automation MCP 鉴权；只认独立 Collector client credential，
 * 并要求 market:read。绝不回退到 PORTFOLIO_UNIVERSE_TOKEN。
 */
function requestMcpMarketReadStatus(request: Request | undefined, env: Env): LiveOverlayStatus {
	const status = resolveMarketReadLiveOverlayStatus(
		request?.headers.get("Authorization") ?? null,
		env.COLLECTOR_MCP_CLIENT_TOKEN,
		env.COLLECTOR_MCP_CLIENT_SCOPES,
	);
	// A credential without an explicit production client identity is not an auditable principal.
	// Fail closed rather than silently granting an identity-less LIVE read.
	if (status === "ENABLED" && !env.COLLECTOR_MCP_CLIENT_ID?.trim()) {
		return "SKIPPED_UNAUTHORIZED";
	}
	return status;
}

/** 内部 token 未配置或请求头不匹配 → 未授权（fail-closed，`!== "ENABLED"`）。 */
function isUniverseAuthorized(request: Request, env: Env): boolean {
	return isLiveOverlayEnabled(requestInternalUniverseStatus(request, env));
}

async function handleUniverseApi(request: Request, env: Env): Promise<Response> {
	if (!env.PORTFOLIO_UNIVERSE) {
		return jsonResponse({ error: "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED" }, 503);
	}
	if (!isUniverseAuthorized(request, env)) {
		return jsonResponse({ error: "UNAUTHORIZED" }, 401);
	}
	if (request.method === "GET") {
		try {
			const universe = await readLiveUniverse(env.PORTFOLIO_UNIVERSE);
			return universe
				? jsonResponse(universe)
				: jsonResponse({ error: "NO_LIVE_UNIVERSE" }, 404);
		} catch (error) {
			return jsonResponse(
				{ error: "LIVE_UNIVERSE_READ_FAILED", message: clientFacingErrorMessage(error) },
				500,
			);
		}
	}
	if (request.method !== "POST") {
		return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	}

	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return jsonResponse({ error: "BODY_READ_FAILED" }, 400);
	}
	if (new TextEncoder().encode(raw).byteLength > 32_768) {
		return jsonResponse({ error: "PAYLOAD_TOO_LARGE" }, 413);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return jsonResponse({ error: "INVALID_JSON" }, 400);
	}
	try {
		const stored = await writeLiveUniverse(env.PORTFOLIO_UNIVERSE, payload);
		return jsonResponse({
			status: "SUCCESS",
			schema_version: stored.schema_version,
			content_hash: stored.content_hash,
			generated_at: stored.generated_at,
			source_manifest_hash: stored.source_manifest_hash,
			received_at: stored.received_at,
			active_count: stored.active.length,
		});
	} catch (error) {
		return jsonResponse(
			{ error: "INVALID_QUOTE_UNIVERSE", message: clientFacingErrorMessage(error) },
			400,
		);
	}
}

async function getControlPlaneStatus(env: Env) {
	const live = await resolveLivePresentation(env.PORTFOLIO_UNIVERSE, new Date(), {
		tolerateUnreadableUniverse: true,
	});
	const universePresent = live.universe !== null;
	// 双轨锚：LRCCA 优先，缺失时回退 generated_at（C-4），口径仍是既有 10 天可用窗口。
	const universeFresh = live.presentation.fresh;
	return {
		status: universePresent && universeFresh ? "OK" : "PENDING",
		ingest_mode: "GITHUB_VERIFIED_PUSH",
		github_private_read: false,
		kv_bound: Boolean(env.PORTFOLIO_UNIVERSE),
		universe_present: universePresent,
		universe_fresh: universeFresh,
		// C-3：只出三态枚举词（无代码 / 数量 / hash）；无件 / 损坏 / 交叉不一致按保守态呈现。
		portfolio_state: live.presentation.portfolio_state,
		stale: live.presentation.stale,
		freshness_anchor: live.presentation.freshness_anchor,
		freshness_anchor_fallback: live.presentation.freshness_anchor_fallback,
		mode: universePresent ? "LIVE_DYNAMIC" : "LEGACY_FALLBACK",
	};
}

async function handleControlPlaneStatus(env: Env): Promise<Response> {
	const payload = await getControlPlaneStatus(env);
	return jsonResponse(payload, payload.kv_bound ? 200 : 503);
}

async function handleGithubAuthProbe(request: Request): Promise<Response> {
	if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	try {
		await verifyGithubAccessToken(githubBearerToken(request));
		return jsonResponse({ status: "OK", identity: "GITHUB_VERIFIED" });
	} catch (error) {
		return jsonResponse(
			{ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) },
			401,
		);
	}
}

async function handleGithubAuthUniverse(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	if (!env.PORTFOLIO_UNIVERSE) {
		return jsonResponse({ error: "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED" }, 503);
	}
	try {
		await verifyGithubAccessToken(githubBearerToken(request));
	} catch (error) {
		return jsonResponse(
			{ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) },
			401,
		);
	}
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return jsonResponse({ error: "BODY_READ_FAILED" }, 400);
	}
	if (new TextEncoder().encode(raw).byteLength > 32_768) {
		return jsonResponse({ error: "PAYLOAD_TOO_LARGE" }, 413);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return jsonResponse({ error: "INVALID_JSON" }, 400);
	}
	try {
		const stored = await writeLiveUniverse(env.PORTFOLIO_UNIVERSE, payload);
		return jsonResponse({
			status: "SUCCESS",
			content_hash: stored.content_hash,
			generated_at: stored.generated_at,
			received_at: stored.received_at,
			active_count: stored.active.length,
		});
	} catch (error) {
		return jsonResponse(
			{ error: "INVALID_QUOTE_UNIVERSE", message: clientFacingErrorMessage(error) },
			400,
		);
	}
}

/**
 * C-1：`POST /api/github-auth/portfolio-status` —— 接收 LIVE 侧状态件。
 *
 * 失败语义与 `/api/github-auth/quote-universe` 完全同款（401 / 413 / 400），
 * 写入前全量校验，非法件拒写且旧件保留（LKG 语义，见 writePortfolioStatus）。
 * 写入内容为状态件原样（LIVE 是三态的权威计算方，J-4）；Worker 的保守复核
 * 发生在**读取**侧（resolveLivePresentation），不回写 KV。
 */
async function handleGithubAuthPortfolioStatus(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	if (!env.PORTFOLIO_UNIVERSE) {
		return jsonResponse({ error: "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED" }, 503);
	}
	try {
		await verifyGithubAccessToken(githubBearerToken(request));
	} catch (error) {
		return jsonResponse(
			{ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) },
			401,
		);
	}
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return jsonResponse({ error: "BODY_READ_FAILED" }, 400);
	}
	if (new TextEncoder().encode(raw).byteLength > PORTFOLIO_STATUS_MAX_PAYLOAD_BYTES) {
		return jsonResponse({ error: "PAYLOAD_TOO_LARGE" }, 413);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return jsonResponse({ error: "INVALID_JSON" }, 400);
	}
	try {
		const stored = await writePortfolioStatus(env.PORTFOLIO_UNIVERSE, payload);
		try {
			await recordPortfolioDeltaAfterStatusWrite(env.PORTFOLIO_UNIVERSE, stored);
		} catch (error) {
			// The authenticated status document is already LKG-valid.  Report the
			// private reducer failure explicitly so LIVE retries instead of treating
			// the batch as a fully accepted C3 observation.
			return jsonResponse(
				{
					error: "PORTFOLIO_DELTA_UPDATE_FAILED",
					message: clientFacingErrorMessage(error),
				},
				503,
			);
		}
		return jsonResponse({
			status: "SUCCESS",
			schema_version: stored.schema_version,
			state: stored.state,
			generated_at: stored.generated_at,
			last_real_complete_confirmed_at: stored.last_real_complete_confirmed_at,
			universe_content_hash: stored.universe_content_hash,
			source_manifest_hash: stored.source_manifest_hash,
			received_at: stored.received_at,
		});
	} catch (error) {
		return jsonResponse(
			{ error: "INVALID_PORTFOLIO_STATUS", message: clientFacingErrorMessage(error) },
			400,
		);
	}
}

/**
 * C3 only observes the authenticated LIVE status push.  A mismatch or an
 * unreadable universe is deliberately downgraded to UNKNOWN for the reducer:
 * it breaks continuity, never manufactures a removal event, and preserves
 * the existing three-state/LRCCA presentation semantics.
 */
async function recordPortfolioDeltaAfterStatusWrite(
	kv: KVNamespace,
	status: StoredPortfolioStatus,
): Promise<void> {
	let universe: StoredLiveUniverse | null = null;
	try {
		universe = await readLiveUniverse(kv);
	} catch {
		// A corrupted private universe cannot participate in COMPLETE→COMPLETE.
		universe = null;
	}
	let state: PortfolioDeltaState = "PORTFOLIO_UNKNOWN";
	if (universe) {
		const freshness = resolveLiveUniverseFreshness(universe, {
			lrcca: status.last_real_complete_confirmed_at,
			now: new Date(),
		});
		// C3 must consume the same conservative state that guards LIVE overlay.
		// A stale LRCCA or hash drift may downgrade a self-declared COMPLETE
		// status, and such a transition must never confirm a removal.
		state = resolvePortfolioPresentation({
			universePresent: true,
			universeContentHash: universe.content_hash,
			universeManifestHash: universe.source_manifest_hash,
			status,
			anchor: {
				anchor: freshness.anchor,
				anchor_fallback: freshness.anchor_fallback,
				fresh: freshness.fresh,
			},
		}).portfolio_state;
	}
	await recordPortfolioUniverseObservation(kv, {
		state,
		current_complete_hash: status.universe_content_hash,
		active_codes: universe?.active ?? [],
		observed_at: status.generated_at,
	});
}

async function handleDynamicPortfolioQuotes(request: Request, env: Env): Promise<Response> {
	if (!isUniverseAuthorized(request, env)) {
		return jsonResponse({ error: "UNAUTHORIZED" }, 401);
	}
	if (!env.PORTFOLIO_UNIVERSE) {
		return jsonResponse({ error: "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED" }, 503);
	}
	const context = bridgeContext("http:dynamic-portfolio-quotes");
	try {
		// C-4/C-5：本端点是「LIVE 动态投影」诊断面，状态未知时不静默返回静态目录。
		const live = await resolveLivePresentation(env.PORTFOLIO_UNIVERSE, new Date());
		if (!live.universe) return jsonResponse({ error: "NO_LIVE_UNIVERSE" }, 503);
		if (!live.presentation.fresh) {
			return jsonResponse(
				{
					error: "LIVE_UNIVERSE_STALE",
					portfolio_state: live.presentation.portfolio_state,
				},
				503,
			);
		}
		if (!live.presentation.apply_overlay) {
			return jsonResponse(
				{ error: "PORTFOLIO_UNKNOWN", portfolio_state: live.presentation.portfolio_state },
				503,
			);
		}
		const upstream = await fetchPrivateCatalogSnapshot(
			context,
			env,
			// 本端点已在上面用同一入口鉴权（未授权直接 401），故门必为放行态。
			{ liveOverlayStatus: requestInternalUniverseStatus(request, env) },
		);
		return jsonResponse(upstream.snapshot);
	} catch (error) {
		logBridgeFailure(context, error, "dynamic_portfolio_quotes");
		return jsonResponse(
			{ error: "PORTFOLIO_QUOTES_UNAVAILABLE", message: clientFacingErrorMessage(error) },
			502,
		);
	}
}

async function handlePublicQuotes(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	const context = bridgeContext("http:public-quotes");
	try {
		return jsonResponse(await fetchPublicQuoteSnapshot(context, env));
	} catch (error) {
		logBridgeFailure(context, error, "public_quotes");
		return jsonResponse(
			{ error: "UPSTREAM_UNAVAILABLE", message: PUBLIC_QUOTES_UNAVAILABLE_MESSAGE },
			502,
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (admissionMode(env) === "enforce") {
			const profile = routeCostProfile(`http:${url.pathname}`);
			if (
				profile?.cost_class === "heavy_unbounded" &&
				url.pathname !== "/internal/research-replica/v2/ingest" &&
				url.pathname !== "/internal/research-semantic-index/run" &&
				url.pathname !== "/internal/research-retention/run"
			) {
				return quotaGuardResponse(
					new QuotaGuardError("QUOTA_GUARD_UNAVAILABLE", "route cost is unproven"),
					crypto.randomUUID().replaceAll("-", ""),
				);
			}
		}
		if (url.pathname === "/api/github-auth/probe") return handleGithubAuthProbe(request);
		if (url.pathname === "/api/github-auth/quote-universe")
			return handleGithubAuthUniverse(request, env);
		if (url.pathname === "/api/github-auth/portfolio-status") {
			return handleGithubAuthPortfolioStatus(request, env);
		}
		if (url.pathname === "/internal/research-replica/v2/ingest") {
			return handleResearchReplicaIngest(request, env, ctx);
		}
		if (url.pathname === "/internal/research-replica/v2/receipts") {
			return handleResearchReplicaReceipts(request, env);
		}
		// Task D 运维通道（内部凭据门控，非 MCP 工具）：批次索引、覆盖率只读查询、
		// 部署探针。语义检索本身只经 MCP `search_documents_semantic`。
		if (url.pathname === "/internal/research-semantic-index/ingest-vectors") {
			return handleSemanticVectorIngest(request, env);
		}
		if (url.pathname === "/internal/research-semantic-index/run") {
			return handleSemanticIndexRun(request, env);
		}
		if (url.pathname === "/internal/research-semantic-index/status") {
			return handleSemanticIndexStatus(request, env);
		}
		if (url.pathname === "/internal/research-semantic-index/probe") {
			return handleSemanticIndexProbe(request, env);
		}
		// PUBLIC 文档数据有效期（retention）运维通道：POST + 内部凭据门控，
		// `?dry_run=1` 只列清单不删（首轮验证用）。非 MCP 工具。
		if (url.pathname === "/internal/research-retention/run") {
			return handleRetentionRun(request, env);
		}
		if (url.pathname === "/api/control-plane-status" && request.method === "GET") {
			return handleControlPlaneStatus(env);
		}
		if (url.pathname === "/api/quote-universe") return handleUniverseApi(request, env);
		if (url.pathname === "/api/public/quotes") return handlePublicQuotes(request, env);
		if (url.pathname === "/api/portfolio-quotes")
			return handleDynamicPortfolioQuotes(request, env);
		// MCP 面（含 `get_portfolio_quotes`）：外部 client auth 与内部 universe token 解耦。
		// 工厂按请求构造 server，故 `ctx.requestInfo` 就是当前请求；market:read 不足一律 fail-closed。
		const handler = createMcpHandler((ctx) => {
			const liveOverlayStatus = requestMcpMarketReadStatus(ctx.requestInfo, env);
			logBridgeStage(bridgeContext("mcp:market-read-auth"), "mcp_market_read_auth", {
				...marketReadAuditFields(env, liveOverlayStatus),
				live_overlay_status: liveOverlayStatus,
			});
			// §A4 研究写面 scope 解析：凭据逐字节匹配为前提，转发 scope 头 ∩
			// server 配置上限（该头仅由 OAuth 桥在剥除客户端同名头后设置）。
			const researchScopes = resolveResearchScopes(
				ctx.requestInfo?.headers.get("Authorization") ?? null,
				ctx.requestInfo?.headers.get(FORWARDED_SCOPES_HEADER) ?? null,
				env.COLLECTOR_MCP_CLIENT_TOKEN,
				env.COLLECTOR_MCP_CLIENT_SCOPES,
			);
			// #19：桥接层从已验证 grant props 盖章的稳定业务主体（chatgpt-production）。
			// 动态 DCR client_id 不再进入授权路径；该头只在内部 bridge credential
			// 逐字节匹配时被接受，客户端自带的同名头已在桥内剥除。
			// 2026-09-27：转发主体走白名单（COLLECTOR_FORWARDABLE_PRINCIPALS），
			// 无头的静态直连客户端取登记身份（COLLECTOR_STATIC_CLIENT_PRINCIPAL）。
			const researchPrincipal = resolveResearchPrincipal(
				ctx.requestInfo?.headers.get("Authorization") ?? null,
				ctx.requestInfo?.headers.get(FORWARDED_PRINCIPAL_HEADER) ?? null,
				env.COLLECTOR_MCP_CLIENT_TOKEN,
				env.COLLECTOR_FORWARDABLE_PRINCIPALS,
				env.COLLECTOR_STATIC_CLIENT_PRINCIPAL,
			);
			const researchIssuer = resolveResearchIssuer(
				ctx.requestInfo?.headers.get("Authorization") ?? null,
				ctx.requestInfo?.headers.get(FORWARDED_ISSUER_HEADER) ?? null,
				env.COLLECTOR_MCP_CLIENT_TOKEN,
				env.COLLECTOR_STATIC_CLIENT_ISSUER,
			);
			return createServer(
				env,
				liveOverlayStatus,
				researchScopes,
				researchPrincipal,
				researchIssuer,
			);
		});
		return handler(request, env, ctx);
	},
	async scheduled(controller: ScheduledController, env: Env) {
		// Daily semantic indexing (owner approved 2026-09-30): one scheduled run
		// per UTC day loops the SAME admission path as the HTTP run route — each
		// batch reserves its own 940-neuron cap, settles against the ledger, and
		// stops the moment the daily 9,500 budget refuses.  No bypass exists.
		if (controller.cron === SEMANTIC_INDEX_CRON) {
			const context = bridgeContext(`cron:${SEMANTIC_INDEX_CRON}`);
			logBridgeStage(context, "scheduled_enter", { task: "research_semantic_index" });
			try {
				await runSemanticIndexCron(env, context);
			} catch (error) {
				logBridgeFailure(context, error, "scheduled");
				throw error;
			}
			return;
		}
		// PUBLIC 文档数据有效期（owner 裁定 2026-09-29）：每日一轮有界
		// retention 编排（标记 EXPIRED → R2 清除 → D1 行删除 → 向量收尾）。
		// 失败如实抛出让 cron 调用显式失败，绝不静默。
		if (controller.cron === RETENTION_CRON) {
			const context = bridgeContext(`cron:${RETENTION_CRON}`);
			logBridgeStage(context, "scheduled_enter", { task: "research_retention" });
			try {
				const storage = researchReplicaStorage(env);
				if (!storage) throw new ResearchBoundaryError("STORE_UNAVAILABLE");
				// Quota admission (SDD CQ spec §4/§5): the retention sweep has no
				// provable scan or Vectorize-stock upper bound.  Enforce mode reports
				// a structured skip/failed outcome and never fabricates a success
				// receipt; the compliance backlog stays visible to operators.
				if (admissionMode(env) === "enforce") {
					const outcome = cronQuotaOutcome(
						"QUOTA_GUARD_UNAVAILABLE",
						"research_retention",
					);
					logBridgeStage(context, `scheduled_${outcome.status}`, {
						task: outcome.task,
						reason: outcome.reason,
						detail: "unbounded documents scan and Vectorize stock deletion have no provable bound",
					});
					return;
				}
				const deps: RetentionDeps = { index: env.RESEARCH_PUBLIC_INDEX ?? null };
				const report: RetentionRunReport = await runRetentionSweep(storage, deps, {
					trigger: "scheduled",
				});
				logBridgeStage(context, "scheduled_complete", {
					task: "research_retention",
					retention_scanned: report.scanned_documents,
					retention_marked: report.marked_expired,
					retention_purged: report.purged_documents,
					retention_purge_skipped: report.purge_skipped,
				});
			} catch (error) {
				logBridgeFailure(context, error, "scheduled");
				throw error;
			}
			return;
		}
		const runId = controller.cron ? `cron:${controller.cron}` : "test:scheduled";
		const context = bridgeContext(runId);
		logBridgeStage(context, "scheduled_enter");
		// The legacy 2026-09-29 daily prototype is inert: report a leftover flag
		// explicitly so it can never be mistaken for an active 95% guard.
		const legacy = legacyBreakerFlag(env);
		if (legacy.present) {
			logBridgeStage(context, "quota_legacy_flag_ignored", {
				flag: legacy.flag,
				prototype_state: legacy.prototype_state,
			});
		}

		try {
			const payload = await updateQuoteBridge(env, context.runId);
			logBridgeStage(context, "scheduled_complete", {
				bridge_status: payload.bridge.last_attempt_status,
				snapshot_time: payload.snapshot?.snapshot_time ?? null,
				system_quality: payload.snapshot?.system_quality ?? null,
			});
		} catch (error) {
			logBridgeFailure(context, error, "scheduled");
			throw error;
		} finally {
			// Spec §6.3: reconciliation must run even when the bridge fails, but
			// its own failures are warn-only and never override bridge semantics.
			await runScheduleReconciliation(env, context);
		}
	},
} satisfies ExportedHandler<Env>;
