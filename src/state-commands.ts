import { z } from "zod";

import {
	getMarketCheckpoints,
	MARKET_LEDGER_SLOT_SCHEMA,
	type MarketLedgerSlot,
} from "./market-ledger.ts";
import { appendStateBatch, StateGatewayError } from "./state-gateway.ts";
import type { StateWriteChannel } from "./state-receipts.ts";

const EVIDENCE_TYPES = ["D", "S", "M", "E", "P", "C"] as const;
const EVIDENCE_TYPE_SCHEMA = z.enum(EVIDENCE_TYPES);
const EVENT_TYPE_SCHEMA = z.enum([
	"STATE_SET",
	"STATE_CHANGE",
	"COUNTER_EVIDENCE",
	"CONFIRMATION",
	"EVIDENCE_ADD",
	"EVIDENCE_UPDATE",
	"CORRECTION",
]);
const OPTIONAL_TEXT = z.union([z.string().max(16000), z.null()]).optional();
const RUN_ID_SCHEMA = z.string().min(1).max(192).optional();
const AS_OF_SCHEMA = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => !Number.isNaN(Date.parse(value)), "as_of must be a valid ISO date-time");

function commandValidationSummary(error: z.ZodError): string {
	return error.issues
		.slice(0, 8)
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
			return `${path}:${issue.code}`;
		})
		.join("; ");
}

function parseCommand<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new StateGatewayError({
			code: "STATE_VALIDATION_FAILED",
			phase: "VALIDATE",
			message: `${label} does not match the owned command schema: ${commandValidationSummary(parsed.error)}`,
			retryable: false,
		});
	}
	return parsed.data;
}

const COMMON_EVENT_SHAPE = {
	symbol: z.string().regex(/^(?:CN:\\d{6}|HK:\\d{5})$/),
	event_type: EVENT_TYPE_SCHEMA,
	evidence_types: z.array(EVIDENCE_TYPE_SCHEMA).max(6),
	evidence_keys: z.array(z.string().min(1).max(512)).max(100),
	counter_evidence: z.array(z.string().min(1).max(4000)).max(20),
	confidence: z.number().min(0).max(1),
	next_validation: z.union([z.string().max(8000), z.null()]),
} as const;

export const COMPANY_EVENT_COMMAND_SCHEMA = z
	.object({
		...COMMON_EVENT_SHAPE,
		company_thesis: OPTIONAL_TEXT,
		company_validation: OPTIONAL_TEXT,
		r_proposal: z.union([z.literal("R2"), z.null()]).optional(),
	})
	.catchall(z.unknown());

export const INDUSTRY_EVENT_COMMAND_SCHEMA = z
	.object({
		...COMMON_EVENT_SHAPE,
		research_priority: z.union([z.enum(["P0", "P1", "P2"]), z.null()]).optional(),
		industry_thesis: OPTIONAL_TEXT,
		r_proposal: z.union([z.enum(["R0", "R1"]), z.null()]).optional(),
	})
	.catchall(z.unknown());

export const CLOSE_EVENT_COMMAND_SCHEMA = z
	.object({
		...COMMON_EVENT_SHAPE,
		effective_r_state: z
			.union([z.enum(["R0", "R1", "R2", "R3", "R4"]), z.null()])
			.optional(),
		market_confirmation: OPTIONAL_TEXT,
		r4_candidate: z.union([z.boolean(), z.null()]).optional(),
		close_thesis_view: OPTIONAL_TEXT,
	})
	.catchall(z.unknown());

function investmentCommandSchema(eventSchema: z.ZodTypeAny) {
	return z
		.object({
			as_of: AS_OF_SCHEMA,
			events: z.array(eventSchema).min(1).max(128),
			run_id: RUN_ID_SCHEMA,
		})
		.catchall(z.unknown());
}

export const APPEND_COMPANY_EVENTS_INPUT_SCHEMA = investmentCommandSchema(
	COMPANY_EVENT_COMMAND_SCHEMA,
);
export const APPEND_INDUSTRY_EVENTS_INPUT_SCHEMA = investmentCommandSchema(
	INDUSTRY_EVENT_COMMAND_SCHEMA,
);
export const APPEND_CLOSE_EVENTS_INPUT_SCHEMA = investmentCommandSchema(
	CLOSE_EVENT_COMMAND_SCHEMA,
);

export const APPEND_MARKET_OBSERVATION_INPUT_SCHEMA = z
	.object({
		trading_date: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
		as_of: AS_OF_SCHEMA,
		scheduled_slot: MARKET_LEDGER_SLOT_SCHEMA,
		production_ref: z.string().regex(/^[0-9a-f]{40}$/i),
		records: z.array(z.record(z.string().min(1), z.unknown())).max(512),
		run_id: RUN_ID_SCHEMA,
	})
	.catchall(z.unknown());

type InvestmentCommandChannel = Exclude<StateWriteChannel, "MARKET">;

const PRODUCER_BY_CHANNEL: Record<InvestmentCommandChannel, string> = {
	INDUSTRY: "industry_trend",
	COMPANY: "company_validation",
	CLOSE: "close_review",
};

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(object)
				.sort()
				.map((key) => [key, canonicalize(object[key])]),
		);
	}
	return value;
}

async function sha256Hex(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function normalizeEvidenceTypes(values: Array<(typeof EVIDENCE_TYPES)[number]>) {
	const seen = new Set(values);
	return EVIDENCE_TYPES.filter((value) => seen.has(value));
}

function normalizeEvidenceKeys(values: string[]) {
	return [...new Set(values)].sort();
}

type CommonOwnedEvent = {
	symbol: string;
	event_type: z.infer<typeof EVENT_TYPE_SCHEMA>;
	evidence_types: Array<(typeof EVIDENCE_TYPES)[number]>;
	evidence_keys: string[];
	counter_evidence: string[];
	confidence: number;
	next_validation: string | null;
};

function commonEvent(event: CommonOwnedEvent): Record<string, unknown> {
	return {
		symbol: event.symbol,
		event_type: event.event_type,
		evidence_types: normalizeEvidenceTypes(event.evidence_types),
		evidence_keys: normalizeEvidenceKeys(event.evidence_keys),
		counter_evidence: [...event.counter_evidence],
		confidence: event.confidence,
		next_validation: event.next_validation,
	};
}

function projectCompanyEvent(
	event: z.infer<typeof COMPANY_EVENT_COMMAND_SCHEMA>,
): Record<string, unknown> {
	return {
		...commonEvent(event),
		...(event.company_thesis === undefined ? {} : { company_thesis: event.company_thesis }),
		...(event.company_validation === undefined
			? {}
			: { company_validation: event.company_validation }),
		...(event.r_proposal === undefined ? {} : { r_proposal: event.r_proposal }),
	};
}

function projectIndustryEvent(
	event: z.infer<typeof INDUSTRY_EVENT_COMMAND_SCHEMA>,
): Record<string, unknown> {
	return {
		...commonEvent(event),
		...(event.research_priority === undefined
			? {}
			: { research_priority: event.research_priority }),
		...(event.industry_thesis === undefined ? {} : { industry_thesis: event.industry_thesis }),
		...(event.r_proposal === undefined ? {} : { r_proposal: event.r_proposal }),
	};
}

function projectCloseEvent(
	event: z.infer<typeof CLOSE_EVENT_COMMAND_SCHEMA>,
): Record<string, unknown> {
	return {
		...commonEvent(event),
		...(event.effective_r_state === undefined
			? {}
			: { effective_r_state: event.effective_r_state }),
		...(event.market_confirmation === undefined
			? {}
			: { market_confirmation: event.market_confirmation }),
		...(event.r4_candidate === undefined ? {} : { r4_candidate: event.r4_candidate }),
		...(event.close_thesis_view === undefined
			? {}
			: { close_thesis_view: event.close_thesis_view }),
	};
}

function schemaForChannel(channel: InvestmentCommandChannel) {
	if (channel === "COMPANY") return APPEND_COMPANY_EVENTS_INPUT_SCHEMA;
	if (channel === "INDUSTRY") return APPEND_INDUSTRY_EVENTS_INPUT_SCHEMA;
	return APPEND_CLOSE_EVENTS_INPUT_SCHEMA;
}

function projectEvents(channel: InvestmentCommandChannel, events: unknown[]) {
	if (channel === "COMPANY") {
		return events.map((event) =>
			projectCompanyEvent(parseCommand(COMPANY_EVENT_COMMAND_SCHEMA, event, "COMPANY event")),
		);
	}
	if (channel === "INDUSTRY") {
		return events.map((event) =>
			projectIndustryEvent(parseCommand(INDUSTRY_EVENT_COMMAND_SCHEMA, event, "INDUSTRY event")),
		);
	}
	return events.map((event) =>
		projectCloseEvent(parseCommand(CLOSE_EVENT_COMMAND_SCHEMA, event, "CLOSE event")),
	);
}

export async function buildInvestmentCommandBatch(input: {
	channel: InvestmentCommandChannel;
	command: unknown;
	portfolioVersion: string;
}): Promise<{
	batch: Record<string, unknown>;
	writeKey: string;
	payloadSha256: string;
	runId: string | null;
}> {
	const parsed = parseCommand(
		schemaForChannel(input.channel),
		input.command,
		input.channel,
	) as {
		as_of: string;
		events: unknown[];
		run_id?: string | null;
	};
	const events = projectEvents(input.channel, parsed.events);
	const normalizedCommand = {
		contract: "owned-state-command-v1",
		channel: input.channel,
		as_of: parsed.as_of,
		events,
	};
	const digest = await sha256Hex(normalizedCommand);
	const producer = PRODUCER_BY_CHANNEL[input.channel];
	return {
		batch: {
			schema_version: "investment_state_batch_v1",
			portfolio_version: input.portfolioVersion,
			event_id: `CMD:${digest}|${producer}|BATCH`,
			as_of: parsed.as_of,
			events,
		},
		writeKey: `CMD:${input.channel}:${digest}`,
		payloadSha256: digest,
		runId: parsed.run_id ?? null,
	};
}

export async function appendInvestmentCommand(input: {
	db: D1Database;
	token: string;
	channel: InvestmentCommandChannel;
	command: unknown;
	portfolioVersion: string;
	fetchImpl?: typeof fetch;
	now?: string;
	requestId?: string;
}) {
	const prepared = await buildInvestmentCommandBatch({
		channel: input.channel,
		command: input.command,
		portfolioVersion: input.portfolioVersion,
	});
	const result = await appendStateBatch({
		db: input.db,
		token: input.token,
		channel: input.channel,
		batch: prepared.batch,
		fetchImpl: input.fetchImpl,
		now: input.now,
		requestId: input.requestId,
		writeKey: prepared.writeKey,
		payloadSha256: prepared.payloadSha256,
	});
	return { ...result, run_id: prepared.runId };
}

function marketObservationType(slot: MarketLedgerSlot): "PREMARKET" | "INTRADAY" | "CLOSE" {
	if (slot === "09:10") return "PREMARKET";
	if (slot === "16:45") return "CLOSE";
	return "INTRADAY";
}

function marketEventId(tradingDate: string, slot: MarketLedgerSlot): string {
	const date = tradingDate.replaceAll("-", "");
	const clock = slot.replace(":", "");
	return `${date}T${clock}00+08|holding-assistant|BATCH`;
}

export async function buildMarketObservationBatch(input: {
	token: string;
	command: unknown;
	portfolioVersion: string;
	liveUniverseHash: string;
	fetchImpl?: typeof fetch;
}): Promise<{ batch: Record<string, unknown>; runId: string | null }> {
	const parsed = parseCommand(
		APPEND_MARKET_OBSERVATION_INPUT_SCHEMA,
		input.command,
		"MARKET observation",
	);
	const state = await getMarketCheckpoints({
		token: input.token,
		tradingDate: parsed.trading_date,
		scheduledSlot: parsed.scheduled_slot,
		fetchImpl: input.fetchImpl,
	});
	if (state.status === "CHECKPOINT_CONFLICT") {
		throw new StateGatewayError({
			code: "STATE_CONFLICT",
			phase: "VALIDATE",
			message: "market ledger already contains duplicate checkpoint keys",
		});
	}
	const premarket = parsed.scheduled_slot === "09:10";
	return {
		batch: {
			schema_version: premarket ? "premarket_plan_batch_v1" : "market_observation_batch_v1",
			prompt_id: "holding-assistant",
			production_ref: parsed.production_ref,
			portfolio_version: input.portfolioVersion,
			event_id: marketEventId(parsed.trading_date, parsed.scheduled_slot),
			idempotency_key: `holding-assistant:${parsed.trading_date}:${parsed.scheduled_slot}`,
			trading_date: parsed.trading_date,
			as_of: parsed.as_of,
			scheduled_slot: parsed.scheduled_slot,
			producer: "holding-assistant",
			observation_type: marketObservationType(parsed.scheduled_slot),
			previous_checkpoint_comment_id: premarket
				? null
				: state.previous_checkpoint?.comment_id ?? null,
			preopen_comment_id: premarket ? null : state.preopen?.comment_id ?? null,
			live_universe_hash: input.liveUniverseHash,
			source_task: "持仓助手",
			records: parsed.records,
		},
		runId: parsed.run_id ?? null,
	};
}

export async function appendMarketObservation(input: {
	db: D1Database;
	token: string;
	command: unknown;
	portfolioVersion: string;
	liveUniverseHash: string;
	fetchImpl?: typeof fetch;
	now?: string;
	requestId?: string;
}) {
	const prepared = await buildMarketObservationBatch({
		token: input.token,
		command: input.command,
		portfolioVersion: input.portfolioVersion,
		liveUniverseHash: input.liveUniverseHash,
		fetchImpl: input.fetchImpl,
	});
	const result = await appendStateBatch({
		db: input.db,
		token: input.token,
		channel: "MARKET",
		batch: prepared.batch,
		fetchImpl: input.fetchImpl,
		now: input.now,
		requestId: input.requestId,
	});
	return { ...result, run_id: prepared.runId };
}
