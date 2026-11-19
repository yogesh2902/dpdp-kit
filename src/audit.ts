import { type DpdpConfig, LEGITIMATE_USES, type Retention } from "./config.js";
import { durationMs, isDuration } from "./duration.js";
import { isNoticeLanguage } from "./languages.js";
import { ENGLISH_WORDING, type NoticeWording, REQUIRED_PLACEHOLDERS } from "./notice.js";
import { guessPersonal } from "./personal.js";
import { REQUEST_TYPES } from "./records.js";

export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  code:
    | "no-purposes"
    | "invalid-basis"
    | "invalid-retention"
    | "invalid-legitimate-use"
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
    | "held-rows-block-delete"
    // Section 16 and Rule 15: transfers outside India
    | "invalid-country"
    | "transfer-restricted"
    | "transfer-outside-india"
    | "processor-countries-missing"
    | "foreign-state-transfer"
    // Section 5 and Rule 3: notices, when config.notice is set
    | "notice-link-missing"
    | "notice-description-missing"
    | "notice-label-missing"
    | "notice-translation-incomplete"
    | "invalid-notice-language";
  /** Where in the config (`data.users.fields.phone`), or in the schema (`schema.users.phone`). */
  path: string;
  message: string;
  /**
   * The version that introduced this check, for warnings added after 0.4. `--strict` doesn't fail
   * on a warning in the minor version that introduced it, so upgrading doesn't break CI.
   */
  since?: string;
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
    if (def.legitimateUse !== undefined) {
      if (def.basis !== "legitimate-use") {
        issues.push({
          level: "error",
          code: "invalid-legitimate-use",
          path: `${path}.legitimateUse`,
          message: "legitimateUse only applies to legitimate-use purposes. Remove it, or set basis: \"legitimate-use\".",
        });
      } else if (!LEGITIMATE_USES.includes(def.legitimateUse)) {
        issues.push({
          level: "error",
          code: "invalid-legitimate-use",
          path: `${path}.legitimateUse`,
          message: `legitimateUse must be one of ${LEGITIMATE_USES.join(", ")}: the clause of Section 7 this use relies on.`,
        });
      }
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
  checkTransfers(config, issues);
  checkNotice(config, issues);

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

const COUNTRY = /^[A-Z]{2}$/;

/** Section 16 and Rule 15: where each processor handles the data, against the restrictions you list. */
function checkTransfers(config: DpdpConfig<string>, issues: Issue[]) {
  const badCountry = (value: unknown, path: string) => {
    if (typeof value === "string" && COUNTRY.test(value)) return false;
    issues.push({
      level: "error",
      code: "invalid-country",
      path,
      message: `${JSON.stringify(value)} is not a country code. Use ISO 3166-1 alpha-2 in capitals, e.g. "IN", "US", "SG".`,
    });
    return true;
  };
  const restricted = new Set<string>();
  (config.transfers?.restricted ?? []).forEach((c, i) => {
    if (!badCountry(c, `transfers.restricted.${i}`)) restricted.add(c);
  });
  const keepInIndia = new Set<string>(config.transfers?.keepInIndia ?? []);
  for (const p of keepInIndia) {
    if (!config.purposes[p]) {
      issues.push({ level: "error", code: "unknown-purpose", path: "transfers.keepInIndia", message: `Unknown purpose ${JSON.stringify(p)}.` });
    }
  }

  for (const [name, def] of Object.entries(config.processors ?? {})) {
    const path = `processors.${name}.countries`;
    if (def.foreignState) {
      issues.push({
        level: "warning",
        code: "foreign-state-transfer",
        path: `processors.${name}.foreignState`,
        message: `Rule 15 lets the Central Government set requirements, by general or special order, for making personal data available to a foreign State or an entity it controls. Check for any order that applies before sharing data with ${name}.`,
        since: "0.5",
      });
    }
    if (def.countries === undefined || def.countries.length === 0) {
      issues.push({
        level: "warning",
        code: "processor-countries-missing",
        path,
        message: `Say where ${name} handles the data, e.g. countries: ["IN"] or ["IN", "US"]. Section 16 lets the Central Government restrict transfers to countries it notifies, so you need to know.`,
        since: "0.5",
      });
      continue;
    }
    const countries = def.countries.filter((c, i) => !badCountry(c, `${path}.${i}`));
    for (const c of countries.filter((c) => restricted.has(c))) {
      issues.push({
        level: "error",
        code: "transfer-restricted",
        path,
        message: `${name} handles data in ${c}, which transfers.restricted lists as a country transfers are restricted to under Section 16(1). Stop the transfer or move the processing.`,
      });
    }
    const local = def.purposes.filter((p) => keepInIndia.has(p));
    const abroad = countries.filter((c) => c !== "IN");
    if (local.length > 0 && abroad.length > 0) {
      issues.push({
        level: "error",
        code: "transfer-outside-india",
        path,
        message: `${name} handles data for ${local.join(", ")}, which transfers.keepInIndia says must stay in India, in ${abroad.join(", ")}.`,
      });
    }
  }
}

/** Section 5 and Rule 3: only when the config builds notices (`notice`). */
function checkNotice(config: DpdpConfig<string>, issues: Issue[]) {
  const notice = config.notice;
  if (!notice) return;
  const links = (notice.links ?? {}) as unknown as Partial<Record<string, unknown>>;
  for (const [key, what] of [
    ["website", "the link to your website or app (Rule 3(c))"],
    ["withdraw", "where to withdraw consent, as easily as it was given (Rule 3(c)(i))"],
    ["rights", "where to exercise rights under the Act (Rule 3(c)(ii))"],
  ] as const) {
    if (typeof links[key] !== "string" || (links[key] as string).trim() === "") {
      issues.push({ level: "error", code: "notice-link-missing", path: `notice.links.${key}`, message: `The notice must give ${what}: a URL, or a short description such as "Settings → Privacy in the app".` });
    }
  }

  const consentPurposes = Object.entries(config.purposes).filter(([, d]) => d.basis === "consent").map(([p]) => p);
  const noticeFields = Object.entries(config.data).flatMap(([key, table]) =>
    Object.entries(table.fields ?? {})
      .filter(([, f]) => f.purposes?.some((p) => consentPurposes.includes(p)))
      .map(([field, f]) => ({ key: `${key}.${field}`, label: f.label })),
  );
  for (const p of consentPurposes) {
    if (!config.purposes[p]?.description?.trim()) {
      issues.push({
        level: "error",
        code: "notice-description-missing",
        path: `purposes.${p}.description`,
        message: `The notice must state each purpose and what it provides (Rule 3(b)(ii)), e.g. "Offers and order updates by SMS".`,
      });
    }
  }
  for (const f of noticeFields.filter((f) => !f.label)) {
    issues.push({
      level: "warning",
      code: "notice-label-missing",
      path: `data.${f.key.replace(".", ".fields.")}.label`,
      message: `The notice lists each item of data (Rule 3(b)(i)). Without a label it shows the field name made readable; set label to what people would call it, e.g. "Mobile number".`,
    });
  }

  for (const [language, t] of Object.entries(notice.translations ?? {})) {
    const path = `notice.translations.${language}`;
    if (!isNoticeLanguage(language) || language === "en") {
      issues.push({
        level: "error",
        code: "invalid-notice-language",
        path,
        message: language === "en" ? "English is built in: remove this translation." : `${JSON.stringify(language)} is not English or a language of the Eighth Schedule. Use codes such as "hi", "ta", "bn".`,
      });
      continue;
    }
    const incomplete = (where: string, message: string) => issues.push({ level: "error", code: "notice-translation-incomplete", path: `${path}.${where}`, message });
    if (!t) continue;
    for (const p of consentPurposes) {
      if (!t.purposes?.[p]?.trim()) incomplete(`purposes.${p}`, `Describe purpose ${p} in this language.`);
    }
    for (const f of noticeFields) {
      if (!t.fields?.[f.key]?.trim()) incomplete(`fields.${f.key}`, `Give the label for ${f.key} in this language.`);
    }
    for (const key of Object.keys(ENGLISH_WORDING) as Array<keyof NoticeWording>) {
      const text = t.wording?.[key];
      const needs = REQUIRED_PLACEHOLDERS[key];
      if (typeof text !== "string" || text.trim() === "") incomplete(`wording.${key}`, `Translate this sentence: ${JSON.stringify(ENGLISH_WORDING[key])}.`);
      else if (needs && !text.includes(needs)) incomplete(`wording.${key}`, `Keep ${needs} in this sentence, so the notice still shows it.`);
    }
  }
}
