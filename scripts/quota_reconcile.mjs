#!/usr/bin/env node
// Collector 用量对账（只读、**非权威**）。
//
// ⚠ SDD CQ 规格（2026-09-29）后的定位变更：本脚本**不再驱动任何准入门**。
//   - 已废止：月包含量 ÷ 31 的"日红线"、日线 × 已过天数的"按比例月线"，
//     以及 `CIRCUIT_OPEN / WARN` 退出码语义。付费版 D1 额度按**账户订阅续费日**
//     重置，不是 UTC 自然月；月额 ÷ 31 不是 95% 保证。
//   - 现行准入在 Collector 服务端：`src/quota-admission.ts`（账户账期锚点 +
//     VERIFIED 基线 + 多维原子预留）。本脚本的输出**只能作为人工提示**：
//     Cloudflare Billable Usage API 为日更且无已知最迟到达保证；2026-09-29
//     授权后只读返回 HTTP 200，但仅出现 R2 计费行，缺失维度不能按零用量
//     处理。此脚本仍不能作为准入或实时闭环。
//   - 除硬失败外退出码恒为 0；不会再输出 2/3 的"熔断"退出码被外部当成闸。
//
// 数据源：Cloudflare GraphQL Analytics（D1 rowsRead/rowsWritten、Worker 请求数，
// 按日聚合），仅只读。凭据只从环境读取，不打印、不落盘。
// 用法：CLOUDFLARE_API_TOKEN=... node scripts/quota_reconcile.mjs [--json]

const ACCOUNT_TAG = "4b0901ceeeef89ac3b8414d56c50c946";
const D1_DATABASE_ID = "0e20aca4-c394-4f41-aa46-d98831b81836";
const WORKER_NAME = "cn-hk-quotes-mcp";

// 官方付费版包含量（仅作显示参考；准入阈值以 src/quota-dimensions.ts 为准）。
const INCLUDED_REFERENCE = {
	"d1.rowsRead": 25_000_000_000,
	"d1.rowsWritten": 50_000_000,
};
const ROLLING_WINDOW_DAYS = 31;

function ymd(date) {
	return date.toISOString().slice(0, 10);
}

import { execFileSync } from "node:child_process";

async function graphql(query, token) {
	// curl 子进程而非 fetch：Windows 上 undici + process.exit 会触发 libuv 关闭断言，
	// 破坏退出码语义。
	const raw = execFileSync(
		"curl",
		[
			"-s",
			"-X",
			"POST",
			"https://api.cloudflare.com/client/v4/graphql",
			"-H",
			`Authorization: Bearer ${token}`,
			"-H",
			"Content-Type: application/json",
			"--data",
			JSON.stringify({ query }),
			"--max-time",
			"30",
		],
		{ encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
	);
	const body = JSON.parse(raw);
	if (body.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
	return body.data;
}

async function main() {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) {
		console.error("CLOUDFLARE_API_TOKEN 未设置（只读分析凭据）");
		process.exit(1);
	}
	const now = new Date();
	const windowStart = new Date(now.getTime() - ROLLING_WINDOW_DAYS * 24 * 3600 * 1000);
	const query = `query {
		viewer {
			accounts(filter: {accountTag: "${ACCOUNT_TAG}"}) {
				d1AnalyticsAdaptiveGroups(
					filter: {datetime_geq: "${windowStart.toISOString()}", datetime_lt: "${now.toISOString()}", databaseId: "${D1_DATABASE_ID}"},
					limit: 40, orderBy: [date_ASC]
				) {
					dimensions { date }
					sum { rowsRead rowsWritten }
				}
				workersInvocationsAdaptive(
					filter: {datetime_geq: "${windowStart.toISOString()}", datetime_lt: "${now.toISOString()}", scriptName: "${WORKER_NAME}"},
					limit: 40, orderBy: [date_ASC]
				) {
					dimensions { date }
					sum { requests }
				}
			}
		}
	}`;
	const data = await graphql(query, token);
	const account = data.viewer.accounts[0];
	const d1Days = account.d1AnalyticsAdaptiveGroups.map((group) => ({
		date: group.dimensions.date,
		rowsRead: group.sum.rowsRead,
		rowsWritten: group.sum.rowsWritten,
	}));
	const requestDays = account.workersInvocationsAdaptive.map((group) => ({
		date: group.dimensions.date,
		requests: group.sum.requests,
	}));

	const report = {
		// 这个字段是刻意的：任何消费者都不得把本报告当作准入判据。
		gate_authority: "NONE",
		state: "UNVERIFIED",
		asOf: now.toISOString(),
		window: {
			start: ymd(windowStart),
			end: ymd(now),
			days: d1Days.length,
			kind: `rolling_${ROLLING_WINDOW_DAYS}d`,
		},
		observed: {
			d1RowsRead: d1Days.reduce((total, day) => total + day.rowsRead, 0),
			d1RowsWritten: d1Days.reduce((total, day) => total + day.rowsWritten, 0),
			requests: requestDays.reduce((total, day) => total + day.requests, 0),
			includedReference: INCLUDED_REFERENCE,
		},
		days: d1Days,
		requestsPerDay: requestDays,
		notAuthoritativeBecause: [
			"计费期是账户订阅续费周期，不是 UTC 自然月；本脚本没有权威账期锚点",
			"账单 API 已能只读访问，但当前只返回 R2 行；缺失维度不可当零，且日更无已知最大延迟",
			"本脚本不覆盖 Workers/KV/R2/AI/Vectorize 的账号级剩余额度",
			"运维提示不得用于放行生产写入或恢复补录",
		],
		admissionReference: "src/quota-admission.ts（账户账期锚点 + VERIFIED 基线 + 多维原子预留）",
	};

	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log("判定: UNVERIFIED（非权威提示；不驱动准入）");
		console.log(
			`D1 读取  近 ${ROLLING_WINDOW_DAYS} 天观测 ${report.observed.d1RowsRead.toLocaleString()} 行`,
		);
		console.log(
			`D1 写入  近 ${ROLLING_WINDOW_DAYS} 天观测 ${report.observed.d1RowsWritten.toLocaleString()} 行`,
		);
		console.log(
			`Worker 请求 近 ${ROLLING_WINDOW_DAYS} 天观测 ${report.observed.requests.toLocaleString()} 次`,
		);
		console.log("计费期口径：付费版按账户订阅续费日重置（非 UTC 自然月；禁用月额÷31）");
		console.log(
			"账单 API 已返回 200，但仅 R2 行且有未知尾部 → 本脚本 gate_authority=NONE",
		);
	}
	process.exit(0);
}

main().catch((error) => {
	console.error("reconcile failed:", error.message);
	process.exit(1);
});
