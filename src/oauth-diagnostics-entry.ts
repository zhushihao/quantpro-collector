import oauthWorker from "./oauth-entry";

type Env = Parameters<typeof oauthWorker.fetch>[1] & {
	RESEARCH_REPLICA?: D1Database;
};

type DiagnosticDetail = Record<string, string | number | boolean | null>;

const TABLE = "oauth_diag_v1";
const MAX_ROWS = 100;
const OAUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

async function ensureTable(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, phase TEXT NOT NULL, status INTEGER NOT NULL, detail_json TEXT NOT NULL)`,
		)
		.run();
}

async function writeDiagnostic(
	env: Env,
	phase: string,
	status: number,
	detail: DiagnosticDetail,
): Promise<void> {
	// No quota gate: diagnostics always write (2026-10-02 gate removal).  The
	// former `QUOTA_ADMISSION_MODE === "enforce"` early return is abolished.
	const db = env.RESEARCH_REPLICA;
	if (!db) return;
	try {
		await ensureTable(db);
		await db
			.prepare(
				`INSERT INTO ${TABLE} (created_at, phase, status, detail_json) VALUES (?1, ?2, ?3, ?4)`,
			)
			.bind(new Date().toISOString(), phase, status, JSON.stringify(detail))
			.run();
		await db
			.prepare(
				`DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY id DESC LIMIT ?1)`,
			)
			.bind(MAX_ROWS)
			.run();
	} catch {
		// Diagnostics must never change OAuth behavior.
	}
}

function tokenAuthMethod(request: Request): string {
	const authorization = request.headers.get("Authorization") ?? "";
	if (authorization.startsWith("Basic ")) return "client_secret_basic";
	if (authorization.startsWith("Bearer ")) return "bearer";
	return "none";
}

async function parseTokenRequest(request: Request): Promise<DiagnosticDetail> {
	try {
		const form = await request.formData();
		return {
			grant_type: String(form.get("grant_type") ?? ""),
			client_id_present: Boolean(form.get("client_id")),
			code_present: Boolean(form.get("code")),
			code_verifier_present: Boolean(form.get("code_verifier")),
			refresh_token_present: Boolean(form.get("refresh_token")),
			resource_present: Boolean(form.get("resource")),
			auth_method: tokenAuthMethod(request),
		};
	} catch {
		return { request_parse_error: true, auth_method: tokenAuthMethod(request) };
	}
}

async function tokenResponseDetail(response: Response): Promise<DiagnosticDetail> {
	try {
		const body = (await response.clone().json()) as Record<string, unknown>;
		if (response.ok) {
			return {
				has_access_token:
					typeof body.access_token === "string" && body.access_token.length > 0,
				has_refresh_token:
					typeof body.refresh_token === "string" && body.refresh_token.length > 0,
				token_type: typeof body.token_type === "string" ? body.token_type : null,
				expires_in: typeof body.expires_in === "number" ? body.expires_in : null,
				scope: typeof body.scope === "string" ? body.scope : null,
			};
		}
		return {
			error: typeof body.error === "string" ? body.error : null,
			error_description:
				typeof body.error_description === "string"
					? body.error_description.slice(0, 240)
					: null,
		};
	} catch {
		return { response_parse_error: true };
	}
}

function authorizeResponseDetail(response: Response): DiagnosticDetail {
	const location = response.headers.get("Location");
	if (!location) return { redirect: false };
	try {
		const url = new URL(location);
		return {
			redirect: true,
			redirect_host: url.host,
			redirect_path: url.pathname,
			code_present: url.searchParams.has("code"),
			state_present: url.searchParams.has("state"),
			iss_present: url.searchParams.has("iss"),
		};
	} catch {
		return { redirect: true, redirect_parse_error: true };
	}
}

async function applyIssuerAdvertisementCompat(
	request: Request,
	response: Response,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "GET" || url.pathname !== OAUTH_SERVER_METADATA_PATH || !response.ok) {
		return response;
	}
	try {
		const metadata = (await response.clone().json()) as Record<string, unknown>;
		if (!("authorization_response_iss_parameter_supported" in metadata)) return response;
		delete metadata.authorization_response_iss_parameter_supported;
		const headers = new Headers(response.headers);
		headers.delete("Content-Length");
		headers.set("Content-Type", "application/json; charset=utf-8");
		headers.set("Cache-Control", "no-store");
		return new Response(JSON.stringify(metadata), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch {
		return response;
	}
}

function applyChatGptCallbackIssuerCompat(response: Response): Response {
	if (response.status < 300 || response.status >= 400) return response;
	const location = response.headers.get("Location");
	if (!location) return response;
	try {
		const redirect = new URL(location);
		const isChatGptConnector =
			redirect.hostname === "chatgpt.com" &&
			(redirect.pathname === "/connector_platform_oauth_redirect" ||
				redirect.pathname.startsWith("/connector/oauth/"));
		if (!isChatGptConnector || !redirect.searchParams.has("iss")) return response;
		redirect.searchParams.delete("iss");
		const headers = new Headers(response.headers);
		headers.set("Location", redirect.toString());
		headers.set("Cache-Control", "no-store");
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch {
		return response;
	}
}

async function readLatest(env: Env): Promise<Response> {
	// No quota gate: the diagnostic read is always available when the binding is.
	const db = env.RESEARCH_REPLICA;
	if (!db) return Response.json({ available: false }, { status: 503 });
	await ensureTable(db);
	const rows = await db
		.prepare(
			`SELECT id, created_at, phase, status, detail_json FROM ${TABLE} ORDER BY id DESC LIMIT 20`,
		)
		.all<{
			id: number;
			created_at: string;
			phase: string;
			status: number;
			detail_json: string;
		}>();
	return Response.json(
		{
			available: true,
			events: rows.results.map((row) => ({
				id: row.id,
				created_at: row.created_at,
				phase: row.phase,
				status: row.status,
				detail: JSON.parse(row.detail_json) as DiagnosticDetail,
			})),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__oauth_diag/latest" && request.method === "GET")
			return readLatest(env);

		const tokenRequest = url.pathname === "/oauth/token" && request.method === "POST";
		const authorizePost = url.pathname === "/authorize" && request.method === "POST";
		const mcpRequest = url.pathname === "/mcp";
		const requestClone = tokenRequest ? request.clone() : null;

		let response: Response;
		try {
			response = await oauthWorker.fetch(request, env, ctx);
			response = await applyIssuerAdvertisementCompat(request, response);
			if (authorizePost) response = applyChatGptCallbackIssuerCompat(response);
		} catch (error) {
			if (tokenRequest || authorizePost || mcpRequest) {
				ctx.waitUntil(
					writeDiagnostic(
						env,
						tokenRequest
							? "token_exception"
							: authorizePost
								? "authorize_exception"
								: "mcp_exception",
						500,
						{
							error_name: error instanceof Error ? error.name : "unknown",
							error_message:
								error instanceof Error ? error.message.slice(0, 240) : "unknown",
						},
					),
				);
			}
			throw error;
		}

		if (authorizePost)
			ctx.waitUntil(
				writeDiagnostic(
					env,
					"authorize_post",
					response.status,
					authorizeResponseDetail(response),
				),
			);
		if (tokenRequest && requestClone) {
			ctx.waitUntil(
				Promise.all([parseTokenRequest(requestClone), tokenResponseDetail(response)]).then(
					([requestDetail, responseDetail]) =>
						writeDiagnostic(env, "token_post", response.status, {
							...requestDetail,
							...responseDetail,
						}),
				),
			);
		}
		if (mcpRequest)
			ctx.waitUntil(
				writeDiagnostic(env, "mcp_request", response.status, {
					method: request.method,
					authorization_present: request.headers.has("Authorization"),
				}),
			);
		return response;
	},
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		return oauthWorker.scheduled?.(controller, env, ctx);
	},
} satisfies ExportedHandler<Env>;
