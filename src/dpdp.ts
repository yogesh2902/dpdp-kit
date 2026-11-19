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
import { type EvidenceReport, gapsOf, requestStats, staticEvidence } from "./evidence.js";
import { isStatsStore } from "./stats.js";
import { DpdpError, SeqConflictError } from "./errors.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isNoticeLanguage, type NoticeLanguage } from "./languages.js";
import {
  buildNotice,
  isNoticeStore,
  type NoticeKind,
  type NoticeStore,
  noticeLanguages,
  type PrivacyNotice,
  type SavedNotice,
  sameNotice,
} from "./notice.js";
import {
  type ErasureTask,
  isVerified,
  type Nominee,
  REQUEST_TYPES,
  type RequestFilter,
  type RequestHistoryEntry,
  type RequestType,
  type RightsRequest,
  type TaskFilter,
} from "./records.js";
import { type ProcessorHooks, type RunReport, runDueTasks, tasksFromPlan } from "./retention.js";
import { type AccessSummary, type Acknowledgement, acknowledgement, buildAccessSummary, dueAt, type RightsInfo, rightsInfo } from "./rights.js";
import {
  type ConsentAction,
  type ConsentEvent,
  type ConsentStore,
  type DpdpStore,
  grantedPurposes,
  objectedPurposes,
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
  "consent.objected": { event: ConsentEvent; erasure: ErasurePlan; tasks: ErasureTask[] };
  "consent.objection-lifted": { event: ConsentEvent; cancelled: ErasureTask[]; tasks: ErasureTask[] };
  "erasure.scheduled": { plan: ErasurePlan; tasks: ErasureTask[] };
  "retention.ran": { report: RunReport };
  "rights.opened": { request: RightsRequest };
  "rights.closed": { request: RightsRequest };
  "rights.verified": { request: RightsRequest };
  "rights.corrected": { request: RightsRequest; fields: string[] };
  "rights.nominated": { nominee: Nominee };
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
     * Record that the person doesn't want their data used for these Section 7(a) purposes
     * (legitimate uses with `legitimateUse: "7(a)"`). `has()` turns false for them at once, and
     * erasure is planned as for a withdrawal: fields whose purposes have all ended, never whole rows.
     */
    object(
      subjectId: string,
      purposes: readonly P[],
      meta?: ConsentMeta,
    ): Promise<{ event: ConsentEvent; erasure: ErasurePlan; tasks: ErasureTask[] }>;
    /**
     * Record that the person changed their mind about an objection. Erasure tasks the objection
     * scheduled and that haven't run yet are cancelled; data already erased stays erased.
     */
    liftObjection(
      subjectId: string,
      purposes: readonly P[],
      meta?: ConsentMeta,
    ): Promise<{ event: ConsentEvent; cancelled: ErasureTask[]; tasks: ErasureTask[] }>;
    /**
     * Whether you hold consent, or don't need it, for this purpose. For consent purposes: true when
     * the person's latest choice was a grant. For Section 7(a) purposes: true unless the person has
     * objected. For other legitimate uses: always true.
     */
    has(subjectId: string, purpose: P): Promise<boolean>;
    /** Consent purposes this person currently has granted. */
    active(subjectId: string): Promise<P[]>;
    /** Section 7(a) purposes this person currently objects to. */
    objections(subjectId: string): Promise<P[]>;
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
   * One report of what the config declares and what the records show, for an auditor, a lawyer or
   * the Board: the data map, the audit, Rule 6 safeguards, notices shown, consent counts, rights
   * requests, erasure, the access review and breaches. Covers the last 30 days unless `from` and
   * `to` are given; the access review reads every log entry in the period, so keep long periods for
   * smaller logs. `formatEvidence()` turns it into Markdown.
   */
  evidence(input?: {
    from?: string;
    to?: string;
    /** Options for the access review part, as for `access.review()`. */
    review?: { window?: Duration; maxSubjects?: number; ignoreActors?: readonly string[] };
    /** How many access findings to list in full. Default 20. */
    examples?: number;
  }): Promise<EvidenceReport>;

  /**
   * Privacy notices built from `config.notice` (Section 5, Rule 3), and the snapshots kept as proof
   * of what people were shown (Section 6(10)).
   */
  readonly notice: {
    /** The notice in a language (default English) and of a kind (default `"consent"`). Doesn't save anything. */
    build(options?: { language?: NoticeLanguage; kind?: NoticeKind }): PrivacyNotice;
    /**
     * The same as `build()`, and saves the notice as proof the first time it's shown. Call it where
     * you display the notice. `consent.grant()` does this for you.
     */
    show(options?: { language?: NoticeLanguage; kind?: NoticeKind }): Promise<PrivacyNotice>;
    /** A saved notice, e.g. the one a consent event's `noticeVersion` points to. */
    get(version: string, options?: { language?: NoticeLanguage; kind?: NoticeKind }): Promise<SavedNotice | undefined>;
    /** Every saved notice, oldest first. */
    list(): Promise<SavedNotice[]>;
    /** Languages the notice is available in: English, then each translation. */
    languages(): NoticeLanguage[];
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
    /** `by`: who answered, recorded in the history. */
    resolve(id: string, note?: string, options?: { by?: string }): Promise<RightsRequest>;
    reject(id: string, reason: string, options?: { by?: string }): Promise<RightsRequest>;
    /** What to tell the person now: the reference, when you'll answer, and who to ask meanwhile. */
    acknowledgement(id: string): Promise<Acknowledgement>;
    /**
     * Record that you checked the identity of the person behind a request, e.g.
     * `{ method: "OTP to registered mobile", by: "support:anita" }`. With `rights.verify: "required"`,
     * summaries, erasure and corrections for a request wait for this.
     */
    verifyIdentity(id: string, input: { method: string; by: string }): Promise<RightsRequest>;
    /**
     * What you hold about the person and who you shared it with (Section 11(1)). Needs `data`. Pass
     * the request it answers as `requestId`: it must be the person's, open, and verified if you
     * require that.
     */
    summary(subjectId: string, options?: { requestId?: string }): Promise<AccessSummary>;
    /**
     * Erase on request (Section 12(3)): every purpose ends except those in `keepFor`, which you still
     * need for the specified purpose. Legal holds and `minimumRetention` still apply. Pass the
     * request id to resolve it.
     */
    erase(
      subjectId: string,
      input?: { keepFor?: readonly P[]; requestId?: string; by?: string },
    ): Promise<{ plan: ErasurePlan; tasks: ErasureTask[] }>;
    /**
     * Correct, complete or update the person's data (Section 12(2)) for an open `correction`
     * request, and resolve it. Keys are data map fields, `"users.phone"`. `where` picks some of the
     * person's rows in one table, e.g. `{ id: 42 }`. The history records which fields changed,
     * never the values. Needs `data` with `updateFields`.
     */
    correct(
      requestId: string,
      changes: Readonly<Record<string, unknown>>,
      options?: { where?: Readonly<Record<string, unknown>>; by?: string; resolve?: boolean },
    ): Promise<{ request: RightsRequest; changed: Record<string, number> }>;
    /**
     * Record someone who may exercise the person's rights if they die or can no longer act
     * (Section 14, Rule 14(4)). Opens and resolves a `nomination` request, or uses the one you pass.
     */
    nominate(
      subjectId: string,
      nominee: { name: string; contact: string; relation?: string },
      options?: { requestId?: string; by?: string },
    ): Promise<Nominee>;
    /** The person's current nominees, oldest first. */
    nominees(subjectId: string): Promise<Nominee[]>;
    /** Remove a nominee at the person's request. */
    revokeNominee(subjectId: string, nomineeId: string, options?: { by?: string }): Promise<void>;
    /** What Rule 14(1) and 14(3) ask you to publish: how to make a request, identifiers, answer times. */
    how(): RightsInfo;
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

  const objectable = (p: string) => purposes[p]?.basis === "legitimate-use" && purposes[p]?.legitimateUse === "7(a)";

  function checkConsentPurposes(list: readonly string[], action: ConsentAction) {
    if (list.length === 0) throw new DpdpError("no-purposes", "Pass at least one purpose");
    for (const p of list) {
      const def = purposes[p];
      if (!def) throw new DpdpError("unknown-purpose", `Unknown purpose ${JSON.stringify(p)}`);
      if (action === "object" || action === "lift-objection") {
        if (!objectable(p)) {
          throw new DpdpError(
            "not-objectable",
            def.basis === "consent"
              ? `${JSON.stringify(p)} is a consent purpose: withdraw consent instead of objecting`
              : `${JSON.stringify(p)} isn't a Section 7(a) use: set legitimateUse: "7(a)" on it if the person gave this data voluntarily`,
          );
        }
        continue;
      }
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
    checkConsentPurposes(list, action);
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

  /** Purposes that still apply to the person: consent still granted, and legitimate uses not objected to. */
  function remainingFrom(events: readonly ConsentEvent[]): string[] {
    const objected = objectedPurposes(events);
    return [...legitimate.filter((p) => !objected.has(p)), ...grantedPurposes(events)];
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

  function noticeStore(): NoticeStore {
    if (!isNoticeStore(store)) {
      throw new DpdpError(
        "store-unsupported",
        "Saved notices need a store that keeps them: any built-in store, or your own NoticeStore",
      );
    }
    return store;
  }

  // The config doesn't change, so each notice is built, and saved, once per process.
  const builtNotices = new Map<string, PrivacyNotice>();
  const savedNotices = new Map<string, Promise<void>>();
  function noticeFor(language: NoticeLanguage = "en", kind: NoticeKind = "consent"): PrivacyNotice {
    const key = `${language}\u0000${kind}`;
    let notice = builtNotices.get(key);
    if (!notice) {
      notice = buildNotice(config, { language, kind });
      builtNotices.set(key, notice);
    }
    return structuredClone(notice);
  }
  async function recordNotice(notice: PrivacyNotice): Promise<void> {
    if (!isNoticeStore(store)) return; // a custom store without notices: the version is still recorded
    const s = store;
    const key = `${notice.version}\u0000${notice.language}\u0000${notice.kind}`;
    let saving = savedNotices.get(key);
    if (!saving) {
      saving = (async () => {
        if (await s.savePrivacyNotice(notice, nowIso())) return;
        const existing = await s.getPrivacyNotice(notice.version, notice.language, notice.kind);
        if (existing && !sameNotice(existing.notice, notice)) {
          throw new DpdpError(
            "notice-version-conflict",
            `A different ${notice.language} notice was already saved as version ${JSON.stringify(notice.version)}. Change notice.version when you change the notice, or leave it out to version by content.`,
          );
        }
      })();
      savedNotices.set(key, saving);
      saving.catch(() => savedNotices.delete(key));
    }
    await saving;
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

  /** A request you're about to act on: the person's, still open, and verified if you require that. */
  async function usableRequest(id: string, expect: { subjectId?: string; type?: RequestType } = {}): Promise<RightsRequest> {
    const request = await requireRequest(id);
    if (expect.subjectId !== undefined && request.subjectId !== expect.subjectId) {
      throw new DpdpError("request-not-found", `Request ${id} belongs to a different person`);
    }
    if (expect.type !== undefined && request.type !== expect.type) {
      throw new DpdpError("wrong-request-type", `Request ${id} is a ${request.type} request, not ${expect.type}`);
    }
    if (request.status !== "open") throw new DpdpError("request-closed", `Request ${id} is already ${request.status}`);
    if (config.rights?.verify === "required" && !isVerified(request)) {
      throw new DpdpError("request-not-verified", `Check the identity of the person behind request ${id} first, and record it with rights.verifyIdentity()`);
    }
    return request;
  }

  const byEntry = (by: string | undefined) => (by !== undefined ? { by } : {});

  async function close(id: string, status: "resolved" | "rejected", note?: string, by?: string, extra: RequestHistoryEntry[] = []): Promise<RightsRequest> {
    const request = await requireRequest(id);
    if (request.status !== "open") {
      throw new DpdpError("request-closed", `Request ${id} is already ${request.status}`);
    }
    const at = nowIso();
    const closed: RightsRequest = {
      ...request,
      status,
      closedAt: at,
      history: [...request.history, ...extra, { at, status, ...(note !== undefined ? { note } : {}), ...byEntry(by) }],
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
        let withNotice = meta;
        if (config.notice && meta?.noticeVersion === undefined) {
          // Record which notice the person saw, and keep it as proof (Section 6(10)).
          checkSubject(subjectId);
          checkConsentPurposes(list, "grant");
          const notice = noticeFor(meta?.language ?? "en", "consent");
          await recordNotice(notice);
          withNotice = { ...meta, noticeVersion: notice.version, language: notice.language };
        }
        const event = await append(subjectId, "grant", list, withNotice);
        emit("consent.granted", { event });
        return event;
      },

      async withdraw(subjectId, list, meta) {
        const event = await append(subjectId, "withdraw", list, meta);
        const erasure = planErasure(config, {
          subjectId,
          reason: "withdrawal",
          ended: event.purposes,
          remaining: remainingFrom(await store.events(subjectId)),
        });
        const tasks = isDpdpStore(store) ? await schedule(erasure) : [];
        emit("consent.withdrawn", { event, erasure, tasks });
        return { event, erasure, tasks };
      },

      async object(subjectId, list, meta) {
        checkSubject(subjectId);
        const before = objectedPurposes(await store.events(subjectId));
        const event = await append(subjectId, "object", list, meta);
        // Erasure only for purposes newly objected to: repeating an objection schedules nothing twice.
        const ended = event.purposes.filter((p) => !before.has(p));
        const erasure = planErasure(config, {
          subjectId,
          reason: "objection",
          ended,
          remaining: remainingFrom(await store.events(subjectId)),
        });
        const tasks = isDpdpStore(store) && ended.length > 0 ? await schedule(erasure) : [];
        emit("consent.objected", { event, erasure, tasks });
        return { event, erasure, tasks };
      },

      async liftObjection(subjectId, list, meta) {
        const event = await append(subjectId, "lift-objection", list, meta);
        const lifted = new Set(event.purposes);
        const cancelled: ErasureTask[] = [];
        let tasks: ErasureTask[] = [];
        if (isDpdpStore(store)) {
          const stillObjected = objectedPurposes(await store.events(subjectId));
          const replan = new Set<string>();
          for (const status of ["pending", "failed"] as const) {
            for (const task of await store.listTasks({ subjectId, status })) {
              if (task.reason !== "objection" || !task.purposes?.some((p) => lifted.has(p))) continue;
              const done: ErasureTask = { ...task, status: "cancelled", note: "Objection lifted" };
              await store.updateTask(done);
              cancelled.push(done);
              // A task can serve several purposes; those still objected to are planned again.
              for (const p of task.purposes) if (stillObjected.has(p)) replan.add(p);
            }
          }
          if (replan.size > 0) {
            tasks = await schedule(
              planErasure(config, { subjectId, reason: "objection", ended: [...replan], remaining: remainingFrom(await store.events(subjectId)) }),
            );
          }
        }
        emit("consent.objection-lifted", { event, cancelled, tasks });
        return { event, cancelled, tasks };
      },

      async has(subjectId, purpose) {
        checkSubject(subjectId);
        const def = purposes[purpose];
        if (!def) throw new DpdpError("unknown-purpose", `Unknown purpose ${JSON.stringify(purpose)}`);
        if (def.basis === "legitimate-use") {
          // Only Section 7(a) uses can be objected to, so only they need the person's history.
          return objectable(purpose) ? !objectedPurposes(await store.events(subjectId)).has(purpose) : true;
        }
        return grantedPurposes(await store.events(subjectId)).has(purpose);
      },

      active: activeFor,

      async objections(subjectId) {
        checkSubject(subjectId);
        return [...objectedPurposes(await store.events(subjectId))] as P[];
      },

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

    async evidence(input = {}) {
      const at = nowIso();
      checkIso(input.from, "from");
      checkIso(input.to, "to");
      // Normalised, so every store compares the same instants (ISO strings only sort as times in UTC).
      const to = new Date(input.to ?? at).toISOString();
      const from = input.from !== undefined ? new Date(input.from).toISOString() : new Date(Date.parse(to) - durationMs("30d")).toISOString();
      const report = staticEvidence(config, at);
      report.period = { from, to };
      const without = (what: string) => ({ unavailable: `the store doesn't keep ${what}` });

      report.notices = isNoticeStore(store)
        ? (await store.listPrivacyNotices()).map((n) => ({
            version: n.notice.version,
            language: n.notice.language,
            kind: n.notice.kind,
            firstShownAt: n.firstShownAt,
            purposes: n.notice.items.length,
          }))
        : without("notices");
      report.consent = isStatsStore(store) ? await store.consentStats(from, to) : { unavailable: "the store can't count consent events (add consentStats)" };
      if (isDpdpStore(store)) {
        report.requests = requestStats(await store.listRequests({}), from, to, at);
        if (isStatsStore(store)) report.erasure = await store.taskCounts(at);
        else {
          const counts = { byStatus: {} as Record<string, number>, late: 0 };
          for (const t of await store.listTasks({})) {
            counts.byStatus[t.status] = (counts.byStatus[t.status] ?? 0) + 1;
            if ((t.status === "pending" || t.status === "failed") && t.dueAt < at) counts.late++;
          }
          report.erasure = counts;
        }
      } else {
        report.requests = without("rights requests");
        report.erasure = without("erasure tasks");
      }
      if (isAccessLogStore(store)) {
        const review = await api.access.review({ from, to, ...input.review });
        const findings: Record<string, number> = {};
        for (const f of review.findings) findings[f.kind] = (findings[f.kind] ?? 0) + 1;
        report.access = { scanned: review.scanned, findings, examples: review.findings.slice(0, input.examples ?? 20) };
      } else report.access = without("an access log");
      if (isBreachStore(store)) {
        const relevant = (await store.listBreaches({})).filter((b) => b.status === "open" || (b.awareAt >= from && b.awareAt < to));
        report.breaches = await Promise.all(relevant.map((b) => api.breach.status(b.id)));
      } else report.breaches = without("breaches");

      report.gaps = gapsOf(report);
      return report;
    },

    notice: {
      build(options = {}) {
        return noticeFor(options.language, options.kind);
      },
      async show(options = {}) {
        const notice = noticeFor(options.language, options.kind);
        await recordNotice(notice);
        return notice;
      },
      async get(version, options = {}) {
        return noticeStore().getPrivacyNotice(version, options.language ?? "en", options.kind ?? "consent");
      },
      async list() {
        return noticeStore().listPrivacyNotices();
      },
      languages() {
        return noticeLanguages(config);
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

      resolve: (id, note, opts = {}) => close(id, "resolved", note, opts.by),

      reject: (id, reason, opts = {}) => close(id, "rejected", reason, opts.by),

      async acknowledgement(id) {
        return acknowledgement(config, await requireRequest(id));
      },

      async verifyIdentity(id, input) {
        if (!input || typeof input.method !== "string" || !input.method.trim() || typeof input.by !== "string" || !input.by.trim()) {
          throw new DpdpError("invalid-input", "Say how the identity was checked and by whom: { method, by }");
        }
        const request = await requireRequest(id);
        if (request.status !== "open") throw new DpdpError("request-closed", `Request ${id} is already ${request.status}`);
        const verified: RightsRequest = {
          ...request,
          history: [...request.history, { at: nowIso(), status: "open", event: "verified", method: input.method, by: input.by }],
        };
        await fullStore("Rights requests").updateRequest(verified);
        emit("rights.verified", { request: verified });
        return verified;
      },

      async correct(requestId, changes, opts = {}) {
        const request = await usableRequest(requestId, { type: "correction" });
        const data = dataAccess();
        if (typeof data.updateFields !== "function") {
          throw new DpdpError("data-access-unsupported", "This data access can't write corrections: give it updateFields (the built-in ones have it)");
        }
        const keys = Object.keys(changes ?? {});
        if (keys.length === 0) throw new DpdpError("invalid-input", `Pass the fields to correct, e.g. { "users.phone": "98…" }`);
        const byTable = new Map<string, Record<string, unknown>>();
        for (const key of keys) {
          const dot = key.indexOf(".");
          const tableKey = dot < 0 ? key : key.slice(0, dot);
          const field = key.slice(dot + 1);
          const table = config.data[tableKey];
          if (dot < 0 || !table || !Object.hasOwn(table.fields, field)) {
            throw new DpdpError("unknown-field", `Not in the data map: ${JSON.stringify(key)}. Use keys like "users.phone".`);
          }
          if (table.legalHold) {
            throw new DpdpError("not-correctable", `${tableKey} is kept under a legal hold (${table.legalHold.reason}): correct it through the process that law sets`);
          }
          const value = changes[key];
          if (value === undefined || ["function", "symbol", "bigint"].includes(typeof value)) {
            throw new DpdpError("invalid-input", `${key}: pass a string, number, boolean, null, or a JSON value`);
          }
          byTable.set(tableKey, { ...byTable.get(tableKey), [field]: value });
        }
        if (opts.where && byTable.size > 1) throw new DpdpError("invalid-input", "where applies to one table: correct one table at a time");
        for (const [column, value] of Object.entries(opts.where ?? {})) {
          // where narrows the person's rows; it can never reach someone else's.
          const t = config.data[[...byTable.keys()][0]!]!;
          if (column === t.subject) throw new DpdpError("invalid-input", `where can't name the subject column ${JSON.stringify(column)}: the request already decides whose rows these are`);
          if (!["string", "number", "boolean"].includes(typeof value)) {
            throw new DpdpError("invalid-input", `where.${column}: pass a string, number or boolean to match`);
          }
        }
        const changed: Record<string, number> = {};
        for (const [tableKey, values] of byTable) {
          const t = config.data[tableKey]!;
          changed[tableKey] = await data.updateFields(t.table, t.subject, request.subjectId, values, opts.where);
        }
        const rows = Object.values(changed).reduce((a, b) => a + b, 0);
        if (rows === 0) {
          // Nothing was corrected, so the request stays open rather than being answered as done.
          throw new DpdpError("no-matching-rows", `No rows of this person matched${opts.where ? " where" : ""}: nothing was corrected and request ${requestId} is still open`);
        }
        const entry: RequestHistoryEntry = { at: nowIso(), status: "open", event: "corrected", fields: keys, ...byEntry(opts.by) };
        let updated: RightsRequest;
        if (opts.resolve === false) {
          updated = { ...request, history: [...request.history, entry] };
          await fullStore("Rights requests").updateRequest(updated);
        } else {
          updated = await close(requestId, "resolved", `Corrected ${keys.join(", ")} (${rows} row${rows === 1 ? "" : "s"})`, opts.by, [entry]);
        }
        emit("rights.corrected", { request: updated, fields: keys });
        return { request: updated, changed };
      },

      async nominate(subjectId, nominee, opts = {}) {
        checkSubject(subjectId);
        for (const k of ["name", "contact"] as const) {
          if (typeof nominee?.[k] !== "string" || !nominee[k].trim()) throw new DpdpError("invalid-input", `The nominee needs a ${k}`);
        }
        const details = { name: nominee.name, contact: nominee.contact, ...(nominee.relation !== undefined ? { relation: nominee.relation } : {}) };
        let request: RightsRequest;
        if (opts.requestId) {
          const existing = await usableRequest(opts.requestId, { subjectId, type: "nomination" });
          request = { ...existing, details: { ...existing.details, ...details } };
          await fullStore("Rights requests").updateRequest(request);
        } else {
          request = await api.rights.open(subjectId, "nomination", details);
        }
        const closed = await close(request.id, "resolved", "Nominee recorded", opts.by);
        const recorded: Nominee = { id: closed.id, subjectId, ...details, nominatedAt: closed.closedAt! };
        emit("rights.nominated", { nominee: recorded });
        return recorded;
      },

      async nominees(subjectId) {
        checkSubject(subjectId);
        const list = await fullStore("Rights requests").listRequests({ subjectId, status: "resolved" });
        return list
          .filter((r) => r.type === "nomination" && typeof r.details?.name === "string" && !r.history.some((e) => e.event === "revoked"))
          .map((r) => ({
            id: r.id,
            subjectId: r.subjectId,
            name: String(r.details!.name),
            contact: String(r.details!.contact ?? ""),
            ...(typeof r.details!.relation === "string" ? { relation: r.details!.relation } : {}),
            nominatedAt: r.closedAt ?? r.openedAt,
          }));
      },

      async revokeNominee(subjectId, nomineeId, opts = {}) {
        checkSubject(subjectId);
        const request = await fullStore("Rights requests").getRequest(nomineeId);
        if (!request || request.subjectId !== subjectId || request.type !== "nomination" || request.status !== "resolved") {
          throw new DpdpError("nominee-not-found", `No nominee ${JSON.stringify(nomineeId)} for this person`);
        }
        if (request.history.some((e) => e.event === "revoked")) return;
        await fullStore("Rights requests").updateRequest({
          ...request,
          history: [...request.history, { at: nowIso(), status: "resolved", event: "revoked", ...byEntry(opts.by) }],
        });
      },

      how: () => rightsInfo(config),

      async summary(subjectId, opts = {}) {
        checkSubject(subjectId);
        if (opts.requestId !== undefined) await usableRequest(opts.requestId, { subjectId });
        const events = await store.events(subjectId);
        return buildAccessSummary({
          config,
          data: dataAccess(),
          subjectId,
          consents: [...grantedPurposes(events)],
          objections: [...objectedPurposes(events)],
          now: nowIso(),
        });
      },

      async erase(subjectId, input = {}) {
        checkSubject(subjectId);
        // Checked before anything is scheduled: the person's, still open, verified if required.
        if (input.requestId) await usableRequest(input.requestId, { subjectId, type: "erasure" });
        const plan = accountPlan(subjectId, "erasure-request", input.keepFor ?? []);
        const tasks = await schedule(plan);
        if (input.requestId) {
          await close(input.requestId, "resolved", `Erasure scheduled: ${tasks.length} task(s)`, input.by);
        }
        return { plan, tasks };
      },
    },
  };
  return api;
}
