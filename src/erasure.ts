import type { DpdpConfig, LegalHold } from "./config.js";
import { type Duration, maxDuration } from "./duration.js";

export type ErasureReason = "withdrawal" | "account-deletion";

export interface FieldPlan {
  field: string;
  /**
   * - `erase`: no purpose is left for this field; erase it after `after`.
   * - `keep`: still needed for `keptFor`.
   * - `hold`: would be erased, but the table is under a legal hold.
   */
  action: "erase" | "keep" | "hold";
  /** For `erase`: how long you may wait before erasing. */
  after?: Duration;
  /** For `keep`: the purposes that still need it. */
  keptFor?: string[];
}

export interface TablePlan {
  /** Key in `config.data`. */
  key: string;
  table: string;
  subject: string;
  /**
   * - `delete-rows`: delete this person's rows (account deletion, every field erasable).
   * - `erase-fields`: null out or anonymise the fields marked `erase`.
   * - `hold`: keep the rows until the legal hold ends, then apply `hold.then`.
   * - `keep`: nothing to do.
   */
  action: "delete-rows" | "erase-fields" | "hold" | "keep";
  fields: FieldPlan[];
  hold?: LegalHold;
}

export interface ProcessorPlan {
  name: string;
  /**
   * - `erase`: every purpose you shared data for has ended; ask them to erase it (Section 8(7)).
   * - `restrict`: some purposes ended; tell them to stop using it for `ended`.
   */
  action: "erase" | "restrict";
  ended: string[];
}

/** What erasing a person's data would involve. Nothing is changed by building a plan. */
export interface ErasurePlan {
  subjectId: string;
  reason: ErasureReason;
  ended: string[];
  remaining: string[];
  tables: TablePlan[];
  processors: ProcessorPlan[];
}

export interface PlanInput {
  subjectId: string;
  reason: ErasureReason;
  /** Purposes that have ended for this person. */
  ended: readonly string[];
  /** Purposes that still apply to this person. */
  remaining: readonly string[];
}

function erasureDelay(config: DpdpConfig<string>, ended: readonly string[]): Duration {
  let delay: Duration = "0d";
  for (const name of ended) {
    const retain = config.purposes[name]?.retain;
    if (retain && typeof retain === "object") delay = maxDuration(delay, retain.afterWithdrawal);
  }
  return delay;
}

/**
 * Work out, from the data map alone, which of a person's fields must be erased now that some
 * purposes have ended. A field is erased only when none of its purposes remain.
 */
export function planErasure(config: DpdpConfig<string>, input: PlanInput): ErasurePlan {
  const ended = new Set(input.ended);
  const remaining = new Set(input.remaining.filter((p) => !ended.has(p)));
  const tables: TablePlan[] = [];

  for (const [key, table] of Object.entries(config.data)) {
    const fields: FieldPlan[] = [];
    for (const [field, def] of Object.entries(table.fields)) {
      const endedHere = def.purposes.filter((p) => ended.has(p));
      if (endedHere.length === 0) continue;
      const keptFor = def.purposes.filter((p) => remaining.has(p));
      if (keptFor.length > 0) {
        fields.push({ field, action: "keep", keptFor });
      } else if (table.legalHold) {
        fields.push({ field, action: "hold" });
      } else {
        fields.push({ field, action: "erase", after: erasureDelay(config, endedHere) });
      }
    }
    if (fields.length === 0) continue;

    const allFieldsGo =
      fields.length === Object.keys(table.fields).length && fields.every((f) => f.action !== "keep");
    let action: TablePlan["action"];
    if (fields.some((f) => f.action === "hold")) action = "hold";
    else if (input.reason === "account-deletion" && allFieldsGo) action = "delete-rows";
    else if (fields.some((f) => f.action === "erase")) action = "erase-fields";
    else action = "keep";

    tables.push({
      key,
      table: table.table,
      subject: table.subject,
      action,
      fields,
      ...(action === "hold" && table.legalHold ? { hold: table.legalHold } : {}),
    });
  }

  const processors: ProcessorPlan[] = [];
  for (const [name, processor] of Object.entries(config.processors ?? {})) {
    const endedHere = processor.purposes.filter((p) => ended.has(p));
    if (endedHere.length === 0) continue;
    const stillUsed = processor.purposes.some((p) => remaining.has(p));
    processors.push({ name, action: stillUsed ? "restrict" : "erase", ended: endedHere });
  }

  return {
    subjectId: input.subjectId,
    reason: input.reason,
    ended: [...ended],
    remaining: [...remaining],
    tables,
    processors,
  };
}
