import { isHighRisk } from "./audit.js";
import type { DpdpConfig } from "./config.js";
import { DEFAULT_ACCESS_LOG_RETENTION } from "./access.js";
import { durationMs, isDuration } from "./duration.js";

/**
 * - `declared`: the config records it (a measure described, fields protected, contracts noted).
 * - `partly`: some of it is recorded.
 * - `missing`: nothing is recorded.
 * - `in-code`: dpdp-kit provides it when your app uses the API (`dpdp.access`).
 */
export type SafeguardStatus = "declared" | "partly" | "missing" | "in-code";

export interface Safeguard {
  /** The clause of Rule 6(1), e.g. `"(a)"`. */
  clause: string;
  title: string;
  status: SafeguardStatus;
  /** What the config says, or what to add. */
  details: string[];
}

/**
 * Rule 6(1) of the DPDP Rules lists the minimum reasonable security safeguards, (a) to (g). This
 * reports, for each one, what your config records as evidence and what's missing. It can't see
 * your infrastructure: a described measure is only as true as the description.
 */
export function safeguardsReport(config: DpdpConfig<string>): Safeguard[] {
  const security = config.security ?? {};
  const report: Safeguard[] = [];

  // (a) encryption, obfuscation, masking, virtual tokens
  const protectedFields: string[] = [];
  const unprotected: string[] = [];
  for (const [key, table] of Object.entries(config.data ?? {})) {
    for (const [field, def] of Object.entries(table.fields ?? {})) {
      if (def.protect) protectedFields.push(`${key}.${field}: ${def.protect}`);
      else if (isHighRisk(field, def.category)) unprotected.push(`${key}.${field}`);
    }
  }
  report.push({
    clause: "(a)",
    title: "Encryption, obfuscation, masking or virtual tokens",
    status: unprotected.length === 0 ? (protectedFields.length > 0 ? "declared" : "missing") : protectedFields.length > 0 ? "partly" : "missing",
    details: [
      ...protectedFields,
      ...unprotected.map((f) => `${f}: high-risk and unprotected; encrypt it (dpdp-kit/protect) and set protect`),
      ...(protectedFields.length === 0 && unprotected.length === 0 ? ["No field declares protect. Mark how sensitive fields are stored."] : []),
    ],
  });

  const described = (clause: string, title: string, value: string | undefined, key: string, hint: string): Safeguard => ({
    clause,
    title,
    status: value ? "declared" : "missing",
    details: [value ?? `Add security.${key}: ${hint}`],
  });

  // (b) access control
  report.push(described("(b)", "Access control to computer resources", security.accessControl, "accessControl", "how access is controlled, e.g. SSO and least-privilege roles"));

  // (c) logs, monitoring and review
  report.push({
    clause: "(c)",
    title: "Logs, monitoring and review of access",
    status: "in-code",
    details: ["Record access with dpdp.access.log() and run dpdp.access.review() daily to find unauthorised access."],
  });

  // (d) continued processing, e.g. backups
  report.push(described("(d)", "Continued processing after a compromise (e.g. backups)", security.backups, "backups", "your backups and how often restores are tested"));

  // (e) a year of logs and personal data
  const logKeep = security.accessLogRetention ?? DEFAULT_ACCESS_LOG_RETENTION;
  const logsOk = isDuration(logKeep) && durationMs(logKeep) >= durationMs("1y");
  const dataOk = config.minimumRetention !== undefined && isDuration(config.minimumRetention) && durationMs(config.minimumRetention) >= durationMs("1y");
  report.push({
    clause: "(e)",
    title: "Keep logs and personal data for one year",
    status: logsOk && dataOk ? "declared" : logsOk || dataOk ? "partly" : "missing",
    details: [
      logsOk ? `Access log kept ${logKeep}; prune with dpdp.access.prune()` : `security.accessLogRetention must be at least "1y"`,
      dataOk ? `Personal data kept at least ${config.minimumRetention} (minimumRetention)` : `Set minimumRetention: "1y"`,
    ],
  });

  // (f) security provisions in processor contracts
  const processors = Object.entries(config.processors ?? {});
  const withContract = processors.filter(([, p]) => p.contract);
  report.push({
    clause: "(f)",
    title: "Security safeguards in contracts with Data Processors",
    status: processors.length === 0 || withContract.length === processors.length ? "declared" : withContract.length > 0 ? "partly" : "missing",
    details:
      processors.length === 0
        ? ["No processors declared."]
        : processors.map(([name, p]) => (p.contract ? `${name}: ${p.contract}` : `${name}: add contract, where the security provision is`)),
  });

  // (g) technical and organisational measures
  report.push(described("(g)", "Technical and organisational measures", security.measures, "measures", "e.g. security training and periodic access reviews"));

  return report;
}

const MARK: Record<SafeguardStatus, string> = { declared: "✔", "in-code": "◆", partly: "◐", missing: "✖" };

export function formatSafeguards(report: readonly Safeguard[]): string {
  const lines = ["Rule 6(1) of the DPDP Rules: reasonable security safeguards", ""];
  for (const s of report) {
    lines.push(`${MARK[s.status]} ${s.clause} ${s.title}  [${s.status}]`);
    for (const d of s.details) lines.push(`      ${d}`);
  }
  const missing = report.filter((s) => s.status === "missing" || s.status === "partly").length;
  lines.push("", missing === 0 ? "Every safeguard is recorded or provided." : `${missing} safeguard(s) missing or partly recorded.`);
  lines.push("This reads your config, not your infrastructure: keep the descriptions true.");
  return lines.join("\n");
}
