#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	appendInvestmentLedgerBatch,
	getInvestmentLedgerState,
	InvestmentLedgerError,
} from "../src/investment-ledger.ts";

const COMMANDS = new Map([
	["get-industry", { operation: "get", role: "industry" }],
	["append-industry", { operation: "append", role: "industry" }],
	["get-company", { operation: "get", role: "company" }],
	["append-company", { operation: "append", role: "company" }],
]);

function githubTokenFromGh() {
	try {
		const token = execFileSync("gh", ["auth", "token"], {
			encoding: "utf8",
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 16 * 1024,
		}).trim();
		if (!token) throw new Error("empty token");
		return token;
	} catch {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_UNAVAILABLE",
			"RESEARCH GitHub credential is unavailable",
		);
	}
}

function safeErrorPayload(error) {
	if (error instanceof InvestmentLedgerError) {
		return { status: error.code, message: error.message };
	}
	return {
		status: "INVESTMENT_LEDGER_UNAVAILABLE",
		message: "investment ledger transport failed",
	};
}

function parseJson(raw, description) {
	try {
		return JSON.parse(raw);
	} catch {
		throw new InvestmentLedgerError(
			"INVESTMENT_LEDGER_VALIDATION_FAILED",
			`stdin is not valid ${description} JSON`,
		);
	}
}

export async function runInvestmentLedgerCli(argv, overrides = {}) {
	const deps = {
		tokenProvider: githubTokenFromGh,
		readStdin: () => readFileSync(0, "utf8"),
		writeStdout: (text) => process.stdout.write(text + "\n"),
		writeStderr: (text) => process.stderr.write(text + "\n"),
		getInvestmentLedgerState,
		appendInvestmentLedgerBatch,
		...overrides,
	};
	try {
		const [command, ...args] = argv;
		const route = COMMANDS.get(command);
		if (!route) {
			throw new InvestmentLedgerError(
				"INVESTMENT_LEDGER_VALIDATION_FAILED",
				"command must be get-industry, append-industry, get-company, or append-company",
			);
		}
		if (args.length !== 0) {
			throw new InvestmentLedgerError(
				"INVESTMENT_LEDGER_VALIDATION_FAILED",
				"investment ledger commands accept JSON via stdin only",
			);
		}
		const raw = await deps.readStdin();
		const input = parseJson(raw, route.operation === "get" ? "symbol request" : "batch");
		const token = await deps.tokenProvider();
		if (route.operation === "get") {
			if (
				!input ||
				typeof input !== "object" ||
				Array.isArray(input) ||
				!Array.isArray(input.symbols)
			) {
				throw new InvestmentLedgerError(
					"INVESTMENT_LEDGER_VALIDATION_FAILED",
					"get stdin must be an object containing symbols",
				);
			}
			const extraKeys = Object.keys(input).filter((key) => key !== "symbols");
			if (extraKeys.length > 0) {
				throw new InvestmentLedgerError(
					"INVESTMENT_LEDGER_VALIDATION_FAILED",
					`get stdin contains unsupported keys: ${extraKeys.join(",")}`,
				);
			}
			const result = await deps.getInvestmentLedgerState({
				token,
				role: route.role,
				symbols: input.symbols,
			});
			deps.writeStdout(JSON.stringify(result));
			return 0;
		}
		const result = await deps.appendInvestmentLedgerBatch({
			token,
			role: route.role,
			batch: input,
		});
		deps.writeStdout(JSON.stringify(result));
		return 0;
	} catch (error) {
		deps.writeStderr(JSON.stringify(safeErrorPayload(error)));
		return 1;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	process.exitCode = await runInvestmentLedgerCli(process.argv.slice(2));
}
