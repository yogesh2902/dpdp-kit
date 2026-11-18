import type { DpdpConfig, Retention } from "./config.js";
import { durationMs, isDuration } from "./duration.js";
import { guessPersonal } from "./personal.js";
import { REQUEST_TYPES } from "./records.js";

export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  code:
    | "no-purposes"
    | "invalid-basis"
    | "invalid-retention"
    | "invalid-duration"
    | "unknown-purpose"
    | "field-without-purpose"
    | "table-without-fields"
    | "missing-subject-column"
    | "unused-purpose"
    | "minimum-retention-missing"
    | "minimum-retention-too-short"
    | "grievance-missing"
    | "contact-missing"
    | "fiduciary-missing"
    | "invalid-not-personal"
    // from checkSchema(), comparing the data map with the real database schema
    | "unknown-table"
    | "unknown-column"
    | "unmapped-personal-column"
    | "stale-not-personal"
    | "grievance-response-too-long"
    | "invalid-request-type"
    // Rule 6: security safeguards
    | "unprotected-high-risk-field"
    | "processor-contract-missing"
    | "security-measure-missing"
    | "access-log-retention-too-short"
    | "invalid-erase"
    | "erase-not-null"
    | "erase-type-mismatch"
    // legal holds against the database's foreign keys
    | "held-rows-cascade"
    | "held-link-lost"
    | "held-rows-block-delete";
  /** Where in the config (`data.users.fields.phone`), or in the schema (`schema.users.phone`). */
  path: string;
  message: string;
}

const ONE_YEAR_MS = durationMs("1y");

function checkRetention(retain: Retention, path: string, issues: Issue[]) {
  if (retain === "while-active" || isDuration(retain)) return;
  if (retain && typeof retain === "object" && "afterWithdrawal" in retain) {
    if (!isDuration(retain.afterWithdrawal)) {
      issues.push({
        level: "error",
        code: "invalid-duration",
        path: `${path}.afterWithdrawal`,
        message: `${JSON.stringify(retain.afterWithdrawal)} is not a duration. Use e.g. "0d", "30d", "1y".`,
      });
    }
    return;
  }
  issues.push({
    level: "error",
    code: "invalid-retention",
    path,
    message: `Retention must be "while-active", a duration like "1y", or { afterWithdrawal: "30d" }.`,
  });
}

function checkPurposeList(
  purposes: readonly string[] | undefined,
  known: Set<string>,
  used: Set<string>,
  path: string,
  issues: Issue[],
) {
  if (!purposes || purposes.length === 0) {
    issues.push({
      level: "error",
      code: "field-without-purpose",
      path: `${path}.purposes`,
      message: "List at least one purpose. Personal data with no purpose must not be collected.",
    });
    return;
  }
  for (const p of purposes) {
    used.add(p);
    if (!known.has(p)) {
      issues.push({
        level: "error",
        code: "unknown-purpose",
        path: `${path}.purposes`,
        message: `Unknown purpose ${JSON.stringify(p)}. Declare it under \`purposes\` or fix the spelling.`,
      });
    }
  }
}

/**
 * Check a config for mistakes. Errors mean the config can't be used; warnings are things a
 * reviewer should look at. This checks the config's own consistency, not legal compliance.
 */
export function audit(config: DpdpConfig<string>): Issue[] {
  const issues: Issue[] = [];
  const purposes = config.purposes ?? {};
  const known = new Set(Object.keys(purposes));
  const used = new Set<string>();

  if (!config.fiduciary?.name) {
    issues.push({
      level: "error",
      code: "fiduciary-missing",
      path: "fiduciary.name",
      message: "Name the Data Fiduciary (your organisation). It appears on every notice.",
    });
  }
  if (!config.fiduciary?.grievanceUrl) {
    issues.push({
      level: "warning",
      code: "grievance-missing",
      path: "fiduciary.grievanceUrl",
      message:
        "Add where people can raise a grievance. Section 8(10) requires a grievance mechanism, and Section 5(1)(ii) requires the notice to say how to use it.",
    });
  }

  if (!config.fiduciary?.dpo) {
    issues.push({
      level: "warning",
      code: "contact-missing",
      path: "fiduciary.dpo",
      message:
        "Add your Data Protection Officer, or a person who can answer questions about personal data, with their business contact. Section 8(9) requires publishing it, and Rule 7(1)(e) requires it in every breach notice.",
    });
  }

  if (known.size === 0) {
    issues.push({ level: "error", code: "no-purposes", path: "purposes", message: "Declare at least one purpose." });
  }

  for (const [name, def] of Object.entries(purposes)) {
    const path = `purposes.${name}`;
    if (def.basis !== "consent" && def.basis !== "legitimate-use") {
      issues.push({
        level: "error",
        code: "invalid-basis",
        path: `${path}.basis`,
        message: `Basis must be "consent" or "legitimate-use".`,
      });
    }
    checkRetention(def.retain, `${path}.retain`, issues);
    if (def.basis === "legitimate-use" && typeof def.retain === "object") {
      issues.push({
        level: "error",
        code: "invalid-retention",
        path: `${path}.retain`,
        message:
          "afterWithdrawal only applies to consent purposes (Section 6(4)). Use \"while-active\" or a duration for a legitimate use.",
      });
    }
  }

  for (const [key, table] of Object.entries(config.data ?? {})) {
    const path = `data.${key}`;
    if (!table.subject) {
      issues.push({
        level: "error",
        code: "missing-subject-column",
        path: `${path}.subject`,
        message: "Name the column that holds the person's id, so their rows can be found.",
      });
    }
    const fields = Object.entries(table.fields ?? {});
    if (fields.length === 0) {
      issues.push({
        level: "warning",
        code: "table-without-fields",
        path: `${path}.fields`,
        message: "No personal fields listed. Remove the table from the map, or list its fields.",
      });
    }
    for (const [field, def] of fields) {
      checkPurposeList(def.purposes, known, used, `${path}.fields.${field}`, issues);
    }
    if (table.legalHold && !isDuration(table.legalHold.keep)) {
      issues.push({
        level: "error",
        code: "invalid-duration",
        path: `${path}.legalHold.keep`,
        message: `${JSON.stringify(table.legalHold.keep)} is not a duration. Use e.g. "8y".`,
      });
    }
  }

  for (const [name, processor] of Object.entries(config.processors ?? {})) {
    checkPurposeList(processor.purposes, known, used, `processors.${name}`, issues);
  }

  for (const name of known) {
    if (!used.has(name)) {
      issues.push({
        level: "warning",
        code: "unused-purpose",
        path: `purposes.${name}`,
        message: "No field or processor uses this purpose. Remove it, or map the data it covers.",
      });
    }
  }

  for (const entry of config.notPersonal ?? []) {
    if (!/^[^.\s]+(\.[^.\s]+)*\.([^.\s]+|\*)$/.test(entry)) {
      issues.push({
        level: "error",
        code: "invalid-not-personal",
        path: "notPersonal",
        message: `${JSON.stringify(entry)} should be "table.column" or "table.*".`,
      });
    }
  }

  const within = config.rights?.responseWithin;
  if (within !== undefined) {
    const entries: [string, unknown][] =
      typeof within === "string" ? [["", within]] : Object.entries(within as Record<string, unknown>);
    for (const [type, value] of entries) {
      const path = type ? `rights.responseWithin.${type}` : "rights.responseWithin";
      if (type && !(REQUEST_TYPES as readonly string[]).includes(type)) {
        issues.push({
          level: "error",
          code: "invalid-request-type",
          path,
          message: `Unknown request type. Use one of: ${REQUEST_TYPES.join(", ")}.`,
        });
      } else if (!isDuration(value)) {
        issues.push({ level: "error", code: "invalid-duration", path, message: `${JSON.stringify(value)} is not a duration. Use e.g. "30d".` });
      } else if ((type === "" || type === "grievance") && durationMs(value) > durationMs("90d")) {
        issues.push({
          level: "error",
          code: "grievance-response-too-long",
          path,
          message: 'Rule 14(3) of the DPDP Rules requires answering grievances within ninety days. Use at most "90d".',
        });
      }
    }
  }

  const minimum = config.minimumRetention;
  if (minimum === undefined) {
    issues.push({
      level: "warning",
      code: "minimum-retention-missing",
      path: "minimumRetention",
      message:
        'Set minimumRetention. Rule 8(3) of the DPDP Rules requires keeping personal data, traffic data and logs of each processing for at least one year from the processing ("1y").',
    });
  } else if (!isDuration(minimum)) {
    issues.push({
      level: "error",
      code: "invalid-duration",
      path: "minimumRetention",
      message: `${JSON.stringify(minimum)} is not a duration. Use e.g. "1y".`,
    });
  } else if (durationMs(minimum) < ONE_YEAR_MS) {
    issues.push({
      level: "error",
      code: "minimum-retention-too-short",
      path: "minimumRetention",
      message:
        'Rule 8(3) of the DPDP Rules requires keeping personal data, traffic data and logs of each processing for at least one year. Use at least "1y".',
    });
  }

  checkSecurity(config, issues);
  checkErase(config, issues);

  return issues;
}

/** Each field's `erase` setting must be "null", "redact" or { value }. */
function checkErase(config: DpdpConfig<string>, issues: Issue[]) {
  for (const [key, table] of Object.entries(config.data ?? {})) {
    for (const [field, def] of Object.entries(table.fields ?? {})) {
      const erase = def.erase as unknown;
      if (erase === undefined || erase === "null" || erase === "redact") continue;
      if (erase && typeof erase === "object" && "value" in erase) {
        const value = (erase as { value: unknown }).value;
        if (value === null || ["string", "number", "boolean", "function"].includes(typeof value)) continue;
      }
      issues.push({
        level: "error",
        code: "invalid-erase",
        path: `data.${key}.fields.${field}.erase`,
        message: 'erase must be "null", "redact", or { value } with a string, number, boolean, null, or a function returning one.',
      });
    }
  }
}

/** Identifiers whose exposure does the most harm: government ids and bank or card numbers. */
const HIGH_RISK_MATCHES = new Set([
  "aadhaar",
  "aadhar",
  "uidai",
  "pan",
  "passport",
  "voter id",
  "epic",
  "driving licence",
  "driving license",
  "abha",
  "account number",
  "bank account",
  "card number",
  "iban",
]);
const HIGH_RISK_CATEGORIES = new Set(["health", "biometric"]);

/** Whether a field holds high-risk data, judging by its declared category and its name. */
export function isHighRisk(field: string, category: string): boolean {
  if (HIGH_RISK_CATEGORIES.has(category)) return true;
  const guess = guessPersonal(field);
  return guess !== undefined && guess.confidence === "strong" && (HIGH_RISK_MATCHES.has(guess.matched) || HIGH_RISK_CATEGORIES.has(guess.category));
}

const SECURITY_MEASURES = [
  ["accessControl", "(b)", "how access to your computer resources is controlled (for example SSO and least-privilege roles)"],
  ["backups", "(d)", "how processing continues after a compromise or loss of data (for example tested backups)"],
  ["measures", "(g)", "the technical and organisational measures that make the safeguards work (for example training and access reviews)"],
] as const;

/** Rule 6(1): reasonable security safeguards. */
function checkSecurity(config: DpdpConfig<string>, issues: Issue[]) {
  for (const [key, table] of Object.entries(config.data ?? {})) {
    for (const [field, def] of Object.entries(table.fields ?? {})) {
      if (!def.protect && isHighRisk(field, def.category)) {
        issues.push({
          level: "warning",
          code: "unprotected-high-risk-field",
          path: `data.${key}.fields.${field}.protect`,
          message: `${field} looks like high-risk personal data. Rule 6(1)(a) lists encryption, obfuscation, masking and virtual tokens as safeguards: store it protected (see dpdp-kit/protect) and say how with protect: "encrypted" | "tokenised" | "masked" | "hashed".`,
        });
      }
    }
  }

  for (const [name, def] of Object.entries(config.processors ?? {})) {
    if (!def.contract) {
      issues.push({
        level: "warning",
        code: "processor-contract-missing",
        path: `processors.${name}.contract`,
        message: `Rule 6(1)(f) requires a provision for reasonable security safeguards in your contract with each Data Processor. Record where it is, e.g. contract: "DPA signed 2026-03-01, clause 7".`,
      });
    }
  }

  for (const [key, clause, what] of SECURITY_MEASURES) {
    if (!config.security?.[key]) {
      issues.push({
        level: "warning",
        code: "security-measure-missing",
        path: `security.${key}`,
        message: `Rule 6(1)${clause} requires ${what}. Describe what you do in a sentence, as evidence.`,
      });
    }
  }

  const keep = config.security?.accessLogRetention;
  if (keep !== undefined && !isDuration(keep)) {
    issues.push({
      level: "error",
      code: "invalid-duration",
      path: "security.accessLogRetention",
      message: `${JSON.stringify(keep)} is not a duration. Use e.g. "1y".`,
    });
  } else if (keep !== undefined && durationMs(keep) < ONE_YEAR_MS) {
    issues.push({
      level: "error",
      code: "access-log-retention-too-short",
      path: "security.accessLogRetention",
      message: 'Rule 6(1)(e) of the DPDP Rules requires keeping access logs for one year to detect and investigate unauthorised access. Use at least "1y".',
    });
  }
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.level === "error");
}
