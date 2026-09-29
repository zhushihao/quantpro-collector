import assert from "node:assert/strict";
import test from "node:test";

import {
	applyLiveUniverse,
	assertLiveUniverseFresh,
	computeLiveUniverseHash,
	getLiveUniverseCoverage,
	readLiveUniverse,
	resolveLiveUniverseFreshness,
	validateLiveUniverse,
	writeLiveUniverse,
} from "../src/live-universe.ts";

function makeStock(code, market, exchange, portfolioGroup, portfolioStatus, holdingStatus, isPosition, mappingOnly = false) {
	const group = portfolioGroup === "growth" ? "Growth" : portfolioGroup === "watch" ? "Watch" : "Core";
	return {
		code, market, exchange, name: code, group,
		portfolio_group: portfolioGroup, portfolio_status: portfolioStatus,
		holding_status: holdingStatus, mapping_only: mappingOnly,
		mapped_to: mappingOnly ? "300308.SZ" : null, mapping_to: mappingOnly ? "300308.SZ" : null,
		position_qty: isPosition ? 100 : 0, is_position: isPosition,
		price: 10, change: 0, change_pct: 0, pre_close: 10, prev_close: 10, open: 10, high: 10, low: 10,
		pct_change: 0, volume: 1, amount: 10, market_status: "CLOSED",
		market_data_time: "2026-09-11T15:00:00+08:00", source_update_time: "2026-09-11T15:01:00+08:00",
		freshness_basis: "MARKET_DATA", quote_time: "2026-09-11T15:00:00+08:00",
		fetch_time: "2026-09-11T15:01:00+08:00", age_seconds: 60,
		primary_source: "tencent", secondary_source: null, source_status: "OK", quality: "CLOSED_SNAPSHOT",
	};
}

function snapshotOf(stocks) {
	return {
		portfolio_version: "legacy-catalog", snapshot_time: "2026-09-11T15:01:00+08:00", system_quality: "OK",
		summary: { total: stocks.length },
		portfolio_universe: stocks.map(({ price, change, change_pct, pre_close, prev_close, open, high, low, pct_change, volume, amount, market_status, market_data_time, source_update_time, freshness_basis, quote_time, fetch_time, age_seconds, primary_source, secondary_source, source_status, quality, ...item }) => item),
		stocks,
	};
}

async function makeUniverse(active) {
	return {
		schema_version: "quote-universe/1",
		generated_at: "2026-09-11T16:00:00+08:00",
		source_manifest_hash: `sha256:${"1".repeat(64)}`,
		active,
		content_hash: await computeLiveUniverseHash(active),
	};
}

test("quote-universe/1 is code-only, canonical, unique, and hash-verified", async () => {
	const active = [
		{ market: "HK", exchange: "HK", code: "09696" },
		{ market: "CN", exchange: "SZ", code: "300308" },
	];
	const payload = await makeUniverse(active);
	assert.equal(payload.content_hash, "sha256:da38af6b472863b63405459f9b9683a12fd458e5c6a043850524b057251f5e0c");
	const validated = await validateLiveUniverse(payload);
	assert.deepEqual(validated.active.map((row) => `${row.market}:${row.code}`), ["CN:300308", "HK:09696"]);
	await assert.rejects(() => validateLiveUniverse({ ...payload, position_qty: 100 }), /not allowed/i);
	await assert.rejects(() => validateLiveUniverse({ ...payload, content_hash: `sha256:${"0".repeat(64)}` }), /mismatch/i);
	const duplicateActive = [...active, active[0]];
	await assert.rejects(
		async () => validateLiveUniverse({ ...payload, active: duplicateActive, content_hash: await computeLiveUniverseHash(duplicateActive) }),
		/duplicate/i,
	);
});

test("LIVE universe freshness rejects very old or future truth but tolerates normal LKG age", async () => {
	const payload = await makeUniverse([{ market: "CN", exchange: "SZ", code: "300308" }]);
	const universe = { ...payload, received_at: "2026-09-11T16:00:01+08:00" };
	assert.doesNotThrow(() => assertLiveUniverseFresh(universe, new Date("2026-09-12T16:00:00+08:00")));
	assert.throws(
		() => assertLiveUniverseFresh(universe, new Date("2026-09-25T16:00:00+08:00")),
		/stale/i,
	);
	const future = { ...universe, generated_at: "2026-09-11T17:00:00+08:00" };
	assert.throws(() => assertLiveUniverseFresh(future, new Date("2026-09-11T16:00:00+08:00")), /future/i);
});

test("KV current is last-known-good: invalid writes never overwrite the previous universe", async () => {
	const values = new Map();
	const kv = {
		get: async (key) => values.get(key) ?? null,
		put: async (key, value) => { values.set(key, value); },
	};
	const payload = await makeUniverse([{ market: "CN", exchange: "SZ", code: "300308" }]);
	await writeLiveUniverse(kv, payload, "2026-09-11T16:00:01+08:00");
	const before = values.get("live-portfolio/current");
	await assert.rejects(
		() => writeLiveUniverse(kv, { ...payload, content_hash: `sha256:${"0".repeat(64)}` }),
		/mismatch/i,
	);
	assert.equal(values.get("live-portfolio/current"), before);
	assert.equal((await readLiveUniverse(kv))?.content_hash, payload.content_hash);
});

test("C-4 dual-track freshness anchor: LRCCA first, generated_at as rollout fallback", async () => {
	const active = [{ market: "CN", exchange: "SZ", code: "300308" }];
	const generatedAt = "2026-09-06T09:30:00+08:00";
	const universe = { ...(await makeUniverse(active)), generated_at: generatedAt };
	const now = new Date("2026-09-14T10:00:00+08:00");

	// 状态件携带的 LRCCA 优先：投影内容 8 天前生成，但账号确认 2 小时前 → 锚 LRCCA。
	const withLrcca = resolveLiveUniverseFreshness(universe, { lrcca: "2026-09-14T08:00:00+08:00", now });
	assert.equal(withLrcca.anchor, "LRCCA");
	assert.equal(withLrcca.anchor_fallback, false);
	assert.equal(withLrcca.anchor_timestamp, "2026-09-14T08:00:00+08:00");
	assert.equal(withLrcca.anchor_age_seconds, 7200);
	assert.equal(withLrcca.fresh, true);

	// 状态件缺失（LRCCA 不可用）→ 回退 generated_at 锚并记 anchor_fallback=true（过渡期双轨）。
	const noLrcca = resolveLiveUniverseFreshness(universe, { now });
	assert.equal(noLrcca.anchor, "GENERATED_AT");
	assert.equal(noLrcca.anchor_fallback, true);
	assert.equal(noLrcca.anchor_timestamp, generatedAt);
	assert.equal(noLrcca.fresh, true);
	// LRCCA 为空与缺失同款处理（状态件在但无基线）。
	assert.equal(resolveLiveUniverseFreshness(universe, { lrcca: null, now }).anchor_fallback, true);

	// 投影陈旧但确认新鲜：以 LRCCA 为准（锚迁移的本意）。
	const oldUniverse = { ...universe, generated_at: "2026-08-20T09:30:00+08:00" };
	assert.equal(resolveLiveUniverseFreshness(oldUniverse, { lrcca: "2026-09-14T07:00:00+08:00", now }).fresh, true);
	assert.equal(resolveLiveUniverseFreshness(oldUniverse, { now }).fresh, false);

	// LRCCA 自身过期 → 不新鲜（由三态层翻 PORTFOLIO_UNKNOWN）。
	const expired = resolveLiveUniverseFreshness(universe, { lrcca: "2026-09-03T09:30:00+08:00", now });
	assert.equal(expired.anchor, "LRCCA");
	assert.equal(expired.fresh, false);

	// 未来时间戳超过容忍窗口 → fail-closed 不新鲜。
	const future = resolveLiveUniverseFreshness(universe, { lrcca: "2026-09-14T12:00:00+08:00", now });
	assert.equal(future.fresh, false);
	assert.equal(future.anchor_age_seconds, -7200);
});

test("LIVE coverage fails closed when a broker holding has no quote row", async () => {
	const snapshot = snapshotOf([makeStock("300308", "CN", "SZ", "core", "CORE", "ACTIVE", true)]);
	const payload = await makeUniverse([
		{ market: "CN", exchange: "SZ", code: "300308" },
		{ market: "CN", exchange: "SZ", code: "002409" },
	]);
	const universe = { ...payload, received_at: "2026-09-11T16:00:01+08:00" };
	assert.deepEqual(getLiveUniverseCoverage(snapshot, universe), {
		status: "INCOMPLETE", active_count: 2, quoted_active_count: 1, missing_active: ["CN:002409"],
	});
});

test("LIVE projection removes sold holdings, promotes held Watch, strips quantities, keeps mappings", async () => {
	const snapshot = snapshotOf([
		makeStock("300308", "CN", "SZ", "core", "CORE", "ACTIVE", true),
		makeStock("300502", "CN", "SZ", "growth", "GROWTH", "ACTIVE", true),
		makeStock("301183", "CN", "SZ", "watch", "WATCH", "WATCH", false),
		makeStock("03308", "HK", "HK", "mapping", null, "MAPPING_ONLY", false, true),
	]);
	const payload = await makeUniverse([
		{ market: "CN", exchange: "SZ", code: "300308" },
		{ market: "CN", exchange: "SZ", code: "301183" },
	]);
	const universe = { ...payload, received_at: "2026-09-11T16:00:01+08:00" };
	assert.equal(getLiveUniverseCoverage(snapshot, universe).status, "COMPLETE");
	const projected = applyLiveUniverse(snapshot, universe);
	assert.equal(projected.portfolio_version, `live:${universe.content_hash}`);
	assert.deepEqual(projected.stocks.map((row) => `${row.market}:${row.code}`), ["CN:300308", "CN:301183", "HK:03308"]);
	assert.equal(projected.stocks.find((row) => row.code === "300308")?.position_qty, null);
	const heldWatch = projected.stocks.find((row) => row.code === "301183");
	assert.equal(heldWatch?.holding_status, "ACTIVE");
	assert.equal(heldWatch?.portfolio_status, "WATCH");
	assert.equal(heldWatch?.is_position, true);
	assert.equal(projected.stocks.find((row) => row.code === "03308")?.mapping_only, true);
});

test("held mapping-group row projects as ACTIVE — position fact outranks catalog display class (#51)", async () => {
	const snapshot = snapshotOf([
		makeStock("300308", "CN", "SZ", "core", "CORE", "ACTIVE", true),
		makeStock("002466", "CN", "SZ", "mapping", null, "MAPPING_ONLY", false, true),
		makeStock("03308", "HK", "HK", "mapping", null, "MAPPING_ONLY", false, true),
	]);
	const payload = await makeUniverse([
		{ market: "CN", exchange: "SZ", code: "300308" },
		{ market: "CN", exchange: "SZ", code: "002466" },
	]);
	const universe = { ...payload, received_at: "2026-09-29T06:30:07+08:00" };
	assert.equal(getLiveUniverseCoverage(snapshot, universe).status, "COMPLETE");
	const projected = applyLiveUniverse(snapshot, universe);
	const heldMapping = projected.stocks.find((row) => row.code === "002466");
	assert.equal(heldMapping?.holding_status, "ACTIVE");
	assert.equal(heldMapping?.is_position, true);
	assert.equal(heldMapping?.position_qty, null);
	const unheldMapping = projected.stocks.find((row) => row.code === "03308");
	assert.equal(unheldMapping?.holding_status, "MAPPING_ONLY");
	assert.equal(unheldMapping?.is_position, false);
	// 源 active=2 == 投影 is_position=2（09-29 曾为 11 vs 10 的矛盾不再出现）。
	assert.equal(universe.active.length, 2);
	assert.equal(projected.summary.active_holding_total, 2);
});
