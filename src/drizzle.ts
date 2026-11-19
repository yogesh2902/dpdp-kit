import { and, asc, count, desc, eq, getTableColumns, getTableName, gte, inArray, is, lt, lte, max, min, or, type SQL, sql, Table } from "drizzle-orm";
import { getTableConfig as mysqlTableConfig, MySqlTable } from "drizzle-orm/mysql-core";
import { check, getTableConfig as pgTableConfig, index, integer, jsonb, type PgDatabase, PgTable, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { SQLiteTable, getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import type { AccessEntry, AccessFilter, AccessLogStore } from "./access.js";
import type { Breach, BreachNotice, BreachStore } from "./breach.js";
import { columnValue, type DataAccess } from "./data-access.js";
import type { ErasureTask, RequestStatus, RequestType, RightsRequest, TaskKind, TaskStatus } from "./records.js";
import { SeqConflictError } from "./errors.js";
import type { NoticeLanguage } from "./languages.js";
import type { NoticeKind, NoticeStore, PrivacyNotice } from "./notice.js";
import type { Schema, SchemaReference, SchemaTable } from "./schema-check.js";
import type { ConsentEvent, DpdpStore } from "./store.js";

export { ACCESS_LOG_DDL, BREACH_DDL, CONSENT_EVENTS_DDL, DPDP_DDL, MIGRATE_0_5_DDL, PRIVACY_NOTICES_DDL, RECORDS_DDL } from "./ddl.js";

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
    action: text("action", { enum: ["grant", "withdraw", "object", "lift-objection"] }).notNull(),
    purposes: jsonb("purposes").$type<string[]>().notNull(),
    noticeVersion: text("notice_version"),
    language: text("language"),
    channel: text("channel"),
    evidence: jsonb("evidence").$type<Record<string, string>>(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectId, t.seq] }),
    // The same constraint DPDP_DDL creates, so drizzle-kit and the plain SQL agree.
    check("dpdp_consent_events_action_check", sql`${t.action} IN ('grant', 'withdraw', 'object', 'lift-objection')`),
  ],
);

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

/** Personal data breaches (Section 8(6), Rule 7). Export it from your Drizzle schema with `consentEvents`. */
export const breaches = pgTable(
  "dpdp_breaches",
  {
    id: text("id").primaryKey(),
    status: text("status").$type<Breach["status"]>().notNull(),
    awareAt: ts("aware_at").notNull(),
    reportDueAt: ts("report_due_at").notNull(),
    data: jsonb("data").$type<Breach>().notNull(),
  },
  (t) => [index("dpdp_breaches_status_idx").on(t.status, t.awareAt)],
);

/** Privacy notices as shown, kept as proof (Section 6(10)). Export it from your Drizzle schema with `consentEvents`. */
export const privacyNotices = pgTable(
  "dpdp_privacy_notices",
  {
    version: text("version").notNull(),
    language: text("language").$type<NoticeLanguage>().notNull(),
    kind: text("kind").$type<NoticeKind>().notNull(),
    content: jsonb("content").$type<PrivacyNotice>().notNull(),
    firstShownAt: ts("first_shown_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.version, t.language, t.kind] })],
);

/** The people affected by each breach, and whether they've been told (Rule 7(1)). */
export const breachNotices = pgTable(
  "dpdp_breach_notices",
  {
    breachId: text("breach_id").notNull(),
    subjectId: text("subject_id").notNull(),
    status: text("status").$type<BreachNotice["status"]>().notNull(),
    addedAt: ts("added_at").notNull(),
    sentAt: ts("sent_at"),
    channel: text("channel"),
  },
  (t) => [primaryKey({ columns: [t.breachId, t.subjectId] }), index("dpdp_breach_notices_status_idx").on(t.breachId, t.status, t.addedAt)],
);

type NoticeRow = typeof breachNotices.$inferSelect;

function noticeFromRow(row: NoticeRow): BreachNotice {
  return {
    breachId: row.breachId,
    subjectId: row.subjectId,
    status: row.status,
    addedAt: row.addedAt.toISOString(),
    ...(row.sentAt ? { sentAt: row.sentAt.toISOString() } : {}),
    ...(row.channel !== null ? { channel: row.channel } : {}),
  };
}

const breachRow = (b: Breach) => ({ id: b.id, status: b.status, awareAt: new Date(b.awareAt), reportDueAt: new Date(b.reportDueAt), data: b });

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
 * `consentEvents`, `rightsRequests`, `erasureTasks`, `accessLog`, `breaches`, `breachNotices` and
 * `privacyNotices` (or `DPDP_DDL`).
 */
export function drizzleStore(db: AnyPgDatabase): DpdpStore & AccessLogStore & BreachStore & NoticeStore {
  const savedNotice = (r: { content: PrivacyNotice; firstShownAt: Date }) => ({ notice: r.content, firstShownAt: new Date(r.firstShownAt).toISOString() });
  return {
    async savePrivacyNotice(notice, at) {
      const rows = await db
        .insert(privacyNotices)
        .values({ version: notice.version, language: notice.language, kind: notice.kind, content: notice, firstShownAt: new Date(at) })
        .onConflictDoNothing()
        .returning({ one: sql<number>`1` });
      return rows.length > 0;
    },
    async getPrivacyNotice(version, language, kind) {
      const [row] = await db
        .select({ content: privacyNotices.content, firstShownAt: privacyNotices.firstShownAt })
        .from(privacyNotices)
        .where(and(eq(privacyNotices.version, version), eq(privacyNotices.language, language), eq(privacyNotices.kind, kind)))
        .limit(1);
      return row ? savedNotice(row) : undefined;
    },
    async listPrivacyNotices() {
      const rows = await db
        .select({ content: privacyNotices.content, firstShownAt: privacyNotices.firstShownAt })
        .from(privacyNotices)
        .orderBy(asc(privacyNotices.firstShownAt), asc(privacyNotices.version), asc(privacyNotices.language), asc(privacyNotices.kind));
      return rows.map(savedNotice);
    },

    async insertBreach(breach) {
      await db.insert(breaches).values(breachRow(breach));
    },
    async getBreach(id) {
      const rows = await db.select({ data: breaches.data }).from(breaches).where(eq(breaches.id, id)).limit(1);
      return rows[0]?.data;
    },
    async updateBreach(breach) {
      const { id, ...rest } = breachRow(breach);
      const unchanged = sql`jsonb_array_length(${breaches.data}->'history') = ${breach.history.length - 1}`;
      const rows = await db.update(breaches).set(rest).where(and(eq(breaches.id, id), unchanged)).returning({ id: breaches.id });
      return rows.length === 1;
    },
    async listBreaches(filter) {
      const rows = await db
        .select({ data: breaches.data })
        .from(breaches)
        .where(filter.status ? eq(breaches.status, filter.status) : undefined)
        .orderBy(desc(breaches.awareAt));
      return rows.map((r) => r.data);
    },
    async addNotices(list) {
      if (list.length === 0) return 0;
      let added = 0;
      for (let i = 0; i < list.length; i += 1000) {
        const rows = list.slice(i, i + 1000).map((n) => ({
          breachId: n.breachId,
          subjectId: n.subjectId,
          status: n.status,
          addedAt: new Date(n.addedAt),
          sentAt: n.sentAt ? new Date(n.sentAt) : null,
          channel: n.channel ?? null,
        }));
        const inserted = await db.insert(breachNotices).values(rows).onConflictDoNothing().returning({ one: sql<number>`1` });
        added += inserted.length;
      }
      return added;
    },
    async markNotices(breachId, subjectIds, sentAt, channel) {
      let changed = 0;
      for (let i = 0; i < subjectIds.length; i += 1000) {
        const updated = await db
          .update(breachNotices)
          .set({ status: "sent", sentAt: new Date(sentAt), channel: channel ?? null })
          .where(
            and(
              eq(breachNotices.breachId, breachId),
              eq(breachNotices.status, "pending"),
              inArray(breachNotices.subjectId, [...subjectIds.slice(i, i + 1000)]),
            ),
          )
          .returning({ one: sql<number>`1` });
        changed += updated.length;
      }
      return changed;
    },
    async listNotices(breachId, filter) {
      const query = db
        .select()
        .from(breachNotices)
        .where(and(eq(breachNotices.breachId, breachId), filter.status ? eq(breachNotices.status, filter.status) : undefined))
        .orderBy(asc(breachNotices.addedAt), asc(breachNotices.subjectId));
      const rows = filter.limit === undefined ? await query : await query.limit(filter.limit);
      return rows.map(noticeFromRow);
    },
    async countNotices(breachId) {
      const [row] = await db
        .select({
          total: count(),
          sent: sql<number>`count(*) filter (where ${breachNotices.status} = 'sent')`.mapWith(Number),
          first: min(breachNotices.sentAt),
          last: max(breachNotices.sentAt),
        })
        .from(breachNotices)
        .where(eq(breachNotices.breachId, breachId));
      return {
        total: Number(row?.total ?? 0),
        sent: Number(row?.sent ?? 0),
        ...(row?.first ? { firstSentAt: new Date(row.first).toISOString() } : {}),
        ...(row?.last ? { lastSentAt: new Date(row.last).toISOString() } : {}),
      };
    },

    async insertAccess(entries) {
      if (entries.length > 0) await db.insert(accessLog).values(entries.map(accessToRow));
    },
    async accessSubjects(filter) {
      const rows = await db.selectDistinct({ subjectId: accessLog.subjectId }).from(accessLog).where(accessWhere(filter));
      return rows.map((r) => r.subjectId);
    },
    async listAccess(filter) {
      const query = db.select().from(accessLog).where(accessWhere(filter)).orderBy(asc(accessLog.at), asc(accessLog.id));
      const rows = filter.limit === undefined ? await query : await query.limit(filter.limit);
      return rows.map(accessFromRow);
    },
    async pruneAccess(before) {
      // Delete in batches, so the first prune of a big table neither holds a long lock nor sends
      // every deleted id back to Node.
      const batch = 5000;
      let total = 0;
      for (;;) {
        const ids = db.select({ id: accessLog.id }).from(accessLog).where(lt(accessLog.at, new Date(before))).limit(batch);
        const deleted = await db
          .delete(accessLog)
          .where(sql`${accessLog.id} IN (${ids})`)
          .returning({ one: sql<number>`1` });
        total += deleted.length;
        if (deleted.length < batch) return total;
      }
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
    const columns = Object.entries(getTableColumns(value)).map(([key, column]) => {
      const type = ["string", "number", "boolean"].includes(column.dataType) ? (column.dataType as "string" | "number" | "boolean") : "other";
      return { name: column.name, ...(key === column.name ? {} : { key }), notNull: column.notNull, type, sqlType: column.getSQLType() } as const;
    });
    const references = foreignKeys(value);
    tables.set(name, { name, columns, ...(references.length ? { references } : {}) });
  }
  return { tables: [...tables.values()] };
}

function accessWhere(filter: AccessFilter) {
  return and(
    filter.subjectId ? eq(accessLog.subjectId, filter.subjectId) : undefined,
    filter.actor ? eq(accessLog.actor, filter.actor) : undefined,
    filter.purpose ? eq(accessLog.purpose, filter.purpose) : undefined,
    filter.from ? gte(accessLog.at, new Date(filter.from)) : undefined,
    filter.to ? lt(accessLog.at, new Date(filter.to)) : undefined,
  );
}

/** A Drizzle table's foreign keys, for Postgres, MySQL and SQLite tables. */
function foreignKeys(table: Table): SchemaReference[] {
  const config = is(table, PgTable)
    ? pgTableConfig(table)
    : is(table, MySqlTable)
      ? mysqlTableConfig(table)
      : is(table, SQLiteTable)
        ? sqliteTableConfig(table)
        : undefined;
  return (config?.foreignKeys ?? []).map((fk) => {
    const ref = fk.reference();
    return { columns: ref.columns.map((c) => c.name), table: getTableName(ref.foreignTable), ...(fk.onDelete ? { onDelete: fk.onDelete } : {}) };
  });
}

/** Rows from `db.execute()`, whichever Postgres driver Drizzle wraps. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
}

/**
 * Data access for your own Postgres tables through Drizzle, for access summaries and erasure.
 * Pass your schema module if data map names are Drizzle property names (`userId`) rather than
 * database column names (`user_id`). Erasure writes each field's `erase` replacement, or NULL;
 * `dpdp-kit audit --schema` checks that each column can take it.
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
    async eraseFields(table, subjectColumn, subjectId, columns, values = {}) {
      if (columns.length === 0) return 0;
      const set = sql.join(
        columns.map((c) => (Object.hasOwn(values, c) && values[c] !== null ? sql`${col(table, c)} = ${values[c]}` : sql`${col(table, c)} = NULL`)),
        sql`, `,
      );
      const result = await db.execute(
        sql`UPDATE ${sql.identifier(table)} SET ${set} WHERE ${where(table, subjectColumn, subjectId)} RETURNING 1`,
      );
      return rowsOf(result).length;
    },
    async updateFields(table, subjectColumn, subjectId, values, only = {}) {
      const entries = Object.entries(values);
      if (entries.length === 0) return 0;
      const set = sql.join(
        entries.map(([c, v]) => (v === null || v === undefined ? sql`${col(table, c)} = NULL` : sql`${col(table, c)} = ${columnValue(v)}`)),
        sql`, `,
      );
      const narrow = Object.entries(only).map(([c, v]) => sql` AND ${col(table, c)} = ${v}`);
      const result = await db.execute(
        sql`UPDATE ${sql.identifier(table)} SET ${set} WHERE ${where(table, subjectColumn, subjectId)}${sql.join(narrow, sql``)} RETURNING 1`,
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
