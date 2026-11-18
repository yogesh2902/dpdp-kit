import type { AccessEntry, AccessLogStore } from "./access.js";
import type { Breach, BreachNotice, BreachStore } from "./breach.js";
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
export function memoryStore(): DpdpStore &
  AccessLogStore &
  BreachStore & {
    readonly all: Map<string, ConsentEvent[]>;
    readonly requests: Map<string, RightsRequest>;
    readonly tasks: Map<string, ErasureTask>;
    readonly accessLog: AccessEntry[];
    readonly breaches: Map<string, Breach>;
    readonly notices: Map<string, BreachNotice>;
  } {
  const all = new Map<string, ConsentEvent[]>();
  const requests = new Map<string, RightsRequest>();
  const tasks = new Map<string, ErasureTask>();
  const accessLog: AccessEntry[] = [];
  const breaches = new Map<string, Breach>();
  const notices = new Map<string, BreachNotice>();
  const noticeKey = (breachId: string, subjectId: string) => `${breachId}\u0000${subjectId}`;
  const noticesOf = (breachId: string) => [...notices.values()].filter((n) => n.breachId === breachId);
  const byDue = (a: ErasureTask, b: ErasureTask) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0);
  return {
    all,
    requests,
    tasks,
    accessLog,
    breaches,
    notices,

    async insertBreach(breach) {
      breaches.set(breach.id, structuredClone(breach));
    },
    async getBreach(id) {
      const b = breaches.get(id);
      return b && structuredClone(b);
    },
    async updateBreach(breach) {
      breaches.set(breach.id, structuredClone(breach));
    },
    async listBreaches(filter) {
      return [...breaches.values()]
        .filter((b) => !filter.status || b.status === filter.status)
        .sort((a, b) => (a.awareAt < b.awareAt ? 1 : a.awareAt > b.awareAt ? -1 : 0))
        .map((b) => structuredClone(b));
    },
    async addNotices(list) {
      let added = 0;
      for (const n of list) {
        const key = noticeKey(n.breachId, n.subjectId);
        if (notices.has(key)) continue;
        notices.set(key, structuredClone(n));
        added++;
      }
      return added;
    },
    async markNotices(breachId, subjectIds, sentAt, channel) {
      let changed = 0;
      for (const subjectId of subjectIds) {
        const n = notices.get(noticeKey(breachId, subjectId));
        if (!n || n.status === "sent") continue;
        notices.set(noticeKey(breachId, subjectId), { ...n, status: "sent", sentAt, ...(channel !== undefined ? { channel } : {}) });
        changed++;
      }
      return changed;
    },
    async listNotices(breachId, filter) {
      const list = noticesOf(breachId)
        .filter((n) => !filter.status || n.status === filter.status)
        .sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0))
        .map((n) => structuredClone(n));
      return filter.limit === undefined ? list : list.slice(0, filter.limit);
    },
    async countNotices(breachId) {
      const list = noticesOf(breachId);
      const sentTimes = list.flatMap((n) => (n.sentAt ? [n.sentAt] : [])).sort();
      return {
        total: list.length,
        sent: sentTimes.length,
        ...(sentTimes.length ? { firstSentAt: sentTimes[0]!, lastSentAt: sentTimes[sentTimes.length - 1]! } : {}),
      };
    },

    async insertAccess(entries) {
      for (const e of entries) accessLog.push(structuredClone(e));
    },
    async listAccess(filter) {
      const list = accessLog
        .filter(
          (e) =>
            (!filter.subjectId || e.subjectId === filter.subjectId) &&
            (!filter.actor || e.actor === filter.actor) &&
            (!filter.purpose || e.purpose === filter.purpose) &&
            (!filter.from || e.at >= filter.from) &&
            (!filter.to || e.at < filter.to),
        )
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        .map((e) => structuredClone(e));
      return filter.limit === undefined ? list : list.slice(0, filter.limit);
    },
    async pruneAccess(before) {
      const keep = accessLog.filter((e) => e.at >= before);
      const deleted = accessLog.length - keep.length;
      accessLog.splice(0, accessLog.length, ...keep);
      return deleted;
    },

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

/**
 * Purposes whose latest event is a grant: the person's consent state. Pass `until` (ISO 8601) for
 * the state at that moment, counting only events at or before it.
 */
export function grantedPurposes(events: readonly ConsentEvent[], until?: string): Set<string> {
  const granted = new Set<string>();
  for (const e of events) {
    if (until !== undefined && e.at > until) break;
    for (const p of e.purposes) {
      if (e.action === "grant") granted.add(p);
      else granted.delete(p);
    }
  }
  return granted;
}
