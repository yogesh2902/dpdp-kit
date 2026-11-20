// Store and data access on SQLite: node:sqlite, better-sqlite3, libsql/Turso, or any function that
// runs a statement. Timestamps are ISO 8601 text in UTC and JSON is text, so everything reads back
// exactly as it was written.
import type { AccessEntry, AccessFilter, AccessLogStore } from "./access.js";
import type { Breach, BreachNotice, BreachStore, NoticeCounts } from "./breach.js";
import type { ErasedValue } from "./config.js";
import { columnValue, type DataAccess } from "./data-access.js";
import { DPDP_DDL } from "./ddl.js";
import { SeqConflictError } from "./errors.js";
import type { NoticeStore, PrivacyNotice } from "./notice.js";
import type { Schema } from "./schema-check.js";
import {
  ACCESS_COLUMNS,
  ACCESS_WHERE,
  batchSize,
  insertSql,
  plainRow,
  positional,
  RUNNABLE,
  updateSql,
  accessFromRow,
  accessValues,
  BREACH_COLUMNS,
  breachValues,
  type Columns,
  defined,
  EVENT_COLUMNS,
  eventFromRow,
  eventValues,
  isUniqueViolation,
  iso,
  json,
  NOTICE_COLUMNS,
  noticeFromRow,
  num,
  REQUEST_COLUMNS,
  requestFromRow,
  requestValues,
  type Row,
  TASK_COLUMNS,
  taskFromRow,
  taskValues,
} from "./sql-rows.js";
import { type StatsStore, statsFromRows, taskCountsFromRows } from "./stats.js";
import type { DpdpStore } from "./store.js";

/**
 * dpdp-kit's tables for SQLite: the same tables as `DPDP_DDL`, with timestamps and JSON as text.
 * Run it once (`db.exec(SQLITE_DDL)`); every statement is `IF NOT EXISTS`.
 */
export const SQLITE_DDL = DPDP_DDL.replace(/\bjsonb\b/g, "text").replace(/\btimestamptz\b/g, "text");

/** Runs one statement with `?` placeholders and resolves with its rows (none for a statement without `RETURNING`). */
export type SqliteQuery = (sql: string, params: readonly unknown[]) => Promise<Row[]>;

/** node:sqlite's `DatabaseSync` and better-sqlite3's `Database`. */
interface PreparesStatements {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown; reader?: boolean };
}
/** libsql / Turso's `Client`. */
interface ExecutesStatements {
  execute(stmt: { sql: string; args: unknown[] }): Promise<{ rows: ArrayLike<unknown>; columns: readonly string[] }>;
}
export type SqliteDatabase = PreparesStatements | ExecutesStatements | SqliteQuery;

/** SQLite takes no booleans or `undefined`: 1/0 and NULL. */
const param = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v);

/** A query function for whichever SQLite driver `db` is. */
export function sqliteQuery(db: SqliteDatabase): SqliteQuery {
  if (typeof db === "function") return db;
  if ("execute" in db && typeof db.execute === "function") {
    return async (sql, params) => {
      const result = await db.execute({ sql, args: params.map(param) });
      return Array.from(result.rows as ArrayLike<Record<number, unknown>>, (r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]])));
    };
  }
  if ("prepare" in db && typeof db.prepare === "function") {
    return async (sql, params) => {
      const stmt = db.prepare(sql);
      const values = params.map(param);
      // better-sqlite3 refuses all() on a statement that returns nothing; node:sqlite returns [].
      if (stmt.reader === false) {
        stmt.run(...values);
        return [];
      }
      return stmt.all(...values) as Row[];
    };
  }
  throw new TypeError("sqliteStore: pass a node:sqlite DatabaseSync, a better-sqlite3 Database, a libsql Client, or a query function");
}


/** Timestamps compared as text must all be ISO 8601 in UTC. */
const ts = (v: string | undefined | null) => (v === undefined || v === null ? null : new Date(v).toISOString());

const select = (cols: Columns) => cols.map(([c]) => c).join(", ");


const accessParams = (f: AccessFilter) => [f.subjectId ?? null, f.actor ?? null, f.purpose ?? null, ts(f.from), ts(f.to)];

const KIND = `CASE WHEN action IN ('grant', 'withdraw') THEN 'consent' ELSE 'objection' END`;

/**
 * Store on SQLite: consent events, rights requests, erasure tasks, the access log, breaches and
 * saved notices. Create the tables with `SQLITE_DDL`.
 *
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * const db = new DatabaseSync("app.db");
 * db.exec(SQLITE_DDL);
 * const store = sqliteStore(db);
 * ```
 *
 * One process writes at a time, as SQLite does; with several servers, use Turso (libsql) or Postgres.
 */
export function sqliteStore(db: SqliteDatabase): DpdpStore & AccessLogStore & BreachStore & NoticeStore & StatsStore {
  const raw = sqliteQuery(db);
  const query = (sql: string, params: readonly unknown[] = []) => raw(...positional(sql, params));

  async function insertMany<T>(table: string, cols: Columns, items: readonly T[], values: (item: T) => unknown[], suffix = "") {
    const results: Row[] = [];
    const size = batchSize(cols);
    for (let i = 0; i < items.length; i += size) {
      const batch = items.slice(i, i + size);
      results.push(...(await query(`${insertSql(table, cols, batch.length)}${suffix}`, batch.flatMap(values))));
    }
    return results;
  }
  const savedNotice = (r: Row) => ({ notice: json<PrivacyNotice>(r.content), firstShownAt: iso(r.first_shown_at)! });

  return {
    async consentStats(from, to) {
      const period = [ts(from), ts(to)];
      const [totals, actions, byPurpose, now] = await Promise.all([
        query(`SELECT count(*) AS events, count(DISTINCT subject_id) AS people FROM dpdp_consent_events WHERE at >= $1 AND at < $2`, period),
        query(`SELECT action, count(*) AS n FROM dpdp_consent_events WHERE at >= $1 AND at < $2 GROUP BY action`, period),
        query(
          `SELECT action, p.value AS purpose, count(*) AS n FROM dpdp_consent_events, json_each(dpdp_consent_events.purposes) AS p
           WHERE at >= $1 AND at < $2 GROUP BY action, p.value`,
          period,
        ),
        query(
          `SELECT kind, purpose, count(*) AS n FROM (
             SELECT action, p.value AS purpose, ${KIND} AS kind,
               row_number() OVER (PARTITION BY subject_id, p.value, ${KIND} ORDER BY seq DESC) AS latest
             FROM dpdp_consent_events, json_each(dpdp_consent_events.purposes) AS p
           ) WHERE latest = 1 AND action IN ('grant', 'object') GROUP BY kind, purpose`,
        ),
      ]);
      return statsFromRows(from, to, totals[0], actions, byPurpose, now);
    },
    async taskCounts(now) {
      return taskCountsFromRows(
        await query(
          `SELECT status, count(*) AS n, sum(CASE WHEN status IN ('pending', 'failed') AND due_at < $1 THEN 1 ELSE 0 END) AS late
           FROM dpdp_erasure_tasks GROUP BY status`,
          [ts(now)],
        ),
      );
    },

    async savePrivacyNotice(n, at) {
      const rows = await query(
        `INSERT INTO dpdp_privacy_notices (version, language, kind, content, first_shown_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (version, language, kind) DO NOTHING RETURNING 1 AS one`,
        [n.version, n.language, n.kind, JSON.stringify(n), ts(at)],
      );
      return rows.length > 0;
    },
    async getPrivacyNotice(version, language, kind) {
      const [row] = await query(`SELECT content, first_shown_at FROM dpdp_privacy_notices WHERE version = $1 AND language = $2 AND kind = $3`, [
        version,
        language,
        kind,
      ]);
      return row ? savedNotice(row) : undefined;
    },
    async listPrivacyNotices() {
      return (await query(`SELECT content, first_shown_at FROM dpdp_privacy_notices ORDER BY first_shown_at, version, language, kind`)).map(savedNotice);
    },

    async lastEvent(subjectId) {
      const [row] = await query(`SELECT ${select(EVENT_COLUMNS)} FROM dpdp_consent_events WHERE subject_id = $1 ORDER BY seq DESC LIMIT 1`, [subjectId]);
      return row ? eventFromRow(row) : undefined;
    },
    async insert(e) {
      try {
        await query(insertSql("dpdp_consent_events", EVENT_COLUMNS), eventValues(e));
      } catch (err) {
        if (isUniqueViolation(err)) throw new SeqConflictError(e.subjectId, e.seq);
        throw err;
      }
    },
    async events(subjectId) {
      return (await query(`SELECT ${select(EVENT_COLUMNS)} FROM dpdp_consent_events WHERE subject_id = $1 ORDER BY seq ASC`, [subjectId])).map(eventFromRow);
    },

    async insertRequest(r) {
      await query(insertSql("dpdp_requests", REQUEST_COLUMNS), requestValues(r));
    },
    async getRequest(id) {
      const [row] = await query(`SELECT ${select(REQUEST_COLUMNS)} FROM dpdp_requests WHERE id = $1`, [id]);
      return row ? requestFromRow(row) : undefined;
    },
    async updateRequest(r) {
      await query(updateSql("dpdp_requests", REQUEST_COLUMNS), requestValues(r));
    },
    async listRequests(filter) {
      const rows = await query(
        `SELECT ${select(REQUEST_COLUMNS)} FROM dpdp_requests WHERE ($1 IS NULL OR subject_id = $1) AND ($2 IS NULL OR status = $2) ORDER BY opened_at ASC`,
        [filter.subjectId ?? null, filter.status ?? null],
      );
      return rows.map(requestFromRow);
    },

    async insertTasks(tasks) {
      await insertMany("dpdp_erasure_tasks", TASK_COLUMNS, tasks, taskValues);
    },
    async dueTasks({ limit, now, staleBefore, maxAttempts }) {
      const rows = await query(`SELECT ${select(TASK_COLUMNS)} FROM dpdp_erasure_tasks WHERE ${RUNNABLE} ORDER BY due_at ASC LIMIT $4`, [
        ts(now),
        ts(staleBefore),
        maxAttempts,
        limit,
      ]);
      return rows.map(taskFromRow);
    },
    async claimTask({ id, now, staleBefore, maxAttempts }) {
      // One statement: the check and the claim can't be split by another runner.
      const rows = await query(`UPDATE dpdp_erasure_tasks SET status = 'running', claimed_at = $1 WHERE id = $4 AND ${RUNNABLE} RETURNING id`, [
        ts(now),
        ts(staleBefore),
        maxAttempts,
        id,
      ]);
      return rows.length === 1;
    },
    async updateTask(t) {
      await query(updateSql("dpdp_erasure_tasks", TASK_COLUMNS), taskValues(t));
    },
    async getTask(id) {
      const [row] = await query(`SELECT ${select(TASK_COLUMNS)} FROM dpdp_erasure_tasks WHERE id = $1`, [id]);
      return row ? taskFromRow(row) : undefined;
    },
    async listTasks(filter) {
      const rows = await query(
        `SELECT ${select(TASK_COLUMNS)} FROM dpdp_erasure_tasks WHERE ($1 IS NULL OR subject_id = $1) AND ($2 IS NULL OR status = $2) ORDER BY due_at ASC`,
        [filter.subjectId ?? null, filter.status ?? null],
      );
      return rows.map(taskFromRow);
    },

    async insertAccess(entries) {
      await insertMany("dpdp_access_log", ACCESS_COLUMNS, entries, accessValues);
    },
    async listAccess(f) {
      // LIMIT -1 is no limit in SQLite.
      const rows = await query(`SELECT ${select(ACCESS_COLUMNS)} FROM dpdp_access_log WHERE ${ACCESS_WHERE} ORDER BY at ASC, id ASC LIMIT $6`, [
        ...accessParams(f),
        f.limit ?? -1,
      ]);
      return rows.map(accessFromRow);
    },
    async accessSubjects(f) {
      return (await query(`SELECT DISTINCT subject_id FROM dpdp_access_log WHERE ${ACCESS_WHERE}`, accessParams(f))).map((r) => String(r.subject_id));
    },
    async pruneAccess(before) {
      let total = 0;
      for (;;) {
        const rows = await query(`DELETE FROM dpdp_access_log WHERE id IN (SELECT id FROM dpdp_access_log WHERE at < $1 LIMIT 5000) RETURNING 1 AS one`, [ts(before)]);
        total += rows.length;
        if (rows.length < 5000) return total;
      }
    },

    async insertBreach(b) {
      await query(insertSql("dpdp_breaches", BREACH_COLUMNS), breachValues(b));
    },
    async getBreach(id) {
      const [row] = await query(`SELECT data FROM dpdp_breaches WHERE id = $1`, [id]);
      return row ? json<Breach>(row.data) : undefined;
    },
    async updateBreach(b) {
      // Only if no one saved it since it was read: each change adds one history entry.
      const rows = await query(`${updateSql("dpdp_breaches", BREACH_COLUMNS)} AND json_array_length(data, '$.history') = $${BREACH_COLUMNS.length + 1} RETURNING 1 AS one`, [
        ...breachValues(b),
        b.history.length - 1,
      ]);
      return rows.length === 1;
    },
    async listBreaches(filter) {
      const rows = await query(`SELECT data FROM dpdp_breaches WHERE ($1 IS NULL OR status = $1) ORDER BY aware_at DESC`, [filter.status ?? null]);
      return rows.map((r) => json<Breach>(r.data));
    },
    async addNotices(list) {
      const values = (n: BreachNotice) => [n.breachId, n.subjectId, n.status, n.addedAt, n.sentAt ?? null, n.channel ?? null];
      const rows = await insertMany("dpdp_breach_notices", NOTICE_COLUMNS, list, values, " ON CONFLICT (breach_id, subject_id) DO NOTHING RETURNING 1 AS one");
      return rows.length;
    },
    async markNotices(breachId, subjectIds, sentAt, channel) {
      let changed = 0;
      for (let i = 0; i < subjectIds.length; i += 1000) {
        const rows = await query(
          `UPDATE dpdp_breach_notices SET status = 'sent', sent_at = $2, channel = $3
           WHERE breach_id = $1 AND status = 'pending' AND subject_id IN (SELECT value FROM json_each($4)) RETURNING 1 AS one`,
          [breachId, ts(sentAt), channel ?? null, JSON.stringify(subjectIds.slice(i, i + 1000))],
        );
        changed += rows.length;
      }
      return changed;
    },
    async listNotices(breachId, filter) {
      const rows = await query(
        `SELECT ${select(NOTICE_COLUMNS)} FROM dpdp_breach_notices WHERE breach_id = $1 AND ($2 IS NULL OR status = $2)
         ORDER BY added_at ASC, subject_id ASC LIMIT $3`,
        [breachId, filter.status ?? null, filter.limit ?? -1],
      );
      return rows.map(noticeFromRow);
    },
    async countNotices(breachId) {
      const [r] = await query(
        `SELECT count(*) AS total, sum(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent, min(sent_at) AS first, max(sent_at) AS last
         FROM dpdp_breach_notices WHERE breach_id = $1`,
        [breachId],
      );
      return defined<NoticeCounts>({ total: num(r?.total), sent: num(r?.sent), firstSentAt: iso(r?.first), lastSentAt: iso(r?.last) });
    },
  };
}

/** Quote a table or column name for SQLite. */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;


/**
 * Data access for your own SQLite tables, for access summaries, erasure and corrections. Pass a
 * `schema` (from `drizzleSchema()` or `prismaSchema()`) when the data map uses names from code
 * (`userId`) rather than the database's (`user_id`).
 */
export function sqliteData(db: SqliteDatabase, options: { schema?: Schema } = {}): DataAccess {
  const raw = sqliteQuery(db);
  const query = (sql: string, params: readonly unknown[]) => raw(...positional(sql, params));
  const tables = new Map<string, { name: string; columns: Map<string, string> }>();
  for (const table of options.schema?.tables ?? []) {
    const entry = { name: table.name, columns: new Map(table.columns.flatMap((c) => [[c.key ?? c.name, c.name] as const, [c.name, c.name] as const])) };
    if (!tables.has(table.name)) tables.set(table.name, entry);
    if (table.key && !tables.has(table.key)) tables.set(table.key, entry);
  }
  const from = (table: string) => ident(tables.get(table)?.name ?? table);
  const col = (table: string, name: string) => ident(tables.get(table)?.columns.get(name) ?? name);
  const where = (table: string, subjectColumn: string) => `${col(table, subjectColumn)} = $1`;

  return {
    async read(table, subjectColumn, subjectId, columns) {
      if (columns.length === 0) return [];
      const list = columns.map((c) => `${col(table, c)} AS ${ident(c)}`).join(", ");
      return (await query(`SELECT ${list} FROM ${from(table)} WHERE ${where(table, subjectColumn)}`, [subjectId])).map(plainRow);
    },
    async eraseFields(table, subjectColumn, subjectId, columns, values: Readonly<Record<string, ErasedValue>> = {}) {
      if (columns.length === 0) return 0;
      const params: unknown[] = [subjectId];
      const set = columns
        .map((c) => {
          if (!Object.hasOwn(values, c) || values[c] === null) return `${col(table, c)} = NULL`;
          params.push(values[c]);
          return `${col(table, c)} = $${params.length}`;
        })
        .join(", ");
      return (await query(`UPDATE ${from(table)} SET ${set} WHERE ${where(table, subjectColumn)} RETURNING 1 AS one`, params)).length;
    },
    async updateFields(table, subjectColumn, subjectId, values, only = {}) {
      const entries = Object.entries(values);
      if (entries.length === 0) return 0;
      const params: unknown[] = [subjectId];
      const set = entries
        .map(([c, v]) => {
          if (v === null || v === undefined) return `${col(table, c)} = NULL`;
          params.push(columnValue(v)); // SQLite has no arrays or JSON type: objects and arrays as JSON text
          return `${col(table, c)} = $${params.length}`;
        })
        .join(", ");
      const narrow = Object.entries(only).map(([c, v]) => {
        params.push(v);
        return ` AND ${col(table, c)} = $${params.length}`;
      });
      return (await query(`UPDATE ${from(table)} SET ${set} WHERE ${where(table, subjectColumn)}${narrow.join("")} RETURNING 1 AS one`, params)).length;
    },
    async deleteRows(table, subjectColumn, subjectId) {
      return (await query(`DELETE FROM ${from(table)} WHERE ${where(table, subjectColumn)} RETURNING 1 AS one`, [subjectId])).length;
    },
  };
}
