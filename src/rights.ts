import type { Category, DpdpConfig } from "./config.js";
import type { DataAccess } from "./data-access.js";
import { type Duration, durationMs } from "./duration.js";
import { REQUEST_TYPES, type RequestType, type RightsRequest } from "./records.js";

/** Default answer time: Rule 14(3) caps grievance responses at ninety days. */
export const DEFAULT_RESPONSE_WITHIN: Duration = "90d";

export function responseWithin(config: DpdpConfig<string>, type: RequestType): Duration {
  const setting = config.rights?.responseWithin;
  if (setting === undefined) return DEFAULT_RESPONSE_WITHIN;
  if (typeof setting === "string") return setting;
  return setting[type] ?? DEFAULT_RESPONSE_WITHIN;
}

export function dueAt(config: DpdpConfig<string>, type: RequestType, openedAt: string): string {
  return new Date(Date.parse(openedAt) + durationMs(responseWithin(config, type))).toISOString();
}

/**
 * What a person gets back from an access request (Section 11(1)): (a) the personal data you
 * process and why, and (b) who else it was shared with.
 */
export interface AccessSummary {
  subjectId: string;
  generatedAt: string;
  data: Array<{
    /** Key in `config.data`. */
    key: string;
    table: string;
    /** `label` is the field's `label` in the data map, when it has one (what people would call it). */
    fields: Array<{ field: string; label?: string; category: Category; purposes: string[] }>;
    /** The person's rows, personal fields only. */
    rows: Record<string, unknown>[];
  }>;
  /** Consent purposes currently granted. */
  consents: string[];
  /** Legitimate-use purposes that apply without consent (Section 7), minus any the person objected to. */
  legitimateUses: string[];
  /** Section 7(a) purposes the person objected to. Only present when there are any. */
  objections?: string[];
  /**
   * Processors that receive data for a purpose that applies to this person (Section 11(1)(b)).
   * Section 11(2) exempts sharing with authorities for preventing or investigating offences;
   * leave those out of `config.processors`.
   */
  sharedWith: Array<{ name: string; description?: string; purposes: string[]; countries?: string[] }>;
}

export async function buildAccessSummary(input: {
  config: DpdpConfig<string>;
  data: DataAccess;
  subjectId: string;
  consents: string[];
  objections?: string[];
  now: string;
}): Promise<AccessSummary> {
  const { config, data, subjectId, consents, now } = input;
  const objections = input.objections ?? [];
  const legitimateUses = Object.entries(config.purposes)
    .filter(([name, def]) => def.basis === "legitimate-use" && !objections.includes(name))
    .map(([name]) => name);
  const applies = new Set([...consents, ...legitimateUses]);

  const tables: AccessSummary["data"] = [];
  for (const [key, def] of Object.entries(config.data)) {
    const fields = Object.entries(def.fields).map(([field, f]) => ({
      field,
      ...(f.label ? { label: f.label } : {}),
      category: f.category,
      purposes: [...f.purposes],
    }));
    const rows = await data.read(
      def.table,
      def.subject,
      subjectId,
      fields.map((f) => f.field),
    );
    if (rows.length > 0) tables.push({ key, table: def.table, fields, rows });
  }

  const sharedWith = Object.entries(config.processors ?? {})
    .map(([name, p]) => ({
      name,
      ...(p.description !== undefined ? { description: p.description } : {}),
      purposes: p.purposes.filter((purpose) => applies.has(purpose)),
      ...(p.countries?.length ? { countries: [...p.countries] } : {}),
    }))
    .filter((p) => p.purposes.length > 0);

  return {
    subjectId,
    generatedAt: now,
    data: tables,
    consents,
    legitimateUses,
    ...(objections.length > 0 ? { objections: [...objections] } : {}),
    sharedWith,
  };
}

/** What you tell the person when a request arrives. */
export interface Acknowledgement {
  /** The request id: the person quotes it when following up. */
  reference: string;
  type: RequestType;
  receivedAt: string;
  /** When you'll answer by (`config.rights.responseWithin`). */
  dueAt: string;
  /** Who to ask in the meantime: `fiduciary.dpo`. */
  contact?: string;
  /** The acknowledgement in plain English, ready to send. */
  text: string;
}

const REQUEST_LABELS: Record<RequestType, string> = {
  access: "request to see your personal data",
  correction: "request to correct your personal data",
  erasure: "request to erase your personal data",
  grievance: "grievance",
  nomination: "nomination",
};

/** A date as people read it in India, e.g. "19 November 2026". */
export const indianDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

export function acknowledgement(config: DpdpConfig<string>, request: RightsRequest): Acknowledgement {
  const contact = config.fiduciary.dpo;
  const text = [
    `We received your ${REQUEST_LABELS[request.type]} on ${indianDate(request.openedAt)}. Your reference is ${request.id}.`,
    `We'll respond by ${indianDate(request.dueAt)}.`,
    ...(contact ? [`Questions in the meantime: ${contact}.`] : []),
  ].join(" ");
  return { reference: request.id, type: request.type, receivedAt: request.openedAt, dueAt: request.dueAt, ...(contact ? { contact } : {}), text };
}

/** What Rule 14(1) and 14(3) ask you to publish about making requests. */
export interface RightsInfo {
  /** The means of making a request (Rule 14(1)(a)). */
  how?: string;
  /** What identifies the person (Rule 14(1)(b)). */
  identifiers: string[];
  /** How long you take to answer each type (Rule 14(3) for grievances). */
  responseWithin: Record<RequestType, Duration>;
  contact?: string;
  grievanceUrl?: string;
  verify: "required" | "optional";
}

export function rightsInfo(config: DpdpConfig<string>): RightsInfo {
  const r = config.rights ?? {};
  return {
    ...(r.how !== undefined ? { how: r.how } : {}),
    identifiers: [...(r.identifiers ?? [])],
    responseWithin: Object.fromEntries(REQUEST_TYPES.map((t) => [t, responseWithin(config, t)])) as Record<RequestType, Duration>,
    ...(config.fiduciary.dpo ? { contact: config.fiduciary.dpo } : {}),
    ...(config.fiduciary.grievanceUrl ? { grievanceUrl: config.fiduciary.grievanceUrl } : {}),
    verify: r.verify ?? "optional",
  };
}
