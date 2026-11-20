// Store and data access on MySQL 8 (and MariaDB 10.6+ with JSON_TABLE): mysql2, Prisma's raw
// queries, or any function that runs a statement. Timestamps are DATETIME(3) in UTC, written and
// read as text so no driver or session time zone can shift them.
import type { AccessEntry, AccessFilter, AccessLogStore } from "./access.js";
import type { Breach, BreachNotice, BreachStore, NoticeCounts } from "./breach.js";
import type { ErasedValue } from "./config.js";
import { columnValue, type DataAccess } from "./data-access.js";
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
 * dpdp-kit's tables for MySQL 8 (InnoDB, utf8mb4): the same tables as `DPDP_DDL`, with JSON
 * columns and DATETIME(3) timestamps in UTC. Run each statement once; all are `IF NOT EXISTS`.
 * mysql2 runs several statements at once only with `multipleStatements: true`; otherwise split on `;`.
 */
export const MYSQL_DDL = `CREATE TABLE IF NOT EXISTS dpdp_consent_events (
  subject_id varchar(255) NOT NULL,
  seq int NOT NULL,
  action varchar(32) NOT NULL,
  purposes json NOT NULL,
  notice_version varchar(255),
  language varchar(8),
  channel varchar(255),
  evidence json,
  at datetime(3) NOT NULL,
  prev_hash varchar(128),
  hash varchar(128) NOT NULL,
  PRIMARY KEY (subject_id, seq),
  CONSTRAINT dpdp_consent_events_action_check CHECK (action IN ('grant', 'withdraw', 'object', 'lift-objection'))
);
CREATE TABLE IF NOT EXISTS dpdp_requests (
  id varchar(255) PRIMARY KEY,
  subject_id varchar(255) NOT NULL,
  type varchar(32) NOT NULL,
  status varchar(32) NOT NULL,
  opened_at datetime(3) NOT NULL,
  due_at datetime(3) NOT NULL,
  closed_at datetime(3),
  details json,
  history json NOT NULL,
  INDEX dpdp_requests_subject_idx (subject_id),
  INDEX dpdp_requests_status_due_idx (status, due_at)
);
CREATE TABLE IF NOT EXISTS dpdp_erasure_tasks (
  id varchar(255) PRIMARY KEY,
  subject_id varchar(255) NOT NULL,
  reason varchar(32) NOT NULL,
  kind varchar(32) NOT NULL,
  table_key varchar(255),
  fields json,
  processor varchar(255),
  purposes json,
  created_at datetime(3) NOT NULL,
  due_at datetime(3) NOT NULL,
  status varchar(32) NOT NULL,
  attempts int NOT NULL,
  claimed_at datetime(3),
  done_at datetime(3),
  affected int,
  last_error text,
  note text,
  INDEX dpdp_erasure_tasks_subject_idx (subject_id),
  INDEX dpdp_erasure_tasks_status_due_idx (status, due_at)
);
CREATE TABLE IF NOT EXISTS dpdp_access_log (
  id varchar(255) PRIMARY KEY,
  at datetime(3) NOT NULL,
  actor varchar(255) NOT NULL,
  subject_id varchar(255) NOT NULL,
  action varchar(64) NOT NULL,
  purpose varchar(255) NOT NULL,
  fields json,
  out_of_purpose json,
  reason text,
  evidence json,
  INDEX dpdp_access_log_at_idx (at),
  INDEX dpdp_access_log_subject_idx (subject_id, at),
  INDEX dpdp_access_log_actor_idx (actor, at)
);
CREATE TABLE IF NOT EXISTS dpdp_breaches (
  id varchar(255) PRIMARY KEY,
  status varchar(32) NOT NULL,
  aware_at datetime(3) NOT NULL,
  report_due_at datetime(3) NOT NULL,
  data json NOT NULL,
  INDEX dpdp_breaches_status_idx (status, aware_at)
);
CREATE TABLE IF NOT EXISTS dpdp_breach_notices (
  breach_id varchar(255) NOT NULL,
  subject_id varchar(255) NOT NULL,
  status varchar(32) NOT NULL,
  added_at datetime(3) NOT NULL,
  sent_at datetime(3),
  channel varchar(255),
  PRIMARY KEY (breach_id, subject_id),
  INDEX dpdp_breach_notices_status_idx (breach_id, status, added_at)
);
CREATE TABLE IF NOT EXISTS dpdp_privacy_notices (
  version varchar(255) NOT NULL,
  language varchar(8) NOT NULL,
  kind varchar(32) NOT NULL,
  content json NOT NULL,
  first_shown_at datetime(3) NOT NULL,
  PRIMARY KEY (version, language, kind)
);`;

/** What a statement answers: rows for a SELECT, or how many rows a write affected. */
export type MysqlResult = Row[] | { affectedRows: number };
/** Runs one statement with `?` placeholders. */
export type MysqlQuery = (sql: string, params: readonly unknown[]) => Promise<MysqlResult>;

/** mysql2's promise `Pool` or `Connection`: `query(sql, params)` resolves with `[rows or result, fields]`. */
interface Mysql2Like {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}
export type MysqlDatabase = Mysql2Like | MysqlQuery;

/** A query function for mysql2, or the function you pass. */
export function mysqlQuery(db: MysqlDatabase): MysqlQuery {
  if (typeof db === "function") return db;
  if (typeof db.query === "function") {
    return async (sql, params) => {
      const [result] = await db.query(sql, [...params]);
      return result as MysqlResult;
    };
  }
  throw new TypeError("mysqlStore: pass a mysql2 promise Pool or Connection, or a query function");
}

/** `2026-11-20T10:00:00.000Z` as MySQL DATETIME text in UTC. */
const dt = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString().replace("T", " ").replace("Z", ""));
/** A DATETIME column read back as ISO 8601 UTC text. */
const utc = (col: string) => `DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s.%fZ')`;


const rowsOf = (r: MysqlResult): Row[] => (Array.isArray(r) ? r : []);
const affected = (r: MysqlResult): number => (Array.isArray(r) ? r.length : num(r.affectedRows));

/** Column lists with DATETIME columns read back as UTC text. */
const select = (cols: Columns) => cols.map(([c, t]) => (t === "timestamptz" ? `${utc(c)} AS ${c}` : c)).join(", ");
/** Values in column order, with timestamps as DATETIME text. */
const asDb = (cols: Columns, values: unknown[]) => values.map((v, i) => (cols[i]![1] === "timestamptz" ? dt(v) : v));


/** MySQL's "no limit". */
const ALL = "18446744073709551615";

const accessParams = (f: AccessFilter) => [f.subjectId ?? null, f.actor ?? null, f.purpose ?? null, dt(f.from), dt(f.to)];
const PURPOSES = `JSON_TABLE(e.purposes, '$[*]' COLUMNS (purpose varchar(255) PATH '$')) AS p`;
const KIND = `CASE WHEN e.action IN ('grant', 'withdraw') THEN 'consent' ELSE 'objection' END`;

/**
 * Store on MySQL 8: consent events, rights requests, erasure tasks, the access log, breaches and
 * saved notices. Create the tables with `MYSQL_DDL`.
 *
 * ```ts
 * import mysql from "mysql2/promise";
 * const pool = mysql.createPool(process.env.DATABASE_URL);
 * const store = mysqlStore(pool);
 * ```
 *
 * With Prisma: `mysqlStore((sql, params) => /^\s*(SELECT|WITH)/i.test(sql) ? prisma.$queryRawUnsafe(sql, ...params)
 * : prisma.$executeRawUnsafe(sql, ...params).then((affectedRows) => ({ affectedRows })))`.
 */
export function mysqlStore(db: MysqlDatabase): DpdpStore & AccessLogStore & BreachStore & NoticeStore & StatsStore {
  const raw = mysqlQuery(db);
  const query = (sql: string, params: readonly unknown[] = []) => raw(...positional(sql, params));
  const rows = async (sql: string, params: readonly unknown[] = []) => rowsOf(await query(sql, params));

  async function insertMany<T>(table: string, cols: Columns, items: readonly T[], values: (item: T) => unknown[]) {
    let total = 0;
    const size = batchSize(cols);
    for (let i = 0; i < items.length; i += size) {
      const batch = items.slice(i, i + size);
      total += affected(await query(insertSql(table, cols, batch.length), batch.flatMap((item) => asDb(cols, values(item)))));
    }
    return total;
  }
  const savedNotice = (r: Row) => ({ notice: json<PrivacyNotice>(r.content), firstShownAt: iso(r.first_shown_at)! });
  /** The notices in `batch` for people not already on their breach, each person once. */
  async function notYetAdded(batch: readonly BreachNotice[]): Promise<BreachNotice[]> {
    const byBreach = new Map<string, BreachNotice[]>();
    for (const n of batch) byBreach.set(n.breachId, [...(byBreach.get(n.breachId) ?? []), n]);
    const fresh: BreachNotice[] = [];
    for (const [breachId, notices] of byBreach) {
      const ids = [...new Set(notices.map((n) => n.subjectId))];
      const placeholders = ids.map((_, k) => `$${k + 2}`).join(", ");
      const found = await rows(`SELECT subject_id FROM dpdp_breach_notices WHERE breach_id = $1 AND subject_id IN (${placeholders})`, [breachId, ...ids]);
      const skip = new Set(found.map((r) => String(r.subject_id)));
      for (const n of notices) {
        if (skip.has(n.subjectId)) continue;
        skip.add(n.subjectId);
        fresh.push(n);
      }
    }
    return fresh;
  }

  return {
    async consentStats(from, to) {
      const period = [dt(from), dt(to)];
      const [totals, actions, byPurpose, now] = await Promise.all([
        rows(`SELECT count(*) AS events, count(DISTINCT subject_id) AS people FROM dpdp_consent_events WHERE at >= $1 AND at < $2`, period),
        rows(`SELECT action, count(*) AS n FROM dpdp_consent_events WHERE at >= $1 AND at < $2 GROUP BY action`, period),
        rows(`SELECT e.action, p.purpose, count(*) AS n FROM dpdp_consent_events e, ${PURPOSES} WHERE e.at >= $1 AND e.at < $2 GROUP BY e.action, p.purpose`, period),
        rows(
          `SELECT kind, purpose, count(*) AS n FROM (
             SELECT e.action, p.purpose, ${KIND} AS kind,
               row_number() OVER (PARTITION BY e.subject_id, p.purpose, ${KIND} ORDER BY e.seq DESC) AS latest
             FROM dpdp_consent_events e, ${PURPOSES}
           ) x WHERE latest = 1 AND action IN ('grant', 'object') GROUP BY kind, purpose`,
        ),
      ]);
      return statsFromRows(from, to, totals[0], actions, byPurpose, now);
    },
    async taskCounts(now) {
      return taskCountsFromRows(
        await rows(
          `SELECT status, count(*) AS n, sum(CASE WHEN status IN ('pending', 'failed') AND due_at < $1 THEN 1 ELSE 0 END) AS late
           FROM dpdp_erasure_tasks GROUP BY status`,
          [dt(now)],
        ),
      );
    },

    async savePrivacyNotice(n, at) {
      // A plain INSERT: INSERT IGNORE would also store a too-long value cut short instead of failing.
      try {
        await query(`INSERT INTO dpdp_privacy_notices (version, language, kind, content, first_shown_at) VALUES ($1, $2, $3, $4, $5)`, [
          n.version,
          n.language,
          n.kind,
          JSON.stringify(n),
          dt(at),
        ]);
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },
    async getPrivacyNotice(version, language, kind) {
      const [row] = await rows(`SELECT content, ${utc("first_shown_at")} AS first_shown_at FROM dpdp_privacy_notices WHERE version = $1 AND language = $2 AND kind = $3`, [
        version,
        language,
        kind,
      ]);
      return row ? savedNotice(row) : undefined;
    },
    async listPrivacyNotices() {
      return (await rows(`SELECT content, ${utc("first_shown_at")} AS first_shown_at FROM dpdp_privacy_notices ORDER BY first_shown_at, version, language, kind`)).map(
        savedNotice,
      );
    },

    async lastEvent(subjectId) {
      const [row] = await rows(`SELECT ${select(EVENT_COLUMNS)} FROM dpdp_consent_events WHERE subject_id = $1 ORDER BY seq DESC LIMIT 1`, [subjectId]);
      return row ? eventFromRow(row) : undefined;
    },
    async insert(e) {
      try {
        await query(insertSql("dpdp_consent_events", EVENT_COLUMNS), asDb(EVENT_COLUMNS, eventValues(e)));
      } catch (err) {
        if (isUniqueViolation(err)) throw new SeqConflictError(e.subjectId, e.seq);
        throw err;
      }
    },
    async events(subjectId) {
      return (await rows(`SELECT ${select(EVENT_COLUMNS)} FROM dpdp_consent_events WHERE subject_id = $1 ORDER BY seq ASC`, [subjectId])).map(eventFromRow);
    },

    async insertRequest(r) {
      await query(insertSql("dpdp_requests", REQUEST_COLUMNS), asDb(REQUEST_COLUMNS, requestValues(r)));
    },
    async getRequest(id) {
      const [row] = await rows(`SELECT ${select(REQUEST_COLUMNS)} FROM dpdp_requests WHERE id = $1`, [id]);
      return row ? requestFromRow(row) : undefined;
    },
    async updateRequest(r) {
      await query(updateSql("dpdp_requests", REQUEST_COLUMNS), asDb(REQUEST_COLUMNS, requestValues(r)));
    },
    async listRequests(filter) {
      return (
        await rows(
          `SELECT ${select(REQUEST_COLUMNS)} FROM dpdp_requests WHERE ($1 IS NULL OR subject_id = $1) AND ($2 IS NULL OR status = $2) ORDER BY opened_at ASC, id ASC`,
          [filter.subjectId ?? null, filter.status ?? null],
        )
      ).map(requestFromRow);
    },

    async insertTasks(tasks) {
      await insertMany("dpdp_erasure_tasks", TASK_COLUMNS, tasks, taskValues);
    },
    async dueTasks({ limit, now, staleBefore, maxAttempts }) {
      return (
        await rows(`SELECT ${select(TASK_COLUMNS)} FROM dpdp_erasure_tasks WHERE ${RUNNABLE} ORDER BY due_at ASC, id ASC LIMIT ${Math.max(0, Math.floor(limit))}`, [
          dt(now),
          dt(staleBefore),
          maxAttempts,
        ])
      ).map(taskFromRow);
    },
    async claimTask({ id, now, staleBefore, maxAttempts }) {
      // One statement: InnoDB locks the row, and a second runner re-checks the conditions after the
      // first commits, finds the task running, and changes nothing.
      const r = await query(`UPDATE dpdp_erasure_tasks SET status = 'running', claimed_at = $1 WHERE id = $4 AND ${RUNNABLE}`, [
        dt(now),
        dt(staleBefore),
        maxAttempts,
        id,
      ]);
      return affected(r) === 1;
    },
    async updateTask(t) {
      await query(updateSql("dpdp_erasure_tasks", TASK_COLUMNS), asDb(TASK_COLUMNS, taskValues(t)));
    },
    async getTask(id) {
      const [row] = await rows(`SELECT ${select(TASK_COLUMNS)} FROM dpdp_erasure_tasks WHERE id = $1`, [id]);
      return row ? taskFromRow(row) : undefined;
    },
    async listTasks(filter) {
      return (
        await rows(
          `SELECT ${select(TASK_COLUMNS)} FROM dpdp_erasure_tasks WHERE ($1 IS NULL OR subject_id = $1) AND ($2 IS NULL OR status = $2) ORDER BY due_at ASC, id ASC`,
          [filter.subjectId ?? null, filter.status ?? null],
        )
      ).map(taskFromRow);
    },

    async insertAccess(entries) {
      await insertMany("dpdp_access_log", ACCESS_COLUMNS, entries, accessValues);
    },
    async listAccess(f) {
      const limit = f.limit === undefined ? ALL : String(Math.max(0, Math.floor(f.limit)));
      return (await rows(`SELECT ${select(ACCESS_COLUMNS)} FROM dpdp_access_log WHERE ${ACCESS_WHERE} ORDER BY at ASC, id ASC LIMIT ${limit}`, accessParams(f))).map(accessFromRow);
    },
    async accessSubjects(f) {
      return (await rows(`SELECT DISTINCT subject_id FROM dpdp_access_log WHERE ${ACCESS_WHERE}`, accessParams(f))).map((r) => String(r.subject_id));
    },
    async pruneAccess(before) {
      let total = 0;
      for (;;) {
        const n = affected(await query(`DELETE FROM dpdp_access_log WHERE at < $1 ORDER BY at LIMIT 5000`, [dt(before)]));
        total += n;
        if (n < 5000) return total;
      }
    },

    async insertBreach(b) {
      await query(insertSql("dpdp_breaches", BREACH_COLUMNS), asDb(BREACH_COLUMNS, breachValues(b)));
    },
    async getBreach(id) {
      const [row] = await rows(`SELECT data FROM dpdp_breaches WHERE id = $1`, [id]);
      return row ? json<Breach>(row.data) : undefined;
    },
    async updateBreach(b) {
      // Only if no one saved it since it was read: each change adds one history entry.
      const r = await query(`${updateSql("dpdp_breaches", BREACH_COLUMNS)} AND JSON_LENGTH(data, '$.history') = $${BREACH_COLUMNS.length + 1}`, [
        ...asDb(BREACH_COLUMNS, breachValues(b)),
        b.history.length - 1,
      ]);
      return affected(r) === 1;
    },
    async listBreaches(filter) {
      return (await rows(`SELECT data FROM dpdp_breaches WHERE ($1 IS NULL OR status = $1) ORDER BY aware_at DESC`, [filter.status ?? null])).map((r) => json<Breach>(r.data));
    },
    async addNotices(list) {
      const values = (n: BreachNotice) => [n.breachId, n.subjectId, n.status, n.addedAt, n.sentAt ?? null, n.channel ?? null];
      // People already on the breach are skipped, and the count is the new ones. Not INSERT IGNORE,
      // which would also store a too-long value cut short instead of failing.
      let added = 0;
      for (let i = 0; i < list.length; i += 1000) {
        const fresh = await notYetAdded(list.slice(i, i + 1000));
        if (fresh.length === 0) continue;
        try {
          added += await insertMany("dpdp_breach_notices", NOTICE_COLUMNS, fresh, values);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // Someone added the same people at the same moment: one at a time, skipping those.
          for (const n of fresh) {
            try {
              added += await insertMany("dpdp_breach_notices", NOTICE_COLUMNS, [n], values);
            } catch (e) {
              if (!isUniqueViolation(e)) throw e;
            }
          }
        }
      }
      return added;
    },
    async markNotices(breachId, subjectIds, sentAt, channel) {
      let changed = 0;
      for (let i = 0; i < subjectIds.length; i += 1000) {
        const ids = subjectIds.slice(i, i + 1000);
        const r = await query(
          `UPDATE dpdp_breach_notices SET status = 'sent', sent_at = $2, channel = $3
           WHERE breach_id = $1 AND status = 'pending' AND subject_id IN (${ids.map((_, k) => `$${k + 4}`).join(", ")})`,
          [breachId, dt(sentAt), channel ?? null, ...ids],
        );
        changed += affected(r);
      }
      return changed;
    },
    async listNotices(breachId, filter) {
      const limit = filter.limit === undefined ? ALL : String(Math.max(0, Math.floor(filter.limit)));
      return (
        await rows(
          `SELECT ${select(NOTICE_COLUMNS)} FROM dpdp_breach_notices WHERE breach_id = $1 AND ($2 IS NULL OR status = $2)
           ORDER BY added_at ASC, subject_id ASC LIMIT ${limit}`,
          [breachId, filter.status ?? null],
        )
      ).map(noticeFromRow);
    },
    async countNotices(breachId) {
      const [r] = await rows(
        `SELECT count(*) AS total, sum(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent, ${utc("min(sent_at)")} AS first, ${utc("max(sent_at)")} AS last
         FROM dpdp_breach_notices WHERE breach_id = $1`,
        [breachId],
      );
      return defined<NoticeCounts>({ total: num(r?.total), sent: num(r?.sent), firstSentAt: iso(r?.first), lastSentAt: iso(r?.last) });
    },
  };
}

/** Quote a table or column name for MySQL. */
const ident = (name: string) => `\`${name.replace(/`/g, "``")}\``;


/**
 * Data access for your own MySQL tables, for access summaries, erasure and corrections. Pass a
 * `schema` (from `drizzleSchema()` or `prismaSchema()`) when the data map uses names from code.
 * Date and time columns are read back as text, so the driver's time zone can't change them.
 */
export function mysqlData(db: MysqlDatabase, options: { schema?: Schema } = {}): DataAccess {
  const raw = mysqlQuery(db);
  const query = (sql: string, params: readonly unknown[]) => raw(...positional(sql, params));
  type Col = { name: string; sqlType?: string | undefined };
  const tables = new Map<string, { name: string; columns: Map<string, Col> }>();
  for (const table of options.schema?.tables ?? []) {
    const columns = new Map<string, Col>(table.columns.map((c) => [c.key ?? c.name, c]));
    for (const c of table.columns) if (!columns.has(c.name)) columns.set(c.name, c);
    const entry = { name: table.name, columns };
    if (!tables.has(table.name)) tables.set(table.name, entry);
    if (table.key && !tables.has(table.key)) tables.set(table.key, entry);
  }
  const from = (table: string) => ident(tables.get(table)?.name ?? table);
  const column = (table: string, name: string) => tables.get(table)?.columns.get(name);
  const col = (table: string, name: string) => ident(column(table, name)?.name ?? name);
  const where = (table: string, subjectColumn: string) => `${col(table, subjectColumn)} = $1`;
  /** DATETIME and TIMESTAMP columns as text, so a driver's time zone can't shift them. */
  const readable = (table: string, c: string) => (/^(datetime|timestamp)/i.test(column(table, c)?.sqlType ?? "") ? `CAST(${col(table, c)} AS CHAR)` : col(table, c));

  return {
    async read(table, subjectColumn, subjectId, columns) {
      if (columns.length === 0) return [];
      const list = columns.map((c) => `${readable(table, c)} AS ${ident(c)}`).join(", ");
      return rowsOf(await query(`SELECT ${list} FROM ${from(table)} WHERE ${where(table, subjectColumn)}`, [subjectId])).map(plainRow);
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
      return affected(await query(`UPDATE ${from(table)} SET ${set} WHERE ${where(table, subjectColumn)}`, params));
    },
    async updateFields(table, subjectColumn, subjectId, values, only = {}) {
      const entries = Object.entries(values);
      if (entries.length === 0) return 0;
      const params: unknown[] = [subjectId];
      const narrow = Object.entries(only)
        .map(([c, v]) => {
          params.push(v);
          return ` AND ${col(table, c)} = $${params.length}`;
        })
        .join("");
      // Counted first: some drivers report only rows whose value changed, and a correction to the
      // value already stored still matched the person's row.
      const [counted] = rowsOf(await query(`SELECT count(*) AS n FROM ${from(table)} WHERE ${where(table, subjectColumn)}${narrow}`, params));
      const setParams = [...params];
      const set = entries
        .map(([c, v]) => {
          if (v === null || v === undefined) return `${col(table, c)} = NULL`;
          setParams.push(columnValue(v));
          return `${col(table, c)} = $${setParams.length}`;
        })
        .join(", ");
      await query(`UPDATE ${from(table)} SET ${set} WHERE ${where(table, subjectColumn)}${narrow}`, setParams);
      return num(counted?.n);
    },
    async deleteRows(table, subjectColumn, subjectId) {
      return affected(await query(`DELETE FROM ${from(table)} WHERE ${where(table, subjectColumn)}`, [subjectId]));
    },
  };
}
