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
import { ResearchBoundaryError } from "./research-outbound-v2.ts";
import { withResearchReadRetry } from "./research-read-retry.ts";
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
	STATE_CHANNEL_SCHEMA,
	StateGatewayError,
	validateStateBatch,
} from "./state-gateway.ts";
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
	RESEARCH_REPLICA?: D1Database;
	RESEARCH_OBJECTS?: R2Bucket;
	/** RESEARCH 私有 transport credential；ingest 与 receipts 共用，不与 market/research OAuth scopes 混用。 */
	RESEARCH_REPLICA_INGEST_TOKEN?: string;
	/** 非敏感部署标识；由发布命令注入，用于生产版本核验。 */
	DEPLOYED_GIT_SHA?: string;
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
		version: "1.2.0",
	});

	// 保留测试工具，确认 MCP 基础链路持续正常
	server.registerTool(
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
	server.registerTool(
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

	server.registerTool(
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

	server.registerTool(
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
		if (!storage) throw new ResearchBoundaryError("STORE_UNAVAILABLE");
		return new CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	};
	const researchWorkflowDb = () => {
		const storage = env ? researchReplicaStorage(env) : null;
		if (!storage) throw new ResearchBoundaryError("STORE_UNAVAILABLE");
		return storage.db;
	};
	const researchDomain = async (operation: () => Promise<unknown>) => {
		try {
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) },
				],
			};
		} catch (error) {
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
	const researchRead = <T>(operation: () => Promise<T>) =>
		researchDomain(() => withResearchReadRetry(operation));
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

	const stateGatewayErrorResponse = (error: unknown) => {
		const safe =
			error instanceof StateGatewayError
				? {
						status: error.code,
						phase: error.phase,
						retryable: error.retryable,
						request_id: error.requestId,
						message: error.message,
						...(error.httpStatus == null ? {} : { http_status: error.httpStatus }),
					}
				: {
						status: "STATE_UNAVAILABLE",
						phase: "READ",
						retryable: true,
						request_id: crypto.randomUUID().replaceAll("-", ""),
						message: "state gateway operation failed",
					};
		return {
			isError: true as const,
			content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
		};
	};
	const requireStateScope = (scope: string, tool: string) => {
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
		if (exact || compatible) {
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

	server.registerTool(
		"get_state_snapshot",
		{
			description:
				"读取固定生产状态账本：MARKET 固定 Issue #2，INDUSTRY/COMPANY/CLOSE 固定 Issue #3。调用方不能指定外部目标。需要 state:read scope。",
			inputSchema: z.object({
				symbols: z
					.array(z.string().regex(/^(?:CN:\d{6}|HK:\d{5})$/))
					.min(1)
					.max(512),
				include: z.array(STATE_CHANNEL_SCHEMA).min(1).max(4),
				trading_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional(),
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

	server.registerTool(
		"validate_state_batch",
		{
			description:
				"仅校验 State Gateway batch，不产生外部写入；返回 channel、write_key、schema version 与 canonical payload hash。需要 state:read scope。",
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
				return stateGatewayErrorResponse(error);
			}
		},
	);

	server.registerTool(
		"append_state_batch",
		{
			description:
				"将 exact-schema 状态批次 append-only 持久化到固定 QuantPro 账本。调用方只能选择 MARKET/INDUSTRY/COMPANY/CLOSE，不能选择 repo、issue、URL、credential、producer 或 dimension。服务端执行权限、幂等、关系校验、持久化回执与写后回读。需要 state:write scope。",
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

	server.registerTool(
		"get_state_write_receipt",
		{
			description:
				"读取 State Gateway D1 持久化回执。只接受 channel + write_key，不返回 credential。需要 state:read scope。",
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

	server.registerTool(
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
					deployedGitSha:
						env?.DEPLOYED_GIT_SHA?.trim() || env?.CF_VERSION_METADATA?.tag || null,
					cloudflareVersionId: env?.CF_VERSION_METADATA?.id ?? null,
					cloudflareVersionTimestamp: env?.CF_VERSION_METADATA?.timestamp ?? null,
					serviceVersion: "1.2.0",
					db: env?.RESEARCH_REPLICA,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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

	server.registerTool(
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

	server.registerTool(
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

	server.registerTool(
		"search_documents",
		{
			description: "在 Collector 的 PUBLIC Research replica 中搜索文档元数据。",
			inputSchema: z.object({
				query: z.string().optional(),
				limit: z.number().int().min(1).max(100).optional(),
			}),
		},
		async ({ query, limit }) =>
			researchRead(() => researchAdapter().searchDocuments(query, limit)),
	);
	server.registerTool(
		"get_document",
		{
			description: "读取 Collector replica 中经 SHA-256 校验的 PUBLIC 文档正文。",
			inputSchema: z.object({ document_id: z.string().min(1) }),
		},
		async ({ document_id }) => researchRead(() => researchAdapter().getDocument(document_id)),
	);
	server.registerTool(
		"search_evidence",
		{
			description: "列出 Collector replica 中的 PUBLIC Evidence。",
			inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
		},
		async ({ limit }) => researchRead(() => researchAdapter().searchEvidence(limit)),
	);
	server.registerTool(
		"get_evidence",
		{
			description: "读取 Collector replica 中指定的 PUBLIC Evidence。",
			inputSchema: z.object({ evidence_id: z.string().min(1) }),
		},
		async ({ evidence_id }) => researchRead(() => researchAdapter().getEvidence(evidence_id)),
	);
	server.registerTool(
		"get_theme_accumulator",
		{
			description: "读取指定主题的 PUBLIC Evidence Accumulator。",
			inputSchema: z.object({ subject_key: z.string().min(1) }),
		},
		async ({ subject_key }) =>
			researchRead(() => researchAdapter().getThemeAccumulator(subject_key)),
	);
	server.registerTool(
		"get_company_evidence_state",
		{
			description: "读取指定公司的 PUBLIC Evidence Accumulator 状态。",
			inputSchema: z.object({ company: z.string().min(1) }),
		},
		async ({ company }) =>
			researchRead(() => researchAdapter().getCompanyEvidenceState(company)),
	);
	server.registerTool(
		"get_coverage_status",
		{
			description: "读取 Collector replica 中的 PUBLIC Research Coverage。",
			inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
		},
		async ({ limit }) => researchRead(() => researchAdapter().getCoverageStatus(limit)),
	);
	server.registerTool(
		"get_source_health",
		{
			description:
				"读取 Research source health（outbound-v3 source_health 记录投影，实读 replica）。",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(100).optional(),
			}),
		},
		async ({ limit }) => researchRead(() => researchAdapter().getSourceHealth(limit)),
	);
	server.registerTool(
		"get_market_signal_state",
		{
			description:
				"读取市场信号状态（独立 market_signal 数值记录，仅作 R3/R4 价格输入）。无记录时如实返回 NO_DATA，不报错也不伪造数据。",
			inputSchema: z.object({ subject_key: z.string().min(1).max(128) }),
		},
		async ({ subject_key }) =>
			researchRead(() => researchAdapter().getMarketSignalState(subject_key)),
	);
	server.registerTool(
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
			researchRead(() =>
				researchAdapter().listResearchJobs(limit, { claimableOnly: claimable_only }),
			),
	);
	server.registerTool(
		"get_research_job_context",
		{
			description:
				"读取 Collector replica 中指定 PUBLIC Research Job 的上下文：job record（含触发证据）+ server_state + 提交历史 proposals。claim_token 永不出现在本面。",
			inputSchema: z.object({ job_id: z.string().min(1) }),
		},
		async ({ job_id }) => researchRead(() => researchAdapter().getResearchJobContext(job_id)),
	);
	server.registerTool(
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
	server.registerTool(
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
	server.registerTool(
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
 * C5 private one-way transport.  This is an internal ingestion endpoint, not
 * an MCP tool and not a RESEARCH database connection.  The separate secret is
 * deliberately unrelated to LIVE/market scopes and remains fail-closed until
 * configured.
 */
async function handleResearchReplicaIngest(request: Request, env: Env): Promise<Response> {
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
	// §A8 双道尺寸门：Content-Length 预检（缺失/非数值跳过）+ 读体后实测。
	const contentLength = Number(request.headers.get("Content-Length"));
	if (Number.isFinite(contentLength) && contentLength > RESEARCH_INGEST_MAX_BODY_BYTES) {
		return researchBoundaryResponse(new ResearchBoundaryError("RATE_LIMITED"), 413);
	}
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	if (new TextEncoder().encode(raw).byteLength > RESEARCH_INGEST_MAX_BODY_BYTES) {
		return researchBoundaryResponse(new ResearchBoundaryError("RATE_LIMITED"), 413);
	}
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
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
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	const transport = body as { record?: unknown; object_chunks_base64?: unknown };
	try {
		const objectChunks =
			transport.object_chunks_base64 === undefined
				? null
				: decodeBase64Chunks(transport.object_chunks_base64);
		return jsonResponse(
			await ingestResearchReplicaRecord(storage, transport.record, objectChunks),
		);
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
		if (url.pathname === "/api/github-auth/probe") return handleGithubAuthProbe(request);
		if (url.pathname === "/api/github-auth/quote-universe")
			return handleGithubAuthUniverse(request, env);
		if (url.pathname === "/api/github-auth/portfolio-status") {
			return handleGithubAuthPortfolioStatus(request, env);
		}
		if (url.pathname === "/internal/research-replica/v2/ingest") {
			return handleResearchReplicaIngest(request, env);
		}
		if (url.pathname === "/internal/research-replica/v2/receipts") {
			return handleResearchReplicaReceipts(request, env);
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
			const researchPrincipal = resolveResearchPrincipal(
				ctx.requestInfo?.headers.get("Authorization") ?? null,
				ctx.requestInfo?.headers.get(FORWARDED_PRINCIPAL_HEADER) ?? null,
				env.COLLECTOR_MCP_CLIENT_TOKEN,
			);
			const researchIssuer = resolveResearchIssuer(
				ctx.requestInfo?.headers.get("Authorization") ?? null,
				ctx.requestInfo?.headers.get(FORWARDED_ISSUER_HEADER) ?? null,
				env.COLLECTOR_MCP_CLIENT_TOKEN,
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
		const runId = controller.cron ? `cron:${controller.cron}` : "test:scheduled";
		const context = bridgeContext(runId);
		logBridgeStage(context, "scheduled_enter");

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
		}
	},
} satisfies ExportedHandler<Env>;
