import { asc, desc, eq } from "drizzle-orm";
import { integer, jsonb, type PgDatabase, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { SeqConflictError } from "./errors.js";
import type { NoticeLanguage } from "./languages.js";
import type { ConsentEvent, ConsentStore } from "./store.js";

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

/**
 * Consent store on Postgres through Drizzle. Works with node-postgres, postgres.js, Neon,
 * PGlite and other Drizzle Postgres drivers.
 */
export function drizzleStore(db: AnyPgDatabase): ConsentStore {
  return {
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
  };
}
