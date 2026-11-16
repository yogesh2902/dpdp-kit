import type { Duration } from "./duration.js";

/**
 * Why you may process data for a purpose.
 * - `"consent"`: the person agreed (Section 6). They can withdraw at any time.
 * - `"legitimate-use"`: one of the certain legitimate uses in Section 7 (for example, data the
 *   person gave you voluntarily for a specific service, or to meet a legal obligation).
 */
export type Basis = "consent" | "legitimate-use";

/**
 * How long data held for a purpose is kept.
 * - `"while-active"`: for as long as the purpose is still being served (e.g. the account is open).
 * - a duration, e.g. `"1y"`: at most this long after it was collected.
 * - `{ afterWithdrawal }`: for consent purposes, how long after withdrawal before it's erased
 *   (default `"0d"`, erase as soon as possible).
 */
export type Retention = "while-active" | Duration | { afterWithdrawal: Duration };

export interface PurposeDef {
  basis: Basis;
  retain: Retention;
  /** Plain-language description, as shown to people in the notice. */
  description?: string;
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

export interface PersonalField<P extends string = string> {
  category: Category;
  /** Every purpose this field is held for. When all of them end, the field must go. */
  purposes: readonly P[];
  /** This field can tell you the person is under 18 (e.g. date of birth). Used from v0.3. */
  childSignal?: boolean;
}

/** Another law says you must keep these rows (e.g. tax records). Section 8(7) allows that. */
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
}

export interface FiduciaryDef {
  name: string;
  /** Where people raise a grievance (Section 13). */
  grievanceUrl?: string;
  /** Data Protection Officer or contact person. */
  dpo?: string;
}

export interface DpdpConfig<P extends string = string> {
  fiduciary: FiduciaryDef;
  purposes: { readonly [K in P]: PurposeDef };
  data: Record<string, TableDef<NoInfer<P>>>;
  processors?: Record<string, ProcessorDef<NoInfer<P>>>;
  /** Rule 8(3) of the DPDP Rules sets a minimum of one year for logs and traffic data. */
  logs?: { minimumRetention: Duration };
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
