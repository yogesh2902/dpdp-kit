import type { DpdpConfig, Retention } from "./config.js";
import { durationMs, isDuration } from "./duration.js";

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
    | "fiduciary-missing";
  /** Where in the config, e.g. `data.users.fields.phone`. */
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

  return issues;
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.level === "error");
}
