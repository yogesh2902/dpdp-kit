import type { DpdpConfig } from "./config.js";
import { type Duration, durationMs } from "./duration.js";
import type { ConsentEvent } from "./store.js";

/** What was done with the data. Free text is allowed; these are the common ones. */
export type AccessAction = "read" | "export" | "update" | "delete" | "search" | (string & {});

/**
 * One access to one person's personal data. Rule 6(1)(c) of the DPDP Rules requires "visibility on
 * the accessing of such personal data, through appropriate logs, monitoring and review", and Rule
 * 6(1)(e) requires keeping those logs for a year.
 */
export interface AccessEntry {
  id: string;
  /** ISO 8601 timestamp. */
  at: string;
  /** Who accessed the data: a staff user's id, a service or job name. */
  actor: string;
  /** Whose data it was. */
  subjectId: string;
  action: AccessAction;
  /** Why: one of the config's purposes. */
  purpose: string;
  /** What was accessed, as data map keys: `"users.phone"`. */
  fields?: string[];
  /** The fields from `fields` that aren't held for `purpose`. */
  outOfPurpose?: string[];
  /** Free text, e.g. a support ticket number. */
  reason?: string;
  /** Details of the request, e.g. IP address, user agent, request id. */
  evidence?: Record<string, string>;
}

export interface AccessFilter {
  subjectId?: string;
  actor?: string;
  purpose?: string;
  /** ISO 8601, inclusive. */
  from?: string;
  /** ISO 8601, exclusive. */
  to?: string;
  limit?: number;
}

/** Storage for the access log. Both built-in stores implement it. */
export interface AccessLogStore {
  insertAccess(entries: readonly AccessEntry[]): Promise<void>;
  /** Entries matching the filter, oldest first. */
  listAccess(filter: AccessFilter): Promise<AccessEntry[]>;
  /** Delete entries older than `before` (ISO 8601). Returns how many were deleted. */
  pruneAccess(before: string): Promise<number>;
}

export function isAccessLogStore(store: object): store is AccessLogStore {
  const s = store as Partial<AccessLogStore>;
  return typeof s.insertAccess === "function" && typeof s.listAccess === "function" && typeof s.pruneAccess === "function";
}

/** Default and minimum time to keep the access log (Rule 6(1)(e)). */
export const DEFAULT_ACCESS_LOG_RETENTION = "1y";

/**
 * Expand field keys against the data map: `"users.phone"` stays as it is; `"users.*"` and
 * `"users"` become every personal field of that table. Returns the keys it doesn't know too.
 */
export function resolveFields(config: DpdpConfig<string>, keys: readonly string[]): { fields: string[]; unknown: string[] } {
  const fields = new Set<string>();
  const unknown: string[] = [];
  for (const key of keys) {
    const [table, field, ...extra] = key.split(".");
    const def = table ? config.data[table] : undefined;
    if (!def || extra.length > 0) {
      unknown.push(key);
    } else if (field === undefined || field === "*") {
      for (const f of Object.keys(def.fields)) fields.add(`${table}.${f}`);
    } else if (def.fields[field]) {
      fields.add(key);
    } else {
      unknown.push(key);
    }
  }
  return { fields: [...fields], unknown };
}

/** The fields that aren't held for `purpose` according to the data map. */
export function fieldsOutsidePurpose(config: DpdpConfig<string>, fields: readonly string[], purpose: string): string[] {
  return fields.filter((key) => {
    const [table, field] = key.split(".") as [string, string];
    const def = config.data[table]?.fields[field];
    return !def || !def.purposes.includes(purpose);
  });
}

export type AccessFindingKind = "out-of-purpose" | "no-consent" | "bulk-access";

export interface AccessFinding {
  kind: AccessFindingKind;
  actor: string;
  /** Plain-language explanation, for whoever reviews the log. */
  message: string;
  /** Ids of the log entries involved. */
  entries: string[];
  subjectId?: string;
  purpose?: string;
  /** For `bulk-access`: distinct people accessed within one window. */
  subjects?: number;
}

export interface AccessReview {
  from: string;
  to: string;
  /** Entries looked at. */
  scanned: number;
  findings: AccessFinding[];
}

export interface ReviewInput {
  config: DpdpConfig<string>;
  entries: readonly AccessEntry[];
  from: string;
  to: string;
  /** Consent events for a person, oldest first. */
  history: (subjectId: string) => Promise<readonly ConsentEvent[]>;
  /** Window for bulk-access detection, e.g. `"1h"`. */
  window: Duration;
  /** More distinct people than this within one window is reported as bulk access. */
  maxSubjects: number;
}

/** Whether the person had granted `purpose` at time `at`, according to their consent history. */
function grantedAt(events: readonly ConsentEvent[], purpose: string, at: string): boolean {
  let granted = false;
  for (const e of events) {
    if (e.at > at) break;
    if (e.purposes.includes(purpose)) granted = e.action === "grant";
  }
  return granted;
}

/**
 * Look through access log entries for signs of unauthorised access (Rule 6(1)(c)): fields read for
 * a purpose they aren't held for, consent purposes used without consent at the time, and one actor
 * reaching an unusual number of people in a short time.
 */
export async function reviewAccess(input: ReviewInput): Promise<AccessReview> {
  const { config, entries } = input;
  const findings: AccessFinding[] = [];

  for (const e of entries) {
    if (e.outOfPurpose && e.outOfPurpose.length > 0) {
      findings.push({
        kind: "out-of-purpose",
        actor: e.actor,
        subjectId: e.subjectId,
        purpose: e.purpose,
        entries: [e.id],
        message: `${e.actor} accessed ${e.outOfPurpose.join(", ")} for "${e.purpose}", which those fields aren't held for.`,
      });
    }
  }

  const consentPurposes = new Set(Object.keys(config.purposes).filter((p) => config.purposes[p]?.basis === "consent"));
  const histories = new Map<string, readonly ConsentEvent[]>();
  for (const e of entries) {
    if (!consentPurposes.has(e.purpose)) continue;
    let events = histories.get(e.subjectId);
    if (!events) {
      events = await input.history(e.subjectId);
      histories.set(e.subjectId, events);
    }
    if (!grantedAt(events, e.purpose, e.at)) {
      findings.push({
        kind: "no-consent",
        actor: e.actor,
        subjectId: e.subjectId,
        purpose: e.purpose,
        entries: [e.id],
        message: `${e.actor} accessed data for "${e.purpose}" when the person hadn't consented to it.`,
      });
    }
  }

  const windowMs = durationMs(input.window);
  const byActor = new Map<string, AccessEntry[]>();
  for (const e of entries) {
    const list = byActor.get(e.actor);
    if (list) list.push(e);
    else byActor.set(e.actor, [e]);
  }
  for (const [actor, list] of byActor) {
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const counts = new Map<string, number>();
    let start = 0;
    let peak = { subjects: 0, from: 0, to: 0 };
    for (let end = 0; end < list.length; end++) {
      const e = list[end]!;
      counts.set(e.subjectId, (counts.get(e.subjectId) ?? 0) + 1);
      while (Date.parse(e.at) - Date.parse(list[start]!.at) > windowMs) {
        const s = list[start]!.subjectId;
        const n = counts.get(s)! - 1;
        if (n === 0) counts.delete(s);
        else counts.set(s, n);
        start++;
      }
      if (counts.size > peak.subjects) peak = { subjects: counts.size, from: start, to: end };
    }
    if (peak.subjects > input.maxSubjects) {
      findings.push({
        kind: "bulk-access",
        actor,
        subjects: peak.subjects,
        entries: list.slice(peak.from, peak.to + 1).map((e) => e.id),
        message: `${actor} accessed the data of ${peak.subjects} people within ${input.window} (more than ${input.maxSubjects}).`,
      });
    }
  }

  return { from: input.from, to: input.to, scanned: entries.length, findings };
}
