import type { Category, DpdpConfig } from "./config.js";
import type { DataAccess } from "./data-access.js";
import { type Duration, durationMs } from "./duration.js";
import type { RequestType } from "./records.js";

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
    fields: Array<{ field: string; category: Category; purposes: string[] }>;
    /** The person's rows, personal fields only. */
    rows: Record<string, unknown>[];
  }>;
  /** Consent purposes currently granted. */
  consents: string[];
  /** Legitimate-use purposes that apply without consent (Section 7). */
  legitimateUses: string[];
  /**
   * Processors that receive data for a purpose that applies to this person (Section 11(1)(b)).
   * Section 11(2) exempts sharing with authorities for preventing or investigating offences;
   * leave those out of `config.processors`.
   */
  sharedWith: Array<{ name: string; description?: string; purposes: string[] }>;
}

export async function buildAccessSummary(input: {
  config: DpdpConfig<string>;
  data: DataAccess;
  subjectId: string;
  consents: string[];
  now: string;
}): Promise<AccessSummary> {
  const { config, data, subjectId, consents, now } = input;
  const legitimateUses = Object.entries(config.purposes)
    .filter(([, def]) => def.basis === "legitimate-use")
    .map(([name]) => name);
  const applies = new Set([...consents, ...legitimateUses]);

  const tables: AccessSummary["data"] = [];
  for (const [key, def] of Object.entries(config.data)) {
    const fields = Object.entries(def.fields).map(([field, f]) => ({
      field,
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
    }))
    .filter((p) => p.purposes.length > 0);

  return { subjectId, generatedAt: now, data: tables, consents, legitimateUses, sharedWith };
}
