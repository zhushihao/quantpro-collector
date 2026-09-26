import OAuthProvider, {
	type AuthRequest,
	type OAuthHelpers,
	type TokenSummary,
} from "@cloudflare/workers-oauth-provider";

import { createD1Kv, createD1OAuthKv } from "./d1-oauth-kv";
import coreWorker from "./index";
import {
	FORWARDED_SCOPES_HEADER,
	FORWARDED_PRINCIPAL_HEADER,
	FORWARDED_CLIENT_ID_HEADER,
	FORWARDED_ISSUER_HEADER,
	RESEARCH_CLAIM_SCOPE,
	RESEARCH_SUBMIT_SCOPE,
} from "./research-scopes";
import { STATE_READ_SCOPE, STATE_WRITE_SCOPE } from "./state-scopes";

const ORIGIN = "https://cn-hk-quotes-mcp.zhushihao710.workers.dev";
const MCP_RESOURCE = `${ORIGIN}/mcp`;
const MARKET_READ_SCOPE = "market:read";
const OFFLINE_ACCESS_SCOPE = "offline_access";
/** §A4 纯增量：research 写面 scope 进入支持列表；market:read 仍为必含项。 */
const SUPPORTED_SCOPES: readonly string[] = [
	MARKET_READ_SCOPE,
	RESEARCH_CLAIM_SCOPE,
	RESEARCH_SUBMIT_SCOPE,
	STATE_READ_SCOPE,
	STATE_WRITE_SCOPE,
	OFFLINE_ACCESS_SCOPE,
];
const RESOURCE_SUPPORTED_SCOPES: readonly string[] = [
	MARKET_READ_SCOPE,
	RESEARCH_CLAIM_SCOPE,
	RESEARCH_SUBMIT_SCOPE,
	STATE_READ_SCOPE,
	STATE_WRITE_SCOPE,
];
const OWNER_USER_ID = "quantpro-owner";
const MAX_OWNER_KEY_LENGTH = 512;
const AUTH_FORM_MAX_AGE_SECONDS = 10 * 60;
const AUTH_FORM_FUTURE_TOLERANCE_SECONDS = 60;

type CoreEnv = Parameters<typeof coreWorker.fetch>[1];
type OAuthProps = {
	principal: string;
	scopes: string[];
};
type OAuthEnv = CoreEnv & {
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
};

/** 隔离于 OAuth 表之外的 LIVE 控制面持久化表（issue #17）。 */
const PORTFOLIO_KV_TABLE = "portfolio_kv_v1";

/**
 * OAuth state is intentionally kept out of Workers KV. The account-wide free-tier KV write
 * allowance is shared with the LIVE control plane and can be exhausted independently of OAuth.
 * A KV-compatible adapter backed by the Collector's private D1 database gives OAuth its own
 * table and quota.
 *
 * Issue #17 extends the same isolation to the LIVE control plane itself: the account-wide
 * free-tier KV quota (1,000 writes/day) cannot absorb the per-round universe/status/delta
 * writes of a full trading-day publish window, so `PORTFOLIO_UNIVERSE` reads and writes are
 * served from `portfolio_kv_v1` in the already-private Collector D1 database instead. The
 * binding name, key-space (`live-portfolio/*`), payload contracts, and the
 * PORTFOLIO_UNIVERSE_TOKEN auth secret all stay untouched; only the storage engine changes.
 * OAuth persistence never reads or writes the portfolio table.
 */
function oauthRuntimeEnv(env: CoreEnv): OAuthEnv {
	if (!env.RESEARCH_REPLICA) {
		throw new Error("RESEARCH_REPLICA D1 binding is required for OAuth storage");
	}
	return {
		...env,
		OAUTH_KV: createD1OAuthKv(env.RESEARCH_REPLICA),
		PORTFOLIO_UNIVERSE: createD1Kv(env.RESEARCH_REPLICA, PORTFOLIO_KV_TABLE),
	} as OAuthEnv;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomBase64Url(bytes = 24): string {
	return base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function constantTimeTextEquals(leftValue: string, rightValue: string): Promise<boolean> {
	const [left, right] = await Promise.all([sha256(leftValue), sha256(rightValue)]);
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
	return difference === 0;
}

async function constantTimeSecretEquals(
	candidate: string,
	configured: string | undefined,
): Promise<boolean> {
	if (!configured || !candidate || candidate.length > MAX_OWNER_KEY_LENGTH) return false;
	return constantTimeTextEquals(candidate, configured);
}

async function authFormSignature(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return base64UrlFromBytes(new Uint8Array(signature));
}

async function createAuthFormToken(
	action: string,
	secret: string | undefined,
): Promise<string | null> {
	if (!secret) return null;
	const issuedAt = Math.floor(Date.now() / 1000);
	const nonce = randomBase64Url(18);
	const payload = `${issuedAt}.${nonce}.${action}`;
	const signature = await authFormSignature(secret, payload);
	return `${issuedAt}.${nonce}.${signature}`;
}

async function validateAuthFormToken(
	token: string,
	action: string,
	secret: string | undefined,
): Promise<boolean> {
	if (!secret) return false;
	const parts = token.split(".");
	if (parts.length !== 3) return false;
	const [issuedAtRaw, nonce, providedSignature] = parts;
	const issuedAt = Number.parseInt(issuedAtRaw, 10);
	if (!Number.isSafeInteger(issuedAt) || nonce.length < 12 || providedSignature.length < 32) {
		return false;
	}
	const now = Math.floor(Date.now() / 1000);
	const ageSeconds = now - issuedAt;
	if (
		ageSeconds > AUTH_FORM_MAX_AGE_SECONDS ||
		ageSeconds < -AUTH_FORM_FUTURE_TOLERANCE_SECONDS
	) {
		return false;
	}
	const payload = `${issuedAtRaw}.${nonce}.${action}`;
	const expectedSignature = await authFormSignature(secret, payload);
	return constantTimeTextEquals(providedSignature, expectedSignature);
}

function audienceMatches(audience: string | string[] | undefined): boolean {
	if (typeof audience === "string") return audience === MCP_RESOURCE;
	return Array.isArray(audience) && audience.includes(MCP_RESOURCE);
}

function resourceMetadataUrl(request: Request): string {
	return new URL("/.well-known/oauth-protected-resource/mcp", request.url).toString();
}

function oauthChallenge(request: Request, error = "invalid_token", status = 401): Response {
	const challenge = [
		"Bearer",
		`resource_metadata="${resourceMetadataUrl(request)}"`,
		`scope="${RESOURCE_SUPPORTED_SCOPES.join(" ")}"`,
		`error="${error}"`,
	].join(" ");
	return new Response(JSON.stringify({ error }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"WWW-Authenticate": challenge,
		},
	});
}

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (!authorization) return null;
	if (!authorization.startsWith("Bearer ")) return "";
	const token = authorization.slice("Bearer ".length);
	return token.length > 0 ? token : "";
}

function withAuthorization(request: Request, authorization: string | null): Request {
	const headers = new Headers(request.headers);
	if (authorization === null) headers.delete("Authorization");
	else headers.set("Authorization", authorization);
	return new Request(request, { headers });
}

function validRequestedScopes(authRequest: AuthRequest): string[] | null {
	const requested = new Set(authRequest.scope);
	if (!requested.has(MARKET_READ_SCOPE)) return null;
	for (const scope of requested) {
		if (!SUPPORTED_SCOPES.includes(scope)) return null;
	}
	return [...requested];
}

function authorizationHeaders(): HeadersInit {
	return {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'",
		"Referrer-Policy": "no-referrer",
	};
}

function authorizationPage(options: {
	action: string;
	clientName: string;
	scopes: string[];
	csrf: string;
	error?: string;
}): string {
	const scopeList = options.scopes
		.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
		.join("");
	const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : "";
	// §A4：请求含 research 写 scope 时如实增列研究工作流说明；
	// 任何情况下都不宣称交易能力。
	const researchNote = options.scopes.some(
		(scope) => scope === RESEARCH_CLAIM_SCOPE || scope === RESEARCH_SUBMIT_SCOPE,
	)
		? `<p class="muted">研究工作流：认领/提交研究候选。</p>`
		: "";
	const stateNote = options.scopes.some(
		(scope) => scope === STATE_READ_SCOPE || scope === STATE_WRITE_SCOPE,
	)
		? `<p class="muted">状态网关：按固定 Channel 读取/追加 QuantPro 生产状态账本；不能选择任意外部目标。</p>`
		: "";
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuantPro Collector 授权</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#111;margin:0;padding:32px}
main{max-width:560px;margin:8vh auto;background:#fff;border:1px solid #ddd;border-radius:14px;padding:28px;box-shadow:0 8px 28px #0001}
h1{margin-top:0;font-size:24px}.muted{color:#666}.error{background:#fff0f0;color:#9b1c1c;padding:10px;border-radius:8px}
input{box-sizing:border-box;width:100%;padding:11px;margin:8px 0 18px;border:1px solid #aaa;border-radius:8px}button{padding:11px 16px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:600;cursor:pointer}
code{background:#f1f2f4;padding:2px 5px;border-radius:4px}
</style>
</head>
<body><main>
<h1>授权 QuantPro Collector</h1>
<p>客户端：<strong>${escapeHtml(options.clientName)}</strong></p>
<p class="muted">授权范围仅限所列 QuantPro 能力；不会授予交易、撤单、账户、成本或订单权限。</p>
${researchNote}${stateNote}<ul>${scopeList}</ul>${error}
<form method="post" action="${escapeHtml(options.action)}" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<label for="owner_key">QuantPro Collector 授权密钥</label>
<input id="owner_key" name="owner_key" type="password" required maxlength="${MAX_OWNER_KEY_LENGTH}" autocomplete="off">
<button type="submit">授权访问</button>
</form>
</main></body></html>`;
}

async function parseAuthorizationRequest(
	request: Request,
	env: OAuthEnv,
): Promise<AuthRequest | Response> {
	try {
		const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		if (!validRequestedScopes(authRequest)) {
			return new Response("OAuth scope request is not permitted", { status: 400 });
		}
		return authRequest;
	} catch {
		return new Response("Invalid OAuth authorization request", { status: 400 });
	}
}

async function renderAuthorizationError(options: {
	action: string;
	clientName: string;
	scopes: string[];
	secret: string | undefined;
	error: string;
	status: number;
}): Promise<Response> {
	const csrf = (await createAuthFormToken(options.action, options.secret)) ?? "";
	return new Response(
		authorizationPage({
			action: options.action,
			clientName: options.clientName,
			scopes: options.scopes,
			csrf,
			error: options.error,
		}),
		{ status: options.status, headers: authorizationHeaders() },
	);
}

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	const parsed = await parseAuthorizationRequest(request, env);
	if (parsed instanceof Response) return parsed;
	const scopes = validRequestedScopes(parsed)!;
	const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
	const clientName = client?.clientName || "ChatGPT";
	const url = new URL(request.url);
	const action = `${url.pathname}${url.search}`;
	const ownerSecret = env.COLLECTOR_MCP_CLIENT_TOKEN;

	if (request.method === "GET") {
		const csrf = await createAuthFormToken(action, ownerSecret);
		if (!csrf) {
			return renderAuthorizationError({
				action,
				clientName,
				scopes,
				secret: ownerSecret,
				error: "服务端授权密钥尚未配置，请稍后重试。",
				status: 503,
			});
		}
		return new Response(authorizationPage({ action, clientName, scopes, csrf }), {
			headers: authorizationHeaders(),
		});
	}

	const form = await request.formData();
	const csrf = String(form.get("csrf") ?? "");
	const ownerKey = String(form.get("owner_key") ?? "");
	if (!ownerSecret) {
		return renderAuthorizationError({
			action,
			clientName,
			scopes,
			secret: ownerSecret,
			error: "服务端授权密钥尚未配置，请稍后重试。",
			status: 503,
		});
	}
	const csrfOk = await validateAuthFormToken(csrf, action, ownerSecret);
	if (!csrfOk) {
		return renderAuthorizationError({
			action,
			clientName,
			scopes,
			secret: ownerSecret,
			error: "授权会话已过期或无效，请返回 ChatGPT 重新发起授权。",
			status: 400,
		});
	}
	const ownerOk = await constantTimeSecretEquals(ownerKey, ownerSecret);
	if (!ownerOk) {
		return renderAuthorizationError({
			action,
			clientName,
			scopes,
			secret: ownerSecret,
			error: "授权密钥不匹配，请确认使用当前生效的授权密钥。",
			status: 401,
		});
	}

	const principal = env.COLLECTOR_MCP_CLIENT_ID?.trim() || "chatgpt-production";
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: parsed,
		userId: OWNER_USER_ID,
		metadata: { principal, capability: MARKET_READ_SCOPE },
		scope: scopes,
		props: { principal, scopes } satisfies OAuthProps,
	});
	return new Response(null, {
		status: 302,
		headers: {
			Location: redirectTo,
			"Cache-Control": "no-store",
		},
	});
}

function tokenHasMarketRead(summary: TokenSummary<OAuthProps>): boolean {
	return (
		summary.userId === OWNER_USER_ID &&
		audienceMatches(summary.audience) &&
		summary.scope.includes(MARKET_READ_SCOPE) &&
		summary.grant.props?.principal === "chatgpt-production" &&
		Array.isArray(summary.grant.props?.scopes) &&
		summary.grant.props.scopes.includes(MARKET_READ_SCOPE)
	);
}

async function handleMcp(
	request: Request,
	env: OAuthEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const token = bearerToken(request);
	if (token === null) {
		// No bearer at all: forwarded straight through with the Authorization
		// header stripped.  No forwarded principal/scope headers are stamped
		// on this path, and the core's resolvers require the bridge credential
		// byte-for-byte — research formal writes stay fail-closed here.
		return coreWorker.fetch(withAuthorization(request, null), env, ctx);
	}
	if (!token) return oauthChallenge(request);

	let summary: TokenSummary<OAuthProps> | null = null;
	try {
		summary = await env.OAUTH_PROVIDER.unwrapToken<OAuthProps>(token);
	} catch {
		return oauthChallenge(request);
	}
	if (!summary) return oauthChallenge(request);
	if (!summary.scope.includes(MARKET_READ_SCOPE)) {
		return oauthChallenge(request, "insufficient_scope", 403);
	}
	if (!tokenHasMarketRead(summary)) return oauthChallenge(request);

	// §A4：替换 Authorization 前先剥除客户端自带的转发 scope 头，再写入
	// 本令牌经校验的 scope 集合——核心 Worker 端把「转发头 ∩ server 配置」
	// 当上限，伪造或残留的头部都无法越过配置集合。
	const headers = new Headers(request.headers);
	headers.delete(FORWARDED_SCOPES_HEADER);
	headers.delete(FORWARDED_PRINCIPAL_HEADER);
	headers.delete(FORWARDED_CLIENT_ID_HEADER);
	headers.delete(FORWARDED_ISSUER_HEADER);
	headers.set(FORWARDED_SCOPES_HEADER, summary.scope.join(" "));
	// Issue #19: forward the *stable business principal* taken from the
	// validated grant props — never the dynamically registered (DCR)
	// client_id, which rotates on every ChatGPT re-registration.  The core
	// worker accepts these headers only behind its internal bridge credential,
	// and any client-supplied copies were deleted above.
	const principal = summary.grant.props?.principal;
	if (typeof principal === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(principal)) {
		headers.set(FORWARDED_PRINCIPAL_HEADER, principal);
		headers.set(FORWARDED_ISSUER_HEADER, new URL(request.url).origin);
	}
	const scopeStamped = new Request(request, { headers });

	const bridgeSecret = env.COLLECTOR_MCP_CLIENT_TOKEN;
	const forwarded = withAuthorization(
		scopeStamped,
		bridgeSecret ? `Bearer ${bridgeSecret}` : null,
	);
	return coreWorker.fetch(forwarded, env, ctx);
}

const defaultHandler: ExportedHandler<OAuthEnv> = {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/authorize") return handleAuthorize(request, env);
		if (url.pathname === "/mcp") return handleMcp(request, env, ctx);
		return coreWorker.fetch(request, env, ctx);
	},
};

const unusedProtectedHandler = {
	fetch() {
		return new Response("Not Found", { status: 404 });
	},
};

const oauthProvider = new OAuthProvider<OAuthEnv>({
	apiRoute: "/__oauth_provider_protected",
	apiHandler: unusedProtectedHandler,
	defaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	accessTokenTTL: 60 * 60,
	refreshTokenTTL: 90 * 24 * 60 * 60,
	clientRegistrationTTL: 90 * 24 * 60 * 60,
	scopesSupported: [...SUPPORTED_SCOPES],
	allowImplicitFlow: false,
	allowPlainPKCE: false,
	clientIdMetadataDocumentEnabled: true,
	resourceMetadata: {
		resource: MCP_RESOURCE,
		authorization_servers: [ORIGIN],
		scopes_supported: [...RESOURCE_SUPPORTED_SCOPES],
		bearer_methods_supported: ["header"],
		resource_name: "QuantPro Collector",
	},
	tokenExchangeCallback({ requestedScope, props, clientId }) {
		// #19: this callback pins the access-token principal to the single
		// production business identity regardless of what the authorize stage
		// derived — `COLLECTOR_MCP_CLIENT_ID` must therefore stay
		// `chatgpt-production` in production.  Fail-safe direction: a
		// misconfigured value is overwritten here, never the reverse.
		const principal = "chatgpt-production";
		return {
			accessTokenProps: {
				...(props && typeof props === "object" ? props : {}),
				principal,
				clientId,
				scopes: requestedScope,
			},
			accessTokenScope: requestedScope,
		};
	},
});

export default {
	fetch(request: Request, env: CoreEnv, ctx: ExecutionContext) {
		return oauthProvider.fetch(request, oauthRuntimeEnv(env), ctx);
	},
	async scheduled(controller: ScheduledController, env: CoreEnv, ctx: ExecutionContext) {
		const runtimeEnv = oauthRuntimeEnv(env);
		await coreWorker.scheduled(controller, env);
		ctx.waitUntil(
			oauthProvider
				.purgeExpiredData(runtimeEnv, { batchSize: 25 })
				.then(() => undefined)
				.catch(() => undefined),
		);
	},
} satisfies ExportedHandler<CoreEnv>;
