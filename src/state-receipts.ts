export const STATE_WRITE_CHANNELS = ["MARKET", "INDUSTRY", "COMPANY", "CLOSE"] as const;
export type StateWriteChannel = (typeof STATE_WRITE_CHANNELS)[number];

export const STATE_RECEIPT_STATUSES = [
	"PENDING",
	"PERSISTED",
	"IDEMPOTENT_REPLAY",
	"OUTCOME_UNKNOWN",
	"CONFLICT",
	"FAILED",
] as const;
export type StateReceiptStatus = (typeof STATE_RECEIPT_STATUSES)[number];

export type StateWriteReceipt = {
	write_key: string;
	channel: StateWriteChannel;
	payload_sha256: string;
	status: StateReceiptStatus;
	comment_id: string | null;
	comment_url: string | null;
	attempt_count: number;
	lease_owner: string | null;
	lease_until: string | null;
	created_at: string;
	updated_at: string;
	last_error_code: string | null;
	last_error_phase: string | null;
	last_http_status: number | null;
};

const TABLE = "state_write_receipts_v1";
const readyByDb = new WeakMap<object, Promise<void>>();

function ensureReceiptTable(db: D1Database): Promise<void> {
	const existing = readyByDb.get(db as object);
	if (existing) return existing;
	const ready = db
		.prepare(
			`CREATE TABLE IF NOT EXISTS ${TABLE} (
				write_key TEXT PRIMARY KEY NOT NULL,
				channel TEXT NOT NULL,
				payload_sha256 TEXT NOT NULL,
				status TEXT NOT NULL,
				comment_id TEXT,
				comment_url TEXT,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				lease_owner TEXT,
				lease_until TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_error_code TEXT,
				last_error_phase TEXT,
				last_http_status INTEGER
			) WITHOUT ROWID`,
		)
		.run()
		.then(() => undefined);
	readyByDb.set(db as object, ready);
	return ready;
}

async function receiptTableExists(db: D1Database): Promise<boolean> {
	const row = await db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?1")
		.bind(TABLE)
		.first<Record<string, unknown>>();
	return row?.name === TABLE;
}

function normalizeReceipt(row: Record<string, unknown> | null): StateWriteReceipt | null {
	if (!row) return null;
	return {
		write_key: String(row.write_key ?? ""),
		channel: String(row.channel ?? "") as StateWriteChannel,
		payload_sha256: String(row.payload_sha256 ?? ""),
		status: String(row.status ?? "") as StateReceiptStatus,
		comment_id: row.comment_id == null ? null : String(row.comment_id),
		comment_url: row.comment_url == null ? null : String(row.comment_url),
		attempt_count: Number(row.attempt_count ?? 0),
		lease_owner: row.lease_owner == null ? null : String(row.lease_owner),
		lease_until: row.lease_until == null ? null : String(row.lease_until),
		created_at: String(row.created_at ?? ""),
		updated_at: String(row.updated_at ?? ""),
		last_error_code: row.last_error_code == null ? null : String(row.last_error_code),
		last_error_phase: row.last_error_phase == null ? null : String(row.last_error_phase),
		last_http_status: row.last_http_status == null ? null : Number(row.last_http_status),
	};
}

export async function getStateWriteReceipt(
	db: D1Database,
	writeKey: string,
): Promise<StateWriteReceipt | null> {
	if (!(await receiptTableExists(db))) return null;
	const row = await db
		.prepare(`SELECT * FROM ${TABLE} WHERE write_key = ?1`)
		.bind(writeKey)
		.first<Record<string, unknown>>();
	return normalizeReceipt(row);
}

export async function getStateWriteReceiptSummary(db: D1Database): Promise<{
	last_successful_state_write_at: string | null;
	last_failed_state_write_at: string | null;
}> {
	if (!(await receiptTableExists(db))) {
		return {
			last_successful_state_write_at: null,
			last_failed_state_write_at: null,
		};
	}
	const row = await db
		.prepare(
			`SELECT
				MAX(CASE WHEN status IN ('PERSISTED','IDEMPOTENT_REPLAY') THEN updated_at END)
					AS last_successful_state_write_at,
				MAX(CASE WHEN status IN ('OUTCOME_UNKNOWN','CONFLICT','FAILED') THEN updated_at END)
					AS last_failed_state_write_at
			FROM ${TABLE}`,
		)
		.first<Record<string, unknown>>();
	return {
		last_successful_state_write_at:
			row?.last_successful_state_write_at == null
				? null
				: String(row.last_successful_state_write_at),
		last_failed_state_write_at:
			row?.last_failed_state_write_at == null ? null : String(row.last_failed_state_write_at),
	};
}

export async function reserveStateWrite(input: {
	db: D1Database;
	writeKey: string;
	channel: StateWriteChannel;
	payloadSha256: string;
	requestId: string;
	now: string;
	leaseSeconds?: number;
}): Promise<{ acquired: boolean; receipt: StateWriteReceipt }> {
	await ensureReceiptTable(input.db);
	await input.db
		.prepare(
			`INSERT OR IGNORE INTO ${TABLE}
			(write_key, channel, payload_sha256, status, attempt_count, created_at, updated_at)
			VALUES (?1, ?2, ?3, 'PENDING', 0, ?4, ?4)`,
		)
		.bind(input.writeKey, input.channel, input.payloadSha256, input.now)
		.run();

	let receipt = await getStateWriteReceipt(input.db, input.writeKey);
	if (!receipt) throw new Error("state receipt insert/read failed");
	if (receipt.payload_sha256 !== input.payloadSha256 || receipt.channel !== input.channel) {
		return { acquired: false, receipt: { ...receipt, status: "CONFLICT" } };
	}
	if (receipt.status === "PERSISTED" || receipt.status === "IDEMPOTENT_REPLAY") {
		return { acquired: false, receipt };
	}

	const nowMs = Date.parse(input.now);
	const leaseUntil = new Date(
		nowMs + Math.max(30, Math.min(600, input.leaseSeconds ?? 120)) * 1000,
	).toISOString();
	await input.db
		.prepare(
			`UPDATE ${TABLE}
			SET status='PENDING',
				attempt_count=attempt_count+1,
				lease_owner=?2,
				lease_until=?3,
				updated_at=?4
			WHERE write_key=?1
				AND payload_sha256=?5
				AND channel=?6
				AND status NOT IN ('PERSISTED','IDEMPOTENT_REPLAY','CONFLICT')
				AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until < ?4 OR lease_owner=?2)`,
		)
		.bind(
			input.writeKey,
			input.requestId,
			leaseUntil,
			input.now,
			input.payloadSha256,
			input.channel,
		)
		.run();

	receipt = await getStateWriteReceipt(input.db, input.writeKey);
	if (!receipt) throw new Error("state receipt reservation read failed");
	return { acquired: receipt.lease_owner === input.requestId, receipt };
}

export async function finalizeStateWriteReceipt(input: {
	db: D1Database;
	writeKey: string;
	requestId: string;
	status: StateReceiptStatus;
	updatedAt: string;
	commentId?: string | null;
	commentUrl?: string | null;
	lastErrorCode?: string | null;
	lastErrorPhase?: string | null;
	lastHttpStatus?: number | null;
}): Promise<StateWriteReceipt> {
	await ensureReceiptTable(input.db);
	await input.db
		.prepare(
			`UPDATE ${TABLE}
			SET status=?3,
				comment_id=?4,
				comment_url=?5,
				lease_owner=NULL,
				lease_until=NULL,
				updated_at=?6,
				last_error_code=?7,
				last_error_phase=?8,
				last_http_status=?9
			WHERE write_key=?1 AND lease_owner=?2`,
		)
		.bind(
			input.writeKey,
			input.requestId,
			input.status,
			input.commentId ?? null,
			input.commentUrl ?? null,
			input.updatedAt,
			input.lastErrorCode ?? null,
			input.lastErrorPhase ?? null,
			input.lastHttpStatus ?? null,
		)
		.run();
	const receipt = await getStateWriteReceipt(input.db, input.writeKey);
	if (!receipt) throw new Error("state receipt finalize read failed");
	return receipt;
}
