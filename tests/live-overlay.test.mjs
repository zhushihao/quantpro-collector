import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	computeLiveUniverseHash,
	validateLiveUniverse,
	applyLiveUniverse,
} from "../src/live-universe.ts";
import {
	INSTRUMENT_CODE_PLACEHOLDER,
	LIVE_OVERLAY_STATUSES,
	LiveCoverageError,
	formatLiveCoverageFailureMessage,
	isLiveOverlayEnabled,
	projectCallerSnapshot,
	redactInstrumentCodes,
	resolveLiveOverlayStatus,
	resolveMarketReadLiveOverlayStatus,
} from "../src/live-overlay.ts";
import { validateSnapshot } from "../src/portfolio-validation.ts";

/** 测试假值：绝不使用真实 token（本文件不读也不回显任何真实凭据）。 */
const FAKE_TOKEN = "test-token-not-a-real-secret";
const BEARER_OK = `Bearer ${FAKE_TOKEN}`;

/** 仅出现在 LIVE active set、**不在**上游 legacy 目录里的代码（issue #15 §8.3 的真实泄漏形态）。 */
const LIVE_ONLY_CODE = "002409";

function makeStock(
	code,
	market,
	exchange,
	portfolioGroup,
	portfolioStatus,
	holdingStatus,
	isPosition,
	mappingOnly = false,
) {
	const group =
		portfolioGroup === "growth" ? "Growth" : portfolioGroup === "watch" ? "Watch" : "Core";
	return {
		code,
		market,
		exchange,
		name: code,
		group,
		portfolio_group: portfolioGroup,
		portfolio_status: portfolioStatus,
		holding_status: holdingStatus,
		mapping_only: mappingOnly,
		mapped_to: mappingOnly ? "300308.SZ" : null,
		mapping_to: mappingOnly ? "300308.SZ" : null,
		position_qty: isPosition ? 100 : 0,
		is_position: isPosition,
		price: 10,
		change: 0,
		change_pct: 0,
		pre_close: 10,
		prev_close: 10,
		open: 10,
		high: 10,
		low: 10,
		pct_change: 0,
		volume: 1,
		amount: 10,
		market_status: "CLOSED",
		market_data_time: "2026-09-11T15:00:00+08:00",
		source_update_time: "2026-09-11T15:01:00+08:00",
		freshness_basis: "MARKET_DATA",
		quote_time: "2026-09-11T15:00:00+08:00",
		fetch_time: "2026-09-11T15:01:00+08:00",
		age_seconds: 60,
		primary_source: "tencent",
		secondary_source: null,
		source_status: "OK",
		quality: "CLOSED_SNAPSHOT",
	};
}

/** `portfolio_universe` 行只保留 `PortfolioUniverseItem` 的字段（与快照里的行同源）。 */
const UNIVERSE_FIELDS = [
	"code",
	"market",
	"exchange",
	"name",
	"group",
	"portfolio_group",
	"portfolio_status",
	"holding_status",
	"mapping_only",
	"mapped_to",
	"mapping_to",
	"position_qty",
	"is_position",
];

function snapshotOf(stocks, summary = { total: stocks.length }) {
	return {
		portfolio_version: "legacy-catalog",
		snapshot_time: "2026-09-11T15:01:00+08:00",
		system_quality: "OK",
		summary,
		portfolio_universe: stocks.map((stock) =>
			Object.fromEntries(UNIVERSE_FIELDS.map((field) => [field, stock[field]])),
		),
		stocks,
	};
}

async function makeUniverse(active) {
	const payload = {
		schema_version: "quote-universe/1",
		generated_at: "2026-09-11T16:00:00+08:00",
		source_manifest_hash: `sha256:${"1".repeat(64)}`,
		active,
		content_hash: await computeLiveUniverseHash(active),
	};
	return { ...(await validateLiveUniverse(payload)), received_at: "2026-09-11T16:00:01+08:00" };
}

/** 复刻「上游目录只覆盖部分在仓代码」的生产形态：2 只在仓，1 只缺行情。 */
function incompleteFixtureSnapshot() {
	const snapshot = snapshotOf([
		makeStock("300308", "CN", "SZ", "core", "CORE", "ACTIVE", true),
		makeStock("002975", "CN", "SZ", "growth", "GROWTH", "ACTIVE", true),
	]);
	validateSnapshot(snapshot);
	return snapshot;
}

/** 出厂口径：控制面块与响应文本（与被测工具真实拼装的字段一致）。 */
function callerResponseText(snapshot, liveOverlayStatus) {
	return JSON.stringify(
		{
			...snapshot,
			control_plane_status: {
				status: "OK",
				kb_bound: true,
				universe_present: true,
				universe_fresh: true,
				portfolio_state: "LIVE_COMPLETE",
				stale: false,
				freshness_anchor: "LRCCA",
				freshness_anchor_fallback: false,
				mode: "LIVE_DYNAMIC",
				live_overlay_status: liveOverlayStatus,
			},
		},
		null,
		2,
	);
}

/**
 * 面向调用方的文本扫描：既不许出现已知的敏感代码字面量，也不许出现任何
 * 「代码形态」的数字串（5–6 位、不在字母/数字/下划线/哈希上下文里）。
 */
function assertNoSecurityCodes(text, forbiddenCodes = []) {
	for (const code of forbiddenCodes) {
		assert.ok(!text.includes(code), `caller-facing text leaked ${code}`);
	}
	assert.ok(
		!/\b\d{5,6}\b/.test(text),
		`caller-facing text contains a code-shaped token: ${text.slice(0, 200)}`,
	);
}

test("gate: only an exact bearer match unlocks the LIVE overlay; both skip states are fail-closed", () => {
	// 有效凭据。
	assert.equal(resolveLiveOverlayStatus(BEARER_OK, FAKE_TOKEN), "ENABLED");
	assert.equal(isLiveOverlayEnabled("ENABLED"), true);

	// 匿名 / 错值 / 宽松化形态一律不放行（沿用既有 isUniverseAuthorized 口径）。
	for (const header of [
		null,
		undefined,
		"",
		FAKE_TOKEN,
		`Bearer ${FAKE_TOKEN} `,
		`bearer ${FAKE_TOKEN}`,
		`Bearer ${FAKE_TOKEN}x`,
		"Bearer ",
	]) {
		assert.equal(resolveLiveOverlayStatus(header, FAKE_TOKEN), "SKIPPED_UNAUTHORIZED");
	}

	// 服务端未配置 token：任何请求头（含长得像正确值的）都 fail-closed。
	for (const configured of [undefined, null, ""]) {
		assert.equal(
			resolveLiveOverlayStatus(BEARER_OK, configured),
			"SKIPPED_TOKEN_NOT_CONFIGURED",
		);
	}
	for (const status of LIVE_OVERLAY_STATUSES) {
		assert.equal(isLiveOverlayEnabled(status), status === "ENABLED");
	}
});

test("Issue #8 market:read MCP credential is independent from the internal universe token", () => {
	const externalToken = "synthetic-chatgpt-client-token";
	const internalUniverseToken = "synthetic-internal-universe-token";

	assert.equal(
		resolveMarketReadLiveOverlayStatus(`Bearer ${externalToken}`, externalToken, "market:read"),
		"ENABLED",
	);
	assert.equal(
		resolveMarketReadLiveOverlayStatus(
			`Bearer ${externalToken}`,
			externalToken,
			"research:read",
		),
		"SKIPPED_INSUFFICIENT_SCOPE",
	);
	assert.equal(
		resolveMarketReadLiveOverlayStatus(`Bearer ${externalToken}`, externalToken, ""),
		"SKIPPED_INSUFFICIENT_SCOPE",
	);
	assert.equal(
		resolveMarketReadLiveOverlayStatus(`Bearer wrong`, externalToken, "market:read"),
		"SKIPPED_UNAUTHORIZED",
	);
	assert.equal(
		resolveMarketReadLiveOverlayStatus(null, externalToken, "market:read"),
		"SKIPPED_UNAUTHORIZED",
	);
	assert.equal(
		resolveMarketReadLiveOverlayStatus(`Bearer ${externalToken}`, undefined, "market:read"),
		"SKIPPED_TOKEN_NOT_CONFIGURED",
	);
	assert.equal(
		resolveMarketReadLiveOverlayStatus(
			`Bearer ${internalUniverseToken}`,
			externalToken,
			"market:read",
		),
		"SKIPPED_UNAUTHORIZED",
		"the internal PORTFOLIO_UNIVERSE_TOKEN must never authorize the external MCP client",
	);
});

test("anonymous get_portfolio_quotes: no overlay, no error, no LIVE code / hash / count leak", async () => {
	// 匿名 = 无 Authorization 头。
	const gate = resolveLiveOverlayStatus(null, FAKE_TOKEN);
	assert.equal(gate, "SKIPPED_UNAUTHORIZED");

	const snapshot = incompleteFixtureSnapshot();
	const universe = await makeUniverse([
		{ market: "CN", exchange: "SZ", code: "300308" },
		{ market: "CN", exchange: "SZ", code: LIVE_ONLY_CODE },
	]);
	// 门未放行时即使 KV 里有生效中的 universe，也必须整段跳过（不读 KV、不判三态、不报错）。
	const outcome = projectCallerSnapshot({
		snapshot,
		liveOverlayStatus: gate,
		universeBound: true,
		universe,
		applyOverlay: true,
	});

	assert.equal(outcome.applied, false, "anonymous callers must not get the LIVE overlay");
	assert.equal(outcome.coverage, "SKIPPED_UNAUTHORIZED");
	// 未叠加时逐字段等于入参：legacy 目录视图（与 universe_present=false 同形）。
	assert.deepEqual(outcome.snapshot, snapshot);
	assert.equal(
		"live_universe" in outcome.snapshot,
		false,
		"no LIVE universe hash may be attached",
	);

	const text = callerResponseText(outcome.snapshot, gate);
	// 降级原因必须标注出来。
	assert.match(text, /"live_overlay_status": "SKIPPED_UNAUTHORIZED"/);
	// 真实持仓代码（只在 LIVE active set 里、目录未覆盖的那只）不得出现。
	assert.ok(
		!text.includes(LIVE_ONLY_CODE),
		"anonymous response must not leak LIVE-only holding codes",
	);
	assert.ok(
		!text.includes("CN:002975"),
		"anonymous response must not leak the coverage key form",
	);
	// hash 不得出现（叠加态才会带 live:<content_hash>）。
	assert.ok(
		!text.includes(universe.content_hash),
		"anonymous response must not leak the universe hash",
	);
	assert.ok(
		!text.includes("live:"),
		"anonymous response must stay on the legacy portfolio_version",
	);
	// 未叠加时不得出现任何 overlay 专属标记。
	assert.ok(
		!outcome.snapshot.stocks.some(
			(row) => row.holding_status === "ACTIVE" && row.position_qty === null,
		),
	);
	assert.equal(
		outcome.snapshot.stocks.find((row) => row.code === "002975")?.holding_status,
		"ACTIVE",
	);
});

test("LIVE-derived counts stay hidden from anonymous callers: legacy summary is preserved verbatim", async () => {
	const stocks = [
		makeStock("300308", "CN", "SZ", "core", "CORE", "ACTIVE", true),
		makeStock("002975", "CN", "SZ", "growth", "GROWTH", "ACTIVE", true),
	];
	// legacy 目录自报口径（2 行都在仓）；LIVE 真相只有 1 只在仓。
	const legacySummary = {
		total: 2,
		active_quote_total: 2,
		active_holding_total: 2,
		watch_total: 0,
		exited_watch_total: 0,
		mapping_total: 0,
		core_total: 1,
		growth_total: 1,
	};
	const snapshot = snapshotOf(stocks, { ...legacySummary });
	validateSnapshot(snapshot);
	const universe = await makeUniverse([{ market: "CN", exchange: "SZ", code: "300308" }]);

	// 对照组：门放行 → 数量按 LIVE 真相重算（覆盖私有面在受鉴权时才出现）。
	const gated = projectCallerSnapshot({
		snapshot,
		liveOverlayStatus: "ENABLED",
		universeBound: true,
		universe,
		applyOverlay: true,
	});
	assert.equal(gated.snapshot.summary.active_holding_total, 1);
	assert.notDeepEqual(gated.snapshot.summary, legacySummary);

	// 匿名：数量口径必须与 legacy 目录逐字段相同，LIVE 真相（1）不得出现。
	const anonymous = projectCallerSnapshot({
		snapshot,
		liveOverlayStatus: resolveLiveOverlayStatus(null, FAKE_TOKEN),
		universeBound: true,
		universe,
		applyOverlay: true,
	});
	assert.deepEqual(anonymous.snapshot.summary, legacySummary);
	const parsed = JSON.parse(callerResponseText(anonymous.snapshot, "SKIPPED_UNAUTHORIZED"));
	assert.deepEqual(parsed.summary, legacySummary);
	assert.equal(parsed.portfolio_version, "legacy-catalog");
	assert.equal(parsed.live_universe, undefined);
	assert.equal(parsed.control_plane_status.live_overlay_status, "SKIPPED_UNAUTHORIZED");
});

test("gated call with a valid token behaves exactly like the pre-gate overlay path", async () => {
	assert.equal(resolveLiveOverlayStatus(BEARER_OK, FAKE_TOKEN), "ENABLED");
	const snapshot = snapshotOf([
		makeStock("300308", "CN", "SZ", "core", "CORE", "ACTIVE", true),
		makeStock("300502", "CN", "SZ", "growth", "GROWTH", "ACTIVE", true),
		makeStock("301183", "CN", "SZ", "watch", "WATCH", "WATCH", false),
		makeStock("03308", "HK", "HK", "mapping", null, "MAPPING_ONLY", false, true),
	]);
	validateSnapshot(snapshot);
	const universe = await makeUniverse([
		{ market: "CN", exchange: "SZ", code: "300308" },
		{ market: "CN", exchange: "SZ", code: "301183" },
	]);

	const outcome = projectCallerSnapshot({
		snapshot,
		liveOverlayStatus: "ENABLED",
		universeBound: true,
		universe,
		applyOverlay: true,
	});

	assert.equal(outcome.applied, true);
	assert.equal(outcome.coverage, "COMPLETE");
	// 门放行后行为与改动前完全一致：叠加确实发生（卖出标的被投影删除、数量被抹平）。
	assert.notDeepEqual(outcome.snapshot, snapshot);
	assert.deepEqual(outcome.snapshot, applyLiveUniverse(snapshot, universe));
	assert.equal(outcome.snapshot.portfolio_version, `live:${universe.content_hash}`);
	assert.deepEqual(
		outcome.snapshot.stocks.map((row) => `${row.market}:${row.code}`),
		["CN:300308", "CN:301183", "HK:03308"],
	);
	assert.equal(
		outcome.snapshot.stocks.some((row) => row.code === "300502"),
		false,
	);
	assert.equal(
		outcome.snapshot.stocks.find((row) => row.code === "301183")?.holding_status,
		"ACTIVE",
	);
	assert.equal(outcome.snapshot.stocks.find((row) => row.code === "300308")?.position_qty, null);
	assert.equal(outcome.snapshot.live_universe.content_hash, universe.content_hash);
});

test("missing token configuration is fail-closed even for a well-formed request", async () => {
	const snapshot = incompleteFixtureSnapshot();
	const universe = await makeUniverse([{ market: "CN", exchange: "SZ", code: LIVE_ONLY_CODE }]);
	const gate = resolveLiveOverlayStatus(BEARER_OK, undefined);
	assert.equal(gate, "SKIPPED_TOKEN_NOT_CONFIGURED");
	const outcome = projectCallerSnapshot({
		snapshot,
		liveOverlayStatus: gate,
		universeBound: true,
		universe,
		applyOverlay: true,
	});
	assert.equal(outcome.applied, false);
	assert.equal(outcome.coverage, "SKIPPED_TOKEN_NOT_CONFIGURED");
	assert.ok(!callerResponseText(outcome.snapshot, gate).includes(LIVE_ONLY_CODE));
});

test("pre-gate states stay unchanged: no KV binding and unconfirmed three-state both fall back silently", async () => {
	const snapshot = incompleteFixtureSnapshot();
	const universe = await makeUniverse([{ market: "CN", exchange: "SZ", code: LIVE_ONLY_CODE }]);

	// KV 未绑定（迁移前形态）。
	const unbound = projectCallerSnapshot({
		snapshot,
		liveOverlayStatus: "ENABLED",
		universeBound: false,
		universe: null,
		applyOverlay: false,
	});
	assert.deepEqual([unbound.applied, unbound.coverage], [false, "NOT_CONFIGURED"]);
	assert.deepEqual(unbound.snapshot, snapshot);

	// 门放行但三态未确认（J-11 / C-5）：不叠加、不报错，沿用既有 SKIPPED 标记。
	const unknown = projectCallerSnapshot({
		snapshot,
		liveOverlayStatus: "ENABLED",
		universeBound: true,
		universe,
		applyOverlay: false,
	});
	assert.deepEqual(
		[unknown.applied, unknown.coverage],
		[false, "SKIPPED_PORTFOLIO_NOT_CONFIRMED"],
	);
	assert.deepEqual(unknown.snapshot, snapshot);
});

test("coverage gate stays fail-closed for authorized callers and its text carries no security code", async () => {
	const snapshot = incompleteFixtureSnapshot();
	const universe = await makeUniverse([
		{ market: "CN", exchange: "SZ", code: "300308" },
		{ market: "CN", exchange: "SZ", code: LIVE_ONLY_CODE },
	]);

	let thrown = null;
	try {
		projectCallerSnapshot({
			snapshot,
			liveOverlayStatus: "ENABLED",
			universeBound: true,
			universe,
			applyOverlay: true,
		});
	} catch (error) {
		thrown = error;
	}
	assert.ok(
		thrown instanceof LiveCoverageError,
		"authorized coverage failure must stay fail-closed",
	);
	// 面向调用方的文本：只出数量。
	assert.equal(thrown.message, "upstream quote catalog is missing 1 LIVE positions");
	assert.equal(thrown.message, formatLiveCoverageFailureMessage(1));
	assert.match(thrown.message, /missing 1 LIVE positions/);
	// 不含任何证券代码形态（含 coverage 缺失的那一只与目录内的那一只）。
	assert.ok(!thrown.message.includes(LIVE_ONLY_CODE));
	assert.ok(
		!/\b\d{5,6}\b/.test(thrown.message),
		"the caller-facing text must not contain code-shaped tokens",
	);
	// 逐代码明细仍在异常对象上，供服务端日志使用（不进响应体）。
	assert.deepEqual(thrown.missingActive, [`CN:${LIVE_ONLY_CODE}`]);
	assert.equal(thrown.missingCount, 1);
	assert.equal(thrown.activeCount, 2);
	assert.equal(thrown.quotedActiveCount, 1);
	// 出口再洗一遍（index.ts 的 clientFacingErrorMessage 同款）也必须是幂等无码的。
	assert.equal(redactInstrumentCodes(thrown.message), thrown.message);

	// 面向调用方的**响应文本**扫描：错误信封与 identity / stale 提示都不得带出任何代码形态。
	const errorEnvelope = JSON.stringify(
		{
			error: "UPSTREAM_FETCH_ERROR",
			message: redactInstrumentCodes(thrown.message),
		},
		null,
		2,
	);
	assertNoSecurityCodes(errorEnvelope, [LIVE_ONLY_CODE, "300308", "002975"]);
	for (const promptText of [
		"GitHub login mismatch",
		"GitHub token lacks write permission on private repository",
		"quote universe is stale: age=900001s max=864000s",
		"LIVE_UNIVERSE_STALE",
		"PORTFOLIO_UNKNOWN",
	]) {
		assertNoSecurityCodes(redactInstrumentCodes(promptText));
	}
});

test("client-facing text scrubber removes security codes but never mangles hashes, ages or counts", () => {
	// 真实泄漏形态（issue #15 §8.3）：匿名调用曾经拿到的错误文本。
	assert.equal(
		redactInstrumentCodes(
			"upstream quote catalog is missing LIVE positions: CN:002409, CN:002975",
		),
		`upstream quote catalog is missing LIVE positions: ${INSTRUMENT_CODE_PLACEHOLDER}, ${INSTRUMENT_CODE_PLACEHOLDER}`,
	);
	assert.ok(
		!redactInstrumentCodes(
			"upstream quote catalog is missing LIVE positions: CN:002409, CN:002975",
		).includes("002409"),
	);

	const samples = [
		"duplicate active instrument: CN:002409",
		"duplicate active instrument: HK:09696",
		"portfolio_universe[0] does not match stocks for CN:300308: price",
		"portfolio_universe instrument is missing from stocks: HK:03308",
		"missing code 002409",
	];
	for (const sample of samples) {
		const scrubbed = redactInstrumentCodes(sample);
		assert.ok(!/\b\d{5,6}\b/.test(scrubbed), `security code survived: ${sample}`);
		assert.match(scrubbed, /\[REDACTED_CODE\]/);
	}

	// 不得误伤：hash、age/max 的秒数、数量、HTTP 状态码原样保留。
	const untouched = [
		`content_hash mismatch: expected sha256:${"abcdef0123".repeat(6)}ab`,
		`content_hash mismatch: expected sha256:${"1".repeat(64)}`,
		"quote universe is stale: age=900000s max=864000s",
		"quote universe generated_at is 120s in the future",
		"upstream quote catalog is missing 2 LIVE positions",
		"GitHub token lacks write permission on private repository",
		"portfolio_universe.length=3 but stocks.length=4",
	];
	for (const sample of untouched) assert.equal(redactInstrumentCodes(sample), sample);

	// 幂等 + 空串。
	const once = redactInstrumentCodes("CN:002409");
	assert.equal(redactInstrumentCodes(once), once);
	assert.equal(redactInstrumentCodes(""), "");
});

test("Issue #8 wiring: external MCP market:read and internal universe auth are separate fail-closed gates", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

	// 1. MCP 工厂只走外部 client credential + market:read gate。
	assert.match(source, /createMcpHandler\(\(ctx\) =>/);
	assert.match(
		source,
		/const liveOverlayStatus = requestMcpMarketReadStatus\(ctx\.requestInfo, env\);/,
	);
	// #5 §A4：第三参 researchScopes 由 resolveResearchScopes 解析（凭据逐字节
	// 匹配 + 转发头 ∩ 配置上限），只扩研究写面，不触碰 market:read 门。
	assert.match(
		source,
		/\);\s*[\s\S]*?return createServer\(\s*env,\s*liveOverlayStatus,\s*researchScopes[\s\S]*?\);/,
	);
	assert.match(source, /request\?\.headers\.get\("Authorization"\)/);
	assert.match(source, /env\.COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(source, /env\.COLLECTOR_MCP_CLIENT_SCOPES/);
	assert.match(source, /env\.COLLECTOR_MCP_CLIENT_ID/);
	assert.match(source, /status === "ENABLED" && !env\.COLLECTOR_MCP_CLIENT_ID\?\.trim\(\)/);
	// 2. 内部 universe API 继续只认内部 token，且绝不调用 MCP gate。
	assert.match(
		source,
		/function isUniverseAuthorized\(request: Request, env: Env\): boolean \{\s*return isLiveOverlayEnabled\(requestInternalUniverseStatus\(request, env\)\);/,
	);
	assert.match(source, /env\.PORTFOLIO_UNIVERSE_TOKEN/);
	const internalGate = source.slice(
		source.indexOf("function requestInternalUniverseStatus"),
		source.indexOf("function requestMcpMarketReadStatus"),
	);
	assert.doesNotMatch(internalGate, /COLLECTOR_MCP_CLIENT_TOKEN|COLLECTOR_MCP_CLIENT_SCOPES/);
	const mcpGate = source.slice(
		source.indexOf("function requestMcpMarketReadStatus"),
		source.indexOf("function isUniverseAuthorized"),
	);
	assert.doesNotMatch(mcpGate, /PORTFOLIO_UNIVERSE_TOKEN/);
	// 3. get_portfolio_quotes 把门传给叠加出口，且两处 control_plane_status 都带降级标注。
	const toolStart = source.indexOf('"get_portfolio_quotes"');
	const toolBody = source.slice(toolStart, source.indexOf('"get_control_plane_status"'));
	assert.ok(toolStart > 0);
	assert.match(toolBody, /\{\s*liveOverlayStatus,?\s*\}/);
	assert.equal((toolBody.match(/live_overlay_status: liveOverlayStatus/g) ?? []).length, 2);
	assert.equal(
		(toolBody.match(/market_read_auth: marketReadAuditFields\(env, liveOverlayStatus\)/g) ?? [])
			.length,
		2,
	);
	assert.match(source, /auth_mode: MARKET_READ_AUTH_MODE/);
	assert.match(
		source,
		/client_id: authenticated \? env\?\.COLLECTOR_MCP_CLIENT_ID\?\.trim\(\) \|\| null : null/,
	);
	assert.match(source, /scopes: authenticated \? \[MARKET_READ_SCOPE\] : \[\]/);
	const authLog = source.slice(
		source.indexOf('bridgeContext("mcp:market-read-auth")'),
		source.indexOf("const researchScopes = resolveResearchScopes("),
	);
	assert.doesNotMatch(
		authLog,
		/Authorization|COLLECTOR_MCP_CLIENT_TOKEN|PORTFOLIO_UNIVERSE_TOKEN/,
	);
	// 4. 叠加出口唯一，且其缺省是 fail-closed。
	assert.match(source, /liveOverlayStatus \?\? "SKIPPED_UNAUTHORIZED"/);
	assert.match(source, /liveOverlayStatus: LiveOverlayStatus = "SKIPPED_UNAUTHORIZED"/);
	// 5. 公开桥（cron）不传门（liveOverlayStatus），结构上不可能叠加；
	//    基础行情来自私有 catalog + direct provider。
	const bridgeBody = source.slice(
		source.indexOf("export async function updateQuoteBridge"),
		source.lastIndexOf("/**", source.indexOf("function createServer")),
	);
	assert.doesNotMatch(bridgeBody, /liveOverlayStatus/);
	assert.match(bridgeBody, /fetchPrivateCatalogSnapshot\(context, env\)/);
	assert.doesNotMatch(source, /chatgpt\.site|PORTFOLIO_QUOTES_PUBLIC_FALLBACK_URL/);
});

test("D-1 wiring: no security code and no un-scrubbed message can reach a caller", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

	// 旧泄漏模板（逐代码 join）必须彻底消失。
	assert.ok(
		!source.includes("missing LIVE positions: $"),
		"the per-code coverage template must be gone",
	);
	assert.ok(!source.includes("missing_active.join"));
	assert.ok(!source.includes("getLiveUniverseCoverage"));

	// 所有响应体 message 都走去码出口；服务端日志口径（safeErrorMessage）只允许留在日志/异常构造处。
	assert.equal((source.match(/jsonResponse\([^\n]*safeErrorMessage/g) ?? []).length, 0);
	// 服务端日志仍保留明细（含逐代码），与「调用方文本去码」互补。
	assert.match(source, /error_message: safeErrorMessage\(error\),/);
	// Formatting may span a jsonResponse across lines; every dynamic caller
	// error message must still use the single code-scrubbing helper.
	const scrubbedResponses = (source.match(/message:\s*clientFacingErrorMessage\(error\)/g) ?? [])
		.length;
	assert.equal(scrubbedResponses, 10);
	assert.match(
		source,
		/function clientFacingErrorMessage\(error: unknown\): string \{\s*return redactInstrumentCodes\(safeErrorMessage\(error\)\);/,
	);

	// 去码实现只此一份（唯一正则来源），且不含任何具体证券代码。
	const overlaySource = await readFile(
		new URL("../src/live-overlay.ts", import.meta.url),
		"utf8",
	);
	assert.match(overlaySource, /INSTRUMENT_CODE_PATTERN/);
	assert.ok(
		!/\bCN:\d{5,6}\b/.test(overlaySource.replace(/\/\*[\s\S]*?\*\//g, "")),
		"no real code may be hard-coded as a sample",
	);
	assert.ok(!/\bHK:\d{5,6}\b/.test(overlaySource.replace(/\/\*[\s\S]*?\*\//g, "")));
});
