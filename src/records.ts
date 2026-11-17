/**
 * Records kept alongside consent events: rights requests (Sections 11–14) and erasure tasks
 * (Section 8(7), Rule 8(3)).
 */

/** The rights a person can exercise under Sections 11–14 of the Act. */
export type RequestType = "access" | "correction" | "erasure" | "grievance" | "nomination";

export const REQUEST_TYPES: readonly RequestType[] = ["access", "correction", "erasure", "grievance", "nomination"];

export type RequestStatus = "open" | "resolved" | "rejected";

export interface RequestHistoryEntry {
  at: string;
  status: RequestStatus;
  note?: string;
}

/** A rights request or grievance, from the moment it's raised until it's answered. */
export interface RightsRequest {
  id: string;
  subjectId: string;
  type: RequestType;
  status: RequestStatus;
  openedAt: string;
  /** When the answer is due. */
  dueAt: string;
  closedAt?: string;
  /** What the person asked for: the correction, the nominee, the grievance text… */
  details?: Record<string, unknown>;
  /** Every status change, oldest first, so the response can be shown later. */
  history: RequestHistoryEntry[];
}

/**
 * One step of erasing a person's data.
 * - `erase-fields`: set the listed fields to null in that table's rows for the person.
 * - `delete-rows`: delete the person's rows in that table.
 * - `processor-stop`: tell a processor to stop using the data for the ended purposes (Section 6(6)).
 * - `processor-erase`: tell a processor to erase the data (Section 8(7)(b)).
 */
export type TaskKind = "erase-fields" | "delete-rows" | "processor-stop" | "processor-erase";

/**
 * - `pending`: waiting for its due date.
 * - `running`: claimed by a runner.
 * - `done`: carried out.
 * - `failed`: the last attempt threw; retried on the next run (up to 5 attempts).
 * - `manual`: needs a person, e.g. a processor with no `erase` hook. Mark it done when handled.
 */
export type TaskStatus = "pending" | "running" | "done" | "failed" | "manual";

export interface ErasureTask {
  id: string;
  subjectId: string;
  /** Why it exists: `"withdrawal"`, `"account-deletion"` or `"erasure-request"`. */
  reason: string;
  kind: TaskKind;
  /** Key in `config.data`, for table tasks. */
  table?: string;
  /** Field names (as in the data map), for `erase-fields`. */
  fields?: string[];
  /** Key in `config.processors`, for processor tasks. */
  processor?: string;
  /** Purposes that ended, for processor tasks. */
  purposes?: string[];
  createdAt: string;
  /** Not run before this time. */
  dueAt: string;
  status: TaskStatus;
  attempts: number;
  claimedAt?: string;
  doneAt?: string;
  /** Rows changed, for table tasks. */
  affected?: number;
  /** Message from the last failure, for developers. */
  lastError?: string;
  /** Who or what completed a manual task. */
  note?: string;
}

export interface RequestFilter {
  subjectId?: string;
  status?: RequestStatus;
}

export interface TaskFilter {
  subjectId?: string;
  status?: TaskStatus;
}

/** Storage for rights requests. */
export interface RequestStore {
  insertRequest(request: RightsRequest): Promise<void>;
  getRequest(id: string): Promise<RightsRequest | undefined>;
  /** Replace a stored request. */
  updateRequest(request: RightsRequest): Promise<void>;
  /** Oldest first. */
  listRequests(filter: RequestFilter): Promise<RightsRequest[]>;
}

/** Storage for erasure tasks. */
export interface TaskStore {
  insertTasks(tasks: readonly ErasureTask[]): Promise<void>;
  /**
   * Tasks to run now: `pending` or `failed` (fewer than `maxAttempts`) with `dueAt <= now`, plus
   * `running` tasks claimed before `staleBefore` (their runner died). Oldest due first.
   */
  dueTasks(input: { now: string; staleBefore: string; maxAttempts: number; limit: number }): Promise<ErasureTask[]>;
  /**
   * Atomically mark a due task as `running`. Returns false if another runner got it first, so the
   * same task is never carried out twice at once.
   */
  claimTask(input: { id: string; now: string; staleBefore: string; maxAttempts: number }): Promise<boolean>;
  /** Replace a stored task. */
  updateTask(task: ErasureTask): Promise<void>;
  getTask(id: string): Promise<ErasureTask | undefined>;
  /** Oldest due first. */
  listTasks(filter: TaskFilter): Promise<ErasureTask[]>;
}

/** Whether a task can be picked up by a runner right now. */
export function isRunnable(
  task: ErasureTask,
  { now, staleBefore, maxAttempts }: { now: string; staleBefore: string; maxAttempts: number },
): boolean {
  if (task.dueAt > now) return false;
  if (task.status === "pending") return true;
  if (task.status === "failed") return task.attempts < maxAttempts;
  if (task.status === "running") return (task.claimedAt ?? "") < staleBefore;
  return false;
}
