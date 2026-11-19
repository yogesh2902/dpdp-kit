import { DpdpError } from "./errors.js";
import type { Duration } from "./duration.js";
import type { NoticeConfig } from "./notice.js";
import type { RequestType } from "./records.js";

/**
 * Why you may process data for a purpose.
 * - `"consent"`: the person agreed (Section 6(1)). They can withdraw at any time, as easily as
 *   they gave it (Section 6(4)).
 * - `"legitimate-use"`: one of the uses listed in Section 7, which need no consent. For most apps
 *   that means Section 7(a): data the person voluntarily gave you for a specified purpose (a
 *   receipt by SMS, an order delivery). Section 7(a) applies only while they haven't told you they
 *   don't want it used, so it isn't permanent. Section 7(i) covers employment. The other clauses
 *   are for the State, legal orders, medical emergencies and disasters.
 *
 * Keeping data because another law requires it (tax, KYC) is not a legitimate use. Model it as a
 * `legalHold` on the table instead (Section 8(7)).
 */
export type Basis = "consent" | "legitimate-use";

/**
 * How long data held for a purpose is kept.
 * - `"while-active"`: for as long as the purpose is still being served (e.g. the account is open).
 * - a duration, e.g. `"1y"`: at most this long after it was collected.
 * - `{ afterWithdrawal }`: for consent purposes, how long after withdrawal before it's erased
 *   (default `"0d"`). Section 8(7)(a) says to erase upon withdrawal, and Section 6(6) to stop
 *   processing within a reasonable time, so keep this to the delay your systems really need
 *   (batch jobs, backups).
 */
export type Retention = "while-active" | Duration | { afterWithdrawal: Duration };

/**
 * Which clause of Section 7 a legitimate use relies on. Only `"7(a)"` (data the person gave
 * voluntarily for a specified purpose) can be objected to: Section 7(a) holds only while the person
 * "has not indicated … that she does not consent", so `consent.object()` stops it.
 */
export type LegitimateUse = "7(a)" | "7(b)" | "7(c)" | "7(d)" | "7(e)" | "7(f)" | "7(g)" | "7(h)" | "7(i)";

export const LEGITIMATE_USES: readonly LegitimateUse[] = ["7(a)", "7(b)", "7(c)", "7(d)", "7(e)", "7(f)", "7(g)", "7(h)", "7(i)"];

export interface PurposeDef {
  basis: Basis;
  retain: Retention;
  /** Plain-language description, as shown to people in the notice. */
  description?: string;
  /** For a legitimate-use purpose: the clause of Section 7 it relies on. `"7(a)"` purposes accept objections. */
  legitimateUse?: LegitimateUse;
}

/** Kind of personal data. Free text is allowed; these are the common ones. */
export type Category =
  | "contact"
  | "identity"
  | "financial"
  | "health"
  | "location"
  | "device"
  | "biometric"
  | "behavioural"
  | (string & {});

/**
 * How a field is protected where it's stored. Rule 6(1)(a) of the DPDP Rules lists "encryption,
 * obfuscation, masking or the use of virtual tokens mapped to that personal data" as safeguards.
 * - `"encrypted"`: stored encrypted (e.g. with `createEncryptor` from `dpdp-kit/protect`).
 * - `"tokenised"`: replaced by a token that maps to the value kept elsewhere (a vault).
 * - `"masked"`: only a masked form is stored (e.g. the last four digits of an Aadhaar number).
 * - `"hashed"`: only a keyed hash is stored, for matching (e.g. `createTokenizer`).
 */
export type Protection = "encrypted" | "tokenised" | "masked" | "hashed";

/** A value a field can be set to when it's erased. */
export type ErasedValue = string | number | boolean | null;

/** Text written by `erase: "redact"`. */
export const REDACTED = "[erased]";

/**
 * What a field becomes when it's erased. Default `"null"`.
 * - `"null"`: set to `NULL`. The column must be nullable.
 * - `"redact"`: set to the text `"[erased]"`, for `NOT NULL` text columns.
 * - `{ value }`: a fixed value, or a function of the person and field, for columns with other
 *   constraints, e.g. a `NOT NULL UNIQUE` email:
 *   `{ value: ({ subjectId }) => \`erased-${subjectId}@invalid\` }`.
 *
 * The replacement must not identify the person: use their internal id, never a hash of their data.
 */
export type EraseWith =
  | "null"
  | "redact"
  | { value: ErasedValue | ((field: { subjectId: string; table: string; field: string }) => ErasedValue) };

export interface PersonalField<P extends string = string> {
  category: Category;
  /**
   * How the field is named in the notice, e.g. `"Mobile number"`. Rule 3(b)(i) requires an
   * itemised description of the data. Default: the field name made readable (`phoneNumber` →
   * "Phone number").
   */
  label?: string;
  /** Every purpose this field is held for. When all of them end, the field must go. */
  purposes: readonly P[];
  /** This field can tell you the person is under 18 (e.g. date of birth). Used from v0.3. */
  childSignal?: boolean;
  /**
   * How the field is protected at rest (Rule 6(1)(a)). The audit warns when a high-risk
   * identifier (Aadhaar, PAN, passport, bank account, card number, health or biometric data)
   * has none.
   */
  protect?: Protection;
  /** What the field becomes when it's erased. Default `"null"`. See `EraseWith`. */
  erase?: EraseWith;
}

/**
 * Another law says you must keep these rows (e.g. tax or KYC records). Section 8(7) requires
 * erasure "unless retention is necessary for compliance with any law".
 */
export interface LegalHold {
  reason: string;
  keep: Duration;
  /** What happens to the personal fields once the hold ends. */
  then: "anonymise" | "delete";
}

export interface TableDef<P extends string = string> {
  /** Table (or collection) name in your database. */
  table: string;
  /** Column that holds the person's id. */
  subject: string;
  fields: Record<string, PersonalField<P>>;
  legalHold?: LegalHold;
}

/** A third party you share data with (SMS gateway, analytics, payment provider…). */
export interface ProcessorDef<P extends string = string> {
  purposes: readonly P[];
  description?: string;
  /**
   * Where your contract with this processor requires reasonable security safeguards, e.g.
   * `"DPA signed 2026-03-01, clause 7"`. Rule 6(1)(f) requires such a provision. The audit warns
   * when it's missing.
   */
  contract?: string;
  /**
   * Where the processor handles the data, as ISO 3166-1 alpha-2 codes: `["IN"]`, `["IN", "SG"]`.
   * Include every country of its servers and support staff that can reach the data. Section 16
   * lets the Central Government restrict transfers to countries it notifies; list those in
   * `transfers.restricted`. The audit warns when this is missing.
   */
  countries?: readonly string[];
  /**
   * The processor is a foreign State, or an entity under its control or one of its agencies.
   * Rule 15 subjects such transfers to requirements the Central Government specifies by order.
   */
  foreignState?: boolean;
}

/** Transfers of personal data outside India (Section 16, Rule 15). */
export interface TransfersConfig<P extends string = string> {
  /**
   * Countries the Central Government has restricted transfers to by notification (Section 16(1)),
   * as ISO 3166-1 alpha-2 codes. None are notified as of November 2026; keep this list up to date
   * yourself. The audit fails when a processor is in one of them.
   */
  restricted?: readonly string[];
  /**
   * Purposes whose data another law requires to stay in India, e.g. payment data under the RBI's
   * storage directive. Section 16(2) keeps such laws in force. The audit fails when a processor
   * for one of these purposes is anywhere else.
   */
  keepInIndia?: readonly P[];
}

/**
 * The security safeguards of Rule 6(1) that live outside your code, written down as evidence.
 * Describe what you actually do, in a sentence; the audit warns about any you leave out.
 */
export interface SecurityConfig {
  /** Rule 6(1)(b): how access to your computer resources is controlled, e.g. `"SSO, least-privilege IAM roles"`. */
  accessControl?: string;
  /** Rule 6(1)(d): how processing continues after a compromise, e.g. `"Daily encrypted backups, restore tested monthly"`. */
  backups?: string;
  /** Rule 6(1)(g): technical and organisational measures, e.g. `"Annual security training, quarterly access reviews"`. */
  measures?: string;
  /**
   * Rule 6(1)(c) and (e): how long the access log (`dpdp.access`) is kept. Default and minimum
   * `"1y"`: the Rule requires a year of logs to detect and investigate unauthorised access.
   */
  accessLogRetention?: Duration;
}

export interface RightsConfig {
  /**
   * How long you give yourself to answer a rights request, from when it's raised. One duration for
   * every type, or one per type. Default `"90d"`. Rule 14(3) of the DPDP Rules caps grievance
   * responses at ninety days; the Rules set no period for the other types, so pick one you can keep.
   */
  responseWithin?: Duration | Partial<Record<RequestType, Duration>>;
  /**
   * How people make a request: the means Rule 14(1)(a) requires you to publish prominently, e.g.
   * `"In the app: Settings → Privacy → Your data, or email privacy@chai.example"`. The audit warns
   * when it's missing.
   */
  how?: string;
  /**
   * What you need to identify the person (Rule 14(1)(b)), e.g. `["registered mobile number"]`.
   * Rule 14(5) gives examples: a customer id, an application number, an email address.
   */
  identifiers?: readonly string[];
  /**
   * `"required"`: summaries, erasure and corrections for a request refuse to run until someone
   * records checking the person's identity with `rights.verifyIdentity()`. Default `"optional"`.
   * Use it when requests arrive by email, phone or letter rather than from a signed-in account.
   */
  verify?: "required" | "optional";
}

export interface FiduciaryDef {
  name: string;
  /**
   * Where people raise a grievance. Section 8(10) requires a grievance mechanism, Section 13 gives
   * people the right to use it, and Section 5(1)(ii) requires the notice to say how.
   */
  grievanceUrl?: string;
  /**
   * Data Protection Officer, or a person who can answer questions about the data. Section 8(9)
   * and Rule 9 require publishing their business contact details prominently and in every reply
   * to a rights request; Section 6(3) requires them in every consent request.
   */
  dpo?: string;
}

export interface DpdpConfig<P extends string = string> {
  fiduciary: FiduciaryDef;
  purposes: { readonly [K in P]: PurposeDef };
  data: Record<string, TableDef<NoInfer<P>>>;
  processors?: Record<string, ProcessorDef<NoInfer<P>>>;
  /** Transfers outside India. See `TransfersConfig`. */
  transfers?: TransfersConfig<NoInfer<P>>;
  /**
   * How long personal data, traffic data and logs of each processing are kept, at minimum, from the
   * date of that processing, even after erasure is otherwise due (e.g. the account is deleted).
   * Rule 8(3) of the DPDP Rules requires at least one year (`"1y"`), only for the purposes in the
   * Seventh Schedule (requests from the State); Rule 6(1)(e) also requires a year of logs for
   * security investigations.
   */
  minimumRetention?: Duration;
  /**
   * Columns whose names look personal but aren't, for the schema drift check: `"products.name"`,
   * or `"products.*"` for a whole table. Use database table and column names.
   */
  notPersonal?: readonly string[];
  rights?: RightsConfig;
  /** Security safeguards under Rule 6(1). See `SecurityConfig`. */
  security?: SecurityConfig;
  /**
   * Build the privacy notice from this config (Section 5, Rule 3). When set, `consent.grant()`
   * records the version of the notice the person saw, and saves the notice as proof.
   */
  notice?: NoticeConfig<NoInfer<P>>;
}

/** Purpose names of a config, e.g. `"account" | "marketing_sms"`. */
export type PurposeOf<C> = C extends DpdpConfig<infer P> ? P : never;

/**
 * Declare what personal data you hold, where, and why. Purpose names used in `data` and
 * `processors` are checked against `purposes` by the type checker, and again by `audit()`.
 */
export function defineConfig<const P extends string>(config: DpdpConfig<P>): DpdpConfig<P> {
  return config;
}

export function purposeNames<P extends string>(config: DpdpConfig<P>): P[] {
  return Object.keys(config.purposes) as P[];
}

/** The value a field is set to when it's erased, from its `erase` setting. */
export function erasedValue(erase: EraseWith | undefined, field: { subjectId: string; table: string; field: string }): ErasedValue {
  if (erase === undefined || erase === "null") return null;
  if (erase === "redact") return REDACTED;
  const value = typeof erase.value === "function" ? erase.value(field) : erase.value;
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
    throw new DpdpError(
      "invalid-erase",
      `The erase value for ${field.table}.${field.field} must be a string, number, boolean or null; got ${value === undefined ? "undefined (does the function return?)" : typeof value}`,
    );
  }
  return value;
}
