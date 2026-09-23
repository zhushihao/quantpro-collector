#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	appendMarketCheckpoint,
	getMarketCheckpoints,
	MARKET_LEDGER_SLOT_SCHEMA,
	MarketLedgerError,
} from "../src/market-ledger.ts";

function validationError(message) {
	return new MarketLedgerError("CHECKPOINT_VALIDATION_FAILED", message);
}

function parseGetArgs(args) {
	let tradingDate = null;
	let scheduledSlot = null;
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (typeof value !== "string") throw validationError("missing CLI argument value");
		if (key === "--trading-date") tradingDate = value;
		else if (key === "--scheduled-slot") scheduledSlot = value;
		else throw validationError("unsupported CLI argument");
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate ?? "")) {
		throw validationError("trading date must use YYYY-MM-DD");
	}
	const parsedSlot = MARKET_LEDGER_SLOT_SCHEMA.safeParse(scheduledSlot);
	if (!parsedSlot.success) throw validationError("scheduled slot is not allowed");
	return { tradingDate, scheduledSlot: parsedSlot.data };
}

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
		throw new MarketLedgerError(
			"MARKET_LEDGER_UNAVAILABLE",
			"RESEARCH GitHub credential is unavailable",
		);
	}
}

function safeErrorPayload(error) {
	if (error instanceof MarketLedgerError) {
		return { status: error.code, message: error.message };
	}
	return {
		status: "MARKET_LEDGER_UNAVAILABLE",
		message: "market ledger transport failed",
	};
}

function sanitizeAppendCheckpoint(checkpoint) {
	if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
		return checkpoint;
	}
	const { universe_transition: _serverOwnedUniverseTransition, ...callerCheckpoint } =
		checkpoint;
	return callerCheckpoint;
}

function compactPreopenRecord(record) {
	return {
		subject_key: record?.subject_key,
		instrument_key: record?.instrument_key,
		name: record?.name,
		group: record?.group,
		holding_status: record?.holding_status,
		previous_close_pct_change: record?.previous_close_pct_change,
		action_gates: Array.isArray(record?.action_gates)
			? record.action_gates.map((gate) => ({
					action_gate_id: gate?.action_gate_id,
					original_condition: gate?.original_condition,
				}))
			: [],
	};
}

function compactPreviousRecord(record) {
	return {
		subject_key: record?.subject_key,
		instrument_key: record?.instrument_key,
		name: record?.name,
		group: record?.group,
		holding_status: record?.holding_status,
		price: record?.price,
		pct_change: record?.pct_change,
		market_data_time: record?.market_data_time,
		gate_status: record?.gate_status,
	};
}

function compactCheckpoint(checkpoint) {
	if (!checkpoint) return null;
	const payload = checkpoint.payload ?? {};
	const premarket = payload.observation_type === "PREMARKET";
	return {
		comment_id: checkpoint.comment_id,
		created_at: checkpoint.created_at,
		payload: {
			schema_version: payload.schema_version,
			prompt_id: payload.prompt_id,
			production_ref: payload.production_ref,
			portfolio_version: payload.portfolio_version,
			event_id: payload.event_id,
			idempotency_key: payload.idempotency_key,
			trading_date: payload.trading_date,
			as_of: payload.as_of,
			scheduled_slot: payload.scheduled_slot,
			observation_type: payload.observation_type,
			previous_checkpoint_comment_id: payload.previous_checkpoint_comment_id,
			preopen_comment_id: payload.preopen_comment_id,
			live_universe_hash: payload.live_universe_hash,
			records: Array.isArray(payload.records)
				? payload.records.map(premarket ? compactPreopenRecord : compactPreviousRecord)
				: [],
		},
	};
}

function checkpointSummary(checkpoint) {
	if (!checkpoint) return null;
	return {
		comment_id: checkpoint.comment_id,
		created_at: checkpoint.created_at,
		payload: {
			trading_date: checkpoint.payload?.trading_date,
			scheduled_slot: checkpoint.payload?.scheduled_slot,
			idempotency_key: checkpoint.payload?.idempotency_key,
			production_ref: checkpoint.payload?.production_ref,
			live_universe_hash: checkpoint.payload?.live_universe_hash,
		},
	};
}

function compactGetState(state) {
	const currentDaySlots = Array.isArray(state?.current_day_checkpoints)
		? state.current_day_checkpoints.map((checkpoint) => ({
				scheduled_slot: checkpoint?.payload?.scheduled_slot ?? null,
				comment_id: checkpoint?.comment_id ?? null,
				created_at: checkpoint?.created_at ?? null,
				idempotency_key: checkpoint?.payload?.idempotency_key ?? null,
				live_universe_hash: checkpoint?.payload?.live_universe_hash ?? null,
			}))
		: [];

	return {
		status: state?.status,
		trading_date: state?.trading_date,
		scheduled_slot: state?.scheduled_slot,
		preopen: compactCheckpoint(state?.preopen),
		previous_checkpoint: compactCheckpoint(state?.previous_checkpoint),
		previous_close: checkpointSummary(state?.previous_close),
		current_slot: checkpointSummary(state?.current_slot),
		current_day_slots: currentDaySlots,
		conflicts: Array.isArray(state?.conflicts) ? state.conflicts : [],
	};
}

export async function runMarketLedgerCli(argv, overrides = {}) {
	const deps = {
		tokenProvider: githubTokenFromGh,
		readStdin: () => readFileSync(0, "utf8"),
		writeStdout: (text) => process.stdout.write(text + "\n"),
		writeStderr: (text) => process.stderr.write(text + "\n"),
		getMarketCheckpoints,
		appendMarketCheckpoint,
		...overrides,
	};
	try {
		const [command, ...args] = argv;
		if (command !== "get" && command !== "append") {
			throw validationError("command must be get or append");
		}
		if (command === "get") {
			const input = parseGetArgs(args);
			const token = await deps.tokenProvider();
			const state = await deps.getMarketCheckpoints({ token, ...input });
			deps.writeStdout(JSON.stringify(compactGetState(state)));
			return 0;
		}

		if (args.length !== 0) throw validationError("append accepts checkpoint JSON via stdin only");
		const raw = await deps.readStdin();
		let checkpoint;
		try {
			checkpoint = JSON.parse(raw);
		} catch {
			throw validationError("stdin is not valid checkpoint JSON");
		}
		checkpoint = sanitizeAppendCheckpoint(checkpoint);
		const token = await deps.tokenProvider();
		const result = await deps.appendMarketCheckpoint({ token, checkpoint });
		deps.writeStdout(JSON.stringify(result));
		return 0;
	} catch (error) {
		deps.writeStderr(JSON.stringify(safeErrorPayload(error)));
		return 1;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	process.exitCode = await runMarketLedgerCli(process.argv.slice(2));
}
