import assert from "node:assert/strict";
import test from "node:test";

const {
	permitsFormalResearchOperation,
	resolveResearchPrincipal,
	resolveResearchIssuer,
	formalResearchOwner,
} = await import("../src/research-scopes.ts");

// Issue #19: formal authorization binds to the stable business principal plus
// the required research scope.  The dynamic OAuth (DCR) client_id and the
// job_id format are NOT authorization inputs; job eligibility is decided
// server-side by record/lease state.
test("formal gate requires stable principal + issuer + exact scope, independent of job id", () => {
	const base = {
		principal: "chatgpt-production",
		issuer: "https://collector.example.test",
		scopes: new Set(["research:claim", "research:submit"]),
		requiredScope: "research:claim",
	};
	assert.equal(permitsFormalResearchOperation({ ...base }), true);
	for (const principal of ["codex", "engineering", "producer", "receipt-reader"]) {
		assert.equal(permitsFormalResearchOperation({ ...base, principal }), false, principal);
	}
	assert.equal(permitsFormalResearchOperation({ ...base, principal: null }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, issuer: null }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, scopes: new Set() }), false);
});

test("market:read alone can never claim or submit (no scope implication)", () => {
	const base = {
		principal: "chatgpt-production",
		issuer: "https://collector.example.test",
		scopes: new Set(["market:read"]),
	};
	assert.equal(permitsFormalResearchOperation({ ...base, requiredScope: "research:claim" }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, requiredScope: "research:submit" }), false);
	// Partial grants fail closed on the missing side only.
	assert.equal(
		permitsFormalResearchOperation({
			...base,
			scopes: new Set(["market:read", "research:claim"]),
			requiredScope: "research:submit",
		}),
		false,
	);
	assert.equal(
		permitsFormalResearchOperation({
			...base,
			scopes: new Set(["market:read", "research:submit"]),
			requiredScope: "research:claim",
		}),
		false,
	);
});

test("stable principal is credential-bound on the bridge path and survives DCR rotation", async () => {
	const bridgeToken = "synthetic-bridge-token";
	// The same stable principal is accepted no matter which dynamic client
	// registered — the DCR client_id is not an input anywhere.
	assert.equal(resolveResearchPrincipal(`Bearer ${bridgeToken}`, "chatgpt-production", bridgeToken), "chatgpt-production");
	assert.equal(resolveResearchPrincipal("Bearer wrong", "chatgpt-production", bridgeToken), null);
	assert.equal(resolveResearchPrincipal(null, "chatgpt-production", bridgeToken), null);
	assert.equal(resolveResearchPrincipal(`Bearer ${bridgeToken}`, "../etc-passwd", bridgeToken), null);
	assert.equal(resolveResearchPrincipal(`Bearer ${bridgeToken}`, "x".repeat(257), bridgeToken), null);
	assert.equal(resolveResearchIssuer(`Bearer ${bridgeToken}`, "https://collector.example.test", bridgeToken), "https://collector.example.test");
	assert.equal(resolveResearchIssuer(`Bearer ${bridgeToken}`, "https://collector.example.test/not-an-issuer", bridgeToken), null);
	// Lease owner binds issuer + principal: identical across DCR client_id
	// changes, distinct across principals/issuers.
	const first = await formalResearchOwner("https://collector.example.test", "chatgpt-production");
	const same = await formalResearchOwner("https://collector.example.test", "chatgpt-production");
	const otherPrincipal = await formalResearchOwner("https://collector.example.test", "chatgpt-staging");
	const otherIssuer = await formalResearchOwner("https://other.example.test", "chatgpt-production");
	assert.match(first, /^oauth-client:[a-f0-9]{64}$/);
	assert.equal(first, same, "DCR re-registration must not move the lease owner");
	assert.notEqual(first, otherPrincipal);
	assert.notEqual(first, otherIssuer);
});

// 2026-09-27 static-direct identities: a registered direct client (e.g. ZCode
// on the research machine) gets a durable non-ChatGPT principal without any
// header, and a configured allow-list closes the forged-principal hole.
test("principal allow-list gates forwarded values; unconfigured keeps legacy open behavior", () => {
	const token = "synthetic-cred";
	const allow = "chatgpt-production zcode-research-machine";
	// Legacy behavior (no allow-list configured): any well-formed value accepted.
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "chatgpt-production", token), "chatgpt-production");
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "chatgpt-production", token, null, null), "chatgpt-production");
	// Configured allow-list: registered principals pass, forgeries fail closed.
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "chatgpt-production", token, allow), "chatgpt-production");
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "zcode-research-machine", token, allow), "zcode-research-machine");
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "chatgpt-impersonator", token, allow), null);
	// Malformed / hostile values fail closed even with an allow-list configured.
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "../etc-passwd", token, allow), null);
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "", token, allow), null);
	// Comma-separated allow-lists parse identically.
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "chatgpt-production", token, "chatgpt-production,zcode-research-machine"), "chatgpt-production");
});

test("static direct client receives its registered identity without presenting headers", () => {
	const token = "synthetic-cred";
	// No principal header + registered static identity.
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, null, token, "chatgpt-production zcode-research-machine", "zcode-research-machine"), "zcode-research-machine");
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, undefined, token, "chatgpt-production", "zcode-research-machine"), "zcode-research-machine");
	// Unconfigured static identity keeps the legacy null (no principal, no formal op).
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, null, token, "chatgpt-production", null), null);
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, null, token, "chatgpt-production", undefined), null);
	// Credential mismatch always fails closed, static identity or not.
	assert.equal(resolveResearchPrincipal("Bearer wrong", null, token, "chatgpt-production", "zcode-research-machine"), null);
	// A malformed presented header fails closed instead of falling through to
	// the static identity.
	assert.equal(resolveResearchPrincipal(`Bearer ${token}`, "x".repeat(257), token, "chatgpt-production", "zcode-research-machine"), null);
	// The static identity participates in the formal gate exactly like the bridge one.
	const formal = permitsFormalResearchOperation({
		principal: "zcode-research-machine",
		issuer: "https://static-direct.quantpro.invalid/",
		scopes: new Set(["market:read", "state:read"]),
		requiredScope: "state:read",
	});
	assert.equal(formal, true);
});

test("issuer resolution: forwarded stays strict, static fallback only without a header", () => {
	const token = "synthetic-cred";
	const staticIssuer = "https://static-direct.quantpro.invalid/";
	// Forwarded path unchanged (three-arg legacy calls).
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, "https://collector.example.test", token), "https://collector.example.test");
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, "https://collector.example.test/not-an-issuer", token), null);
	assert.equal(resolveResearchIssuer("Bearer wrong", "https://collector.example.test", token), null);
	// No header + registered static issuer → static origin; unconfigured → null.
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, null, token, staticIssuer), "https://static-direct.quantpro.invalid");
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, undefined, token, staticIssuer), "https://static-direct.quantpro.invalid");
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, null, token, null), null);
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, null, token, undefined), null);
	// A malformed forwarded value fails closed with no static fallback.
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, "not-a-url", token, staticIssuer), null);
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, "", token, staticIssuer), null);
	// A malformed static value fails closed too.
	assert.equal(resolveResearchIssuer(`Bearer ${token}`, null, token, "not-a-url"), null);
	// Credential mismatch always fails closed.
	assert.equal(resolveResearchIssuer("Bearer wrong", null, token, staticIssuer), null);
});
