import type { DpdpConfig } from "./config.js";

/*
 * Section 8(6) of the Act and Rule 7 of the DPDP Rules: on becoming aware of a personal data breach,
 * tell each affected person without delay (Rule 7(1)), tell the Board without delay (Rule 7(2)(a)),
 * and send the Board a detailed report within seventy-two hours, or a longer period the Board allows
 * in writing (Rule 7(2)(b)). Failing to notify carries a penalty of up to ₹200 crore (Schedule,
 * item 2).
 */

/** Rule 7(2)(b): the detailed report is due within seventy-two hours of becoming aware. */
export const BOARD_REPORT_WITHIN_HOURS = 72;

export interface BreachInput {
  /** When you became aware of the breach (ISO 8601). Rule 7's clock starts here. Default: now. */
  awareAt?: string;
  /** When it happened, as far as you know (ISO 8601). */
  occurredAt?: string;
  /** What happened: its nature (Rule 7(1)(a), 7(2)(a)). */
  description: string;
  /** How much data and how many people (Rule 7(1)(a), 7(2)(a)). */
  extent?: string;
  /** Where it happened: system, region or vendor (Rule 7(2)(a)). */
  location?: string;
  /** The likely impact, for the Board (Rule 7(2)(a)). */
  likelyImpact?: string;
  /** The consequences likely for the people affected (Rule 7(1)(b)). */
  consequences?: string;
  /** What you've done and are doing to reduce the risk (Rule 7(1)(c)). */
  measures?: string;
  /** What people can do to protect themselves (Rule 7(1)(d)). */
  safetySteps?: string;
  /** The personal data exposed, as data map keys: `"users.phone"`, or `"users"` for a whole table. */
  fields?: readonly string[];
}

/** The detailed report's parts, Rule 7(2)(b)(i)–(v). Part (vi) is built from the notice records. */
export interface BoardReportInput {
  /** (i) Updated and detailed information about the breach. */
  details?: string;
  /** (ii) The broad facts: events, circumstances and reasons leading to the breach. */
  facts?: string;
  /** (iii) Measures implemented or proposed to mitigate the risk. */
  mitigation?: string;
  /** (iv) Findings about the person who caused the breach. */
  findings?: string;
  /** (v) Remedial measures taken to prevent it happening again. */
  remedial?: string;
}

export interface Breach extends Omit<BreachInput, "awareAt" | "fields"> {
  id: string;
  awareAt: string;
  fields: string[];
  /** When the detailed report to the Board is due: 72 hours after `awareAt`, or the extension. */
  reportDueAt: string;
  /** A longer period the Board allowed on a written request (Rule 7(2)(b)). */
  extension?: { until: string; reference: string; recordedAt: string };
  /** When you told the Board, without delay (Rule 7(2)(a)). */
  boardNotifiedAt?: string;
  /** The detailed report's parts so far. */
  report: BoardReportInput;
  /** When you sent the detailed report (Rule 7(2)(b)). */
  reportSentAt?: string;
  status: "open" | "closed";
  closedAt?: string;
  history: Array<{ at: string; event: string; note?: string }>;
}

/** One affected person, and whether they've been told (Rule 7(1)). */
export interface BreachNotice {
  breachId: string;
  subjectId: string;
  status: "pending" | "sent";
  addedAt: string;
  sentAt?: string;
  /** How they were told, e.g. `"email"`, `"sms"`, `"in-app"`. */
  channel?: string;
}

/** Storage for breach records and notices. Both built-in stores implement it. */
export interface BreachStore {
  insertBreach(breach: Breach): Promise<void>;
  getBreach(id: string): Promise<Breach | undefined>;
  /**
   * Replace a stored breach, but only if no one changed it since it was read. Each change adds one
   * history entry, so save only when the stored history is one entry shorter than `breach.history`.
   * Returns false when it isn't; dpdp-kit then reads it again and retries.
   */
  updateBreach(breach: Breach): Promise<boolean>;
  /** Breaches, newest first. */
  listBreaches(filter: { status?: Breach["status"] }): Promise<Breach[]>;
  /** Add affected people; people already on the breach are left as they are. Returns how many were new. */
  addNotices(notices: readonly BreachNotice[]): Promise<number>;
  /** Mark these people as told. Returns how many changed. */
  markNotices(breachId: string, subjectIds: readonly string[], sentAt: string, channel?: string): Promise<number>;
  listNotices(breachId: string, filter: { status?: BreachNotice["status"]; limit?: number }): Promise<BreachNotice[]>;
  /** How many people are on the breach and how many were told, with the first and last time anyone was. */
  countNotices(breachId: string): Promise<NoticeCounts>;
}

export interface NoticeCounts {
  total: number;
  sent: number;
  firstSentAt?: string;
  lastSentAt?: string;
}

export function isBreachStore(store: object): store is BreachStore {
  const s = store as Partial<BreachStore>;
  return typeof s.insertBreach === "function" && typeof s.addNotices === "function" && typeof s.countNotices === "function";
}

export interface BreachStatus {
  id: string;
  status: Breach["status"];
  awareAt: string;
  /** Rule 7(2)(a): tell the Board without delay. */
  boardNotified: boolean;
  /** Rule 7(2)(b). */
  report: { dueAt: string; sent: boolean; overdue: boolean; hoursLeft: number; missing: Array<keyof BoardReportInput> };
  /** Rule 7(1): each affected person, without delay. */
  people: { total: number; sent: number; pending: number };
  /** What still needs doing, in plain words. */
  todo: string[];
}

const REPORT_PARTS: Array<[keyof BoardReportInput, string]> = [
  ["details", "(i) updated and detailed information"],
  ["facts", "(ii) the facts, circumstances and reasons"],
  ["mitigation", "(iii) measures to mitigate the risk"],
  ["findings", "(iv) findings about who caused it"],
  ["remedial", "(v) measures to prevent recurrence"],
];

export function breachStatus(breach: Breach, counts: NoticeCounts, now: string): BreachStatus {
  const missing = REPORT_PARTS.filter(([k]) => !breach.report[k]).map(([k]) => k);
  const sent = breach.reportSentAt !== undefined;
  const hoursLeft = Math.round(((Date.parse(breach.reportDueAt) - Date.parse(now)) / 3_600_000) * 10) / 10;
  const pending = counts.total - counts.sent;
  const todo: string[] = [];
  if (breach.status === "open") {
    if (!breach.boardNotifiedAt) todo.push("Tell the Board without delay: nature, extent, timing, location and likely impact (Rule 7(2)(a)).");
    if (pending > 0) todo.push(`Tell ${pending} affected ${pending === 1 ? "person" : "people"} without delay (Rule 7(1)).`);
    if (counts.total === 0) todo.push("Record who is affected, so each person can be told (Rule 7(1)).");
    if (!sent) {
      todo.push(
        hoursLeft >= 0
          ? `Send the Board the detailed report within ${hoursLeft} hours (Rule 7(2)(b)).${missing.length ? ` Still missing: ${REPORT_PARTS.filter(([k]) => missing.includes(k)).map(([, label]) => label).join("; ")}.` : ""}`
          : `The detailed report to the Board was due ${-hoursLeft} hours ago (Rule 7(2)(b)). Send it now, or record the Board's written extension.`,
      );
    }
  }
  return {
    id: breach.id,
    status: breach.status,
    awareAt: breach.awareAt,
    boardNotified: breach.boardNotifiedAt !== undefined,
    report: { dueAt: breach.reportDueAt, sent, overdue: !sent && hoursLeft < 0, hoursLeft, missing },
    people: { total: counts.total, sent: counts.sent, pending },
    todo,
  };
}

/** The notice for an affected person, Rule 7(1)(a)–(e). Translate it for their language before sending. */
export interface PersonNotice {
  /** (a) What happened, how much, and when. */
  description: string;
  /** (b) The consequences likely for them. */
  consequences: string;
  /** (c) What you're doing about it. */
  measures: string;
  /** (d) What they can do to protect themselves. */
  safetySteps: string;
  /** (e) Who can answer their questions. */
  contact: string;
  /** All of the above as plain text. */
  text: string;
  /** Parts not filled in yet: send only when this is empty. */
  missing: Array<"consequences" | "measures" | "safetySteps" | "contact">;
}

export function personNotice(config: DpdpConfig<string>, breach: Breach): PersonNotice {
  const when = breach.occurredAt ? ` It happened on ${breach.occurredAt.slice(0, 10)}` : "";
  const description = `${breach.description.trim()}${breach.extent ? ` ${breach.extent.trim()}` : ""}${when ? `${when}.` : ""}`;
  const contact = config.fiduciary.dpo
    ? `If you have questions, contact ${config.fiduciary.dpo}, on behalf of ${config.fiduciary.name}.`
    : "";
  const missing: PersonNotice["missing"] = [];
  if (!breach.consequences) missing.push("consequences");
  if (!breach.measures) missing.push("measures");
  if (!breach.safetySteps) missing.push("safetySteps");
  if (!contact) missing.push("contact");
  const parts = {
    description,
    consequences: breach.consequences?.trim() ?? "",
    measures: breach.measures?.trim() ?? "",
    safetySteps: breach.safetySteps?.trim() ?? "",
    contact,
  };
  const text = [
    `We're writing to tell you about a personal data breach at ${config.fiduciary.name}.`,
    `What happened: ${parts.description}`,
    parts.consequences && `What this may mean for you: ${parts.consequences}`,
    parts.measures && `What we're doing: ${parts.measures}`,
    parts.safetySteps && `What you can do: ${parts.safetySteps}`,
    parts.contact,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { ...parts, text, missing };
}

/** The detailed report for the Board, Rule 7(2)(b)(i)–(vi). */
export interface BoardReport {
  breachId: string;
  awareAt: string;
  dueAt: string;
  /** (i)–(v), as recorded. */
  details: string;
  facts: string;
  mitigation: string;
  findings: string;
  remedial: string;
  /** (vi) The notices given to affected people. */
  intimations: { total: number; sent: number; pending: number; firstSentAt?: string; lastSentAt?: string };
  /** Parts (i)–(v) not filled in yet. */
  missing: Array<keyof BoardReportInput>;
}
