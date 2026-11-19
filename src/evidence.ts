// The evidence report: what the config declares and what the records show, in one document for
// an auditor, a lawyer or the Data Protection Board. It describes practice; it doesn't certify it.
import type { AccessFinding, AccessFindingKind } from "./access.js";
import { audit, type Issue } from "./audit.js";
import type { BreachStatus } from "./breach.js";
import type { DpdpConfig, FiduciaryDef, LegalHold, Retention } from "./config.js";
import type { NoticeKind } from "./notice.js";
import type { NoticeLanguage } from "./languages.js";
import type { RequestStatus, RequestType, RightsRequest } from "./records.js";
import { type RightsInfo, rightsInfo } from "./rights.js";
import { type Safeguard, safeguardsReport } from "./safeguards.js";
import type { ConsentStats, TaskCounts } from "./stats.js";

/** A part of the report the store couldn't provide, and why. */
export interface Unavailable {
  unavailable: string;
}
export const isUnavailable = (v: unknown): v is Unavailable => typeof v === "object" && v !== null && "unavailable" in v;

export interface RequestStats {
  /** Requests opened in the period, by type. */
  opened: Partial<Record<RequestType, number>>;
  /** Requests answered (resolved or rejected) in the period. */
  closed: number;
  /** Of those, answered after their due date. */
  closedLate: number;
  /** All requests by status, now. */
  byStatus: Partial<Record<RequestStatus, number>>;
  /** Open requests past their due date, now. */
  overdue: number;
}

export interface EvidenceReport {
  generatedAt: string;
  /** For the records; absent in a report built from the config alone. */
  period?: { from: string; to: string };
  fiduciary: FiduciaryDef;
  purposes: Array<{ purpose: string; basis: string; legitimateUse?: string; description?: string; retain: string }>;
  data: Array<{
    key: string;
    table: string;
    fields: Array<{ field: string; category: string; purposes: string[]; protect?: string }>;
    legalHold?: LegalHold;
  }>;
  processors: Array<{ name: string; purposes: string[]; contract?: string; countries?: string[]; foreignState?: boolean }>;
  minimumRetention?: string;
  audit: Issue[];
  safeguards: Safeguard[];
  rights: RightsInfo;
  notices?: Array<{ version: string; language: NoticeLanguage; kind: NoticeKind; firstShownAt: string; purposes: number }> | Unavailable;
  consent?: ConsentStats | Unavailable;
  requests?: RequestStats | Unavailable;
  erasure?: TaskCounts | Unavailable;
  access?: { scanned: number; findings: Partial<Record<AccessFindingKind, number>>; examples: AccessFinding[] } | Unavailable;
  breaches?: BreachStatus[] | Unavailable;
  /** What needs attention, in plain words. Empty when nothing does. */
  gaps: string[];
}

export function describeRetention(retain: Retention): string {
  if (typeof retain === "string") return retain === "while-active" ? "while the purpose is active" : `${retain} after collection`;
  return retain.afterWithdrawal === "0d" ? "until consent is withdrawn" : `${retain.afterWithdrawal} after consent is withdrawn`;
}

/** The parts of the report that come from the config alone: no database needed. */
export function staticEvidence(config: DpdpConfig<string>, generatedAt = new Date().toISOString()): EvidenceReport {
  const report: EvidenceReport = {
    generatedAt,
    fiduciary: { ...config.fiduciary },
    purposes: Object.entries(config.purposes).map(([purpose, d]) => ({
      purpose,
      basis: d.basis,
      ...(d.legitimateUse ? { legitimateUse: d.legitimateUse } : {}),
      ...(d.description ? { description: d.description } : {}),
      retain: describeRetention(d.retain),
    })),
    data: Object.entries(config.data).map(([key, t]) => ({
      key,
      table: t.table,
      fields: Object.entries(t.fields).map(([field, f]) => ({ field, category: f.category, purposes: [...f.purposes], ...(f.protect ? { protect: f.protect } : {}) })),
      ...(t.legalHold ? { legalHold: { ...t.legalHold } } : {}),
    })),
    processors: Object.entries(config.processors ?? {}).map(([name, p]) => ({
      name,
      purposes: [...p.purposes],
      ...(p.contract ? { contract: p.contract } : {}),
      ...(p.countries ? { countries: [...p.countries] } : {}),
      ...(p.foreignState ? { foreignState: true } : {}),
    })),
    ...(config.minimumRetention ? { minimumRetention: config.minimumRetention } : {}),
    audit: audit(config),
    safeguards: safeguardsReport(config),
    rights: rightsInfo(config),
    gaps: [],
  };
  report.gaps = gapsOf(report);
  return report;
}

export function requestStats(requests: readonly RightsRequest[], from: string, to: string, now: string): RequestStats {
  const stats: RequestStats = { opened: {}, closed: 0, closedLate: 0, byStatus: {}, overdue: 0 };
  for (const r of requests) {
    if (r.openedAt >= from && r.openedAt < to) stats.opened[r.type] = (stats.opened[r.type] ?? 0) + 1;
    if (r.closedAt && r.closedAt >= from && r.closedAt < to) {
      stats.closed++;
      if (r.closedAt > r.dueAt) stats.closedLate++;
    }
    stats.byStatus[r.status] = (stats.byStatus[r.status] ?? 0) + 1;
    if (r.status === "open" && r.dueAt < now) stats.overdue++;
  }
  return stats;
}

/** What needs attention, from everything else in the report. */
export function gapsOf(r: EvidenceReport): string[] {
  const gaps: string[] = [];
  for (const i of r.audit.filter((i) => i.level === "error")) gaps.push(`Audit error at ${i.path}: ${i.message}`);
  const warnings = r.audit.filter((i) => i.level === "warning");
  if (warnings.length > 0) gaps.push(`${warnings.length} audit warning(s): ${warnings.map((i) => i.path).join(", ")}`);
  for (const s of r.safeguards.filter((s) => s.status === "missing" || s.status === "partly")) {
    gaps.push(`Rule 6(1)${s.clause} ${s.title}: ${s.status === "missing" ? "not recorded" : "partly recorded"}`);
  }
  if (r.requests && !isUnavailable(r.requests)) {
    if (r.requests.overdue > 0) gaps.push(`${r.requests.overdue} rights request(s) open past their due date`);
    if (r.requests.closedLate > 0) gaps.push(`${r.requests.closedLate} rights request(s) answered late in the period`);
  }
  if (r.erasure && !isUnavailable(r.erasure)) {
    if (r.erasure.late > 0) gaps.push(`${r.erasure.late} erasure task(s) past their due date: is the retention runner running?`);
    const manual = r.erasure.byStatus.manual ?? 0;
    if (manual > 0) gaps.push(`${manual} erasure task(s) waiting for a person (manual)`);
  }
  if (r.access && !isUnavailable(r.access)) {
    const n = Object.values(r.access.findings).reduce((a, b) => a + (b ?? 0), 0);
    if (n > 0) gaps.push(`${n} access review finding(s) in the period`);
  }
  if (r.breaches && !isUnavailable(r.breaches)) {
    for (const b of r.breaches) for (const t of b.todo) gaps.push(`Breach ${b.id}: ${t}`);
  }
  return gaps;
}

const table = (head: string[], rows: string[][]) =>
  rows.length === 0 ? "_None._" : [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");
const counts = (o: Partial<Record<string, number>>) =>
  Object.entries(o)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${k}: ${n}`)
    .join(", ") || "none";
const day = (iso: string) => iso.slice(0, 10);

/** The report as Markdown, ready to save, print or convert to PDF. */
export function formatEvidence(r: EvidenceReport): string {
  const out: string[] = [];
  const section = (title: string, body: string) => out.push(`## ${title}`, "", body, "");
  const unavailable = (v: Unavailable) => `_Not available: ${v.unavailable}._`;

  out.push(`# DPDP Act evidence: ${r.fiduciary.name}`, "");
  out.push(`Generated ${r.generatedAt}${r.period ? `, for ${day(r.period.from)} to ${day(r.period.to)}` : ", from the configuration only"}.`, "");
  out.push(
    "> This report shows what the organisation has declared in its dpdp-kit configuration and what dpdp-kit has recorded. It is evidence of practice, not a certificate of compliance, and it can't see systems dpdp-kit isn't connected to.",
    "",
  );

  section("What needs attention", r.gaps.length === 0 ? "Nothing outstanding." : r.gaps.map((g) => `- ${g}`).join("\n"));

  section(
    "Data Fiduciary",
    [`- Name: ${r.fiduciary.name}`, `- Contact (Section 8(9), Rule 9): ${r.fiduciary.dpo ?? "not set"}`, `- Grievances (Section 8(10)): ${r.fiduciary.grievanceUrl ?? "not set"}`].join("\n"),
  );

  section(
    "Purposes (Sections 4 to 7)",
    table(
      ["Purpose", "Basis", "Description", "Kept"],
      r.purposes.map((p) => [p.purpose, p.basis === "consent" ? "Consent" : `Legitimate use${p.legitimateUse ? `, Section ${p.legitimateUse}` : ""}`, p.description ?? "", p.retain]),
    ),
  );

  section(
    "Personal data held",
    r.data
      .map(
        (t) =>
          `**${t.key}** (\`${t.table}\`)${t.legalHold ? `: kept ${t.legalHold.keep} for ${t.legalHold.reason}, then ${t.legalHold.then === "delete" ? "deleted" : "anonymised"}` : ""}\n\n` +
          table(["Field", "Category", "Purposes", "Protection"], t.fields.map((f) => [f.field, f.category, f.purposes.join(", "), f.protect ?? ""])),
      )
      .join("\n\n") + (r.minimumRetention ? `\n\nMinimum retention (Rule 8(3)): ${r.minimumRetention}.` : ""),
  );

  section(
    "Data Processors (Section 8(2), Rule 6(1)(f), Section 16)",
    table(
      ["Processor", "Purposes", "Contract", "Countries"],
      r.processors.map((p) => [p.name, p.purposes.join(", "), p.contract ?? "not recorded", `${p.countries?.join(", ") ?? "not recorded"}${p.foreignState ? " (foreign State)" : ""}`]),
    ),
  );

  section(
    "Security safeguards (Rule 6(1))",
    table(
      ["Clause", "Safeguard", "Status", "Details"],
      r.safeguards.map((s) => [s.clause, s.title, s.status, s.details.join("; ")]),
    ),
  );

  section(
    "How people exercise their rights (Rule 14)",
    [
      `- How to make a request: ${r.rights.how ?? "not published"}`,
      `- Identifiers asked for: ${r.rights.identifiers.join(", ") || "none listed"}`,
      `- Answer within: ${Object.entries(r.rights.responseWithin).map(([t, d]) => `${t} ${d}`).join(", ")}`,
      `- Identity check before acting on a request: ${r.rights.verify}`,
    ].join("\n"),
  );

  if (r.notices) {
    section(
      "Notices shown (Section 5, Rule 3)",
      isUnavailable(r.notices)
        ? unavailable(r.notices)
        : table(["Version", "Language", "Kind", "Purposes", "First shown"], r.notices.map((n) => [n.version, n.language, n.kind, String(n.purposes), n.firstShownAt])),
    );
  }
  if (r.consent) {
    const c = r.consent;
    section(
      "Consent (Section 6)",
      isUnavailable(c)
        ? unavailable(c)
        : [
            `${c.events} consent event(s) from ${c.people} person(s) in the period: ${counts(c.byAction)}.`,
            "",
            table(
              ["Purpose", "In the period", "Granted now", "Objecting now"],
              [...new Set([...Object.keys(c.byPurpose), ...Object.keys(c.grantedNow), ...Object.keys(c.objectedNow)])].map((p) => [
                p,
                counts(c.byPurpose[p] ?? {}),
                String(c.grantedNow[p] ?? 0),
                String(c.objectedNow[p] ?? 0),
              ]),
            ),
          ].join("\n"),
    );
  }
  if (r.requests) {
    const q = r.requests;
    section(
      "Rights requests (Sections 11 to 14)",
      isUnavailable(q)
        ? unavailable(q)
        : [
            `- Opened in the period: ${counts(q.opened)}`,
            `- Answered in the period: ${q.closed}, of which late: ${q.closedLate}`,
            `- All requests now: ${counts(q.byStatus)}`,
            `- Open past their due date now: ${q.overdue}`,
          ].join("\n"),
    );
  }
  if (r.erasure) {
    const e = r.erasure;
    section("Erasure (Section 8(7), Rule 8)", isUnavailable(e) ? unavailable(e) : `Tasks by status: ${counts(e.byStatus)}. Past their due date: ${e.late}.`);
  }
  if (r.access) {
    const a = r.access;
    section(
      "Access review (Rule 6(1)(c))",
      isUnavailable(a)
        ? unavailable(a)
        : [
            `${a.scanned} access(es) reviewed. Findings: ${counts(a.findings)}.`,
            ...(a.examples.length
              ? ["", table(["Kind", "Who", "Whose data", "Finding"], a.examples.map((f) => [f.kind, f.actor, f.subjectId ?? "", f.message]))]
              : []),
          ].join("\n"),
    );
  }
  if (r.breaches) {
    const b = r.breaches;
    section(
      "Breaches (Section 8(6), Rule 7)",
      isUnavailable(b)
        ? unavailable(b)
        : table(
            ["Breach", "Aware", "Status", "Board told", "Detailed report", "People told"],
            b.map((x) => [
              x.id,
              x.awareAt,
              x.status,
              x.boardNotified ? "yes" : "no",
              x.report.sent ? "sent" : `${x.report.overdue ? "overdue" : "due"} ${x.report.dueAt}`,
              `${x.people.sent} of ${x.people.total}`,
            ]),
          ),
    );
  }

  const errors = r.audit.filter((i) => i.level === "error");
  const warnings = r.audit.filter((i) => i.level === "warning");
  section(
    "Configuration audit",
    errors.length + warnings.length === 0 ? "No problems found." : table(["Level", "Where", "Problem"], [...errors, ...warnings].map((i) => [i.level, i.path, i.message])),
  );

  return `${out.join("\n").trimEnd()}\n`;
}

