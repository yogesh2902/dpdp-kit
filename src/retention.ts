import { randomUUID } from "node:crypto";
import { type DpdpConfig, erasedValue } from "./config.js";
import type { DataAccess } from "./data-access.js";
import { type Duration, durationMs, maxDuration } from "./duration.js";
import type { ErasurePlan } from "./erasure.js";
import type { ErasureTask, TaskStore } from "./records.js";

/** What a processor hook is told. */
export interface ProcessorHookInput {
  subjectId: string;
  /** Purposes that ended. */
  purposes: string[];
  /** `"withdrawal"`, `"account-deletion"` or `"erasure-request"`. */
  reason: string;
}

/**
 * How to reach a third party you shared data with. A hook should call their API (or open a ticket).
 * Without a hook the task becomes `manual`, for a person to handle and mark done.
 */
export interface ProcessorHooks {
  /** Stop using the person's data for the ended purposes (Section 6(6)). */
  stop?: (input: ProcessorHookInput) => Promise<void> | void;
  /** Erase the person's data (Section 8(7)(b)). */
  erase?: (input: ProcessorHookInput) => Promise<void> | void;
}

export interface RunReport {
  done: ErasureTask[];
  failed: ErasureTask[];
  manual: ErasureTask[];
}

export const MAX_ATTEMPTS = 5;
/** A `running` task claimed longer ago than this is assumed abandoned and picked up again. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/**
 * Turn an erasure plan into dated tasks. Nothing is erased before the person's data has been kept
 * for `config.minimumRetention` (Rule 8(3)), and legal holds wait for their own period. Those
 * periods count from now, the time the plan is scheduled, which is never earlier than the last
 * processing, so data is kept at least as long as the law requires.
 */
export function tasksFromPlan(config: DpdpConfig<string>, plan: ErasurePlan, now: string): ErasureTask[] {
  const minimum: Duration = config.minimumRetention ?? "0d";
  const base = { subjectId: plan.subjectId, reason: plan.reason, createdAt: now, status: "pending" as const, attempts: 0 };
  const due = (wait: Duration) => addMs(now, durationMs(maxDuration(wait, minimum)));
  const tasks: ErasureTask[] = [];

  for (const table of plan.tables) {
    if (table.action === "keep") continue;
    if (table.action === "hold" && table.hold) {
      const fields = table.fields.filter((f) => f.action === "hold").map((f) => f.field);
      tasks.push({
        ...base,
        id: randomUUID(),
        kind: table.hold.then === "delete" ? "delete-rows" : "erase-fields",
        table: table.key,
        ...(table.hold.then === "delete" ? {} : { fields }),
        dueAt: due(table.hold.keep),
      });
      continue;
    }
    const erasable = table.fields.filter((f) => f.action === "erase");
    const wait = erasable.reduce<Duration>((d, f) => (f.after ? maxDuration(d, f.after) : d), "0d");
    tasks.push({
      ...base,
      id: randomUUID(),
      kind: table.action === "delete-rows" ? "delete-rows" : "erase-fields",
      table: table.key,
      ...(table.action === "delete-rows" ? {} : { fields: erasable.map((f) => f.field) }),
      // Objection tasks record the purposes they serve, so lifting the objection can cancel them.
      ...(plan.reason === "objection" ? { purposes: [...plan.ended] } : {}),
      dueAt: due(wait),
    });
  }

  for (const processor of plan.processors) {
    tasks.push({ ...base, id: randomUUID(), kind: "processor-stop", processor: processor.name, purposes: processor.ended, dueAt: now });
    if (processor.action === "erase") {
      tasks.push({
        ...base,
        id: randomUUID(),
        kind: "processor-erase",
        processor: processor.name,
        purposes: processor.ended,
        dueAt: due("0d"),
      });
    }
  }
  return tasks;
}

export interface RunInput {
  config: DpdpConfig<string>;
  store: TaskStore;
  data: DataAccess | undefined;
  processors: Record<string, ProcessorHooks>;
  now: string;
  limit: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function carryOut(task: ErasureTask, input: RunInput): Promise<{ affected?: number; manual?: boolean }> {
  if (task.kind === "processor-stop" || task.kind === "processor-erase") {
    const hook = input.processors[task.processor ?? ""]?.[task.kind === "processor-stop" ? "stop" : "erase"];
    if (!hook) return { manual: true };
    await hook({ subjectId: task.subjectId, purposes: task.purposes ?? [], reason: task.reason });
    return {};
  }
  const def = input.config.data[task.table ?? ""];
  if (!def) throw new Error(`Table "${task.table}" is no longer in the data map`);
  if (!input.data) throw new Error("No data access configured: pass `data` to createDpdp to erase from your tables");
  if (task.kind === "delete-rows") {
    return { affected: await input.data.deleteRows(def.table, def.subject, task.subjectId) };
  }
  const fields = task.fields ?? [];
  const values = Object.fromEntries(
    fields.map((field) => [field, erasedValue(def.fields[field]?.erase, { subjectId: task.subjectId, table: task.table ?? "", field })]),
  );
  return { affected: await input.data.eraseFields(def.table, def.subject, task.subjectId, fields, values) };
}

/** Carry out every due task once. Safe to run from several processes at the same time. */
export async function runDueTasks(input: RunInput): Promise<RunReport> {
  const when = { now: input.now, staleBefore: addMs(input.now, -STALE_AFTER_MS), maxAttempts: MAX_ATTEMPTS };
  const report: RunReport = { done: [], failed: [], manual: [] };
  for (const task of await input.store.dueTasks({ ...when, limit: input.limit })) {
    if (!(await input.store.claimTask({ id: task.id, ...when }))) continue;
    const attempts = task.attempts + 1;
    try {
      const result = await carryOut(task, input);
      const { lastError: _, claimedAt: __, ...rest } = task;
      const finished: ErasureTask = result.manual
        ? { ...rest, status: "manual", attempts }
        : {
            ...rest,
            status: "done",
            attempts,
            doneAt: input.now,
            ...(result.affected !== undefined ? { affected: result.affected } : {}),
          };
      await input.store.updateTask(finished);
      (result.manual ? report.manual : report.done).push(finished);
    } catch (err) {
      const { claimedAt: _, ...rest } = task;
      const failed: ErasureTask = { ...rest, status: "failed", attempts, lastError: errorText(err) };
      await input.store.updateTask(failed);
      report.failed.push(failed);
    }
  }
  return report;
}
