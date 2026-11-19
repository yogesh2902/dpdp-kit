// Counts for the evidence report, computed in the database by the built-in stores so a large
// consent record isn't loaded into memory.
import type { TaskStatus } from "./records.js";
import type { ConsentAction, ConsentEvent } from "./store.js";

export interface ConsentStats {
  from: string;
  to: string;
  /** Consent events in the period. */
  events: number;
  /** People with at least one event in the period. */
  people: number;
  /** Events in the period by action. */
  byAction: Partial<Record<ConsentAction, number>>;
  /** Events in the period by purpose and action. */
  byPurpose: Record<string, Partial<Record<ConsentAction, number>>>;
  /** Right now: people whose latest choice for each consent purpose is a grant. */
  grantedNow: Record<string, number>;
  /** Right now: people who object to each Section 7(a) purpose. */
  objectedNow: Record<string, number>;
}

export interface TaskCounts {
  byStatus: Partial<Record<TaskStatus, number>>;
  /** Pending or failed tasks whose due date has passed: the retention runner is behind. */
  late: number;
}

/** A store that can count for the evidence report. The built-in stores all can. */
export interface StatsStore {
  consentStats(from: string, to: string): Promise<ConsentStats>;
  taskCounts(now: string): Promise<TaskCounts>;
}

export function isStatsStore(store: object): store is StatsStore {
  const s = store as Partial<StatsStore>;
  return typeof s.consentStats === "function" && typeof s.taskCounts === "function";
}

const CONSENT_ACTIONS = new Set<string>(["grant", "withdraw"]);

/** The same counts from events in memory. */
export function statsFromEvents(all: Iterable<readonly ConsentEvent[]>, from: string, to: string): ConsentStats {
  const stats: ConsentStats = { from, to, events: 0, people: 0, byAction: {}, byPurpose: {}, grantedNow: {}, objectedNow: {} };
  for (const events of all) {
    let counted = false;
    const latest = new Map<string, ConsentAction>();
    for (const e of events) {
      if (e.at >= from && e.at < to) {
        stats.events++;
        if (!counted) stats.people++;
        counted = true;
        stats.byAction[e.action] = (stats.byAction[e.action] ?? 0) + 1;
        for (const p of e.purposes) {
          const row = (stats.byPurpose[p] ??= {});
          row[e.action] = (row[e.action] ?? 0) + 1;
        }
      }
      for (const p of e.purposes) latest.set(`${CONSENT_ACTIONS.has(e.action) ? "c" : "o"}:${p}`, e.action);
    }
    for (const [key, action] of latest) {
      const p = key.slice(2);
      if (action === "grant") stats.grantedNow[p] = (stats.grantedNow[p] ?? 0) + 1;
      if (action === "object") stats.objectedNow[p] = (stats.objectedNow[p] ?? 0) + 1;
    }
  }
  return stats;
}

/** Postgres: events in the period, by action and purpose. $1 from, $2 to. */
export const PERIOD_SQL = `SELECT action, p AS purpose, count(*) AS n
  FROM dpdp_consent_events, jsonb_array_elements_text(purposes) AS p
  WHERE at >= $1::timestamptz AND at < $2::timestamptz GROUP BY action, p`;
export const TOTALS_SQL = `SELECT count(*) AS events, count(DISTINCT subject_id) AS people
  FROM dpdp_consent_events WHERE at >= $1::timestamptz AND at < $2::timestamptz`;
export const ACTIONS_SQL = `SELECT action, count(*) AS n
  FROM dpdp_consent_events WHERE at >= $1::timestamptz AND at < $2::timestamptz GROUP BY action`;
/** Postgres: each person's latest consent choice and objection per purpose, counted. */
export const NOW_SQL = `SELECT kind, p AS purpose, count(*) AS n FROM (
    SELECT DISTINCT ON (subject_id, p, kind) action, p, kind
    FROM (SELECT subject_id, seq, action, p, CASE WHEN action IN ('grant', 'withdraw') THEN 'consent' ELSE 'objection' END AS kind
          FROM dpdp_consent_events, jsonb_array_elements_text(purposes) AS p) e
    ORDER BY subject_id, p, kind, seq DESC
  ) latest WHERE action IN ('grant', 'object') GROUP BY kind, p`;
export const TASKS_SQL = `SELECT status, count(*) AS n, count(*) FILTER (WHERE status IN ('pending', 'failed') AND due_at < $1::timestamptz) AS late
  FROM dpdp_erasure_tasks GROUP BY status`;

/** Turn the rows of the queries above into stats. */
export function statsFromRows(
  from: string,
  to: string,
  totals: Record<string, unknown> | undefined,
  actions: readonly Record<string, unknown>[],
  period: readonly Record<string, unknown>[],
  now: readonly Record<string, unknown>[],
): ConsentStats {
  const stats: ConsentStats = {
    from,
    to,
    events: Number(totals?.events ?? 0),
    people: Number(totals?.people ?? 0),
    byAction: {},
    byPurpose: {},
    grantedNow: {},
    objectedNow: {},
  };
  for (const r of actions) stats.byAction[String(r.action) as ConsentAction] = Number(r.n);
  for (const r of period) {
    const action = String(r.action) as ConsentAction;
    const n = Number(r.n);
    const row = (stats.byPurpose[String(r.purpose)] ??= {});
    row[action] = (row[action] ?? 0) + n;
  }
  for (const r of now) (r.kind === "consent" ? stats.grantedNow : stats.objectedNow)[String(r.purpose)] = Number(r.n);
  return stats;
}

export function taskCountsFromRows(rows: readonly Record<string, unknown>[]): TaskCounts {
  const counts: TaskCounts = { byStatus: {}, late: 0 };
  for (const r of rows) {
    counts.byStatus[String(r.status) as TaskStatus] = Number(r.n);
    counts.late += Number(r.late ?? 0);
  }
  return counts;
}
