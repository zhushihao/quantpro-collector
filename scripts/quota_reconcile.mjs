#!/usr/bin/env node
// D1/平台用量对账（Owner 硬约束 2026-09-29：按付费版上限的 95% 设计预算，超线熔断）。
// 数据源：Cloudflare GraphQL Analytics（D1 rowsRead/rowsWritten，按日聚合）。
// 退出码：0=OK；2=WARN（≥80% 日线）；3=CIRCUIT_OPEN（≥95% 日线或月度按比例超线）。
// 用法：CLOUDFLARE_API_TOKEN=... node scripts/quota_reconcile.mjs [--json]

const ACCOUNT_TAG = "4b0901ceeeef89ac3b8414d56c50c946";
const D1_DATABASE_ID = "0e20aca4-c394-4f41-aa46-d98831b81836";
const WORKER_NAME = "cn-hk-quotes-mcp";

// —— 95 折预算表（付费版 included 用量 × 0.95；日线 = 月线 / 31）——
const BUDGET = {
	"d1.rowsRead": { monthly: 25e9 * 0.95, label: "D1 读取行数/月" },
	"d1.rowsWritten": { monthly: 50e6 * 0.95, label: "D1 写入行数/月" },
};

const WARN_RATIO = 0.8; // 预警线：日红线的 80%
const CIRCUIT_RATIO = 0.95; // 熔断线：达日红线即熔断

function monthStartUtc(now = new Date()) {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
function ymd(d) {
	return d.toISOString().slice(0, 10);
}
function dayOfMonthUtc(now = new Date()) {
	return now.getUTCDate();
}

import { execFileSync } from "node:child_process";

async function graphql(query, token) {
	// curl 子进程而非 fetch：Windows 上 undici + process.exit 会触发 libuv 关闭断言，
	// 破坏本脚本的熔断退出码语义（0/2/3）。
	const raw = execFileSync(
		"curl",
		["-s", "-X", "POST", "https://api.cloudflare.com/client/v4/graphql",
			"-H", `Authorization: Bearer ${token}`,
			"-H", "Content-Type: application/json",
			"--data", JSON.stringify({ query }),
			"--max-time", "30"],
		{ encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
	);
	const body = JSON.parse(raw);
	if (body.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
	return body.data;
}

async function main() {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) {
		console.error("CLOUDFLARE_API_TOKEN 未设置");
		process.exit(1);
	}
	const now = new Date();
	const start = monthStartUtc(now);
	const q = `query {
		viewer {
			accounts(filter: {accountTag: "${ACCOUNT_TAG}"}) {
				d1AnalyticsAdaptiveGroups(
					filter: {datetime_geq: "${start.toISOString()}", datetime_lt: "${now.toISOString()}", databaseId: "${D1_DATABASE_ID}"},
					limit: 40, orderBy: [date_ASC]
				) {
					dimensions { date }
					sum { rowsRead rowsWritten }
				}
				workersInvocationsAdaptive(
					filter: {datetime_geq: "${start.toISOString()}", datetime_lt: "${now.toISOString()}", scriptName: "${WORKER_NAME}"},
					limit: 40, orderBy: [date_ASC]
				) {
					dimensions { date }
					sum { requests }
				}
			}
		}
	}`;
	const data = await graphql(q, token);
	const acct = data.viewer.accounts[0];
	const d1Days = acct.d1AnalyticsAdaptiveGroups.map((g) => ({
		date: g.dimensions.date,
		rowsRead: g.sum.rowsRead,
		rowsWritten: g.sum.rowsWritten,
	}));
	const reqDays = acct.workersInvocationsAdaptive.map((g) => ({
		date: g.dimensions.date,
		requests: g.sum.requests,
	}));

	// 月累计与今日读数
	const monthRead = d1Days.reduce((a, d) => a + d.rowsRead, 0);
	const monthWritten = d1Days.reduce((a, d) => a + d.rowsWritten, 0);
	const today = ymd(now);
	const todayRead = d1Days.find((d) => d.date === today)?.rowsRead ?? 0;

	// 日红线（月预算均摊 31 天）与按比例月线
	const dailyLine = (b) => b.monthly / 31;
	const monthProportionalLine = (b) => (b.monthly / 31) * dayOfMonthUtc(now);

	const readBudget = BUDGET["d1.rowsRead"];
	const readDailyLine = dailyLine(readBudget);
	const readMonthLine = monthProportionalLine(readBudget);
	const todayRatio = todayRead / readDailyLine;
	const monthRatio = monthRead / readMonthLine;

	let verdict = "OK";
	if (todayRatio >= CIRCUIT_RATIO || monthRatio >= CIRCUIT_RATIO) verdict = "CIRCUIT_OPEN";
	else if (todayRatio >= WARN_RATIO || monthRatio >= WARN_RATIO) verdict = "WARN";

	const report = {
		verdict,
		asOf: now.toISOString(),
		d1: {
			todayRowsRead: todayRead,
			todayDailyLine: Math.round(readDailyLine),
			todayRatioPct: +(todayRatio * 100).toFixed(1),
			monthRowsRead: monthRead,
			monthProportionalLine: Math.round(readMonthLine),
			monthRatioPct: +(monthRatio * 100).toFixed(1),
			monthlyBudget95: readBudget.monthly,
			days: d1Days,
		},
		workersRequests: reqDays,
		note: "预算=付费版 included × 95%；日线=月预算/31；月线=日线×本月已过天数（防月初狂飙）",
	};

	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`判定: ${verdict}`);
		console.log(`D1 读取  今日 ${report.d1.todayRowsRead.toLocaleString()} / 日线 ${report.d1.todayDailyLine.toLocaleString()}（${report.d1.todayRatioPct}%）`);
		console.log(`D1 读取  月累计 ${report.d1.monthRowsRead.toLocaleString()} / 按比例月线 ${report.d1.monthProportionalLine.toLocaleString()}（${report.d1.monthRatioPct}%）`);
		console.log(`D1 写入  月累计 ${monthWritten.toLocaleString()} / 月预算 ${Math.round(BUDGET["d1.rowsWritten"].monthly).toLocaleString()}`);
		for (const d of d1Days) console.log(`  ${d.date}: read=${d.rowsRead.toLocaleString()} written=${d.rowsWritten.toLocaleString()}`);
	}
	process.exit(verdict === "CIRCUIT_OPEN" ? 3 : verdict === "WARN" ? 2 : 0);
}

main().catch((err) => {
	console.error("reconcile failed:", err.message);
	process.exit(1);
});
