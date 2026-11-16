import { audit, hasErrors } from "./audit.js";
import type { DpdpConfig } from "./config.js";
import { type ErasurePlan, planErasure } from "./erasure.js";
import { DpdpError, SeqConflictError } from "./errors.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isNoticeLanguage, type NoticeLanguage } from "./languages.js";
import type { ConsentAction, ConsentEvent, ConsentStore } from "./store.js";

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
  store: ConsentStore;
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
     * Record that the person withdrew consent. Returns what must now be erased; nothing is
     * erased for you in v0.1.
     */
    withdraw(
      subjectId: string,
      purposes: readonly P[],
      meta?: ConsentMeta,
    ): Promise<{ event: ConsentEvent; erasure: ErasurePlan }>;
    /**
     * Whether you may process this person's data for this purpose: always true for
     * legitimate-use purposes; for consent purposes, true when their latest choice was a grant.
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
        return { event, erasure };
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
        return planErasure(config, {
          subjectId,
          reason: input.reason,
          ended: Object.keys(purposes),
          remaining: [],
        });
      },
    },
  };
}
