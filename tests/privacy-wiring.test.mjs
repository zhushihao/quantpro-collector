import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Issue #7 隐私收口的源码级不变式（wiring 断言，与 live-overlay.test.mjs 同风格）。
 * 只做静态断言，不引入真实 token/持仓数据。
 */
test("Issue #1 bridge payload is always projected quote-only (success and failure paths)", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const bridgeBody = source.slice(
		source.indexOf("export async function updateQuoteBridge"),
		source.indexOf("function createServer"),
	);

	// 成功路径：写公开 Issue 的载荷必须投影。
	assert.match(bridgeBody, /snapshot: toPublicQuoteSnapshot\(upstream\.snapshot\),/);
	// 失败路径：历史快照回退同样投影，防止身份字段回流公开面。
	assert.match(
		bridgeBody,
		/snapshot: previous\.snapshot \? toPublicQuoteSnapshot\(previous\.snapshot\) : null,/,
	);
});

test("anonymous get_portfolio_quotes is projected quote-only; authorized keeps full LIVE", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const toolStart = source.indexOf('"get_portfolio_quotes"');
	const toolBody = source.slice(toolStart, source.indexOf("get_public_quotes"));

	assert.match(
		toolBody,
		/const displaySnapshot = isLiveOverlayEnabled\(liveOverlayStatus\)[\s\S]*?upstream\.snapshot[\s\S]*?toPublicQuoteSnapshot\(upstream\.snapshot\);/,
	);
	assert.match(toolBody, /\{ \.\.\.displaySnapshot, control_plane_status: controlPlaneStatus \}/);
});

test("legacy proxy and CF Access runtime dependency are absent after decommission", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /cn-hk-quotes-proxy/);
	assert.doesNotMatch(source, /PORTFOLIO_QUOTES_URL/);
	assert.doesNotMatch(source, /CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET/);
	assert.doesNotMatch(source, /fetchUpstreamSnapshot/);
	assert.match(source, /PRIVATE_QUOTE_CATALOG_MISSING/);
	assert.match(source, /PRIVATE_KV_DIRECT_TENCENT/);
});

test("private LIVE surface is preserved alongside the public one (dual contract)", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	// 私域 gated 端点仍在且鉴权门不变。
	assert.match(source, /if \(url\.pathname === "\/api\/portfolio-quotes"\)/);
	assert.match(source, /function isUniverseAuthorized/);
	// 公开路由无鉴权（它是明确公开面），但必须投影 quote-only。
	assert.match(source, /if \(url\.pathname === "\/api\/public\/quotes"\)/);
	assert.match(source, /return jsonResponse\(await fetchPublicQuoteSnapshot\(context, env\)\);/);
	// 私域响应保持富投影：gated 端点直接返回 upstream.snapshot（未投影）。
	const gatedBody = source.slice(
		source.indexOf("async function handleDynamicPortfolioQuotes"),
		source.indexOf("async function handlePublicQuotes"),
	);
	assert.match(gatedBody, /return jsonResponse\(upstream\.snapshot\);/);
	assert.doesNotMatch(gatedBody, /toPublicQuoteSnapshot/);
});

test("Issue #8 auth split cannot make the internal universe token an MCP credential", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const internalGate = source.slice(
		source.indexOf("function requestInternalUniverseStatus"),
		source.indexOf("function requestMcpMarketReadStatus"),
	);
	const mcpGate = source.slice(
		source.indexOf("function requestMcpMarketReadStatus"),
		source.indexOf("function isUniverseAuthorized"),
	);
	assert.match(internalGate, /PORTFOLIO_UNIVERSE_TOKEN/);
	assert.doesNotMatch(internalGate, /COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(mcpGate, /COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(mcpGate, /COLLECTOR_MCP_CLIENT_SCOPES/);
	assert.match(mcpGate, /COLLECTOR_MCP_CLIENT_ID/);
	const auditHelper = source.slice(
		source.indexOf("function marketReadAuditFields"),
		source.indexOf("/** KV 中的 LIVE 面"),
	);
	assert.match(auditHelper, /MARKET_READ_AUTH_MODE/);
	assert.doesNotMatch(auditHelper, /COLLECTOR_MCP_CLIENT_TOKEN|PORTFOLIO_UNIVERSE_TOKEN/);
	assert.doesNotMatch(mcpGate, /PORTFOLIO_UNIVERSE_TOKEN/);
});

/**
 * Task D（PUBLIC 向量索引）：语义面只允许 PUBLIC，且不得复用投资 state:read 权限，
 * 也不得把内部运维通道变成 MCP 工具。静态断言，不引入真实 binding/向量。
 */
test("Task D semantic surface stays on the PUBLIC research read face with no PRIVATE input", async () => {
	const indexSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const toolStart = indexSource.indexOf('"search_documents_semantic"');
	const toolBody = indexSource.slice(toolStart, indexSource.indexOf('"search_evidence"', toolStart));
	// 只走既有 PUBLIC research adapter（visibility 硬编码 PUBLIC），不接受 visibility/source_id。
	assert.match(toolBody, /researchAdapter\(\)\.searchDocumentsSemantic\(/);
	assert.doesNotMatch(toolBody, /visibility/);
	assert.doesNotMatch(toolBody, /source_id/);
	// 语义面不得复用投资 state 权限，也不得直接触碰 state gateway。
	const semanticToolScope = indexSource.slice(
		indexSource.indexOf('"search_documents_semantic"'),
		indexSource.indexOf('"search_evidence"', indexSource.indexOf('"search_documents_semantic"')),
	);
	assert.doesNotMatch(semanticToolScope, /state:read|STATE_READ_SCOPE|requireResearchScope/);
	assert.doesNotMatch(semanticToolScope, /stateGateway|researchWorkflowDb/);
	// 内部索引通道是 token 门控端点，不是 MCP 工具。
	assert.match(indexSource, /url\.pathname === "\/internal\/research-semantic-index\/run"/);
	assert.match(indexSource, /url\.pathname === "\/internal\/research-semantic-index\/status"/);
	const runStart = indexSource.indexOf("async function handleSemanticIndexRun");
	const runBody = indexSource.slice(runStart, indexSource.indexOf("async function handleSemanticIndexStatus"));
	assert.match(runBody, /researchReplicaAuthorized\(request, env\)/);
});

test("Task D index schema and readers are PUBLIC-only by construction", async () => {
	const semanticSource = await readFile(new URL("../src/research-semantic-index.ts", import.meta.url), "utf8");
	const migration = await readFile(new URL("../migrations/0012_research_semantic_index.sql", import.meta.url), "utf8");
	// 索引状态表在数据库层拒绝 PRIVATE；查询与写入 SQL 一律写死 PUBLIC。
	assert.match(migration, /CHECK \(visibility IN \('PUBLIC'\)\)/);
	assert.doesNotMatch(migration, /'PRIVATE'/);
	assert.doesNotMatch(semanticSource, /visibility='PRIVATE'/);
	assert.doesNotMatch(semanticSource, /visibility=\?/);
	// 向量 metadata 只允许 PUBLIC 标识与模型 id；不得写入正文、摘要或定位符。
	const metadataStart = semanticSource.indexOf("metadata: {");
	const metadataBlock = semanticSource.slice(
		metadataStart,
		semanticSource.indexOf("}", metadataStart) + 1,
	);
	assert.match(metadataBlock, /document_id: row\.document_id/);
	assert.doesNotMatch(metadataBlock, /snippet|body|text:|locator|url|token/i);
	// ingest 只在 PUBLIC document_version 上登记，且不携 PRIVATE 字段。
	const replicaSource = await readFile(new URL("../src/research-replica.ts", import.meta.url), "utf8");
	assert.match(replicaSource, /semanticIndexIngestStatements\(storage\.db, record, now\)/);
	assert.match(semanticSource, /record\.visibility !== "PUBLIC"\) return null;/);
});
