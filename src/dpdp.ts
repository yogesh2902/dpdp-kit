import { randomUUID } from "node:crypto";
import { audit, hasErrors } from "./audit.js";
import type { DpdpConfig } from "./config.js";
import type { DataAccess } from "./data-access.js";
import { type ErasurePlan, planErasure } from "./erasure.js";
import { DpdpError, SeqConflictError } from "./errors.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isNoticeLanguage, type NoticeLanguage } from "./languages.js";
import {
  type ErasureTask,
  REQUEST_TYPES,
  type RequestFilter,
  type RequestType,
  type RightsRequest,
  type TaskFilter,
} from "./records.js";
import { type ProcessorHooks, type RunReport, runDueTasks, tasksFromPlan } from "./retention.js";
import { type AccessSummary, buildAccessSummary, dueAt } from "./rights.js";
import { type ConsentAction, type ConsentEvent, type ConsentStore, type DpdpStore, isDpdpStore } from "./store.js";

export interface ConsentMeta {
  noticeVersion?: string;
  language?: NoticeLanguage;
  channel?: string;
  evidence?: Record<string, string>;
}

export type VerifyResult =
  | { ok: true; events: number }
  | { ok: false; events: number; brokenAt: number; reason: "hash-mismatch" | "chain-broken" | "seq-gap" };

export interface DpdpOptions<P extends string> {
  config: DpdpConfig<P>;
  /** `memoryStore()`, `drizzleStore(db)`, or your own. Rights and retention need a full `DpdpStore`. */
  store: ConsentStore;
  /**
   * How to reach the personal data in your tables, for access summaries and erasure:
   * `drizzleData(db)` from `dpdp-kit/drizzle`, or your own `DataAccess`.
   */
  data?: DataAccess;
  /** Hooks for each processor in `config.processors`, to stop or erase on their side. */
  processors?: Partial<Record<string, ProcessorHooks>>;
  /** Clock, for tests. */
  now?: () => Date;
  /** Attempts when two writes for the same person race. Default 5. */
  maxRetries?: number;
}

export interface Dpdp<P extends string> {
  readonly config: DpdpConfig<P>;
  readonly consent: {
    /** Record that the person agreed to these consent purposes. */
    grant(subjectId: string, purposes: readonly P[], meta?: ConsentMeta): Promise<ConsentEvent>;
    /**
     * Record that the person withdrew consent. Returns the erasure plan and, when the store keeps
     * tasks, schedules it: `retention.run()` carries the tasks out when they're due.
     */
    withdraw(
      subjectId: string,
      purposes: readonly P[],
      meta?: ConsentMeta,
    ): Promise<{ event: ConsentEvent; erasure: ErasurePlan; tasks: ErasureTask[] }>;
    /**
     * Whether you hold consent, or don't need it, for this purpose. For consent purposes: true when
     * the person's latest choice was a grant. For legitimate-use purposes: always true, because
     * there's nothing to record. But under Section 7(a) you must stop once the person tells you they
     * don't want their data used; v0.1 doesn't record that yet.
     */
    has(subjectId: string, purpose: P): Promise<boolean>;
    /** Consent purposes this person currently has granted. */
    active(subjectId: string): Promise<P[]>;
    history(subjectId: string): Promise<ConsentEvent[]>;
    /** Recompute every hash for this person and check nothing was edited, removed or reordered. */
    verify(subjectId: string): Promise<VerifyResult>;
  };
  readonly erasure: {
    /** What deleting this person's account would erase, delete or hold. Changes nothing. */
    plan(subjectId: string, input: { reason: "account-deletion" }): Promise<ErasurePlan>;
    /** Turn a plan into dated tasks for `retention.run()`. */
    schedule(plan: ErasurePlan): Promise<ErasureTask[]>;
    /** Plan and schedule erasure for a deleted account. */
    deleteAccount(subjectId: string): Promise<{ plan: ErasurePlan; tasks: ErasureTask[] }>;
  };
  readonly retention: {
    /**
     * Carry out every due erasure task: null out or delete rows through `data`, and call processor
     * hooks. Run it on a schedule (a daily cron is plenty). Safe to run from several processes.
     */
    run(input?: { limit?: number }): Promise<RunReport>;
    tasks(filter?: TaskFilter): Promise<ErasureTask[]>;
    /** Mark a `manual` or `failed` task as handled by a person. */
    markDone(taskId: string, note: string): Promise<ErasureTask>;
  };
  readonly rights: {
    /** Record a request (Sections 11–14). It's due after `config.rights.responseWithin` (default 90 days). */
    open(subjectId: string, type: RequestType, details?: Record<string, unknown>): Promise<RightsRequest>;
    get(id: string): Promise<RightsRequest | undefined>;
    /** Requests, oldest first. `overdue: true` gives open requests past their due date. */
    list(filter?: RequestFilter & { overdue?: boolean }): Promise<RightsRequest[]>;
    resolve(id: string, note?: string): Promise<RightsRequest>;
    reject(id: string, reason: string): Promise<RightsRequest>;
    /** What you hold about the person and who you shared it with (Section 11(1)). Needs `data`. */
    summary(subjectId: string): Promise<AccessSummary>;
    /**
     * Erase on request (Section 12(3)): every purpose ends except those in `keepFor`, which you still
     * need for the specified purpose. Legal holds and `minimumRetention` still apply. Pass the
     * request id to resolve it.
     */
    erase(
      subjectId: string,
      input?: { keepFor?: readonly P[]; requestId?: string },
    ): Promise<{ plan: ErasurePlan; tasks: ErasureTask[] }>;
  };
}

type HashedFields = Omit<ConsentEvent, "hash">;

export function hashEvent(event: HashedFields): string {
  return sha256(
    canonicalJson({
      subjectId: event.subjectId,
      seq: event.seq,
      action: event.action,
      purposes: event.purposes,
      noticeVersion: event.noticeVersion,
      language: event.language,
      channel: event.channel,
      evidence: event.evidence,
      at: event.at,
      prevHash: event.prevHash,
    }),
  );
}

/** Purposes whose latest event is a grant. */
function grantedFrom(events: readonly ConsentEvent[]): Set<string> {
  const granted = new Set<string>();
  for (const e of events) {
    for (const p of e.purposes) {
      if (e.action === "grant") granted.add(p);
      else granted.delete(p);
    }
  }
  return granted;
}

/**
 * Create the runtime. Throws `DpdpError("invalid-config")` if `audit()` finds errors, so a broken
 * data map fails at start-up instead of during an erasure.
 */
export function createDpdp<const P extends string>(options: DpdpOptions<P>): Dpdp<P> {
  const { config, store } = options;
  const now = options.now ?? (() => new Date());
  const maxRetries = options.maxRetries ?? 5;

  const issues = audit(config);
  if (hasErrors(issues)) {
    const lines = issues.filter((i) => i.level === "error").map((i) => `  ${i.path}: ${i.message}`);
    throw new DpdpError("invalid-config", `dpdp-kit config has errors:\n${lines.join("\n")}`, issues);
  }

  const purposes = config.purposes as Record<string, DpdpConfig["purposes"][string]>;
  const legitimate = Object.keys(purposes).filter((p) => purposes[p]?.basis === "legitimate-use");

  function checkSubject(subjectId: unknown): asserts subjectId is string {
    if (typeof subjectId !== "string" || subjectId.length === 0) {
      throw new DpdpError("invalid-subject", "subjectId must be a non-empty string");
    }
  }

  function checkConsentPurposes(list: readonly string[]) {
    if (list.length === 0) throw new DpdpError("no-purposes", "Pass at least one purpose");
    for (const p of list) {
      const def = purposes[p];
      if (!def) throw new DpdpError("unknown-purpose", `Unknown purpose ${JSON.stringify(p)}`);
      if (def.basis !== "consent") {
        throw new DpdpError(
          "not-a-consent-purpose",
          `${JSON.stringify(p)} is a legitimate-use purpose; consent isn't granted or withdrawn for it`,
        );
      }
    }
  }

  async function append(
    subjectId: string,
    action: ConsentAction,
    list: readonly string[],
    meta: ConsentMeta = {},
  ): Promise<ConsentEvent> {
    checkSubject(subjectId);
    checkConsentPurposes(list);
    if (meta.language !== undefined && !isNoticeLanguage(meta.language)) {
      throw new DpdpError("invalid-language", `Unknown notice language ${JSON.stringify(meta.language)}`);
    }
    const unique = [...new Set(list)];

    for (let attempt = 1; ; attempt++) {
      const last = await store.lastEvent(subjectId);
      const fields: HashedFields = {
        subjectId,
        seq: (last?.seq ?? 0) + 1,
        action,
        purposes: unique,
        ...(meta.noticeVersion !== undefined ? { noticeVersion: meta.noticeVersion } : {}),
        ...(meta.language !== undefined ? { language: meta.language } : {}),
        ...(meta.channel !== undefined ? { channel: meta.channel } : {}),
        ...(meta.evidence !== undefined ? { evidence: { ...meta.evidence } } : {}),
        at: now().toISOString(),
        prevHash: last?.hash ?? null,
      };
      const event: ConsentEvent = { ...fields, hash: hashEvent(fields) };
      try {
        await store.insert(event);
        return event;
      } catch (err) {
        if (err instanceof SeqConflictError && attempt < maxRetries) continue;
        if (err instanceof SeqConflictError) {
          throw new DpdpError("write-conflict", `Gave up after ${maxRetries} conflicting writes for one subject`);
        }
        throw err;
      }
    }
  }

  async function activeFor(subjectId: string): Promise<P[]> {
    checkSubject(subjectId);
    return [...grantedFrom(await store.events(subjectId))] as P[];
  }

  const nowIso = () => now().toISOString();
  const processorHooks = (options.processors ?? {}) as Record<string, ProcessorHooks>;

  function fullStore(feature: string): DpdpStore {
    if (!isDpdpStore(store)) {
      throw new DpdpError(
        "store-unsupported",
        `${feature} needs a store that keeps requests and tasks: memoryStore(), drizzleStore(db), or a full DpdpStore`,
      );
    }
    return store;
  }

  function dataAccess(): DataAccess {
    if (!options.data) {
      throw new DpdpError("no-data-access", "Pass `data` to createDpdp (e.g. drizzleData(db)) to read or erase personal data");
    }
    return options.data;
  }

  async function schedule(plan: ErasurePlan): Promise<ErasureTask[]> {
    const tasks = tasksFromPlan(config, plan, nowIso());
    if (tasks.length > 0) await fullStore("Scheduling erasure").insertTasks(tasks);
    return tasks;
  }

  async function requireRequest(id: string): Promise<RightsRequest> {
    const request = await fullStore("Rights requests").getRequest(id);
    if (!request) throw new DpdpError("request-not-found", `No rights request with id ${JSON.stringify(id)}`);
    return request;
  }

  async function close(id: string, status: "resolved" | "rejected", note?: string): Promise<RightsRequest> {
    const request = await requireRequest(id);
    if (request.status !== "open") {
      throw new DpdpError("request-closed", `Request ${id} is already ${request.status}`);
    }
    const at = nowIso();
    const closed: RightsRequest = {
      ...request,
      status,
      closedAt: at,
      history: [...request.history, { at, status, ...(note !== undefined ? { note } : {}) }],
    };
    await fullStore("Rights requests").updateRequest(closed);
    return closed;
  }

  function accountPlan(subjectId: string, reason: "account-deletion" | "erasure-request", keepFor: readonly string[]) {
    for (const p of keepFor) {
      if (!purposes[p]) throw new DpdpError("unknown-purpose", `Unknown purpose ${JSON.stringify(p)}`);
    }
    return planErasure(config, {
      subjectId,
      reason,
      ended: Object.keys(purposes).filter((p) => !keepFor.includes(p)),
      remaining: [...keepFor],
    });
  }

  return {
    config,
    consent: {
      grant: (subjectId, list, meta) => append(subjectId, "grant", list, meta),

      async withdraw(subjectId, list, meta) {
        const event = await append(subjectId, "withdraw", list, meta);
        const stillGranted = await activeFor(subjectId);
        const erasure = planErasure(config, {
          subjectId,
          reason: "withdrawal",
          ended: event.purposes,
          remaining: [...legitimate, ...stillGranted],
        });
        const tasks = isDpdpStore(store) ? await schedule(erasure) : [];
        return { event, erasure, tasks };
      },

      async has(subjectId, purpose) {
        checkSubject(subjectId);
        const def = purposes[purpose];
        if (!def) throw new DpdpError("unknown-purpose", `Unknown purpose ${JSON.stringify(purpose)}`);
        if (def.basis === "legitimate-use") return true;
        return grantedFrom(await store.events(subjectId)).has(purpose);
      },

      active: activeFor,

      async history(subjectId) {
        checkSubject(subjectId);
        return store.events(subjectId);
      },

      async verify(subjectId) {
        checkSubject(subjectId);
        const events = await store.events(subjectId);
        let prev: ConsentEvent | undefined;
        for (const e of events) {
          if (e.seq !== (prev?.seq ?? 0) + 1) {
            return { ok: false, events: events.length, brokenAt: e.seq, reason: "seq-gap" };
          }
          if (e.prevHash !== (prev?.hash ?? null)) {
            return { ok: false, events: events.length, brokenAt: e.seq, reason: "chain-broken" };
          }
          const { hash, ...fields } = e;
          if (hashEvent(fields) !== hash) {
            return { ok: false, events: events.length, brokenAt: e.seq, reason: "hash-mismatch" };
          }
          prev = e;
        }
        return { ok: true, events: events.length };
      },
    },

    erasure: {
      async plan(subjectId, input) {
        checkSubject(subjectId);
        return accountPlan(subjectId, input.reason, []);
      },

      schedule,

      async deleteAccount(subjectId) {
        checkSubject(subjectId);
        const plan = accountPlan(subjectId, "account-deletion", []);
        return { plan, tasks: await schedule(plan) };
      },
    },

    retention: {
      async run(input = {}) {
        return runDueTasks({
          config,
          store: fullStore("The retention runner"),
          data: options.data,
          processors: processorHooks,
          now: nowIso(),
          limit: input.limit ?? 500,
        });
      },

      async tasks(filter = {}) {
        return fullStore("Erasure tasks").listTasks(filter);
      },

      async markDone(taskId, note) {
        const tasks = fullStore("Erasure tasks");
        const task = await tasks.getTask(taskId);
        if (!task) throw new DpdpError("task-not-found", `No erasure task with id ${JSON.stringify(taskId)}`);
        if (task.status !== "manual" && task.status !== "failed") {
          throw new DpdpError("task-not-manual", `Task ${taskId} is ${task.status}; only manual or failed tasks can be marked done`);
        }
        const done: ErasureTask = { ...task, status: "done", doneAt: nowIso(), note };
        await tasks.updateTask(done);
        return done;
      },
    },

    rights: {
      async open(subjectId, type, details) {
        checkSubject(subjectId);
        if (!REQUEST_TYPES.includes(type)) {
          throw new DpdpError("invalid-request-type", `Unknown request type ${JSON.stringify(type)}`);
        }
        const openedAt = nowIso();
        const request: RightsRequest = {
          id: randomUUID(),
          subjectId,
          type,
          status: "open",
          openedAt,
          dueAt: dueAt(config, type, openedAt),
          ...(details !== undefined ? { details: structuredClone(details) } : {}),
          history: [{ at: openedAt, status: "open" }],
        };
        await fullStore("Rights requests").insertRequest(request);
        return request;
      },

      get: (id) => fullStore("Rights requests").getRequest(id),

      async list(filter = {}) {
        const { overdue, ...rest } = filter;
        const list = await fullStore("Rights requests").listRequests(overdue ? { ...rest, status: "open" } : rest);
        if (!overdue) return list;
        const at = nowIso();
        return list.filter((r) => r.dueAt < at);
      },

      resolve: (id, note) => close(id, "resolved", note),

      reject: (id, reason) => close(id, "rejected", reason),

      async summary(subjectId) {
        checkSubject(subjectId);
        return buildAccessSummary({
          config,
          data: dataAccess(),
          subjectId,
          consents: await activeFor(subjectId),
          now: nowIso(),
        });
      },

      async erase(subjectId, input = {}) {
        checkSubject(subjectId);
        if (input.requestId) {
          const request = await requireRequest(input.requestId);
          if (request.subjectId !== subjectId) {
            throw new DpdpError("request-not-found", `Request ${input.requestId} belongs to a different person`);
          }
        }
        const plan = accountPlan(subjectId, "erasure-request", input.keepFor ?? []);
        const tasks = await schedule(plan);
        if (input.requestId) {
          await close(input.requestId, "resolved", `Erasure scheduled: ${tasks.length} task(s)`);
        }
        return { plan, tasks };
      },
    },
  };
}
