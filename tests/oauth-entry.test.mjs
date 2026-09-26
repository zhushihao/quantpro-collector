import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
	return readFile(new URL(path, import.meta.url), "utf8");
}

test("OAuth state is stored in an isolated D1 table instead of account-wide Workers KV", async () => {
	const wrangler = await source("../wrangler.jsonc");
	const oauth = await source("../src/oauth-entry.ts");
	const diagnostics = await source("../src/oauth-diagnostics-entry.ts");
	const adapter = await source("../src/d1-oauth-kv.ts");
	assert.match(wrangler, /"main": "src\/oauth-diagnostics-entry\.ts"/);
	assert.match(diagnostics, /import oauthWorker from "\.\/oauth-entry"/);
	assert.match(diagnostics, /oauthWorker\.fetch\(request, env, ctx\)/);
	assert.match(wrangler, /"binding": "RESEARCH_REPLICA"/);
	assert.match(wrangler, /"binding": "PORTFOLIO_UNIVERSE"/);
	assert.doesNotMatch(wrangler, /"binding": "OAUTH_KV"/);
	assert.match(oauth, /OAUTH_KV: createD1OAuthKv\(env\.RESEARCH_REPLICA\)/);
	assert.match(oauth, /RESEARCH_REPLICA D1 binding is required for OAuth storage/);
	assert.doesNotMatch(oauth, /OAUTH_KV: env\.PORTFOLIO_UNIVERSE/);
	assert.match(adapter, /OAUTH_TABLE = "oauth_kv_v1"/);
	assert.match(adapter, /ON CONFLICT\(kv_key\) DO UPDATE/);
	assert.match(adapter, /list_complete:/);
});

// 原判词「LIVE universe remains on its original KV keyspace」(issue #8) 已被 issue #17 推翻：
// 账户级 KV 免费写配额无法承载 LIVE 控制面发布窗口的逐轮写入，控制面改用同一私有 D1
// 库内的独立表。键空间、契约与鉴权语义全部不变，本测试钉住迁移后的新不变量。
test("LIVE control plane keeps its keyspace and contracts but is served from an isolated D1 table (issue #17)", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const adapter = await source("../src/d1-oauth-kv.ts");
	const liveUniverse = await source("../src/live-universe.ts");
	const portfolioStatus = await source("../src/portfolio-status.ts");
	const portfolioDelta = await source("../src/portfolio-delta.ts");
	// OAuth 持久化永远不借用 PORTFOLIO 键空间或表。
	assert.doesNotMatch(oauth, /createD1OAuthKv\(env\.PORTFOLIO_UNIVERSE/);
	assert.doesNotMatch(oauth, /createD1OAuthKv\([^)]*portfolio_kv_v1/);
	// 控制面读写走独立 D1 表（非 OAuth 表、非账户 KV）。
	assert.match(oauth, /const PORTFOLIO_KV_TABLE = "portfolio_kv_v1"/);
	assert.match(
		oauth,
		/PORTFOLIO_UNIVERSE: createD1Kv\(env\.RESEARCH_REPLICA, PORTFOLIO_KV_TABLE\)/,
	);
	assert.match(adapter, /export function createD1Kv\(/);
	assert.match(adapter, /TABLE_NAME_PATTERN/);
	assert.doesNotMatch(oauth, /PORTFOLIO_KV_TABLE = "oauth_kv_v1"/);
	// 键空间与契约不因存储引擎迁移而漂移。
	assert.match(liveUniverse, /LIVE_UNIVERSE_KV_KEY = "live-portfolio\/current"/);
	assert.match(portfolioStatus, /PORTFOLIO_STATUS_KV_KEY = "live-portfolio\/status"/);
	assert.match(portfolioDelta, /PORTFOLIO_UNIVERSE_BASELINE_KV_KEY = "live-portfolio\/private\//);
	assert.match(portfolioDelta, /PORTFOLIO_UNIVERSE_DELTA_KV_KEY = "live-portfolio\/private\//);
});

test("temporary production storage diagnostic is removed after identifying the KV daily quota root cause", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.doesNotMatch(oauth, /STORAGE_SMOKE_USER_AGENT/);
	assert.doesNotMatch(oauth, /probePortfolioUniverseWrite/);
	assert.doesNotMatch(oauth, /PORTFOLIO_UNIVERSE_DIRECT/);
	assert.doesNotMatch(oauth, /OAUTH_PROVIDER_DCR/);
});

test("OAuth discovery advertises market, research and State Gateway scopes with offline refresh support", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	// #5 §A4 pure increment: research:claim / research:submit join the
	// supported list; market:read remains mandatory and offline_access stays.
	assert.match(oauth, /scopesSupported: \[\.\.\.SUPPORTED_SCOPES\]/);
	assert.match(
		oauth,
		/const SUPPORTED_SCOPES: readonly string\[\] = \[\n\tMARKET_READ_SCOPE,\n\tRESEARCH_CLAIM_SCOPE,\n\tRESEARCH_SUBMIT_SCOPE,\n\tSTATE_READ_SCOPE,\n\tSTATE_WRITE_SCOPE,\n\tOFFLINE_ACCESS_SCOPE,\n\]/,
	);
	assert.match(oauth, /scopes_supported: \[\.\.\.RESOURCE_SUPPORTED_SCOPES\]/);
	assert.match(oauth, /scope="\$\{RESOURCE_SUPPORTED_SCOPES\.join\(" "\)\}"/);
	assert.match(
		oauth,
		/const RESOURCE_SUPPORTED_SCOPES: readonly string\[\] = \[\n\tMARKET_READ_SCOPE,\n\tRESEARCH_CLAIM_SCOPE,\n\tRESEARCH_SUBMIT_SCOPE,\n\tSTATE_READ_SCOPE,\n\tSTATE_WRITE_SCOPE,\n\]/,
	);
	assert.match(oauth, /clientIdMetadataDocumentEnabled: true/);
	assert.match(oauth, /allowImplicitFlow: false/);
	assert.match(oauth, /allowPlainPKCE: false/);
	assert.match(oauth, /refreshTokenTTL:/);
	assert.match(oauth, /clientRegistrationEndpoint: "\/oauth\/register"/);
	assert.match(oauth, /tokenEndpoint: "\/oauth\/token"/);
	assert.match(oauth, /authorizeEndpoint: "\/authorize"/);
});

test("ChatGPT issuer compatibility omits RFC 9207 advertisement and strips iss only from ChatGPT connector callbacks", async () => {
	const diagnostics = await source("../src/oauth-diagnostics-entry.ts");
	assert.match(
		diagnostics,
		/OAUTH_SERVER_METADATA_PATH = "\/\.well-known\/oauth-authorization-server"/,
	);
	assert.match(diagnostics, /delete metadata\.authorization_response_iss_parameter_supported/);
	assert.match(
		diagnostics,
		/response = await applyIssuerAdvertisementCompat\(request, response\)/,
	);
	assert.match(diagnostics, /function applyChatGptCallbackIssuerCompat/);
	assert.match(diagnostics, /redirect\.hostname === "chatgpt\.com"/);
	assert.match(diagnostics, /redirect\.pathname\.startsWith\("\/connector\/oauth\/"\)/);
	assert.match(diagnostics, /redirect\.searchParams\.delete\("iss"\)/);
	assert.match(
		diagnostics,
		/if \(authorizePost\) response = applyChatGptCallbackIssuerCompat\(response\)/,
	);
	assert.match(diagnostics, /iss_present: url\.searchParams\.has\("iss"\)/);
});

test("anonymous MCP remains quote-only compatible while OAuth bearer is validated before core", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const mcpStart = oauth.indexOf("async function handleMcp");
	const mcpEnd = oauth.indexOf("const defaultHandler", mcpStart);
	const body = oauth.slice(mcpStart, mcpEnd);
	assert.match(
		body,
		/if \(token === null\)[\s\S]*coreWorker\.fetch\(withAuthorization\(request, null\)/,
	);
	assert.match(body, /OAUTH_PROVIDER\.unwrapToken<OAuthProps>\(token\)/);
	assert.match(body, /summary\.scope\.includes\(MARKET_READ_SCOPE\)/);
	assert.match(body, /tokenHasMarketRead\(summary\)/);
	const tokenGateStart = oauth.indexOf("function tokenHasMarketRead");
	const tokenGateEnd = oauth.indexOf("async function handleMcp", tokenGateStart);
	const tokenGate = oauth.slice(tokenGateStart, tokenGateEnd);
	assert.match(tokenGate, /audienceMatches\(summary\.audience\)/);
	assert.match(body, /bridgeSecret \? `Bearer \$\{bridgeSecret\}` : null/);
	assert.match(body, /headers\.delete\(FORWARDED_ISSUER_HEADER\)/);
	assert.match(body, /headers\.set\(FORWARDED_ISSUER_HEADER, new URL\(request\.url\)\.origin\)/);
});

test("legacy static bearer cannot bypass OAuth at the public MCP route", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const mcpStart = oauth.indexOf("async function handleMcp");
	const mcpEnd = oauth.indexOf("const defaultHandler", mcpStart);
	const body = oauth.slice(mcpStart, mcpEnd);
	assert.match(body, /unwrapToken<OAuthProps>\(token\)/);
	assert.doesNotMatch(
		body,
		/request\.headers\.get\("Authorization"\) === `Bearer \$\{env\.COLLECTOR_MCP_CLIENT_TOKEN\}`/,
	);
	assert.doesNotMatch(body, /PORTFOLIO_UNIVERSE_TOKEN/);
});

test("owner secret stays out of rendered HTML, OAuth props and logs", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const pageStart = oauth.indexOf("function authorizationPage");
	const pageEnd = oauth.indexOf("async function parseAuthorizationRequest", pageStart);
	const page = oauth.slice(pageStart, pageEnd);
	assert.doesNotMatch(page, /COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(oauth, /const ownerSecret = env\.COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(oauth, /constantTimeSecretEquals\(ownerKey, ownerSecret\)/);
	assert.doesNotMatch(oauth, /console\.(?:log|warn|error).*COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.doesNotMatch(oauth, /props:\s*\{[^}]*ownerKey/s);
});

test("internal universe credential remains outside the OAuth adapter", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const runtimeStart = oauth.indexOf("function oauthRuntimeEnv");
	const runtimeEnd = oauth.indexOf("function escapeHtml", runtimeStart);
	const runtime = oauth.slice(runtimeStart, runtimeEnd);
	assert.match(runtime, /createD1OAuthKv\(env\.RESEARCH_REPLICA\)/);
	assert.doesNotMatch(runtime, /PORTFOLIO_UNIVERSE_TOKEN/);
	assert.doesNotMatch(runtime, /env\.PORTFOLIO_UNIVERSE/);
	const core = await source("../src/index.ts");
	const internalStart = core.indexOf("function requestInternalUniverseStatus");
	const internalEnd = core.indexOf("function requestMcpMarketReadStatus", internalStart);
	assert.match(core.slice(internalStart, internalEnd), /PORTFOLIO_UNIVERSE_TOKEN/);
});

test("OAuth owner authorization uses a signed cookie-independent form token", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.match(oauth, /async function createAuthFormToken/);
	assert.match(oauth, /async function validateAuthFormToken/);
	assert.match(oauth, /name: "HMAC", hash: "SHA-256"/);
	assert.match(oauth, /AUTH_FORM_MAX_AGE_SECONDS = 10 \* 60/);
	assert.doesNotMatch(oauth, /CSRF_COOKIE/);
	assert.doesNotMatch(oauth, /parseCookies/);
	assert.doesNotMatch(oauth, /Set-Cookie/);
	assert.match(oauth, /授权会话已过期或无效/);
	assert.match(oauth, /授权密钥不匹配/);
});

test("authorization CSP grants only the minimal ChatGPT callback origin", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const headersStart = oauth.indexOf("function authorizationHeaders");
	const headersEnd = oauth.indexOf("function authorizationPage", headersStart);
	const headers = oauth.slice(headersStart, headersEnd);
	assert.match(headers, /form-action 'self' https:\/\/chatgpt\.com/);
	assert.doesNotMatch(headers, /form-action \*/);
	assert.doesNotMatch(headers, /form-action https:/);
	assert.match(headers, /default-src 'none'/);
	assert.match(headers, /base-uri 'none'/);
	assert.match(headers, /frame-ancestors 'none'/);
});

test("OAuth authorization remains market-read anchored while explicitly listing state scopes", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.match(oauth, /if \(!requested\.has\(MARKET_READ_SCOPE\)\) return null/);
	assert.match(oauth, /scope: scopes/);
	assert.match(oauth, /userId: OWNER_USER_ID/);
	assert.match(oauth, /不会授予交易、撤单、账户、成本或订单权限/);
	assert.match(oauth, /状态网关：按固定 Channel/);
	assert.match(oauth, /STATE_READ_SCOPE/);
	assert.match(oauth, /STATE_WRITE_SCOPE/);
});

// Issue #19 源码锁：formal 授权的信任根是桥接层盖章的 stable principal 头。
// 剥客户端同名头必须先于任何 set（防残留/伪造），principal 必须来自已验证的
// grant props，绝不允许 DCR client_id 重新进入授权路径。
test("bridge strips client forwarded headers before stamping and binds principal to verified grant props (issue #19)", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const scopes = await source("../src/research-scopes.ts");
	const handleStart = oauth.indexOf("async function handleMcp");
	const handleEnd = oauth.indexOf("const defaultHandler", handleStart);
	const handleMcp = oauth.slice(handleStart, handleEnd);

	// Delete-before-set：四个转发头全部先剥后盖，顺序不得回退。
	const lastDelete = Math.max(
		handleMcp.indexOf("headers.delete(FORWARDED_SCOPES_HEADER)"),
		handleMcp.indexOf("headers.delete(FORWARDED_PRINCIPAL_HEADER)"),
		handleMcp.indexOf("headers.delete(FORWARDED_CLIENT_ID_HEADER)"),
		handleMcp.indexOf("headers.delete(FORWARDED_ISSUER_HEADER)"),
	);
	const firstSet = handleMcp.indexOf("headers.set(");
	assert.ok(
		lastDelete >= 0 && firstSet > lastDelete,
		"all forwarded headers must be deleted before any set",
	);

	// principal 只能来自已验证 grant props；DCR client_id 不得再被盖章。
	assert.match(handleMcp, /const principal = summary\.grant\.props\?\.principal;/);
	assert.match(handleMcp, /headers\.set\(FORWARDED_PRINCIPAL_HEADER, principal\)/);
	assert.doesNotMatch(handleMcp, /headers\.set\(FORWARDED_CLIENT_ID_HEADER/);
	assert.doesNotMatch(oauth, /authenticatedClientId/);

	// core 侧只在 bridge credential 逐字节匹配后才接受 principal/scope/issuer。
	assert.match(scopes, /function resolveResearchPrincipal\(/);
	const resolver = scopes.slice(
		scopes.indexOf("export function resolveResearchPrincipal"),
		scopes.indexOf("export function resolveResearchIssuer"),
	);
	assert.match(resolver, /authorizationHeader !== `Bearer \$\{configuredToken\}`/);
	// DCR client_id 解析器必须已被 stable principal 解析器替代。
	assert.doesNotMatch(scopes, /function resolveResearchClientId\(/);
});
