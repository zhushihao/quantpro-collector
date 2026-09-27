/**
 * Research write-plane scope gate (2026-09-15 research-backend design §A4).
 *
 * Two new scopes (`research:claim` / `research:submit`) gate exactly one
 * write tool each. There is deliberately no `research:read`: the read plane
 * is hard-clamped to PUBLIC at adapter construction, and `research:read` is
 * reserved for the future PRIVATE read plane (post-#16). No scope implies
 * any other scope; `market:read` never grants research access.
 *
 * Resolution rules (the server-side `COLLECTOR_MCP_CLIENT_SCOPES`
 * configuration is an uncircumventable ceiling):
 *   - The request Authorization header must equal `Bearer <configured token>`
 *     byte-for-byte (same discipline as `resolveLiveOverlayStatus`); anything
 *     else yields the empty set (fail-closed, including unconfigured token).
 *   - With a forwarded scope header (set only by the OAuth bridge in
 *     `oauth-entry.ts` after stripping any client-supplied copy): effective
 *     scopes = forwarded set ∩ configured set. Forged headers cannot exceed
 *     the ceiling.
 *   - Without the header (static-credential path): effective scopes =
 *     configured set.
 *
 * Principal / issuer resolution (2026-09-27 static-direct identities):
 *   - A presented principal header must be registered in
 *     `COLLECTOR_FORWARDABLE_PRINCIPALS` once that allow-list is configured;
 *     unconfigured deployments keep the legacy open behavior so the OAuth
 *     bridge path is unaffected until the operator opts in.
 *   - Without any principal header, a registered static direct client
 *     (`COLLECTOR_STATIC_CLIENT_PRINCIPAL` + `COLLECTOR_STATIC_CLIENT_ISSUER`)
 *     receives its configured durable identity. Unconfigured deployments keep
 *     the legacy `null` (no principal, no formal operation).
 *
 * This module is pure: no IO, no logging, no token values echoed anywhere.
 */

/** Gate for `claim_research_job`. */
export const RESEARCH_CLAIM_SCOPE = "research:claim";

/** Gate for `submit_research_result_proposal`. */
export const RESEARCH_SUBMIT_SCOPE = "research:submit";

/**
 * Forwarded scope header. Only trusted when set by `handleMcp` after it has
 * replaced the Authorization header; the bridge deletes any client-supplied
 * copy before setting its own value.
 */
export const FORWARDED_SCOPES_HEADER = "X-QuantPro-Client-Scopes";
/**
 * Stable business principal, stamped only by the OAuth bridge from the
 * validated OAuth grant props (`COLLECTOR_MCP_CLIENT_ID`, frozen to
 * `chatgpt-production` in production).  Issue #19: formal authorization binds
 * to this durable principal — never to the dynamically registered (DCR)
 * OAuth client_id, which rotates whenever ChatGPT re-registers.
 */
export const FORWARDED_PRINCIPAL_HEADER = "X-QuantPro-Principal";
/**
 * Legacy DCR client_id header: no longer consumed for authorization.  The
 * bridge still deletes any client-supplied copy so stale headers can never
 * re-enter the trust boundary.
 */
export const FORWARDED_CLIENT_ID_HEADER = "X-QuantPro-Client-Id";
/** OAuth issuer stamped by the bridge together with the authenticated principal. */
export const FORWARDED_ISSUER_HEADER = "X-QuantPro-OAuth-Issuer";

const FORMAL_OWNER_PREFIX = "oauth-client:";

/**
 * Engineering / transport / receipt roles.  Server configuration cannot
 * accidentally promote any of them into a formal ChatGPT result owner merely
 * by granting a scope (defense in depth on top of the scope gate).
 */
const NON_FORMAL_PRINCIPALS = new Set([
	"codex",
	"engineering",
	"producer",
	"receipt-reader",
	"receipt_reader",
]);

/** Parse a space/comma separated scope list into a set (order-insensitive). */
function parseScopeList(value: string | null | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(/[\s,]+/)
			.map((scope) => scope.trim())
			.filter(Boolean),
	);
}

/** Well-formed principal token shape, shared by forwarded and static identities. */
const PRINCIPAL_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

/** Parse a space/comma separated principal allow-list into a set (order-insensitive). */
function parsePrincipalList(value: string | null | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(/[\s,]+/)
			.map((principal) => principal.trim())
			.filter(Boolean),
	);
}

/** Origin-only issuer normalization shared by forwarded and static identities. */
function normalizeIssuerOrigin(value: string): string | null {
	if (value.length > 512) return null;
	try {
		const issuer = new URL(value);
		if (issuer.protocol !== "https:" && issuer.protocol !== "http:") return null;
		if (issuer.pathname !== "/" || issuer.search || issuer.hash) return null;
		return issuer.origin;
	} catch {
		return null;
	}
}

export function resolveResearchScopes(
	authorizationHeader: string | null | undefined,
	forwardedScopesHeader: string | null | undefined,
	configuredToken: string | null | undefined,
	configuredScopes: string | null | undefined,
): Set<string> {
	// Byte-exact credential match is the precondition for any scope at all.
	if (!configuredToken || authorizationHeader !== `Bearer ${configuredToken}`) {
		return new Set();
	}
	const configured = parseScopeList(configuredScopes);
	if (forwardedScopesHeader === null || forwardedScopesHeader === undefined) {
		// Static-credential direct path: the configured set is the grant.
		return configured;
	}
	// Forwarded path: intersection only. A static credential holder forging
	// this header still cannot exceed its own configured ceiling.
	const forwarded = parseScopeList(forwardedScopesHeader);
	const effective = new Set<string>();
	for (const scope of forwarded) {
		if (configured.has(scope)) effective.add(scope);
	}
	return effective;
}

/**
 * Stable principal resolution (2026-09-27 revision).
 *
 * Bridge path: the bridge replaces the Authorization header with the internal
 * credential and stamps the principal header from the *validated* OAuth grant
 * props. Once `forwardablePrincipals` is configured, a presented principal is
 * accepted only if it is registered there — previously any static-credential
 * holder could forge an arbitrary principal (audit impersonation), which this
 * allow-list closes. Unconfigured deployments keep the legacy open behavior.
 *
 * Static-credential direct path: a client that presents no principal header
 * receives the registered static identity (`staticPrincipal`), giving an
 * operator-approved direct client (e.g. ZCode on the research machine) a
 * durable, non-ChatGPT principal for the formal gate. Unconfigured deployments
 * keep the legacy `null` (no principal, no formal operation).
 */
export function resolveResearchPrincipal(
	authorizationHeader: string | null | undefined,
	forwardedPrincipal: string | null | undefined,
	configuredToken: string | null | undefined,
	forwardablePrincipals?: string | null,
	staticPrincipal?: string | null,
): string | null {
	if (!configuredToken || authorizationHeader !== `Bearer ${configuredToken}`) return null;
	if (forwardedPrincipal != null) {
		// A principal header was presented: it must be well-formed AND registered.
		if (typeof forwardedPrincipal !== "string" || !PRINCIPAL_PATTERN.test(forwardedPrincipal)) return null;
		const allow = parsePrincipalList(forwardablePrincipals);
		if (allow.size === 0) return forwardedPrincipal;
		return allow.has(forwardedPrincipal) ? forwardedPrincipal : null;
	}
	return staticPrincipal && PRINCIPAL_PATTERN.test(staticPrincipal) ? staticPrincipal : null;
}

/**
 * Issuer resolution (2026-09-27 revision). Same trust split as the principal:
 * forwarded values stay bridge-only, while a static direct client without any
 * issuer header receives its registered static issuer. A malformed forwarded
 * value still fails closed (no static fallback).
 */
export function resolveResearchIssuer(
	authorizationHeader: string | null | undefined,
	forwardedIssuer: string | null | undefined,
	configuredToken: string | null | undefined,
	staticIssuer?: string | null,
): string | null {
	if (!configuredToken || authorizationHeader !== `Bearer ${configuredToken}`) return null;
	if (forwardedIssuer != null) {
		return typeof forwardedIssuer === "string" ? normalizeIssuerOrigin(forwardedIssuer) : null;
	}
	return staticIssuer ? normalizeIssuerOrigin(staticIssuer) : null;
}

/**
 * Opaque, stable queue owner identity.  Issue #19: it binds the authenticated
 * issuer and the stable business principal (not the DCR client_id), so
 * ChatGPT/OAuth re-registration does not strand leases, resume state, or
 * idempotency records.  Neither identifier is exposed in the receipt actor.
 */
export async function formalResearchOwner(
	issuer: string | null,
	principal: string | null,
): Promise<string | null> {
	if (!issuer || !principal) return null;
	const bytes = new TextEncoder().encode(`${issuer}\u0000${principal}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${FORMAL_OWNER_PREFIX}${hex}`;
}

export function isFormalResearchOwner(value: string): boolean {
	return new RegExp(`^${FORMAL_OWNER_PREFIX}[a-f0-9]{64}$`).test(value);
}

/**
 * Formal write gate (issue #19): a verified stable principal on the trusted
 * bridge path plus the required research scope.  Job eligibility is decided
 * solely by server-side record/lease state (PUBLIC + QUEUED + non-terminal,
 * enforced in research-workflow.ts) — the job_id string format never
 * participates in authorization, and the dynamic OAuth client_id is not an
 * authorization input at all.
 */
export function permitsFormalResearchOperation(input: {
	principal: string | null;
	issuer: string | null;
	scopes: ReadonlySet<string>;
	requiredScope: string;
}): boolean {
	if (!input.principal || !input.issuer) return false;
	if (!input.scopes.has(input.requiredScope)) return false;
	return !NON_FORMAL_PRINCIPALS.has(input.principal.toLowerCase());
}
