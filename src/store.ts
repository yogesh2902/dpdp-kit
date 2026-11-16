import { SeqConflictError } from "./errors.js";
import type { NoticeLanguage } from "./languages.js";

export type ConsentAction = "grant" | "withdraw";

/** One entry in a person's consent record. Entries are only ever added, never changed. */
export interface ConsentEvent {
  subjectId: string;
  /** 1, 2, 3… per subject. */
  seq: number;
  action: ConsentAction;
  purposes: string[];
  /** Version of the notice the person saw, e.g. `"2026-11"`. */
  noticeVersion?: string;
  language?: NoticeLanguage;
  /** Where it happened, e.g. `"web"`, `"android"`, `"call-centre"`. */
  channel?: string;
  /** Proof of the action, e.g. IP address, user agent, form id. */
  evidence?: Record<string, string>;
  /** ISO 8601 timestamp. */
  at: string;
  /** Hash of the previous event for this subject (`null` for the first). */
  prevHash: string | null;
  /** sha256 over this event's fields and `prevHash`. */
  hash: string;
}

/**
 * Where consent events are kept. Implement this to use any database.
 * `insert` must reject a duplicate (subjectId, seq) by throwing `SeqConflictError`, usually via
 * a primary key or unique index on those two columns.
 */
export interface ConsentStore {
  lastEvent(subjectId: string): Promise<ConsentEvent | undefined>;
  insert(event: ConsentEvent): Promise<void>;
  /** All events for a subject, oldest first. */
  events(subjectId: string): Promise<ConsentEvent[]>;
}

/** Keeps events in memory. For tests and trying the library out; everything is lost on restart. */
export function memoryStore(): ConsentStore & { readonly all: Map<string, ConsentEvent[]> } {
  const all = new Map<string, ConsentEvent[]>();
  return {
    all,
    async lastEvent(subjectId) {
      const list = all.get(subjectId);
      return list?.[list.length - 1];
    },
    async insert(event) {
      const list = all.get(event.subjectId) ?? [];
      if (list.some((e) => e.seq === event.seq)) throw new SeqConflictError(event.subjectId, event.seq);
      list.push(structuredClone(event));
      list.sort((a, b) => a.seq - b.seq);
      all.set(event.subjectId, list);
    },
    async events(subjectId) {
      return structuredClone(all.get(subjectId) ?? []);
    },
  };
}
