import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCE = "https://cn-hk-quotes-mcp.zhushihao710.workers.dev/mcp";
const OWNER_SECRET = "synthetic-owner-secret";
const REDIRECT_URI = "http://127.0.0.1:8799/callback";
const VERIFIER = "synthetic-verifier-for-pkce-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MCP_HEADERS = {
	accept: "application/json, text/event-stream",
	"content-type": "application/json",
	"mcp-protocol-version": "2025-03-26",
};

async function availablePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const { port } = address;
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}

async function waitForWorker(origin, stderr, requireOk = true) {
	let lastError = "not started";
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(`${origin}/.well-known/oauth-authorization-server`);
			if (response.ok || !requireOk) return;
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`local Worker did not become ready: ${lastError}; stderr=${stderr()}`);
}

async function stop(child) {
	if (child.exitCode !== null || child.killed) return;
	if (process.platform === "win32") {
		const taskkill = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		await new Promise((resolve) => taskkill.once("exit", resolve));
	} else {
		child.kill("SIGTERM");
	}
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		new Promise((resolve) => setTimeout(resolve, 5_000)),
	]);
	if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
}

async function startWorker({
	withoutD1 = false,
	temp = null,
	removeTemp = true,
	extraEnv = {},
} = {}) {
	const workDir = temp ?? (await mkdtemp(path.join(tmpdir(), "quantpro-oauth-lifecycle-")));
	const port = await availablePort();
	const envFile = path.join(workDir, ".dev.vars");
	const stateDir = path.join(workDir, "state");
	await writeFile(
		envFile,
		[
			`COLLECTOR_MCP_CLIENT_TOKEN=${OWNER_SECRET}`,
			"COLLECTOR_MCP_CLIENT_ID=chatgpt-production",
			"COLLECTOR_MCP_CLIENT_SCOPES=market:read",
			"PORTFOLIO_UNIVERSE_TOKEN=synthetic-internal-secret",
			"GITHUB_TOKEN=synthetic-github-token",
			...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`),
		].join("\n"),
	);
	let configPath = "wrangler.jsonc";
	if (withoutD1) {
		configPath = path.join(workDir, "wrangler.no-d1.jsonc");
		await writeFile(
			configPath,
			JSON.stringify({
				name: "cn-hk-quotes-mcp-oauth-no-d1-test",
				main: path.join(ROOT, "src", "oauth-diagnostics-entry.ts"),
				compatibility_date: "2026-07-02",
				compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
				kv_namespaces: [{ binding: "PORTFOLIO_UNIVERSE" }],
			}),
		);
	}
	const stderrLines = [];
	const child = spawn(
		process.execPath,
		[
			path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
			"dev",
			"--config",
			configPath,
			"--local",
			"--ip",
			"127.0.0.1",
			"--port",
			String(port),
			"--persist-to",
			stateDir,
			"--env-file",
			envFile,
			"--log-level",
			"error",
		],
		{
			cwd: ROOT,
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		},
	);
	child.stderr.on("data", (chunk) => {
		stderrLines.push(String(chunk));
		if (stderrLines.length > 20) stderrLines.shift();
	});
	const origin = `http://127.0.0.1:${port}`;
	try {
		await waitForWorker(origin, () => stderrLines.join("").slice(-4_000), !withoutD1);
	} catch (error) {
		await stop(child);
		if (removeTemp)
			await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		throw error;
	}
	return {
		origin,
		stateDir,
		async stop() {
			await stop(child);
		},
		async close() {
			await stop(child);
			if (removeTemp)
				await rm(workDir, {
					recursive: true,
					force: true,
					maxRetries: 10,
					retryDelay: 200,
				});
		},
	};
}

// nodejs/node#64322: Node 24 on Windows can fast-fail inside libuv teardown
// (exit code 3221226505 = 0xC0000409, stderr "Assertion failed: !(handle->flags
// & UV_HANDLE_CLOSING) ... src\win\async.c") AFTER the wrangler command has
// already finished its work; no released Node ships the fix.  Retry only that
// exact crash signature, at most 2 times; every other failure still fails the
// test.  "d1 migrations apply" is idempotent so a retry is safe, and a
// re-executed INSERT after a teardown crash is backstopped by the strong
// assertions later in the test.
async function runLocalD1(stateDir, command, args = []) {
	for (let attempt = 1; ; attempt += 1) {
		const { exitCode, output } = await runLocalD1Once(stateDir, command, args);
		if (exitCode === 0) return;
		const libuvTeardownCrash =
			exitCode === 3221226505 && output.join("").includes("Assertion failed");
		if (!libuvTeardownCrash || attempt > 2) {
			assert.equal(exitCode, 0, `local D1 setup must succeed: ${output.join("").slice(-4_000)}`);
		}
	}
}

async function runLocalD1Once(stateDir, command, args = []) {
	const output = [];
	const child = spawn(
		process.execPath,
		[
			path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
			"d1",
			...args,
			"--config",
			"wrangler.jsonc",
			"--local",
			"--persist-to",
			stateDir,
			...(command === null ? [] : ["--command", command]),
		],
		{ cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
	);
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	const exitCode = await new Promise((resolve) => child.once("exit", resolve));
	return { exitCode, output };
}

function pkceChallenge(verifier = VERIFIER) {
	return createHash("sha256").update(verifier).digest("base64url");
}

async function postForm(origin, pathname, form, options = {}) {
	return fetch(`${origin}${pathname}`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(options.headers ?? {}),
		},
		body: new URLSearchParams(form),
		redirect: options.redirect ?? "manual",
	});
}

async function registerClient(origin) {
	const response = await fetch(`${origin}/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "Synthetic OAuth lifecycle client",
			redirect_uris: [REDIRECT_URI],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	assert.equal(response.status, 201, "DCR must issue a local synthetic client");
	const client = await response.json();
	assert.equal(typeof client.client_id, "string");
	return client;
}

function authorizePath(clientId, overrides = {}) {
	const parameters = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope: "market:read offline_access",
		state: "synthetic-state",
		code_challenge: pkceChallenge(),
		code_challenge_method: "S256",
		resource: RESOURCE,
		...overrides,
	});
	return `/authorize?${parameters}`;
}

async function beginAuthorization(origin, clientId, overrides = {}) {
	const pathname = authorizePath(clientId, overrides);
	const response = await fetch(`${origin}${pathname}`);
	assert.equal(response.status, 200, "authorize GET must render the owner form");
	const html = await response.text();
	const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1];
	assert.ok(csrf, "owner form must carry a signed CSRF value");
	return { pathname, csrf };
}

async function approve(origin, authorization, ownerKey = OWNER_SECRET) {
	return postForm(origin, authorization.pathname, {
		csrf: authorization.csrf,
		owner_key: ownerKey,
	});
}

async function issueAuthorizationCode(origin, clientId, overrides = {}) {
	const authorization = await beginAuthorization(origin, clientId, overrides);
	const response = await approve(origin, authorization);
	assert.equal(response.status, 302, "valid owner consent must return a callback redirect");
	const location = response.headers.get("location");
	assert.ok(location, "authorization response must carry callback Location");
	const callback = new URL(location);
	assert.equal(callback.origin, new URL(REDIRECT_URI).origin);
	assert.equal(callback.pathname, "/callback");
	assert.equal(callback.searchParams.get("state"), "synthetic-state");
	const code = callback.searchParams.get("code");
	assert.ok(code, "callback must carry an authorization code");
	assert.equal(
		location.includes(OWNER_SECRET),
		false,
		"callback must not contain owner form data",
	);
	return code;
}

async function exchangeCode(origin, clientId, code, overrides = {}) {
	return postForm(origin, "/oauth/token", {
		grant_type: "authorization_code",
		client_id: clientId,
		code,
		redirect_uri: REDIRECT_URI,
		code_verifier: VERIFIER,
		resource: RESOURCE,
		...overrides,
	});
}

async function initializeMcp(origin, accessToken) {
	return fetch(`${origin}/mcp`, {
		method: "POST",
		headers: { ...MCP_HEADERS, authorization: `Bearer ${accessToken}` },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "local-oauth-lifecycle", version: "1" },
			},
		}),
	});
}

function rpcPayload(raw, contentType) {
	if (!contentType.includes("text/event-stream")) return JSON.parse(raw);
	const line = raw.split("\n").find((candidate) => candidate.startsWith("data:"));
	assert.ok(line, "MCP SSE response must contain a JSON-RPC data frame");
	return JSON.parse(line.slice("data:".length).trim());
}

async function mcpRpc(origin, accessToken, sessionId, id, method, params) {
	const response = await fetch(`${origin}/mcp`, {
		method: "POST",
		headers: {
			...MCP_HEADERS,
			authorization: `Bearer ${accessToken}`,
			...(sessionId ? { "mcp-session-id": sessionId } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	assert.equal(response.status, 200, `${method} must reach the local MCP endpoint`);
	return {
		payload: rpcPayload(await response.text(), response.headers.get("content-type") ?? ""),
		sessionId: response.headers.get("mcp-session-id") ?? sessionId,
	};
}

async function mcpTool(origin, accessToken, sessionId, id, name, args) {
	const call = await mcpRpc(origin, accessToken, sessionId, id, "tools/call", {
		name,
		arguments: args,
	});
	const result = call.payload.result;
	assert.ok(result && result.isError !== true, `${name} must not return a tool error`);
	const text = result.content?.[0]?.text;
	assert.equal(typeof text, "string", `${name} must return JSON text`);
	return { payload: JSON.parse(text), sessionId: call.sessionId };
}

test("local Worker closes DCR → consent → PKCE → token → refresh → authenticated MCP", async (t) => {
	const worker = await startWorker();
	t.after(() => worker.close());

	const [metadataResponse, resourceResponse] = await Promise.all([
		fetch(`${worker.origin}/.well-known/oauth-authorization-server`),
		fetch(`${worker.origin}/.well-known/oauth-protected-resource/mcp`),
	]);
	assert.equal(metadataResponse.status, 200);
	assert.equal(resourceResponse.status, 200);
	const metadata = await metadataResponse.json();
	const resource = await resourceResponse.json();
	assert.equal(metadata.issuer, worker.origin);
	assert.ok(metadata.scopes_supported.includes("market:read"));
	assert.ok(metadata.scopes_supported.includes("offline_access"));
	assert.equal(resource.resource, RESOURCE);

	const client = await registerClient(worker.origin);
	const code = await issueAuthorizationCode(worker.origin, client.client_id);
	const tokenResponse = await exchangeCode(worker.origin, client.client_id, code);
	assert.equal(tokenResponse.status, 200, "PKCE code exchange must succeed");
	const tokens = await tokenResponse.json();
	assert.equal(typeof tokens.access_token, "string");
	assert.equal(typeof tokens.refresh_token, "string");
	assert.match(tokens.scope, /market:read/);

	const mcp = await initializeMcp(worker.origin, tokens.access_token);
	assert.equal(mcp.status, 200, "OAuth Bearer must reach MCP");
	assert.equal(mcp.headers.has("www-authenticate"), false);
	assert.ok((await mcp.text()).includes('"result"'));

	const refreshResponse = await postForm(worker.origin, "/oauth/token", {
		grant_type: "refresh_token",
		client_id: client.client_id,
		refresh_token: tokens.refresh_token,
		resource: RESOURCE,
	});
	assert.equal(refreshResponse.status, 200, "refresh-token exchange must succeed");
	const refreshed = await refreshResponse.json();
	assert.equal(typeof refreshed.access_token, "string");
	const mcpAfterRefresh = await initializeMcp(worker.origin, refreshed.access_token);
	assert.equal(mcpAfterRefresh.status, 200, "refreshed Bearer must reach MCP");
	assert.ok((await mcpAfterRefresh.text()).includes('"result"'));

	const reused = await exchangeCode(worker.origin, client.client_id, code);
	assert.equal(reused.status, 400, "authorization codes must not be reusable");

	const wrongPkceCode = await issueAuthorizationCode(worker.origin, client.client_id);
	assert.equal(
		(
			await exchangeCode(worker.origin, client.client_id, wrongPkceCode, {
				code_verifier: "wrong",
			})
		).status,
		400,
		"wrong PKCE verifier must fail closed",
	);
	const wrongRedirectCode = await issueAuthorizationCode(worker.origin, client.client_id);
	assert.equal(
		(
			await exchangeCode(worker.origin, client.client_id, wrongRedirectCode, {
				redirect_uri: "http://127.0.0.1:8799/wrong",
			})
		).status,
		400,
		"wrong redirect URI must fail closed",
	);
	const wrongClientCode = await issueAuthorizationCode(worker.origin, client.client_id);
	assert.equal(
		(await exchangeCode(worker.origin, "wrong-client", wrongClientCode)).status,
		401,
		"wrong client ID must fail closed",
	);
	const wrongAudienceCode = await issueAuthorizationCode(worker.origin, client.client_id);
	assert.equal(
		(
			await exchangeCode(worker.origin, client.client_id, wrongAudienceCode, {
				resource: "https://example.test/mcp",
			})
		).status,
		400,
		"wrong resource/audience must fail closed",
	);

	const missingScope = await fetch(
		`${worker.origin}${authorizePath(client.client_id, { scope: "offline_access" })}`,
	);
	assert.equal(missingScope.status, 400, "market:read must be mandatory");
	const invalidForm = await beginAuthorization(worker.origin, client.client_id);
	assert.equal(
		(
			await postForm(worker.origin, invalidForm.pathname, {
				csrf: "invalid",
				owner_key: OWNER_SECRET,
			})
		).status,
		400,
		"invalid signed form state must fail closed",
	);
	const wrongOwner = await beginAuthorization(worker.origin, client.client_id);
	assert.equal((await approve(worker.origin, wrongOwner, "wrong-owner-key")).status, 401);

	const malformedBearer = await initializeMcp(worker.origin, "not-a-valid-or-current-token");
	assert.equal(malformedBearer.status, 401, "malformed or expired-like Bearer must fail closed");
	assert.match(malformedBearer.headers.get("www-authenticate") ?? "", /Bearer/);
	assert.equal(
		(
			await postForm(worker.origin, "/oauth/token", {
				grant_type: "refresh_token",
				client_id: client.client_id,
				refresh_token: "invalid-refresh-token",
				resource: RESOURCE,
			})
		).status,
		400,
		"invalid refresh token must fail closed",
	);
});

test("missing local D1 OAuth persistence fails closed before authorization", async (t) => {
	const worker = await startWorker({ withoutD1: true });
	t.after(() => worker.close());
	const response = await fetch(`${worker.origin}/authorize`);
	assert.ok(
		response.status >= 500,
		"unavailable D1 persistence must not issue an authorization form",
	);
	assert.equal(response.headers.has("location"), false);
});

// Issue #19: the formal write gate binds to the stable business principal —
// never to the dynamic (DCR) OAuth client_id — and job eligibility is purely
// server-side state over real RESEARCH `job_<hash>` ids.
test("formal claim/submit survive DCR client_id rotation on real job_<hash> jobs; missing scope and PRIVATE stay closed", async () => {
	const temp = await mkdtemp(path.join(tmpdir(), "quantpro-formal-principal-"));
	let worker = null;
	try {
		worker = await startWorker({ temp, removeTemp: false });
		// Two independent dynamic registrations -> two different DCR
		// client_ids backing the same stable principal
		// (COLLECTOR_MCP_CLIENT_ID=chatgpt-production).
		const clientA = await registerClient(worker.origin);
		const clientB = await registerClient(worker.origin);
		assert.notEqual(clientA.client_id, clientB.client_id);
		const stateDir = worker.stateDir;
		await worker.stop();
		await runLocalD1(stateDir, null, ["migrations", "apply", "RESEARCH_REPLICA"]);
		// Seed real RESEARCH WorkQueue-shaped ids: stable `job_<hash>` (never
		// a `job:` / `research-formal:` namespace) plus one PRIVATE job.
		const jobA = `job_${createHash("sha256").update("issue19-job-a").digest("hex").slice(0, 40)}`;
		const jobB = `job_${createHash("sha256").update("issue19-job-b").digest("hex").slice(0, 40)}`;
		const jobPrivate = `job_${createHash("sha256").update("issue19-job-private").digest("hex").slice(0, 40)}`;
		for (const [recordKey, visibility] of [
			[jobA, "PUBLIC"],
			[jobB, "PUBLIC"],
			[jobPrivate, "PRIVATE"],
		]) {
			await runLocalD1(
				stateDir,
				`INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at) VALUES ('job', '${recordKey}', 'outbound_issue19_${visibility.toLowerCase()}', '${visibility}', 'collector-outbound-v4', '{}', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')`,
				["execute", "RESEARCH_REPLICA"],
			);
		}
		// No COLLECTOR_MCP_FORMAL_* env exists anymore: the configured scope
		// ceiling is the only server-side grant surface.
		worker = await startWorker({
			temp,
			removeTemp: false,
			extraEnv: {
				COLLECTOR_MCP_CLIENT_SCOPES: "market:read research:claim research:submit",
				RESEARCH_REPLICA_INGEST_TOKEN: "synthetic-replica-ingest-token",
			},
		});

		const fullScopes = "market:read research:claim research:submit";

		// Client A: full formal round on a real job_<hash> id.
		const codeA = await issueAuthorizationCode(worker.origin, clientA.client_id, {
			scope: fullScopes,
		});
		const tokenAResponse = await exchangeCode(worker.origin, clientA.client_id, codeA);
		assert.equal(tokenAResponse.status, 200, "formal OAuth token exchange must succeed");
		const { access_token: accessTokenA } = await tokenAResponse.json();
		const initializedA = await mcpRpc(worker.origin, accessTokenA, null, 1, "initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "issue19-principal-a", version: "1" },
		});
		const claimA = await mcpTool(
			worker.origin,
			accessTokenA,
			initializedA.sessionId,
			2,
			"claim_research_job",
			{ job_id: jobA },
		);
		assert.equal(
			claimA.payload.status,
			"CLAIMED",
			"real job_<hash> must be claimable without any namespace gate",
		);
		// #19 safety-gate compatibility: the model never sees or ferries a
		// credential-like token.  The claim response must not carry one.
		assert.equal(Object.keys(claimA.payload).includes("claim_token"), false);
		assert.equal(JSON.stringify(claimA.payload).includes("clt_"), false);
		assert.equal(claimA.payload.lease_generation, 1);
		const submittedA = await mcpTool(
			worker.origin,
			accessTokenA,
			claimA.sessionId,
			3,
			"submit_research_result_proposal",
			{
				job_id: jobA,
				expected_generation: claimA.payload.lease_generation,
				idempotency_key: "issue19-formal-submit-a",
				origin: "CHATGPT",
				proposal: {
					job_id: jobA,
					summary: "Issue #19 stable-principal formal result",
					findings: [],
					recommendation_hint: "NONE",
					sources_consulted: [],
					completed_at: new Date().toISOString(),
				},
			},
		);
		assert.equal(
			submittedA.payload.status,
			"ACCEPTED",
			"formal submit must complete the job under the stable principal",
		);
		assert.equal(submittedA.payload.terminal_status, "COMPLETED");
		assert.equal(JSON.stringify(submittedA.payload).includes("clt_"), false);

		// #19: no model-facing tool schema may advertise a claim_token input.
		const toolsList = await mcpRpc(
			worker.origin,
			accessTokenA,
			claimA.sessionId,
			10,
			"tools/list",
			{},
		);
		const advertised = toolsList.payload.result.tools;
		assert.ok(Array.isArray(advertised) && advertised.length > 0);
		for (const tool of advertised) {
			assert.equal(
				JSON.stringify(tool.inputSchema).includes("claim_token"),
				false,
				`${tool.name} inputSchema must not advertise claim_token`,
			);
		}

		// Client B: a *different* DCR client_id, same stable principal.  The
		// formal gate must treat it identically — DCR rotation is invisible.
		const codeB = await issueAuthorizationCode(worker.origin, clientB.client_id, {
			scope: fullScopes,
		});
		const tokenBResponse = await exchangeCode(worker.origin, clientB.client_id, codeB);
		assert.equal(tokenBResponse.status, 200, "rotated DCR client token exchange must succeed");
		const { access_token: accessTokenB } = await tokenBResponse.json();
		const initializedB = await mcpRpc(worker.origin, accessTokenB, null, 4, "initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "issue19-principal-b", version: "1" },
		});
		const claimB = await mcpTool(
			worker.origin,
			accessTokenB,
			initializedB.sessionId,
			5,
			"claim_research_job",
			{ job_id: jobB },
		);
		assert.equal(
			claimB.payload.status,
			"CLAIMED",
			"rotated DCR client_id must keep the stable principal claimable",
		);

		// PRIVATE job: eligibility is server-side record state -> NOT_FOUND
		// (no existence oracle) even with a valid principal and full scopes.
		const claimPrivate = await mcpTool(
			worker.origin,
			accessTokenB,
			initializedB.sessionId,
			6,
			"claim_research_job",
			{ job_id: jobPrivate },
		);
		assert.equal(claimPrivate.payload.status, "NOT_CLAIMABLE");
		assert.equal(claimPrivate.payload.reason, "NOT_FOUND");

		// market:read alone can never claim or submit: a token whose grant
		// lacks the research scopes hits the scope gate (FILTERED) first.
		const clientC = await registerClient(worker.origin);
		const codeC = await issueAuthorizationCode(worker.origin, clientC.client_id, {
			scope: "market:read",
		});
		const tokenCResponse = await exchangeCode(worker.origin, clientC.client_id, codeC);
		assert.equal(tokenCResponse.status, 200, "market:read-only token exchange must succeed");
		const { access_token: accessTokenC } = await tokenCResponse.json();
		const initializedC = await mcpRpc(worker.origin, accessTokenC, null, 7, "initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "issue19-market-read-only", version: "1" },
		});
		const deniedClaim = await mcpRpc(
			worker.origin,
			accessTokenC,
			initializedC.sessionId,
			8,
			"tools/call",
			{
				name: "claim_research_job",
				arguments: { job_id: jobB },
			},
		);
		assert.equal(
			deniedClaim.payload.result?.isError,
			true,
			"claim without research:claim must fail closed",
		);
		assert.match(deniedClaim.payload.result?.content?.[0]?.text ?? "", /FILTERED/u);
		const deniedSubmit = await mcpRpc(
			worker.origin,
			accessTokenC,
			initializedC.sessionId,
			9,
			"tools/call",
			{
				name: "submit_research_result_proposal",
				arguments: {
					job_id: jobA,
					expected_generation: 1,
					idempotency_key: "issue19-denied-submit",
					proposal: {},
				},
			},
		);
		assert.equal(
			deniedSubmit.payload.result?.isError,
			true,
			"submit without research:submit must fail closed",
		);
		assert.match(deniedSubmit.payload.result?.content?.[0]?.text ?? "", /FILTERED/u);

		// Formal lifecycle events from the real principal are receipt-readable.
		const receiptsResponse = await fetch(
			`${worker.origin}/internal/research-replica/v2/receipts`,
			{
				headers: { authorization: "Bearer synthetic-replica-ingest-token" },
			},
		);
		assert.equal(receiptsResponse.status, 200);
		const receipts = await receiptsResponse.json();
		assert.ok(
			receipts.receipts.some(
				(receipt) => receipt.job_id === jobA && receipt.event_type === "CLAIMED",
			),
			"claimed job_<hash> must surface as a receipt",
		);
		assert.ok(
			receipts.receipts.some(
				(receipt) => receipt.job_id === jobA && receipt.event_type === "COMPLETED",
			),
			"completed job_<hash> must surface as a receipt",
		);
		assert.ok(
			receipts.receipts.some(
				(receipt) => receipt.job_id === jobB && receipt.event_type === "CLAIMED",
			),
			"rotated-client claim must surface under the same stable principal",
		);
	} finally {
		if (worker) await worker.stop();
		await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
