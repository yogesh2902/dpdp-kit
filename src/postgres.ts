// Store and data access on Postgres with plain SQL, for any client that can run a parameterised
// query: node-postgres, postgres.js, Prisma ($queryRawUnsafe), Kysely, Knex… `dpdp-kit/prisma` builds
// on this. Uses the same tables as `dpdp-kit/drizzle`: create them with DPDP_DDL, exported here too.
import type { AccessEntry, AccessFilter, AccessLogStore } from "./access.js";
import type { Breach, BreachNotice, BreachStore, NoticeCounts } from "./breach.js";
import type { ErasedValue } from "./config.js";
import { columnValue, type DataAccess } from "./data-access.js";
import { SeqConflictError } from "./errors.js";
import type { NoticeLanguage } from "./languages.js";
import type { NoticeStore, PrivacyNotice } from "./notice.js";
import { ACTIONS_SQL, NOW_SQL, PERIOD_SQL, type StatsStore, statsFromRows, TASKS_SQL, taskCountsFromRows, TOTALS_SQL } from "./stats.js";
import type { ErasureTask, RightsRequest } from "./records.js";
import type { Schema } from "./schema-check.js";
import type { ConsentEvent, DpdpStore } from "./store.js";

export { ACCESS_LOG_DDL, BREACH_DDL, CONSENT_EVENTS_DDL, DPDP_DDL, MIGRATE_0_5_DDL, PRIVACY_NOTICES_DDL, RECORDS_DDL } from "./ddl.js";

/**
 * Runs one parameterised SQL statement (`$1`, `$2`… placeholders) and resolves with its rows.
 *
 * ```ts
 * const query: SqlQuery = async (text, params) => (await pool.query(text, [...params])).rows; // node-postgres
 * ```
 */
export type SqlQuery = (text: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>;

type Row = Record<string, unknown>;

/** Quote a table or column name for Postgres. */
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

const iso = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : new Date(v as string | Date).toISOString());
const num = (v: unknown): number => Number(v ?? 0);
const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const optJson = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : json<T>(v));
const optText = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const jsonParam = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
/** Drop undefined values, so optional properties are absent rather than undefined. */
const defined = <T>(o: Record<string, unknown>): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Unique violations look different per client: pg and PGlite set code 23505, Prisma wraps it in `meta`. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const x = e as { code?: unknown; meta?: { code?: unknown }; message?: unknown; cause?: unknown };
    if (x.code === "23505" || x.meta?.code === "23505") return true;
    if (typeof x.message === "string" && /\b23505\b|unique constraint|duplicate key/i.test(x.message)) return true;
    e = x.cause;
  }
  return false;
}

const eventFromRow = (r: Row): ConsentEvent =>
  defined<ConsentEvent>({
    subjectId: String(r.subject_id),
    seq: num(r.seq),
    action: r.action,
    purposes: json<string[]>(r.purposes),
    noticeVersion: optText(r.notice_version),
    language: optText(r.language) as NoticeLanguage | undefined,
    channel: optText(r.channel),
    evidence: optJson(r.evidence),
    at: iso(r.at),
    prevHash: optText(r.prev_hash) ?? null,
    hash: String(r.hash),
  });

const requestFromRow = (r: Row): RightsRequest =>
  defined<RightsRequest>({
    id: String(r.id),
    subjectId: String(r.subject_id),
    type: r.type,
    status: r.status,
    openedAt: iso(r.opened_at),
    dueAt: iso(r.due_at),
    closedAt: iso(r.closed_at),
    details: optJson(r.details),
    history: json(r.history),
  });

const taskFromRow = (r: Row): ErasureTask =>
  defined<ErasureTask>({
    id: String(r.id),
    subjectId: String(r.subject_id),
    reason: r.reason,
    kind: r.kind,
    table: optText(r.table_key),
    fields: optJson(r.fields),
    processor: optText(r.processor),
    purposes: optJson(r.purposes),
    createdAt: iso(r.created_at),
    dueAt: iso(r.due_at),
    status: r.status,
    attempts: num(r.attempts),
    claimedAt: iso(r.claimed_at),
    doneAt: iso(r.done_at),
    affected: r.affected === null || r.affected === undefined ? undefined : num(r.affected),
    lastError: optText(r.last_error),
    note: optText(r.note),
  });

const accessFromRow = (r: Row): AccessEntry =>
  defined<AccessEntry>({
    id: String(r.id),
    at: iso(r.at),
    actor: String(r.actor),
    subjectId: String(r.subject_id),
    action: r.action,
    purpose: String(r.purpose),
    fields: optJson(r.fields),
    outOfPurpose: optJson(r.out_of_purpose),
    reason: optText(r.reason),
    evidence: optJson(r.evidence),
  });

const noticeFromRow = (r: Row): BreachNotice =>
  defined<BreachNotice>({
    breachId: String(r.breach_id),
    subjectId: String(r.subject_id),
    status: r.status,
    addedAt: iso(r.added_at),
    sentAt: iso(r.sent_at),
    channel: optText(r.channel),
  });

/*
 * Every parameter gets an explicit cast, so the statements work with clients that send typed
 * parameters (Prisma sends strings as text) as well as untyped ones (node-postgres).
 */
type Columns = ReadonlyArray<readonly [column: string, type: string]>;

const p = (n: number, type: string) => `$${n}::${type}`;
/** `INSERT INTO table (columns) VALUES ($1::type, …)` */
const insertSql = (table: string, cols: Columns) =>
  `INSERT INTO ${table} (${cols.map(([c]) => c).join(", ")}) VALUES (${cols.map(([, t], i) => p(i + 1, t)).join(", ")})`;
/** `UPDATE table SET column = $2::type, … WHERE id = $1`, for tables whose first column is the id. */
const updateSql = (table: string, cols: Columns) =>
  `UPDATE ${table} SET ${cols
    .slice(1)
    .map(([c, t], i) => `${c} = ${p(i + 2, t)}`)
    .join(", ")} WHERE ${cols[0]![0]} = $1::text`;

const EVENT_COLUMNS: Columns = [
  ["subject_id", "text"], ["seq", "int"], ["action", "text"], ["purposes", "jsonb"], ["notice_version", "text"], ["language", "text"],
  ["channel", "text"], ["evidence", "jsonb"], ["at", "timestamptz"], ["prev_hash", "text"], ["hash", "text"],
];
const eventValues = (e: ConsentEvent): unknown[] => [
  e.subjectId, e.seq, e.action, JSON.stringify(e.purposes), e.noticeVersion ?? null, e.language ?? null, e.channel ?? null,
  jsonParam(e.evidence), e.at, e.prevHash, e.hash,
];

const REQUEST_COLUMNS: Columns = [
  ["id", "text"], ["subject_id", "text"], ["type", "text"], ["status", "text"], ["opened_at", "timestamptz"], ["due_at", "timestamptz"],
  ["closed_at", "timestamptz"], ["details", "jsonb"], ["history", "jsonb"],
];
const requestValues = (r: RightsRequest): unknown[] => [
  r.id, r.subjectId, r.type, r.status, r.openedAt, r.dueAt, r.closedAt ?? null, jsonParam(r.details), JSON.stringify(r.history),
];

const TASK_COLUMNS: Columns = [
  ["id", "text"], ["subject_id", "text"], ["reason", "text"], ["kind", "text"], ["table_key", "text"], ["fields", "jsonb"],
  ["processor", "text"], ["purposes", "jsonb"], ["created_at", "timestamptz"], ["due_at", "timestamptz"], ["status", "text"],
  ["attempts", "int"], ["claimed_at", "timestamptz"], ["done_at", "timestamptz"], ["affected", "int"], ["last_error", "text"], ["note", "text"],
];
const taskValues = (t: ErasureTask): unknown[] => [
  t.id, t.subjectId, t.reason, t.kind, t.table ?? null, jsonParam(t.fields), t.processor ?? null, jsonParam(t.purposes),
  t.createdAt, t.dueAt, t.status, t.attempts, t.claimedAt ?? null, t.doneAt ?? null, t.affected ?? null, t.lastError ?? null, t.note ?? null,
];

const ACCESS_COLUMNS: Columns = [
  ["id", "text"], ["at", "timestamptz"], ["actor", "text"], ["subject_id", "text"], ["action", "text"], ["purpose", "text"],
  ["fields", "jsonb"], ["out_of_purpose", "jsonb"], ["reason", "text"], ["evidence", "jsonb"],
];
const accessValues = (e: AccessEntry): unknown[] => [
  e.id, e.at, e.actor, e.subjectId, e.action, e.purpose, jsonParam(e.fields), jsonParam(e.outOfPurpose), e.reason ?? null, jsonParam(e.evidence),
];

const BREACH_COLUMNS: Columns = [["id", "text"], ["status", "text"], ["aware_at", "timestamptz"], ["report_due_at", "timestamptz"], ["data", "jsonb"]];
const breachValues = (b: Breach): unknown[] => [b.id, b.status, b.awareAt, b.reportDueAt, JSON.stringify(b)];

const NOTICE_COLUMNS: Columns = [
  ["breach_id", "text"], ["subject_id", "text"], ["status", "text"], ["added_at", "timestamptz"], ["sent_at", "timestamptz"], ["channel", "text"],
];

/**
 * A timestamp as ISO 8601 text in UTC. Drivers parse timestamps differently, and some (Prisma's
 * pg adapter) shift them by the server's time zone, which would break the consent hash chain on a
 * server set to Asia/Kolkata. Text in UTC reads back exactly as it was written.
 */
const utc = (expr: string) => `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const selectList = (cols: Columns) => cols.map(([c, t]) => (t === "timestamptz" ? `${utc(c)} AS ${c}` : c)).join(", ");
const EVENT_SELECT = selectList(EVENT_COLUMNS);
const REQUEST_SELECT = selectList(REQUEST_COLUMNS);
const TASK_SELECT = selectList(TASK_COLUMNS);
const ACCESS_SELECT = selectList(ACCESS_COLUMNS);
const NOTICE_SELECT = selectList(NOTICE_COLUMNS);

/** Tasks a runner may pick up now (see `TaskStore.dueTasks`): $1 now, $2 staleBefore, $3 maxAttempts. */
const RUNNABLE = `due_at <= $1::timestamptz AND (status = 'pending' OR (status = 'failed' AND attempts < $3::int) OR (status = 'running' AND claimed_at < $2::timestamptz))`;

/** Rows per statement for bulk writes, well under Postgres's 65,535 parameters. */
const BATCH = 1000;

/** `INSERT INTO table (columns) VALUES (…), (…)` for `rows` rows. */
const insertManySql = (table: string, cols: Columns, rows: number) =>
  `INSERT INTO ${table} (${cols.map(([c]) => c).join(", ")}) VALUES ${Array.from(
    { length: rows },
    (_, r) => `(${cols.map(([, t], i) => p(r * cols.length + i + 1, t)).join(", ")})`,
  ).join(", ")}`;

/** Insert rows in batches, each batch one statement (so a batch is stored whole or not at all). */
async function insertMany<T>(query: SqlQuery, table: string, cols: Columns, items: readonly T[], values: (item: T) => unknown[], suffix = "") {
  const results: Record<string, unknown>[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    results.push(...(await query(`${insertManySql(table, cols, batch.length)}${suffix}`, batch.flatMap(values))));
  }
  return results;
}

const ACCESS_WHERE = `($1::text IS NULL OR subject_id = $1::text) AND ($2::text IS NULL OR actor = $2::text) AND ($3::text IS NULL OR purpose = $3::text)
           AND ($4::timestamptz IS NULL OR at >= $4::timestamptz) AND ($5::timestamptz IS NULL OR at < $5::timestamptz)`;
const accessParams = (f: AccessFilter) => [f.subjectId ?? null, f.actor ?? null, f.purpose ?? null, f.from ?? null, f.to ?? null];

/**
 * Store on Postgres with plain SQL: consent events, rights requests, erasure tasks, the access log and
 * breaches. Needs the dpdp-kit tables (`DPDP_DDL` from `dpdp-kit/drizzle`, or `PRISMA_MODELS` from
 * `dpdp-kit/prisma`).
 *
 * ```ts
 * import pg from "pg";
 * const pool = new pg.Pool();
 * const store = postgresStore(async (text, params) => (await pool.query(text, [...params])).rows);
 * ```
 */
export function postgresStore(query: SqlQuery): DpdpStore & AccessLogStore & BreachStore & NoticeStore & StatsStore {
  const NOTICE_ROW = `content, ${utc("first_shown_at")} AS first_shown_at`;
  const savedNotice = (r: Record<string, unknown>) => ({
    notice: (typeof r.content === "string" ? JSON.parse(r.content) : r.content) as PrivacyNotice,
    firstShownAt: iso(r.first_shown_at)!,
  });
  return {
    async consentStats(from, to) {
      const [totals, actions, period, now] = await Promise.all([
        query(TOTALS_SQL, [from, to]),
        query(ACTIONS_SQL, [from, to]),
        query(PERIOD_SQL, [from, to]),
        query(NOW_SQL, []),
      ]);
      return statsFromRows(from, to, totals[0], actions, period, now);
    },
    async taskCounts(now) {
      return taskCountsFromRows(await query(TASKS_SQL, [now]));
    },
    async savePrivacyNotice(n, at) {
      const rows = await query(
        `INSERT INTO dpdp_privacy_notices (version, language, kind, content, first_shown_at)
         VALUES ($1::text, $2::text, $3::text, $4::jsonb, $5::timestamptz) ON CONFLICT (version, language, kind) DO NOTHING RETURNING 1 AS one`,
        [n.version, n.language, n.kind, JSON.stringify(n), at],
      );
      return rows.length > 0;
    },
    async getPrivacyNotice(version, language, kind) {
      const [row] = await query(
        `SELECT ${NOTICE_ROW} FROM dpdp_privacy_notices WHERE version = $1::text AND language = $2::text AND kind = $3::text`,
        [version, language, kind],
      );
      return row ? savedNotice(row) : undefined;
    },
    async listPrivacyNotices() {
      const rows = await query(`SELECT ${NOTICE_ROW} FROM dpdp_privacy_notices ORDER BY first_shown_at, version, language, kind`, []);
      return rows.map(savedNotice);
    },

    async lastEvent(subjectId) {
      const [row] = await query(`SELECT ${EVENT_SELECT} FROM dpdp_consent_events WHERE subject_id = $1::text ORDER BY seq DESC LIMIT 1`, [subjectId]);
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
      return (await query(`SELECT ${EVENT_SELECT} FROM dpdp_consent_events WHERE subject_id = $1::text ORDER BY seq ASC`, [subjectId])).map(eventFromRow);
    },

    async insertRequest(r) {
      await query(insertSql("dpdp_requests", REQUEST_COLUMNS), requestValues(r));
    },
    async getRequest(id) {
      const [row] = await query(`SELECT ${REQUEST_SELECT} FROM dpdp_requests WHERE id = $1::text`, [id]);
      return row ? requestFromRow(row) : undefined;
    },
    async updateRequest(r) {
      await query(updateSql("dpdp_requests", REQUEST_COLUMNS), requestValues(r));
    },
    async listRequests(filter) {
      const rows = await query(
        `SELECT ${REQUEST_SELECT} FROM dpdp_requests WHERE ($1::text IS NULL OR subject_id = $1::text) AND ($2::text IS NULL OR status = $2::text) ORDER BY opened_at ASC`,
        [filter.subjectId ?? null, filter.status ?? null],
      );
      return rows.map(requestFromRow);
    },

    async insertTasks(tasks) {
      await insertMany(query, "dpdp_erasure_tasks", TASK_COLUMNS, tasks, taskValues);
    },
    async dueTasks({ limit, now, staleBefore, maxAttempts }) {
      const rows = await query(`SELECT ${TASK_SELECT} FROM dpdp_erasure_tasks WHERE ${RUNNABLE} ORDER BY due_at ASC LIMIT $4::int`, [now, staleBefore, maxAttempts, limit]);
      return rows.map(taskFromRow);
    },
    async claimTask({ id, now, staleBefore, maxAttempts }) {
      const rows = await query(
        `UPDATE dpdp_erasure_tasks SET status = 'running', claimed_at = $1::timestamptz WHERE id = $4::text AND ${RUNNABLE} RETURNING id`,
        [now, staleBefore, maxAttempts, id],
      );
      return rows.length === 1;
    },
    async updateTask(t) {
      await query(updateSql("dpdp_erasure_tasks", TASK_COLUMNS), taskValues(t));
    },
    async getTask(id) {
      const [row] = await query(`SELECT ${TASK_SELECT} FROM dpdp_erasure_tasks WHERE id = $1::text`, [id]);
      return row ? taskFromRow(row) : undefined;
    },
    async listTasks(filter) {
      const rows = await query(
        `SELECT ${TASK_SELECT} FROM dpdp_erasure_tasks WHERE ($1::text IS NULL OR subject_id = $1::text) AND ($2::text IS NULL OR status = $2::text) ORDER BY due_at ASC`,
        [filter.subjectId ?? null, filter.status ?? null],
      );
      return rows.map(taskFromRow);
    },

    async insertAccess(entries) {
      await insertMany(query, "dpdp_access_log", ACCESS_COLUMNS, entries, accessValues);
    },
    async listAccess(f) {
      const rows = await query(`SELECT ${ACCESS_SELECT} FROM dpdp_access_log WHERE ${ACCESS_WHERE} ORDER BY at ASC, id ASC LIMIT $6::int`, [
        ...accessParams(f),
        f.limit ?? null,
      ]);
      return rows.map(accessFromRow);
    },
    async accessSubjects(f) {
      const rows = await query(`SELECT DISTINCT subject_id FROM dpdp_access_log WHERE ${ACCESS_WHERE}`, accessParams(f));
      return rows.map((r) => String(r.subject_id));
    },
    async pruneAccess(before) {
      // In batches, so the first prune of a big table neither holds a long lock nor returns every id.
      let total = 0;
      for (;;) {
        const rows = await query(
          `DELETE FROM dpdp_access_log WHERE id IN (SELECT id FROM dpdp_access_log WHERE at < $1::timestamptz LIMIT 5000) RETURNING 1 AS one`,
          [before],
        );
        total += rows.length;
        if (rows.length < 5000) return total;
      }
    },

    async insertBreach(b) {
      await query(insertSql("dpdp_breaches", BREACH_COLUMNS), breachValues(b));
    },
    async getBreach(id) {
      const [row] = await query(`SELECT data FROM dpdp_breaches WHERE id = $1::text`, [id]);
      return row ? json<Breach>(row.data) : undefined;
    },
    async updateBreach(b) {
      // Only if no one saved it since it was read: each change adds one history entry.
      const unchanged = `jsonb_array_length(data->'history') = $${BREACH_COLUMNS.length + 1}::int`;
      const rows = await query(`${updateSql("dpdp_breaches", BREACH_COLUMNS)} AND ${unchanged} RETURNING 1 AS one`, [...breachValues(b), b.history.length - 1]);
      return rows.length === 1;
    },
    async listBreaches(filter) {
      const rows = await query(`SELECT data FROM dpdp_breaches WHERE ($1::text IS NULL OR status = $1::text) ORDER BY aware_at DESC`, [filter.status ?? null]);
      return rows.map((r) => json<Breach>(r.data));
    },
    async addNotices(list) {
      const values = (n: BreachNotice) => [n.breachId, n.subjectId, n.status, n.addedAt, n.sentAt ?? null, n.channel ?? null];
      const rows = await insertMany(query, "dpdp_breach_notices", NOTICE_COLUMNS, list, values, " ON CONFLICT (breach_id, subject_id) DO NOTHING RETURNING 1 AS one");
      return rows.length;
    },
    async markNotices(breachId, subjectIds, sentAt, channel) {
      let changed = 0;
      for (let i = 0; i < subjectIds.length; i += BATCH) {
        const rows = await query(
          `UPDATE dpdp_breach_notices SET status = 'sent', sent_at = $2::timestamptz, channel = $3::text
           WHERE breach_id = $1::text AND status = 'pending' AND subject_id = ANY($4::text[]) RETURNING 1 AS one`,
          [breachId, sentAt, channel ?? null, subjectIds.slice(i, i + BATCH)],
        );
        changed += rows.length;
      }
      return changed;
    },
    async listNotices(breachId, filter) {
      const rows = await query(
        `SELECT ${NOTICE_SELECT} FROM dpdp_breach_notices WHERE breach_id = $1::text AND ($2::text IS NULL OR status = $2::text)
         ORDER BY added_at ASC, subject_id ASC LIMIT $3::int`,
        [breachId, filter.status ?? null, filter.limit ?? null],
      );
      return rows.map(noticeFromRow);
    },
    async countNotices(breachId) {
      const [r] = await query(
        `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'sent') AS sent, ${utc("min(sent_at)")} AS first, ${utc("max(sent_at)")} AS last
         FROM dpdp_breach_notices WHERE breach_id = $1::text`,
        [breachId],
      );
      return defined<NoticeCounts>({ total: num(r?.total), sent: num(r?.sent), firstSentAt: iso(r?.first), lastSentAt: iso(r?.last) });
    },
  };
}

const SERIAL: Record<string, string> = { serial: "integer", serial4: "integer", bigserial: "bigint", serial8: "bigint", smallserial: "smallint", serial2: "smallint" };

/**
 * The type to cast a parameter to for a column. Length limits are dropped, because a cast to
 * `varchar(3)` cuts the value short and would match the wrong rows; serials are plain integers.
 */
export function castType(sqlType: string): string {
  const base = sqlType.trim().replace(/\s*\([^)]*\)/g, "");
  const array = base.endsWith("[]") ? "[]" : "";
  const name = array ? base.slice(0, -2) : base;
  const lower = name.toLowerCase();
  if (Object.hasOwn(SERIAL, lower)) return SERIAL[lower]! + array;
  if (lower === "char" || lower === "character") return `bpchar${array}`;
  return name + array;
}

/**
 * A column as the summary shows it. Timestamps come back as text, so a driver that shifts them by
 * the server's time zone (Prisma's pg adapter) can't show a person the wrong time: `timestamptz` as
 * UTC (`…Z`), `timestamp` as stored.
 */
function readable(column: string, sqlType: string | undefined): string {
  const type = sqlType ? castType(sqlType).toLowerCase() : "";
  if (type === "timestamptz" || type === "timestamp with time zone") return utc(column);
  if (type === "timestamp" || type === "timestamp without time zone") return `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
  return column;
}

/** BigInt values (Prisma returns them for bigint columns) as numbers, or text when too big, so rows serialise to JSON. */
const plainRow = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v]),
  );

/**
 * Data access for your own Postgres tables with plain SQL, for access summaries and erasure. Pass a
 * `schema` (from `prismaSchema()` or `drizzleSchema()`) when the data map uses names from code
 * (a `User` model, a `userId` property) rather than the database's (`users`, `user_id`); it also
 * gives each column's type, so parameters are cast to it. Erasure writes each field's `erase`
 * replacement, or NULL; `dpdp-kit audit --schema` checks that each column can take it.
 */
export function postgresData(query: SqlQuery, options: { schema?: Schema } = {}): DataAccess {
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
  /** `$n`, cast to the column's type when the schema gives it. */
  const param = (n: number, table: string, name: string) => {
    const sqlType = column(table, name)?.sqlType;
    return sqlType ? `$${n}::${castType(sqlType)}` : `$${n}`;
  };
  const where = (table: string, subjectColumn: string) => `${col(table, subjectColumn)} = ${param(1, table, subjectColumn)}`;

  return {
    async read(table, subjectColumn, subjectId, columns) {
      if (columns.length === 0) return [];
      const select = columns.map((c) => `${readable(col(table, c), column(table, c)?.sqlType)} AS ${ident(c)}`).join(", ");
      const rows = await query(`SELECT ${select} FROM ${from(table)} WHERE ${where(table, subjectColumn)}`, [subjectId]);
      return rows.map(plainRow);
    },
    async eraseFields(table, subjectColumn, subjectId, columns, values: Readonly<Record<string, ErasedValue>> = {}) {
      if (columns.length === 0) return 0;
      const params: unknown[] = [subjectId];
      const set = columns
        .map((c) => {
          if (!Object.hasOwn(values, c) || values[c] === null) return `${col(table, c)} = NULL`;
          params.push(values[c]);
          return `${col(table, c)} = ${param(params.length, table, c)}`;
        })
        .join(", ");
      const rows = await query(`UPDATE ${from(table)} SET ${set} WHERE ${where(table, subjectColumn)} RETURNING 1 AS one`, params);
      return rows.length;
    },
    async updateFields(table, subjectColumn, subjectId, values, only = {}) {
      const entries = Object.entries(values);
      if (entries.length === 0) return 0;
      const params: unknown[] = [subjectId];
      const isArrayColumn = (c: string) => /\[\]$|^_/.test(column(table, c)?.sqlType ?? "");
      const set = entries
        .map(([c, v]) => {
          if (v === null || v === undefined) return `${col(table, c)} = NULL`;
          params.push(Array.isArray(v) && isArrayColumn(c) ? v : columnValue(v));
          return `${col(table, c)} = ${param(params.length, table, c)}`;
        })
        .join(", ");
      const narrow = Object.entries(only).map(([c, v]) => {
        params.push(v);
        return ` AND ${col(table, c)} = ${param(params.length, table, c)}`;
      });
      const rows = await query(`UPDATE ${from(table)} SET ${set} WHERE ${where(table, subjectColumn)}${narrow.join("")} RETURNING 1 AS one`, params);
      return rows.length;
    },
    async deleteRows(table, subjectColumn, subjectId) {
      const rows = await query(`DELETE FROM ${from(table)} WHERE ${where(table, subjectColumn)} RETURNING 1 AS one`, [subjectId]);
      return rows.length;
    },
  };
}
