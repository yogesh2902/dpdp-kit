import { randomUUID } from "node:crypto";
import {
  type AccessAction,
  type AccessEntry,
  type AccessFilter,
  type AccessLogStore,
  type AccessReview,
  accessId,
  DEFAULT_ACCESS_LOG_RETENTION,
  fieldsOutsidePurpose,
  isAccessLogStore,
  resolveFields,
  reviewAccess,
} from "./access.js";
import { audit, hasErrors } from "./audit.js";
import {
  BOARD_REPORT_WITHIN_HOURS,
  type Breach,
  type BreachInput,
  type BreachNotice,
  type BoardReport,
  type BoardReportInput,
  type BreachStatus,
  type BreachStore,
  breachStatus,
  isBreachStore,
  type PersonNotice,
  personNotice,
} from "./breach.js";
import type { DpdpConfig } from "./config.js";
import type { DataAccess } from "./data-access.js";
import { type Duration, durationMs } from "./duration.js";
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
import {
  type ConsentAction,
  type ConsentEvent,
  type ConsentStore,
  type DpdpStore,
  grantedPurposes,
  isDpdpStore,
} from "./store.js";

export interface ConsentMeta {
  noticeVersion?: string;
  language?: NoticeLanguage;
  channel?: string;
  evidence?: Record<string, string>;
}

export type VerifyResult =
  | { ok: true; events: number }
  | { ok: false; events: number; brokenAt: number; reason: "hash-mismatch" | "chain-broken" | "seq-gap" };

export interface AccessInput<P extends string> {
  /** Who is accessing the data: a staff user's id, a service or job name. */
  actor: string;
  /** Whose data. Pass `subjectIds` instead for a list or an export. */
  subjectId?: string;
  subjectIds?: readonly string[];
  /** Why: one of your purposes. */
  purpose: P;
  /** Default `"read"`. */
  action?: AccessAction;
  /**
   * What is accessed, as data map keys: `"users.phone"`, or `"users"` / `"users.*"` for every
   * personal field of a table. Fields not held for `purpose` are recorded as `outOfPurpose`.
   */
  fields?: readonly string[];
  /** Free text, e.g. a support ticket number. */
  reason?: string;
  /** Details of the request, e.g. IP address, user agent, request id. */
  evidence?: Record<string, string>;
}

export interface AccessOptions {
  /**
   * What to do when a log entry reads fields that aren't held for its purpose. `"record"` (default)
   * logs it with `outOfPurpose` for `review()` to report; `"throw"` logs it, then throws
   * `DpdpError("out-of-purpose")` so the caller can refuse.
   */
  outOfPurpose?: "record" | "throw";
}

/** What each event carries. Events fire after the change is saved. */
export interface DpdpEvents {
  "consent.granted": { event: ConsentEvent };
  "consent.withdrawn": { event: ConsentEvent; erasure: ErasurePlan; tasks: ErasureTask[] };
  "erasure.scheduled": { plan: ErasurePlan; tasks: ErasureTask[] };
  "retention.ran": { report: RunReport };
  "rights.opened": { request: RightsRequest };
  "rights.closed": { request: RightsRequest };
  "access.logged": { entries: AccessEntry[] };
  "daily.ran": { report: DailyReport };
  "breach.opened": { breach: Breach };
  "breach.reported": { breach: Breach };
  "breach.closed": { breach: Breach };
}

/** What `daily()` did. A part the store can't do (a custom store without the access log) is listed in `skipped`. */
export interface DailyReport {
  /** When the run started (ISO 8601). */
  at: string;
  /** Erasure tasks carried out by `retention.run()`. */
  retention?: RunReport;
  /** Access log entries older than the retention period, deleted by `access.prune()`. */
  accessPruned?: number;
  /** `access.review()` of the last day. */
  review?: AccessReview;
  /** Open rights requests past their due date. */
  overdueRequests?: RightsRequest[];
  /** Open breaches with their Rule 7 deadlines and what's left to do. */
  breaches?: BreachStatus[];
  skipped: Array<"retention" | "access" | "rights" | "breaches">;
  /** Steps that failed. The other steps still ran. */
  errors: Array<{ step: "retention" | "rights" | "access-prune" | "access-review" | "breaches"; message: string; error: unknown }>;
}

export type DpdpEventName = keyof DpdpEvents;
export type DpdpListener<E extends DpdpEventName> = (payload: DpdpEvents[E]) => void | Promise<void>;

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
  /** Access log behaviour. See `AccessOptions`. */
  access?: AccessOptions;
  /**
   * Called when an event listener throws or rejects. Listeners never break the operation that
   * fired them. Default: `console.error`.
   */
  onListenerError?: (error: unknown, event: DpdpEventName) => void;
}

export interface Dpdp<P extends string> {
  readonly config: DpdpConfig<P>;
  /**
   * Listen for an event, e.g. to feed your own audit trail, alerts or analytics. Listeners run after
   * the change is saved, don't delay the call that fired them, and can't make it fail. Returns a
   * function that removes the listener.
   *
   * ```ts
   * dpdp.on("consent.withdrawn", ({ event }) => analytics.forget(event.subjectId, event.purposes));
   * ```
   */
  on<E extends DpdpEventName>(event: E, listener: DpdpListener<E>): () => void;
  /**
   * The daily upkeep in one call: carry out due erasure (`retention.run()`), prune access logs past
   * their retention (`access.prune()`), review the last day of access (`access.review()`), and list
   * overdue rights requests. Run it once a day: from `startDaily()` in `dpdp-kit/schedule`, node-cron,
   * a BullMQ repeatable job, or your platform's cron. Safe to run from several servers at once.
   */
  daily(input?: {
    review?: {
      /** Start of the review (ISO 8601). Default: a day before now. Pass the end of the last successful review so no day is missed. */
      from?: string;
      window?: Duration;
      maxSubjects?: number;
      ignoreActors?: readonly string[];
    };
  }): Promise<DailyReport>;
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
  readonly access: {
    /**
     * Record that someone accessed a person's personal data, and why (Rule 6(1)(c)). One entry per
     * person. Needs a store that keeps the access log: `memoryStore()`, `drizzleStore(db)`, or your
     * own `AccessLogStore`.
     */
    log(input: AccessInput<P>): Promise<AccessEntry[]>;
    /** Entries matching the filter, oldest first: for investigating a person, an actor, or a period. */
    list(filter?: AccessFilter): Promise<AccessEntry[]>;
    /**
     * Look for signs of unauthorised access (Rule 6(1)(c)): fields read for a purpose they aren't
     * held for, consent purposes used without consent at the time, and one actor reaching more
     * than `maxSubjects` people (default 100) within `window` (default `"1h"`). Reviews the last day
     * unless `from` / `to` are given. Run it daily.
     */
    review(input?: {
      from?: string;
      to?: string;
      window?: Duration;
      maxSubjects?: number;
      /** Actors exempt from bulk-access findings, e.g. a nightly export job that reaches everyone. */
      ignoreActors?: readonly string[];
    }): Promise<AccessReview>;
    /**
     * Delete entries older than `config.security.accessLogRetention` (default and minimum one year,
     * Rule 6(1)(e)). Run it with the retention runner.
     */
    prune(): Promise<{ deleted: number; before: string }>;
  };
  /**
   * Personal data breaches (Section 8(6), Rule 7): record one, find and tell the people affected,
   * and track the Board's deadlines. Needs a store that keeps breaches: `memoryStore()`,
   * `drizzleStore(db)`, or your own `BreachStore`.
   */
  readonly breach: {
    /** Record a breach. The 72-hour clock for the Board's detailed report starts at `awareAt` (default now). */
    open(input: BreachInput): Promise<Breach>;
    /** Fill in or correct details, e.g. consequences and safety steps once they're known. */
    update(id: string, input: Partial<Omit<BreachInput, "awareAt">>): Promise<Breach>;
    get(id: string): Promise<Breach | undefined>;
    /** Breaches, newest first. */
    list(filter?: { status?: Breach["status"] }): Promise<Breach[]>;
    /** Deadlines and what's left to do. */
    status(id: string): Promise<BreachStatus>;
    /** Record people affected. People already recorded are left as they are. Returns how many were new. */
    addAffected(id: string, subjectIds: readonly string[]): Promise<number>;
    /**
     * Record as affected everyone in the access log matching the filter, e.g. everyone a compromised
     * account read: `{ actor: "support:ravi", from: "2027-06-01T00:00:00Z" }`. Returns how many were new.
     */
    addAffectedFromAccessLog(id: string, filter: Omit<AccessFilter, "limit">): Promise<number>;
    /** The notice to send each affected person, Rule 7(1)(a)–(e). `missing` lists parts still to fill in. */
    notice(id: string): Promise<PersonNotice>;
    /** People not yet told, oldest first. */
    pending(id: string, limit?: number): Promise<BreachNotice[]>;
    /** Record that these people were told. Returns how many changed. */
    markNotified(id: string, subjectIds: readonly string[], input?: { channel?: string; at?: string }): Promise<number>;
    /** Record that you told the Board, without delay (Rule 7(2)(a)). */
    boardNotified(id: string, input?: { at?: string }): Promise<Breach>;
    /** Save parts (i)–(v) of the detailed report. */
    updateReport(id: string, parts: BoardReportInput): Promise<Breach>;
    /** The detailed report, Rule 7(2)(b)(i)–(vi). Part (vi) comes from the notice records. */
    boardReport(id: string): Promise<BoardReport>;
    /** Record that you sent the detailed report to the Board. */
    reportSent(id: string, input?: { at?: string }): Promise<Breach>;
    /** Record a longer period the Board allowed on your written request (Rule 7(2)(b)). */
    extend(id: string, input: { until: string; reference: string }): Promise<Breach>;
    close(id: string, note?: string): Promise<Breach>;
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
        if (err instanceof SeqConflictError && attempt < maxRetries) {
          // Back off a little, with jitter, so writers racing for the same person spread out.
          await new Promise((r) => setTimeout(r, Math.random() * 5 * attempt));
          continue;
        }
        if (err instanceof SeqConflictError) {
          throw new DpdpError("write-conflict", `Gave up after ${maxRetries} conflicting writes for one subject`);
        }
        throw err;
      }
    }
  }

  async function activeFor(subjectId: string): Promise<P[]> {
    checkSubject(subjectId);
    return [...grantedPurposes(await store.events(subjectId))] as P[];
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
    if (tasks.length > 0) {
      await fullStore("Scheduling erasure").insertTasks(tasks);
      emit("erasure.scheduled", { plan, tasks });
    }
    return tasks;
  }

  const listeners = new Map<DpdpEventName, Set<DpdpListener<any>>>();
  const onListenerError = options.onListenerError ?? ((err: unknown, event: DpdpEventName) => console.error(`dpdp-kit: a "${event}" listener failed`, err));

  function emit<E extends DpdpEventName>(event: E, payload: DpdpEvents[E]): void {
    for (const listener of listeners.get(event) ?? []) {
      // Run after the current call returns, and never let a listener's error reach the caller.
      setImmediate(() => {
        try {
          // Each listener gets its own copy, so one can't change what the caller or another listener sees.
          Promise.resolve(listener(structuredClone(payload))).catch((err: unknown) => onListenerError(err, event));
        } catch (err) {
          onListenerError(err, event);
        }
      });
    }
  }

  function breachStore(): BreachStore {
    if (!isBreachStore(store)) {
      throw new DpdpError(
        "store-unsupported",
        "Breach records need a store that keeps them: memoryStore(), drizzleStore(db), or your own BreachStore",
      );
    }
    return store;
  }

  function checkIso(value: string | undefined, name: string): void {
    if (value !== undefined && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
      throw new DpdpError("invalid-input", `${name} must be an ISO 8601 date and time, e.g. "2027-06-01T10:00:00Z"`);
    }
  }

  async function requireBreach(id: string, open = false): Promise<Breach> {
    const breach = await breachStore().getBreach(id);
    if (!breach) throw new DpdpError("breach-not-found", `No breach with id ${JSON.stringify(id)}`);
    if (open && breach.status !== "open") throw new DpdpError("breach-closed", `Breach ${id} is closed`);
    return breach;
  }

  /**
   * Change an open breach: read it, apply the change, and save it only if no one else saved it in
   * between (the store compares history lengths). On a clash, read it again and retry, so two
   * people updating the same breach at once both keep their changes.
   */
  async function changeBreach(id: string, change: (breach: Breach) => Breach, event: string, note?: string): Promise<Breach> {
    for (let attempt = 1; ; attempt++) {
      const breach = await requireBreach(id, true);
      const next: Breach = { ...change(breach), history: [...breach.history, { at: nowIso(), event, ...(note !== undefined ? { note } : {}) }] };
      if ((await breachStore().updateBreach(next)) !== false) return next;
      if (attempt >= maxRetries) throw new DpdpError("write-conflict", `Gave up after ${maxRetries} conflicting updates to breach ${id}`);
      await new Promise((r) => setTimeout(r, Math.random() * 5 * attempt));
    }
  }

  function breachFields(keys: readonly string[] | undefined): string[] {
    const { fields, unknown } = resolveFields(config, keys ?? []);
    if (unknown.length > 0) {
      throw new DpdpError("unknown-field", `Not in the data map: ${unknown.map((k) => JSON.stringify(k)).join(", ")}`);
    }
    return fields;
  }

  const BREACH_TEXT = ["occurredAt", "description", "extent", "location", "likelyImpact", "consequences", "measures", "safetySteps"] as const;

  function accessStore(): AccessLogStore {
    if (!isAccessLogStore(store)) {
      throw new DpdpError(
        "store-unsupported",
        "The access log needs a store that keeps it: memoryStore(), drizzleStore(db), or your own AccessLogStore",
      );
    }
    return store;
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
    emit("rights.closed", { request: closed });
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

  const api: Dpdp<P> = {
    config,

    async daily(input = {}) {
      const report: DailyReport = { at: nowIso(), skipped: [], errors: [] };
      // Each step runs even if an earlier one fails: one broken table mustn't stop erasure.
      const step = async (name: DailyReport["errors"][number]["step"], run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          report.errors.push({ step: name, message: error instanceof Error ? error.message : String(error), error });
        }
      };
      if (isDpdpStore(store)) {
        await step("retention", async () => {
          report.retention = await api.retention.run();
        });
        await step("rights", async () => {
          report.overdueRequests = await api.rights.list({ overdue: true });
        });
      } else {
        report.skipped.push("retention", "rights");
      }
      if (isBreachStore(store)) {
        await step("breaches", async () => {
          const open = await breachStore().listBreaches({ status: "open" });
          const now = nowIso();
          report.breaches = await Promise.all(open.map(async (b) => breachStatus(b, await breachStore().countNotices(b.id), now)));
        });
      } else {
        report.skipped.push("breaches");
      }
      if (isAccessLogStore(store)) {
        await step("access-prune", async () => {
          report.accessPruned = (await api.access.prune()).deleted;
        });
        await step("access-review", async () => {
          report.review = await api.access.review({ ...input.review });
        });
      } else {
        report.skipped.push("access");
      }
      emit("daily.ran", { report });
      return report;
    },

    on(event, listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },

    consent: {
      async grant(subjectId, list, meta) {
        const event = await append(subjectId, "grant", list, meta);
        emit("consent.granted", { event });
        return event;
      },

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
        emit("consent.withdrawn", { event, erasure, tasks });
        return { event, erasure, tasks };
      },

      async has(subjectId, purpose) {
        checkSubject(subjectId);
        const def = purposes[purpose];
        if (!def) throw new DpdpError("unknown-purpose", `Unknown purpose ${JSON.stringify(purpose)}`);
        if (def.basis === "legitimate-use") return true;
        return grantedPurposes(await store.events(subjectId)).has(purpose);
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
        const report = await runDueTasks({
          config,
          store: fullStore("The retention runner"),
          data: options.data,
          processors: processorHooks,
          now: nowIso(),
          limit: input.limit ?? 500,
        });
        emit("retention.ran", { report });
        return report;
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

    access: {
      async log(input) {
        const log = accessStore();
        if (typeof input.actor !== "string" || input.actor.length === 0) {
          throw new DpdpError("invalid-actor", "actor must be a non-empty string: who is accessing the data");
        }
        const subjects = input.subjectIds ?? (input.subjectId !== undefined ? [input.subjectId] : []);
        if (subjects.length === 0) throw new DpdpError("invalid-subject", "Pass subjectId or subjectIds");
        for (const id of subjects) checkSubject(id);
        if (!purposes[input.purpose]) {
          throw new DpdpError("unknown-purpose", `Unknown purpose ${JSON.stringify(input.purpose)}`);
        }
        const { fields, unknown } = resolveFields(config, input.fields ?? []);
        if (unknown.length > 0) {
          throw new DpdpError(
            "unknown-field",
            `Not in the data map: ${unknown.map((k) => JSON.stringify(k)).join(", ")}. Use keys like "users.phone" or "users".`,
          );
        }
        const outside = fieldsOutsidePurpose(config, fields, input.purpose);
        const at = nowIso();
        const entries: AccessEntry[] = [...new Set(subjects)].map((subjectId) => ({
          id: accessId(at),
          at,
          actor: input.actor,
          subjectId,
          action: input.action ?? "read",
          purpose: input.purpose,
          ...(fields.length > 0 ? { fields } : {}),
          ...(outside.length > 0 ? { outOfPurpose: outside } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.evidence !== undefined ? { evidence: { ...input.evidence } } : {}),
        }));
        await log.insertAccess(entries);
        emit("access.logged", { entries });
        if (outside.length > 0 && options.access?.outOfPurpose === "throw") {
          throw new DpdpError(
            "out-of-purpose",
            `${outside.join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} held for "${input.purpose}". The attempt was logged.`,
          );
        }
        return entries;
      },

      list: (filter = {}) => accessStore().listAccess(filter),

      async review(input = {}) {
        const to = input.to ?? nowIso();
        const from = input.from ?? new Date(Date.parse(to) - durationMs("1d")).toISOString();
        // Without an explicit end, include everything up to and including now.
        const entries = await accessStore().listAccess(input.to ? { from, to } : { from });
        return reviewAccess({
          config,
          entries,
          from,
          to,
          history: (subjectId) => store.events(subjectId),
          window: input.window ?? "1h",
          maxSubjects: input.maxSubjects ?? 100,
          ignoreActors: input.ignoreActors ?? [],
        });
      },

      async prune() {
        const keep = config.security?.accessLogRetention ?? DEFAULT_ACCESS_LOG_RETENTION;
        const keepMs = Math.max(durationMs(keep), durationMs(DEFAULT_ACCESS_LOG_RETENTION));
        const before = new Date(now().getTime() - keepMs).toISOString();
        return { deleted: await accessStore().pruneAccess(before), before };
      },
    },

    breach: {
      async open(input) {
        if (!input || typeof input.description !== "string" || input.description.trim() === "") {
          throw new DpdpError("invalid-input", "Describe the breach: description is required (Rule 7(1)(a), 7(2)(a))");
        }
        checkIso(input.awareAt, "awareAt");
        checkIso(input.occurredAt, "occurredAt");
        const awareAt = input.awareAt ? new Date(input.awareAt).toISOString() : nowIso();
        const text = Object.fromEntries(BREACH_TEXT.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
        const breach: Breach = {
          id: randomUUID(),
          ...text,
          description: input.description,
          awareAt,
          fields: breachFields(input.fields),
          reportDueAt: new Date(Date.parse(awareAt) + BOARD_REPORT_WITHIN_HOURS * 3_600_000).toISOString(),
          report: {},
          status: "open",
          history: [{ at: nowIso(), event: "opened" }],
        };
        await breachStore().insertBreach(breach);
        emit("breach.opened", { breach });
        return breach;
      },

      async update(id, input) {
        checkIso(input.occurredAt, "occurredAt");
        const text = Object.fromEntries(BREACH_TEXT.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
        const fields = input.fields ? { fields: breachFields(input.fields) } : {};
        return changeBreach(id, (breach) => ({ ...breach, ...text, ...fields }), "updated");
      },

      get: (id) => breachStore().getBreach(id),

      list: (filter = {}) => breachStore().listBreaches(filter),

      async status(id) {
        const breach = await requireBreach(id);
        return breachStatus(breach, await breachStore().countNotices(id), nowIso());
      },

      async addAffected(id, subjectIds) {
        await requireBreach(id, true);
        for (const subjectId of subjectIds) checkSubject(subjectId);
        const addedAt = nowIso();
        return breachStore().addNotices([...new Set(subjectIds)].map((subjectId) => ({ breachId: id, subjectId, status: "pending", addedAt })));
      },

      async addAffectedFromAccessLog(id, filter) {
        await requireBreach(id, true);
        const { limit: _, ...where } = filter as AccessFilter;
        const access = accessStore();
        const subjects = access.accessSubjects
          ? await access.accessSubjects(where)
          : [...new Set((await access.listAccess(where)).map((e) => e.subjectId))];
        let added = 0;
        for (let i = 0; i < subjects.length; i += 5000) added += await api.breach.addAffected(id, subjects.slice(i, i + 5000));
        return added;
      },

      async notice(id) {
        return personNotice(config, await requireBreach(id));
      },

      pending: async (id, limit) => {
        await requireBreach(id);
        return breachStore().listNotices(id, { status: "pending", ...(limit !== undefined ? { limit } : {}) });
      },

      async markNotified(id, subjectIds, input = {}) {
        await requireBreach(id, true);
        checkIso(input.at, "at");
        const at = input.at ? new Date(input.at).toISOString() : nowIso();
        return breachStore().markNotices(id, [...new Set(subjectIds)], at, input.channel);
      },

      async boardNotified(id, input = {}) {
        checkIso(input.at, "at");
        const at = input.at ? new Date(input.at).toISOString() : nowIso();
        return changeBreach(id, (breach) => ({ ...breach, boardNotifiedAt: at }), "board notified");
      },

      async updateReport(id, parts) {
        const keys = ["details", "facts", "mitigation", "findings", "remedial"] as const;
        const given = Object.fromEntries(keys.filter((k) => parts[k] !== undefined).map((k) => [k, parts[k]]));
        return changeBreach(id, (breach) => ({ ...breach, report: { ...breach.report, ...given } }), "report updated");
      },

      async boardReport(id) {
        const breach = await requireBreach(id);
        const counts = await breachStore().countNotices(id);
        const status = breachStatus(breach, counts, nowIso());
        return {
          breachId: id,
          awareAt: breach.awareAt,
          dueAt: breach.reportDueAt,
          details: breach.report.details ?? "",
          facts: breach.report.facts ?? "",
          mitigation: breach.report.mitigation ?? "",
          findings: breach.report.findings ?? "",
          remedial: breach.report.remedial ?? "",
          intimations: {
            total: counts.total,
            sent: counts.sent,
            pending: counts.total - counts.sent,
            ...(counts.firstSentAt ? { firstSentAt: counts.firstSentAt } : {}),
            ...(counts.lastSentAt ? { lastSentAt: counts.lastSentAt } : {}),
          },
          missing: status.report.missing,
        };
      },

      async reportSent(id, input = {}) {
        checkIso(input.at, "at");
        const at = input.at ? new Date(input.at).toISOString() : nowIso();
        const saved = await changeBreach(id, (breach) => ({ ...breach, reportSentAt: at }), "report sent");
        emit("breach.reported", { breach: saved });
        return saved;
      },

      async extend(id, input) {
        checkIso(input.until, "until");
        if (!input.reference) throw new DpdpError("invalid-input", "Record the Board's written permission: reference is required");
        const until = new Date(input.until).toISOString();
        const extension = { until, reference: input.reference, recordedAt: nowIso() };
        return changeBreach(id, (breach) => ({ ...breach, reportDueAt: until, extension }), "extended", input.reference);
      },

      async close(id, note) {
        const closedAt = nowIso();
        const saved = await changeBreach(id, (breach) => ({ ...breach, status: "closed", closedAt }), "closed", note);
        emit("breach.closed", { breach: saved });
        return saved;
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
        emit("rights.opened", { request });
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
  return api;
}
