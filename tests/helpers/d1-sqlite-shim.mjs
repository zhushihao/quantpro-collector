/**
 * D1-shaped thin shim over `node:sqlite` (Node 24 builtin) for adversarial
 * SQL-semantics tests of the research work queue (#5 research-backend design
 * §6 test-stack convention).
 *
 * Unlike the pattern-matching FakeD1 used by the ingest-face tests, this shim
 * executes the REAL migration DDL (0001-0007) and the REAL production SQL —
 * conditional upserts (`ON CONFLICT ... WHERE`), partial unique indexes
 * (`research_proposals_one_formal`), and batches — so database-level
 * guarantees are proven, not assumed.
 *
 * Surface mapped (subset used by src/research-workflow.ts, the read adapter,
 * and the replica storage):
 *   - db.prepare(sql).bind(...params) -> { run, first, all }
 *   - run()   -> { meta: { changes } }
 *   - first() -> row object | null
 *   - all()   -> { results: rows }
 *   - db.batch([statements]) — atomic (BEGIN/COMMIT, ROLLBACK on error)
 *
 * `createSharedPair()` returns two independent shim views over one underlying
 * sqlite connection: interleaved awaits reproduce the two-client claim race
 * deterministically (both SELECT before either INSERT; the conditional upsert
 * is the final arbiter, exactly as under D1 write serialization).
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const MIGRATION_PREFIXES = [
	"0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009",
	"0010", "0011", "0012", "0013", "0014", "0015", "0016", "0017", "0018",
];

/** The frozen migration chain, concatenated in order. */
function loadMigrationSql() {
	const files = readdirSync(MIGRATIONS_DIR).sort();
	return MIGRATION_PREFIXES.map((prefix) => {
		const name = files.find((file) => file.startsWith(prefix) && file.endsWith(".sql"));
		if (!name) throw new Error(`missing migration ${prefix}`);
		return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
	});
}

function toRows(cursor) {
	const rows = [];
	for (const row of cursor) {
		const plain = {};
		for (const key of Object.keys(row)) plain[key] = row[key];
		rows.push(plain);
	}
	return rows;
}

class ShimStatement {
	constructor(sqlite, sql) {
		this.sqlite = sqlite;
		this.sql = sql;
		this.params = [];
	}

	bind(...params) {
		this.params = params;
		return this;
	}

	execBound() {
		const isRead = /^\s*(select|with|pragma|explain)/i.test(this.sql);
		const info = this.sqlite.prepare(this.sql).run(...this.params);
		const changes = Number(info.changes ?? 0);
		return {
			meta: isRead
				? { changes, rows_read: 1, rows_written: 0 }
				: { changes, rows_read: 1, rows_written: changes },
		};
	}

	execAll() {
		const rows = toRows(this.sqlite.prepare(this.sql).iterate(...this.params));
		// Real D1 reports usage metadata on every result; the guarded adapter
		// bills against it, so the shim must carry the same shape.
		const isRead = /^\s*(select|with|pragma|explain)/i.test(this.sql);
		const meta = isRead
			? { rows_read: rows.length, rows_written: 0 }
			: { rows_read: 0, rows_written: Number(this.sqlite.prepare(this.sql).run(...this.params).changes ?? 0) };
		return { results: rows, meta };
	}

	async run() {
		const { meta } = this.execAll();
		const info = this.sqlite.prepare(this.sql).run(...this.params);
		return { meta: { ...meta, changes: Number(info.changes ?? 0) } };
	}

	async first() {
		const rows = toRows(this.sqlite.prepare(this.sql).iterate(...this.params));
		return rows.length > 0 ? rows[0] : null;
	}

	async all() {
		return this.execAll();
	}
}

class ShimDatabase {
	constructor(sqlite) {
		this.sqlite = sqlite;
	}

	prepare(sql) {
		return new ShimStatement(this.sqlite, sql);
	}

	async batch(statements) {
		this.sqlite.exec("BEGIN");
		try {
			const results = statements.map((statement) => statement.execBound());
			this.sqlite.exec("COMMIT");
			return results;
		} catch (error) {
			this.sqlite.exec("ROLLBACK");
			throw error;
		}
	}
}

/** Apply the frozen migration chain to a fresh in-memory database. */
export function createResearchWorkflowDb() {
	const sqlite = new DatabaseSync(":memory:");
	for (const sql of loadMigrationSql()) sqlite.exec(sql);
	return new ShimDatabase(sqlite);
}

/**
 * Two D1-shaped views over one sqlite connection plus a dispose hook: the
 * deterministic two-client interleaving used by the concurrent-claim test
 * (B1).  A fresh temporary directory holds the database file; dispose() must
 * be called after the test.
 */
export function createSharedPair() {
	const dir = mkdtempSync("research-workflow-shim-");
	const sqlite = new DatabaseSync(join(dir, "db.sqlite3"));
	for (const sql of loadMigrationSql()) sqlite.exec(sql);
	let disposed = false;
	return {
		connections: [new ShimDatabase(sqlite), new ShimDatabase(sqlite)],
		dispose() {
			if (disposed) return;
			disposed = true;
			sqlite.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
