// Rows of dpdp-kit's tables, read and written the same way by every SQL store (Postgres, SQLite,
// MySQL), so each record comes back exactly as it was saved.
import type { AccessEntry } from "./access.js";
import type { Breach, BreachNotice } from "./breach.js";
import type { NoticeLanguage } from "./languages.js";
import type { ErasureTask, RightsRequest } from "./records.js";
import type { ConsentEvent } from "./store.js";

export type Row = Record<string, unknown>;
/** Columns with their Postgres types; the SQLite and MySQL stores use the names. */
export type Columns = ReadonlyArray<readonly [column: string, type: string]>;

export const iso = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : new Date(v as string | Date).toISOString());
export const num = (v: unknown): number => Number(v ?? 0);
export const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
export const optJson = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : json<T>(v));
export const optText = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
export const jsonParam = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
/** Drop undefined values, so optional properties are absent rather than undefined. */
export const defined = <T>(o: Record<string, unknown>): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

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

export const eventFromRow = (r: Row): ConsentEvent =>
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

export const requestFromRow = (r: Row): RightsRequest =>
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

export const taskFromRow = (r: Row): ErasureTask =>
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

export const accessFromRow = (r: Row): AccessEntry =>
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

export const noticeFromRow = (r: Row): BreachNotice =>
  defined<BreachNotice>({
    breachId: String(r.breach_id),
    subjectId: String(r.subject_id),
    status: r.status,
    addedAt: iso(r.added_at),
    sentAt: iso(r.sent_at),
    channel: optText(r.channel),
  });

export const EVENT_COLUMNS: Columns = [
  ["subject_id", "text"], ["seq", "int"], ["action", "text"], ["purposes", "jsonb"], ["notice_version", "text"], ["language", "text"],
  ["channel", "text"], ["evidence", "jsonb"], ["at", "timestamptz"], ["prev_hash", "text"], ["hash", "text"],
];
export const eventValues = (e: ConsentEvent): unknown[] => [
  e.subjectId, e.seq, e.action, JSON.stringify(e.purposes), e.noticeVersion ?? null, e.language ?? null, e.channel ?? null,
  jsonParam(e.evidence), e.at, e.prevHash, e.hash,
];

export const REQUEST_COLUMNS: Columns = [
  ["id", "text"], ["subject_id", "text"], ["type", "text"], ["status", "text"], ["opened_at", "timestamptz"], ["due_at", "timestamptz"],
  ["closed_at", "timestamptz"], ["details", "jsonb"], ["history", "jsonb"],
];
export const requestValues = (r: RightsRequest): unknown[] => [
  r.id, r.subjectId, r.type, r.status, r.openedAt, r.dueAt, r.closedAt ?? null, jsonParam(r.details), JSON.stringify(r.history),
];

export const TASK_COLUMNS: Columns = [
  ["id", "text"], ["subject_id", "text"], ["reason", "text"], ["kind", "text"], ["table_key", "text"], ["fields", "jsonb"],
  ["processor", "text"], ["purposes", "jsonb"], ["created_at", "timestamptz"], ["due_at", "timestamptz"], ["status", "text"],
  ["attempts", "int"], ["claimed_at", "timestamptz"], ["done_at", "timestamptz"], ["affected", "int"], ["last_error", "text"], ["note", "text"],
];
export const taskValues = (t: ErasureTask): unknown[] => [
  t.id, t.subjectId, t.reason, t.kind, t.table ?? null, jsonParam(t.fields), t.processor ?? null, jsonParam(t.purposes),
  t.createdAt, t.dueAt, t.status, t.attempts, t.claimedAt ?? null, t.doneAt ?? null, t.affected ?? null, t.lastError ?? null, t.note ?? null,
];

export const ACCESS_COLUMNS: Columns = [
  ["id", "text"], ["at", "timestamptz"], ["actor", "text"], ["subject_id", "text"], ["action", "text"], ["purpose", "text"],
  ["fields", "jsonb"], ["out_of_purpose", "jsonb"], ["reason", "text"], ["evidence", "jsonb"],
];
export const accessValues = (e: AccessEntry): unknown[] => [
  e.id, e.at, e.actor, e.subjectId, e.action, e.purpose, jsonParam(e.fields), jsonParam(e.outOfPurpose), e.reason ?? null, jsonParam(e.evidence),
];

export const BREACH_COLUMNS: Columns = [["id", "text"], ["status", "text"], ["aware_at", "timestamptz"], ["report_due_at", "timestamptz"], ["data", "jsonb"]];
export const breachValues = (b: Breach): unknown[] => [b.id, b.status, b.awareAt, b.reportDueAt, JSON.stringify(b)];

export const NOTICE_COLUMNS: Columns = [
  ["breach_id", "text"], ["subject_id", "text"], ["status", "text"], ["added_at", "timestamptz"], ["sent_at", "timestamptz"], ["channel", "text"],
];
