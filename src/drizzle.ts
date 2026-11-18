import { and, asc, desc, eq, getTableColumns, getTableName, gte, is, lt, lte, or, type SQL, sql, Table } from "drizzle-orm";
import { index, integer, jsonb, type PgDatabase, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { AccessEntry, AccessLogStore } from "./access.js";
import type { DataAccess } from "./data-access.js";
import type { ErasureTask, RequestStatus, RequestType, RightsRequest, TaskKind, TaskStatus } from "./records.js";
import { SeqConflictError } from "./errors.js";
import type { NoticeLanguage } from "./languages.js";
import type { Schema, SchemaTable } from "./schema-check.js";
import type { ConsentEvent, DpdpStore } from "./store.js";

/**
 * The consent events table. Export it from your Drizzle schema so drizzle-kit creates it:
 *
 * ```ts
 * export { consentEvents } from "dpdp-kit/drizzle";
 * ```
 */
export const consentEvents = pgTable(
  "dpdp_consent_events",
  {
    subjectId: text("subject_id").notNull(),
    seq: integer("seq").notNull(),
    action: text("action", { enum: ["grant", "withdraw"] }).notNull(),
    purposes: jsonb("purposes").$type<string[]>().notNull(),
    noticeVersion: text("notice_version"),
    language: text("language"),
    channel: text("channel"),
    evidence: jsonb("evidence").$type<Record<string, string>>(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.subjectId, t.seq] })],
);

/** The same table as plain SQL, if you don't use drizzle-kit for migrations. */
export const CONSENT_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS dpdp_consent_events (
  subject_id text NOT NULL,
  seq integer NOT NULL,
  action text NOT NULL CHECK (action IN ('grant', 'withdraw')),
  purposes jsonb NOT NULL,
  notice_version text,
  language text,
  channel text,
  evidence jsonb,
  at timestamptz NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  PRIMARY KEY (subject_id, seq)
);`;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Rights requests (Sections 11–14). Export it from your Drizzle schema with `consentEvents`. */
export const rightsRequests = pgTable(
  "dpdp_requests",
  {
    id: text("id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    type: text("type").$type<RequestType>().notNull(),
    status: text("status").$type<RequestStatus>().notNull(),
    openedAt: ts("opened_at").notNull(),
    dueAt: ts("due_at").notNull(),
    closedAt: ts("closed_at"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    history: jsonb("history").$type<RightsRequest["history"]>().notNull(),
  },
  (t) => [index("dpdp_requests_subject_idx").on(t.subjectId), index("dpdp_requests_status_due_idx").on(t.status, t.dueAt)],
);

/** Erasure tasks for the retention runner. Export it from your Drizzle schema with `consentEvents`. */
export const erasureTasks = pgTable(
  "dpdp_erasure_tasks",
  {
    id: text("id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason").notNull(),
    kind: text("kind").$type<TaskKind>().notNull(),
    tableKey: text("table_key"),
    fields: jsonb("fields").$type<string[]>(),
    processor: text("processor"),
    purposes: jsonb("purposes").$type<string[]>(),
    createdAt: ts("created_at").notNull(),
    dueAt: ts("due_at").notNull(),
    status: text("status").$type<TaskStatus>().notNull(),
    attempts: integer("attempts").notNull(),
    claimedAt: ts("claimed_at"),
    doneAt: ts("done_at"),
    affected: integer("affected"),
    lastError: text("last_error"),
    note: text("note"),
  },
  (t) => [index("dpdp_erasure_tasks_subject_idx").on(t.subjectId), index("dpdp_erasure_tasks_status_due_idx").on(t.status, t.dueAt)],
);

/** Rights requests and erasure tasks as plain SQL, if you don't use drizzle-kit for migrations. */
export const RECORDS_DDL = `CREATE TABLE IF NOT EXISTS dpdp_requests (
  id text PRIMARY KEY,
  subject_id text NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  opened_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  closed_at timestamptz,
  details jsonb,
  history jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS dpdp_requests_subject_idx ON dpdp_requests (subject_id);
CREATE INDEX IF NOT EXISTS dpdp_requests_status_due_idx ON dpdp_requests (status, due_at);
CREATE TABLE IF NOT EXISTS dpdp_erasure_tasks (
  id text PRIMARY KEY,
  subject_id text NOT NULL,
  reason text NOT NULL,
  kind text NOT NULL,
  table_key text,
  fields jsonb,
  processor text,
  purposes jsonb,
  created_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL,
  claimed_at timestamptz,
  done_at timestamptz,
  affected integer,
  last_error text,
  note text
);
CREATE INDEX IF NOT EXISTS dpdp_erasure_tasks_subject_idx ON dpdp_erasure_tasks (subject_id);
CREATE INDEX IF NOT EXISTS dpdp_erasure_tasks_status_due_idx ON dpdp_erasure_tasks (status, due_at);`;

/**
 * The access log (Rule 6(1)(c) and (e)): who accessed whose personal data, when, for which purpose.
 * Export it from your Drizzle schema with `consentEvents`.
 */
export const accessLog = pgTable(
  "dpdp_access_log",
  {
    id: text("id").primaryKey(),
    at: ts("at").notNull(),
    actor: text("actor").notNull(),
    subjectId: text("subject_id").notNull(),
    action: text("action").notNull(),
    purpose: text("purpose").notNull(),
    fields: jsonb("fields").$type<string[]>(),
    outOfPurpose: jsonb("out_of_purpose").$type<string[]>(),
    reason: text("reason"),
    evidence: jsonb("evidence").$type<Record<string, string>>(),
  },
  (t) => [
    index("dpdp_access_log_at_idx").on(t.at),
    index("dpdp_access_log_subject_idx").on(t.subjectId, t.at),
    index("dpdp_access_log_actor_idx").on(t.actor, t.at),
  ],
);

/** The access log as plain SQL, if you don't use drizzle-kit for migrations. */
export const ACCESS_LOG_DDL = `CREATE TABLE IF NOT EXISTS dpdp_access_log (
  id text PRIMARY KEY,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  subject_id text NOT NULL,
  action text NOT NULL,
  purpose text NOT NULL,
  fields jsonb,
  out_of_purpose jsonb,
  reason text,
  evidence jsonb
);
CREATE INDEX IF NOT EXISTS dpdp_access_log_at_idx ON dpdp_access_log (at);
CREATE INDEX IF NOT EXISTS dpdp_access_log_subject_idx ON dpdp_access_log (subject_id, at);
CREATE INDEX IF NOT EXISTS dpdp_access_log_actor_idx ON dpdp_access_log (actor, at);`;

/** Every dpdp-kit table as plain SQL. */
export const DPDP_DDL = `${CONSENT_EVENTS_DDL}\n${RECORDS_DDL}\n${ACCESS_LOG_DDL}`;

type AccessRow = typeof accessLog.$inferSelect;

function accessFromRow(row: AccessRow): AccessEntry {
  return {
    id: row.id,
    at: row.at.toISOString(),
    actor: row.actor,
    subjectId: row.subjectId,
    action: row.action,
    purpose: row.purpose,
    ...(row.fields !== null ? { fields: row.fields } : {}),
    ...(row.outOfPurpose !== null ? { outOfPurpose: row.outOfPurpose } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.evidence !== null ? { evidence: row.evidence } : {}),
  };
}

function accessToRow(e: AccessEntry): AccessRow {
  return {
    id: e.id,
    at: new Date(e.at),
    actor: e.actor,
    subjectId: e.subjectId,
    action: e.action,
    purpose: e.purpose,
    fields: e.fields ?? null,
    outOfPurpose: e.outOfPurpose ?? null,
    reason: e.reason ?? null,
    evidence: e.evidence ?? null,
  };
}

type Row = typeof consentEvents.$inferSelect;

function fromRow(row: Row): ConsentEvent {
  return {
    subjectId: row.subjectId,
    seq: row.seq,
    action: row.action,
    purposes: row.purposes,
    ...(row.noticeVersion !== null ? { noticeVersion: row.noticeVersion } : {}),
    ...(row.language !== null ? { language: row.language as NoticeLanguage } : {}),
    ...(row.channel !== null ? { channel: row.channel } : {}),
    ...(row.evidence !== null ? { evidence: row.evidence } : {}),
    at: row.at.toISOString(),
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (typeof e === "object" && (e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

type AnyPgDatabase = PgDatabase<any, any, any>;

const iso = (d: Date | null) => (d ? d.toISOString() : undefined);
const date = (value: string | undefined) => (value === undefined ? null : new Date(value));

type RequestRow = typeof rightsRequests.$inferSelect;
type TaskRow = typeof erasureTasks.$inferSelect;

function requestFromRow(row: RequestRow): RightsRequest {
  return {
    id: row.id,
    subjectId: row.subjectId,
    type: row.type,
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    ...(row.closedAt ? { closedAt: row.closedAt.toISOString() } : {}),
    ...(row.details !== null ? { details: row.details } : {}),
    history: row.history,
  };
}

function requestToRow(r: RightsRequest): RequestRow {
  return {
    id: r.id,
    subjectId: r.subjectId,
    type: r.type,
    status: r.status,
    openedAt: new Date(r.openedAt),
    dueAt: new Date(r.dueAt),
    closedAt: date(r.closedAt),
    details: r.details ?? null,
    history: r.history,
  };
}

function taskFromRow(row: TaskRow): ErasureTask {
  const optional = {
    table: row.tableKey ?? undefined,
    fields: row.fields ?? undefined,
    processor: row.processor ?? undefined,
    purposes: row.purposes ?? undefined,
    claimedAt: iso(row.claimedAt),
    doneAt: iso(row.doneAt),
    affected: row.affected ?? undefined,
    lastError: row.lastError ?? undefined,
    note: row.note ?? undefined,
  };
  return {
    id: row.id,
    subjectId: row.subjectId,
    reason: row.reason,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    status: row.status,
    attempts: row.attempts,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}

function taskToRow(t: ErasureTask): TaskRow {
  return {
    id: t.id,
    subjectId: t.subjectId,
    reason: t.reason,
    kind: t.kind,
    tableKey: t.table ?? null,
    fields: t.fields ?? null,
    processor: t.processor ?? null,
    purposes: t.purposes ?? null,
    createdAt: new Date(t.createdAt),
    dueAt: new Date(t.dueAt),
    status: t.status,
    attempts: t.attempts,
    claimedAt: date(t.claimedAt),
    doneAt: date(t.doneAt),
    affected: t.affected ?? null,
    lastError: t.lastError ?? null,
    note: t.note ?? null,
  };
}

/** Tasks a runner may pick up now (see `TaskStore.dueTasks`). */
function runnable(when: { now: string; staleBefore: string; maxAttempts: number }): SQL {
  return and(
    lte(erasureTasks.dueAt, new Date(when.now)),
    or(
      eq(erasureTasks.status, "pending"),
      and(eq(erasureTasks.status, "failed"), lt(erasureTasks.attempts, when.maxAttempts)),
      and(eq(erasureTasks.status, "running"), lt(erasureTasks.claimedAt, new Date(when.staleBefore))),
    ),
  ) as SQL;
}

/**
 * Store on Postgres through Drizzle: consent events, rights requests and erasure tasks. Works with
 * node-postgres, postgres.js, Neon, PGlite and other Drizzle Postgres drivers. Needs the tables
 * `consentEvents`, `rightsRequests`, `erasureTasks` and `accessLog` (or `DPDP_DDL`).
 */
export function drizzleStore(db: AnyPgDatabase): DpdpStore & AccessLogStore {
  return {
    async insertAccess(entries) {
      if (entries.length > 0) await db.insert(accessLog).values(entries.map(accessToRow));
    },
    async listAccess(filter) {
      const where = and(
        filter.subjectId ? eq(accessLog.subjectId, filter.subjectId) : undefined,
        filter.actor ? eq(accessLog.actor, filter.actor) : undefined,
        filter.purpose ? eq(accessLog.purpose, filter.purpose) : undefined,
        filter.from ? gte(accessLog.at, new Date(filter.from)) : undefined,
        filter.to ? lt(accessLog.at, new Date(filter.to)) : undefined,
      );
      const query = db.select().from(accessLog).where(where).orderBy(asc(accessLog.at), asc(accessLog.id));
      const rows = filter.limit === undefined ? await query : await query.limit(filter.limit);
      return rows.map(accessFromRow);
    },
    async pruneAccess(before) {
      const deleted = await db.delete(accessLog).where(lt(accessLog.at, new Date(before))).returning({ id: accessLog.id });
      return deleted.length;
    },

    async lastEvent(subjectId) {
      const rows = await db
        .select()
        .from(consentEvents)
        .where(eq(consentEvents.subjectId, subjectId))
        .orderBy(desc(consentEvents.seq))
        .limit(1);
      return rows[0] ? fromRow(rows[0]) : undefined;
    },

    async insert(event) {
      try {
        await db.insert(consentEvents).values({
          subjectId: event.subjectId,
          seq: event.seq,
          action: event.action,
          purposes: event.purposes,
          noticeVersion: event.noticeVersion ?? null,
          language: event.language ?? null,
          channel: event.channel ?? null,
          evidence: event.evidence ?? null,
          at: new Date(event.at),
          prevHash: event.prevHash,
          hash: event.hash,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new SeqConflictError(event.subjectId, event.seq);
        throw err;
      }
    },

    async events(subjectId) {
      const rows = await db
        .select()
        .from(consentEvents)
        .where(eq(consentEvents.subjectId, subjectId))
        .orderBy(asc(consentEvents.seq));
      return rows.map(fromRow);
    },

    async insertRequest(request) {
      await db.insert(rightsRequests).values(requestToRow(request));
    },
    async getRequest(id) {
      const rows = await db.select().from(rightsRequests).where(eq(rightsRequests.id, id)).limit(1);
      return rows[0] ? requestFromRow(rows[0]) : undefined;
    },
    async updateRequest(request) {
      const { id, ...rest } = requestToRow(request);
      await db.update(rightsRequests).set(rest).where(eq(rightsRequests.id, id));
    },
    async listRequests(filter) {
      const where = and(
        filter.subjectId ? eq(rightsRequests.subjectId, filter.subjectId) : undefined,
        filter.status ? eq(rightsRequests.status, filter.status) : undefined,
      );
      const rows = await db.select().from(rightsRequests).where(where).orderBy(asc(rightsRequests.openedAt));
      return rows.map(requestFromRow);
    },

    async insertTasks(tasks) {
      if (tasks.length > 0) await db.insert(erasureTasks).values(tasks.map(taskToRow));
    },
    async dueTasks({ limit, ...when }) {
      const rows = await db.select().from(erasureTasks).where(runnable(when)).orderBy(asc(erasureTasks.dueAt)).limit(limit);
      return rows.map(taskFromRow);
    },
    async claimTask({ id, ...when }) {
      const claimed = await db
        .update(erasureTasks)
        .set({ status: "running", claimedAt: new Date(when.now) })
        .where(and(eq(erasureTasks.id, id), runnable(when)))
        .returning({ id: erasureTasks.id });
      return claimed.length === 1;
    },
    async updateTask(task) {
      const { id, ...rest } = taskToRow(task);
      await db.update(erasureTasks).set(rest).where(eq(erasureTasks.id, id));
    },
    async getTask(id) {
      const rows = await db.select().from(erasureTasks).where(eq(erasureTasks.id, id)).limit(1);
      return rows[0] ? taskFromRow(rows[0]) : undefined;
    },
    async listTasks(filter) {
      const where = and(
        filter.subjectId ? eq(erasureTasks.subjectId, filter.subjectId) : undefined,
        filter.status ? eq(erasureTasks.status, filter.status) : undefined,
      );
      const rows = await db.select().from(erasureTasks).where(where).orderBy(asc(erasureTasks.dueAt));
      return rows.map(taskFromRow);
    },
  };
}

/**
 * Read a Drizzle schema module (Postgres, MySQL or SQLite) for `checkSchema()`. Pass the module
 * itself, so every exported table is found:
 *
 * ```ts
 * import * as schema from "./db/schema";
 * checkSchema(config, drizzleSchema(schema));
 * ```
 */
export function drizzleSchema(module: Record<string, unknown>): Schema {
  const tables = new Map<string, SchemaTable>();
  for (const value of Object.values(module)) {
    if (!is(value, Table)) continue;
    const name = getTableName(value);
    if (tables.has(name)) continue;
    const columns = Object.entries(getTableColumns(value)).map(([key, column]) =>
      key === column.name ? { name: column.name } : { name: column.name, key },
    );
    tables.set(name, { name, columns });
  }
  return { tables: [...tables.values()] };
}

/** Rows from `db.execute()`, whichever Postgres driver Drizzle wraps. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
}

/**
 * Data access for your own Postgres tables through Drizzle, for access summaries and erasure.
 * Pass your schema module if data map names are Drizzle property names (`userId`) rather than
 * database column names (`user_id`). Erasure sets fields to NULL, so erasable columns must be
 * nullable; a NOT NULL column makes the task fail with the database's message.
 */
export function drizzleData(db: AnyPgDatabase, options: { schema?: Record<string, unknown> } = {}): DataAccess {
  const columnsByTable = new Map<string, Map<string, string>>();
  for (const table of options.schema ? drizzleSchema(options.schema).tables : []) {
    columnsByTable.set(table.name, new Map(table.columns.map((c) => [c.key ?? c.name, c.name])));
  }
  const col = (table: string, name: string) => sql.identifier(columnsByTable.get(table)?.get(name) ?? name);
  const where = (table: string, subjectColumn: string, subjectId: string) =>
    sql`${col(table, subjectColumn)} = ${subjectId}`;

  return {
    async read(table, subjectColumn, subjectId, columns) {
      if (columns.length === 0) return [];
      const select = sql.join(
        columns.map((c) => sql`${col(table, c)} AS ${sql.identifier(c)}`),
        sql`, `,
      );
      const result = await db.execute(
        sql`SELECT ${select} FROM ${sql.identifier(table)} WHERE ${where(table, subjectColumn, subjectId)}`,
      );
      return rowsOf(result);
    },
    async eraseFields(table, subjectColumn, subjectId, columns) {
      if (columns.length === 0) return 0;
      const set = sql.join(
        columns.map((c) => sql`${col(table, c)} = NULL`),
        sql`, `,
      );
      const result = await db.execute(
        sql`UPDATE ${sql.identifier(table)} SET ${set} WHERE ${where(table, subjectColumn, subjectId)} RETURNING 1`,
      );
      return rowsOf(result).length;
    },
    async deleteRows(table, subjectColumn, subjectId) {
      const result = await db.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE ${where(table, subjectColumn, subjectId)} RETURNING 1`,
      );
      return rowsOf(result).length;
    },
  };
}
