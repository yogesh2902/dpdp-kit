import { SeqConflictError } from "./errors.js";
import type { NoticeLanguage } from "./languages.js";
import { type ErasureTask, isRunnable, type RequestStore, type RightsRequest, type TaskStore } from "./records.js";

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

/** A store that also keeps rights requests and erasure tasks. Both built-in stores are one. */
export type DpdpStore = ConsentStore & RequestStore & TaskStore;

/** Whether a store can keep rights requests and erasure tasks too (custom stores may not). */
export function isDpdpStore(store: ConsentStore): store is DpdpStore {
  const s = store as Partial<DpdpStore>;
  return typeof s.insertRequest === "function" && typeof s.insertTasks === "function";
}

/** Keeps everything in memory. For tests and trying the library out; everything is lost on restart. */
export function memoryStore(): DpdpStore & {
  readonly all: Map<string, ConsentEvent[]>;
  readonly requests: Map<string, RightsRequest>;
  readonly tasks: Map<string, ErasureTask>;
} {
  const all = new Map<string, ConsentEvent[]>();
  const requests = new Map<string, RightsRequest>();
  const tasks = new Map<string, ErasureTask>();
  const byDue = (a: ErasureTask, b: ErasureTask) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0);
  return {
    all,
    requests,
    tasks,

    async insertRequest(request) {
      requests.set(request.id, structuredClone(request));
    },
    async getRequest(id) {
      const r = requests.get(id);
      return r && structuredClone(r);
    },
    async updateRequest(request) {
      requests.set(request.id, structuredClone(request));
    },
    async listRequests(filter) {
      return [...requests.values()]
        .filter((r) => (!filter.subjectId || r.subjectId === filter.subjectId) && (!filter.status || r.status === filter.status))
        .sort((a, b) => (a.openedAt < b.openedAt ? -1 : 1))
        .map((r) => structuredClone(r));
    },

    async insertTasks(list) {
      for (const t of list) tasks.set(t.id, structuredClone(t));
    },
    async dueTasks({ limit, ...when }) {
      return [...tasks.values()]
        .filter((t) => isRunnable(t, when))
        .sort(byDue)
        .slice(0, limit)
        .map((t) => structuredClone(t));
    },
    async claimTask({ id, ...when }) {
      const t = tasks.get(id);
      if (!t || !isRunnable(t, when)) return false;
      tasks.set(id, { ...t, status: "running", claimedAt: when.now });
      return true;
    },
    async updateTask(task) {
      tasks.set(task.id, structuredClone(task));
    },
    async getTask(id) {
      const t = tasks.get(id);
      return t && structuredClone(t);
    },
    async listTasks(filter) {
      return [...tasks.values()]
        .filter((t) => (!filter.subjectId || t.subjectId === filter.subjectId) && (!filter.status || t.status === filter.status))
        .sort(byDue)
        .map((t) => structuredClone(t));
    },

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
