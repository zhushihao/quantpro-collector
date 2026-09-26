import { z } from "zod";

import {
	appendInvestmentLedgerBatch,
	getInvestmentLedgerState,
	INVESTMENT_LEDGER_BATCH_INPUT_SCHEMA,
	InvestmentLedgerError,
	type InvestmentLedgerBatchInput,
	type InvestmentLedgerRole,
	validateRoleSemantics,
} from "./investment-ledger.ts";
import {
	appendMarketCheckpoint,
	getMarketCheckpoints,
	MARKET_CHECKPOINT_INPUT_SCHEMA,
	MarketLedgerError,
	type MarketLedgerSlot,
	validateCheckpointRelations,
} from "./market-ledger.ts";
import {
	finalizeStateWriteReceipt,
	getStateWriteReceipt,
	getStateWriteReceiptSummary,
	reserveStateWrite,
	STATE_WRITE_CHANNELS,
	type StateWriteChannel,
	type StateWriteReceipt,
} from "./state-receipts.ts";

export const STATE_GATEWAY_VERSION = "1.0.0";
export const STATE_GATEWAY_CONTRACT_VERSION = "state-gateway-v1";
export const STATE_CHANNEL_SCHEMA = z.enum(STATE_WRITE_CHANNELS);

export type StateGatewayPhase = "AUTH" | "VALIDATE" | "READ" | "RECONCILE" | "WRITE" | "READBACK";

export type StateGatewayErrorCode =
	| "STATE_FORBIDDEN"
	| "STATE_VALIDATION_FAILED"
	| "STATE_CONFLICT"
	| "STATE_CHAIN_MISMATCH"
	| "STATE_UNAVAILABLE"
	| "STATE_OUTCOME_UNKNOWN"
	| "STATE_READBACK_FAILED";

export class StateGatewayError extends Error {
	readonly code: StateGatewayErrorCode;
	readonly phase: StateGatewayPhase;
	readonly retryable: boolean;
	readonly requestId: string;
	readonly httpStatus: number | null;

	constructor(input: {
		code: StateGatewayErrorCode;
		phase: StateGatewayPhase;
		message: string;
		retryable?: boolean;
		requestId?: string;
		httpStatus?: number | null;
	}) {
		super(input.message);
		this.name = "StateGatewayError";
		this.code = input.code;
		this.phase = input.phase;
		this.retryable = input.retryable ?? false;
		this.requestId = input.requestId ?? crypto.randomUUID().replaceAll("-", "");
		this.httpStatus = input.httpStatus ?? null;
	}
}

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
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validationSummary(error: z.ZodError): string {
	return error.issues
		.slice(0, 10)
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
			const keys = issue.code === "unrecognized_keys" ? ` keys=${issue.keys.join(",")}` : "";
			return `${path}:${issue.code}${keys}`;
		})
		.join("; ");
}

function roleForChannel(channel: StateWriteChannel): InvestmentLedgerRole | null {
	if (channel === "INDUSTRY") return "industry";
	if (channel === "COMPANY") return "company";
	if (channel === "CLOSE") return "close";
	return null;
}

function mapDomainError(error: unknown, requestId: string): StateGatewayError {
	if (error instanceof StateGatewayError) return error;
	if (error instanceof MarketLedgerError) {
		if (error.code === "CHECKPOINT_CONFLICT") {
			return new StateGatewayError({
				code: "STATE_CONFLICT",
				phase: "VALIDATE",
				message: error.message,
				requestId,
			});
		}
		if (error.code === "CHECKPOINT_CHAIN_MISMATCH") {
			return new StateGatewayError({
				code: "STATE_CHAIN_MISMATCH",
				phase: "VALIDATE",
				message: error.message,
				requestId,
			});
		}
		if (error.code === "CHECKPOINT_VALIDATION_FAILED") {
			return new StateGatewayError({
				code: "STATE_VALIDATION_FAILED",
				phase: "VALIDATE",
				message: error.message,
				requestId,
			});
		}
		if (error.code === "CHECKPOINT_READBACK_FAILED") {
			return new StateGatewayError({
				code: "STATE_READBACK_FAILED",
				phase: "READBACK",
				message: error.message,
				retryable: true,
				requestId,
				httpStatus: error.httpStatus,
			});
		}
		const httpStatus = error.httpStatus ?? null;
		return new StateGatewayError({
			code: "STATE_OUTCOME_UNKNOWN",
			phase: "WRITE",
			message: error.message,
			retryable: httpStatus !== 401 && httpStatus !== 403,
			requestId,
			httpStatus,
		});
	}
	if (error instanceof InvestmentLedgerError) {
		if (error.code === "INVESTMENT_LEDGER_VALIDATION_FAILED") {
			return new StateGatewayError({
				code: "STATE_VALIDATION_FAILED",
				phase: "VALIDATE",
				message: error.message,
				requestId,
			});
		}
		if (error.code === "INVESTMENT_LEDGER_EVENT_ID_CONFLICT") {
			return new StateGatewayError({
				code: "STATE_CONFLICT",
				phase: "VALIDATE",
				message: error.message,
				requestId,
			});
		}
		if (error.code === "INVESTMENT_LEDGER_READBACK_FAILED") {
			return new StateGatewayError({
				code: "STATE_READBACK_FAILED",
				phase: "READBACK",
				message: error.message,
				retryable: true,
				requestId,
				httpStatus: error.httpStatus,
			});
		}
		return new StateGatewayError({
			code: "STATE_OUTCOME_UNKNOWN",
			phase: "WRITE",
			message: error.message,
			retryable: error.httpStatus !== 401 && error.httpStatus !== 403,
			requestId,
			httpStatus: error.httpStatus,
		});
	}
	return new StateGatewayError({
		code: "STATE_UNAVAILABLE",
		phase: "WRITE",
		message: "state gateway operation failed",
		retryable: true,
		requestId,
	});
}

export type ValidatedStateBatch = {
	status: "VALID";
	channel: StateWriteChannel;
	write_key: string;
	payload_sha256: string;
	schema_version: string;
	normalized_batch: unknown;
};

export async function validateStateBatch(
	channel: StateWriteChannel,
	batch: unknown,
): Promise<ValidatedStateBatch> {
	if (channel === "MARKET") {
		const parsed = MARKET_CHECKPOINT_INPUT_SCHEMA.safeParse(batch);
		if (!parsed.success) {
			throw new StateGatewayError({
				code: "STATE_VALIDATION_FAILED",
				phase: "VALIDATE",
				message: `market batch does not match exact schema: ${validationSummary(parsed.error)}`,
			});
		}
		validateCheckpointRelations(parsed.data);
		if (
			parsed.data.prompt_id !== "holding-assistant" ||
			parsed.data.producer !== "holding-assistant" ||
			parsed.data.source_task !== "持仓助手"
		) {
			throw new StateGatewayError({
				code: "STATE_VALIDATION_FAILED",
				phase: "VALIDATE",
				message: "MARKET profile identity fields do not match the fixed producer contract",
			});
		}
		return {
			status: "VALID",
			channel,
			write_key: parsed.data.idempotency_key,
			payload_sha256: await sha256Hex(parsed.data),
			schema_version: parsed.data.schema_version,
			normalized_batch: parsed.data,
		};
	}

	const role = roleForChannel(channel);
	if (!role) {
		throw new StateGatewayError({
			code: "STATE_VALIDATION_FAILED",
			phase: "VALIDATE",
			message: "unsupported state channel",
		});
	}
	const parsed = INVESTMENT_LEDGER_BATCH_INPUT_SCHEMA.safeParse(batch);
	if (!parsed.success) {
		throw new StateGatewayError({
			code: "STATE_VALIDATION_FAILED",
			phase: "VALIDATE",
			message: `investment batch does not match exact schema: ${validationSummary(parsed.error)}`,
		});
	}
	validateRoleSemantics(role, parsed.data);
	return {
		status: "VALID",
		channel,
		write_key: parsed.data.event_id,
		payload_sha256: await sha256Hex(parsed.data),
		schema_version: parsed.data.schema_version,
		normalized_batch: parsed.data,
	};
}

function marketRecordCanonicalSymbol(record: Record<string, unknown>): string | null {
	if (typeof record.symbol === "string" && /^(?:CN:\d{6}|HK:\d{5})$/.test(record.symbol)) {
		return record.symbol;
	}
	const raw =
		typeof record.subject_key === "string"
			? record.subject_key
			: typeof record.instrument_key === "string"
				? record.instrument_key
				: null;
	if (!raw) return null;
	if (/^(?:CN:\d{6}|HK:\d{5})$/.test(raw)) return raw;
	const cn = raw.match(/^(\d{6})\.(?:SZ|SH)$/i);
	if (cn) return `CN:${cn[1]}`;
	const hk = raw.match(/^(\d{1,5})\.HK$/i);
	if (hk) return `HK:${hk[1].padStart(5, "0")}`;
	return null;
}

function marketRecordHasSustainedConfirmation(record: Record<string, unknown>): boolean {
	const continuous = record.continuous_market_structure;
	if (
		continuous &&
		typeof continuous === "object" &&
		!Array.isArray(continuous) &&
		(continuous as Record<string, unknown>).status === "CONFIRMED"
	) {
		return true;
	}
	return record.r4_candidate === true;
}

function checkpointHasConfirmedSymbol(
	records: Array<Record<string, unknown>>,
	symbol: string,
): boolean {
	return records.some(
		(record) =>
			marketRecordCanonicalSymbol(record) === symbol &&
			marketRecordHasSustainedConfirmation(record),
	);
}

async function validateCloseDependencies(input: {
	token: string;
	batch: InvestmentLedgerBatchInput;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	const industryEvents = input.batch.events.filter((event) => event.effective_r_state === "R1");
	if (industryEvents.length > 0) {
		const symbols = [...new Set(industryEvents.map((event) => event.symbol))];
		const industry = await getInvestmentLedgerState({
			token: input.token,
			role: "industry",
			symbols,
			fetchImpl: input.fetchImpl,
		});
		for (const event of industryEvents) {
			if (industry.latest_by_symbol[event.symbol]?.event.r_proposal !== "R1") {
				throw new StateGatewayError({
					code: "STATE_CHAIN_MISMATCH",
					phase: "VALIDATE",
					message: `CLOSE R1 for ${event.symbol} requires an existing INDUSTRY R1`,
				});
			}
		}
	}

	const companyEvents = input.batch.events.filter(
		(event) =>
			event.effective_r_state === "R2" ||
			event.effective_r_state === "R3" ||
			event.effective_r_state === "R4" ||
			event.r4_candidate === true,
	);
	if (companyEvents.length > 0) {
		const symbols = [...new Set(companyEvents.map((event) => event.symbol))];
		const company = await getInvestmentLedgerState({
			token: input.token,
			role: "company",
			symbols,
			fetchImpl: input.fetchImpl,
		});
		for (const event of companyEvents) {
			if (company.latest_by_symbol[event.symbol]?.event.r_proposal !== "R2") {
				throw new StateGatewayError({
					code: "STATE_CHAIN_MISMATCH",
					phase: "VALIDATE",
					message: `CLOSE state for ${event.symbol} requires an existing COMPANY R2`,
				});
			}
		}
	}

	const marketEvents = input.batch.events.filter(
		(event) => event.effective_r_state === "R4" || event.r4_candidate === true,
	);
	if (marketEvents.length === 0) return;
	const tradingDate = input.batch.as_of.slice(0, 10);
	const market = await getMarketCheckpoints({
		token: input.token,
		tradingDate,
		scheduledSlot: "16:45",
		fetchImpl: input.fetchImpl,
	});
	if (!market.current_slot || market.current_slot.payload.observation_type !== "CLOSE") {
		throw new StateGatewayError({
			code: "STATE_CHAIN_MISMATCH",
			phase: "VALIDATE",
			message: "R4 candidate/confirmation requires the same-day MARKET close checkpoint",
		});
	}
	for (const event of marketEvents) {
		if (!checkpointHasConfirmedSymbol(market.current_slot.payload.records, event.symbol)) {
			throw new StateGatewayError({
				code: "STATE_CHAIN_MISMATCH",
				phase: "VALIDATE",
				message: `R4 candidate/confirmation for ${event.symbol} requires same-day sustained MARKET confirmation`,
			});
		}
		if (event.effective_r_state !== "R4") continue;
		if (
			!market.previous_close ||
			!checkpointHasConfirmedSymbol(market.previous_close.payload.records, event.symbol)
		) {
			throw new StateGatewayError({
				code: "STATE_CHAIN_MISMATCH",
				phase: "VALIDATE",
				message: `formal R4 for ${event.symbol} requires sustained MARKET confirmation across two closes`,
			});
		}
	}
}

export async function getStateSnapshot(input: {
	token: string;
	symbols: string[];
	include: StateWriteChannel[];
	tradingDate?: string;
	scheduledSlot?: MarketLedgerSlot;
	historyLimit?: number;
	fetchImpl?: typeof fetch;
}): Promise<{
	status: "OK";
	fully_paginated: true;
	channels: Record<string, unknown>;
}> {
	const invalidSymbol = input.symbols.find(
		(symbol) => !/^(?:CN:[0-9]{6}|HK:[0-9]{5})$/.test(symbol),
	);
	if (invalidSymbol) {
		throw new StateGatewayError({
			code: "STATE_VALIDATION_FAILED",
			phase: "VALIDATE",
			message: `invalid state symbol: ${invalidSymbol}`,
		});
	}
	if (input.tradingDate && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.tradingDate)) {
		throw new StateGatewayError({
			code: "STATE_VALIDATION_FAILED",
			phase: "VALIDATE",
			message: "trading_date must use YYYY-MM-DD",
		});
	}
	if (!input.token) {
		throw new StateGatewayError({
			code: "STATE_UNAVAILABLE",
			phase: "READ",
			message: "GitHub ledger credential is not configured",
		});
	}
	const channels: Record<string, unknown> = {};
	for (const channel of [...new Set(input.include)]) {
		if (channel === "MARKET") {
			if (!input.tradingDate || !input.scheduledSlot) {
				throw new StateGatewayError({
					code: "STATE_VALIDATION_FAILED",
					phase: "VALIDATE",
					message: "MARKET snapshot requires trading_date and scheduled_slot",
				});
			}
			channels.MARKET = await getMarketCheckpoints({
				token: input.token,
				tradingDate: input.tradingDate,
				scheduledSlot: input.scheduledSlot,
				fetchImpl: input.fetchImpl,
			});
			continue;
		}
		const role = roleForChannel(channel);
		if (!role) continue;
		channels[channel] = await getInvestmentLedgerState({
			token: input.token,
			role,
			symbols: input.symbols,
			historyLimit: input.historyLimit,
			fetchImpl: input.fetchImpl,
		});
	}
	return { status: "OK", fully_paginated: true, channels };
}

export async function appendStateBatch(input: {
	db: D1Database;
	token: string;
	channel: StateWriteChannel;
	batch: unknown;
	fetchImpl?: typeof fetch;
	now?: string;
	requestId?: string;
}): Promise<{
	status: "PERSISTED" | "IDEMPOTENT_REPLAY";
	persisted: true;
	channel: StateWriteChannel;
	write_key: string;
	payload_sha256: string;
	comment_id: string;
	url: string;
	receipt: StateWriteReceipt;
}> {
	const requestId = input.requestId ?? crypto.randomUUID().replaceAll("-", "");
	const now = input.now ?? new Date().toISOString();
	let validated: ValidatedStateBatch;
	try {
		validated = await validateStateBatch(input.channel, input.batch);
		if (input.channel === "CLOSE") {
			await validateCloseDependencies({
				token: input.token,
				batch: validated.normalized_batch as InvestmentLedgerBatchInput,
				fetchImpl: input.fetchImpl,
			});
		}
	} catch (error) {
		throw mapDomainError(error, requestId);
	}

	const reservation = await reserveStateWrite({
		db: input.db,
		writeKey: validated.write_key,
		channel: input.channel,
		payloadSha256: validated.payload_sha256,
		requestId,
		now,
	});
	if (reservation.receipt.status === "CONFLICT") {
		throw new StateGatewayError({
			code: "STATE_CONFLICT",
			phase: "RECONCILE",
			message: "write_key already exists with different channel or payload",
			requestId,
		});
	}
	if (!reservation.acquired) {
		if (
			reservation.receipt.status === "PERSISTED" ||
			reservation.receipt.status === "IDEMPOTENT_REPLAY"
		) {
			return {
				status: "IDEMPOTENT_REPLAY",
				persisted: true,
				channel: input.channel,
				write_key: validated.write_key,
				payload_sha256: validated.payload_sha256,
				comment_id: reservation.receipt.comment_id ?? "",
				url: reservation.receipt.comment_url ?? "",
				receipt: reservation.receipt,
			};
		}
		throw new StateGatewayError({
			code: "STATE_UNAVAILABLE",
			phase: "RECONCILE",
			message: "state write is already in progress",
			retryable: true,
			requestId,
		});
	}

	try {
		const result =
			input.channel === "MARKET"
				? await appendMarketCheckpoint({
						token: input.token,
						checkpoint: validated.normalized_batch as z.infer<
							typeof MARKET_CHECKPOINT_INPUT_SCHEMA
						>,
						fetchImpl: input.fetchImpl,
					})
				: await appendInvestmentLedgerBatch({
						token: input.token,
						role: roleForChannel(input.channel)!,
						batch: validated.normalized_batch,
						fetchImpl: input.fetchImpl,
					});
		const receipt = await finalizeStateWriteReceipt({
			db: input.db,
			writeKey: validated.write_key,
			requestId,
			status: result.status,
			updatedAt: new Date().toISOString(),
			commentId: result.comment_id,
			commentUrl: result.url,
		});
		return {
			status: result.status,
			persisted: true,
			channel: input.channel,
			write_key: validated.write_key,
			payload_sha256: validated.payload_sha256,
			comment_id: result.comment_id,
			url: result.url,
			receipt,
		};
	} catch (error) {
		const mapped = mapDomainError(error, requestId);
		await finalizeStateWriteReceipt({
			db: input.db,
			writeKey: validated.write_key,
			requestId,
			status:
				mapped.code === "STATE_CONFLICT"
					? "CONFLICT"
					: mapped.code === "STATE_OUTCOME_UNKNOWN" ||
						  mapped.code === "STATE_READBACK_FAILED"
						? "OUTCOME_UNKNOWN"
						: "FAILED",
			updatedAt: new Date().toISOString(),
			lastErrorCode: mapped.code,
			lastErrorPhase: mapped.phase,
			lastHttpStatus: mapped.httpStatus,
		});
		throw mapped;
	}
}

async function issueReadable(
	token: string,
	issue: number,
	fetchImpl: typeof fetch,
): Promise<boolean> {
	try {
		const response = await fetchImpl(
			`https://api.github.com/repos/zhushihao/quantpro-collector/issues/${issue}`,
			{
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "quantpro-collector/state-gateway",
				},
			},
		);
		return response.ok;
	} catch {
		return false;
	}
}

export async function getGatewayStatus(input: {
	token: string | null | undefined;
	effectiveScopes: ReadonlySet<string>;
	principalVerified: boolean;
	deployedGitSha?: string | null;
	cloudflareVersionId?: string | null;
	cloudflareVersionTimestamp?: string | null;
	serviceVersion?: string;
	db?: D1Database;
	fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const token = input.token ?? "";
	const [issue2Readable, issue3Readable] = token
		? await Promise.all([
				issueReadable(token, 2, fetchImpl),
				issueReadable(token, 3, fetchImpl),
			])
		: [false, false];
	const receiptSummary = input.db
		? await getStateWriteReceiptSummary(input.db)
		: { last_successful_state_write_at: null, last_failed_state_write_at: null };
	return {
		status: "OK",
		service_version: input.serviceVersion ?? null,
		service_build_sha: input.deployedGitSha ?? null,
		cloudflare_version_id: input.cloudflareVersionId ?? null,
		cloudflare_version_timestamp: input.cloudflareVersionTimestamp ?? null,
		state_gateway_version: STATE_GATEWAY_VERSION,
		mcp_contract_version: STATE_GATEWAY_CONTRACT_VERSION,
		registered_tools: [
			"get_state_snapshot",
			"read_state_snapshot",
			"validate_state_batch",
			"append_state_batch",
			"get_state_write_receipt",
			"get_gateway_status",
			"get_market_checkpoints",
			"append_market_checkpoint",
		],
		supported_channels: [...STATE_WRITE_CHANNELS],
		supported_schema_versions: [
			"premarket_plan_batch_v1",
			"market_observation_batch_v1",
			"investment_state_batch_v1",
		],
		effective_scopes: [...input.effectiveScopes].sort(),
		principal_verified: input.principalVerified,
		github_ledger_configured: Boolean(token),
		...receiptSummary,
		issue2_readable: issue2Readable,
		issue3_readable: issue3Readable,
	};
}

export { getStateWriteReceipt };
