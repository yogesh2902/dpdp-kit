import type { DailyReport, Dpdp } from "./dpdp.js";
import { DpdpError } from "./errors.js";

export interface StartDailyOptions {
  /** Local time of day to run, `"HH:MM"` in 24-hour time. Default `"03:00"`. */
  at?: string;
  /** Called with each run's report, e.g. to alert on failed tasks or review findings. */
  onReport?: (report: DailyReport) => void | Promise<void>;
  /** Called when a run throws. Default: `console.error`. The next day's run still happens. */
  onError?: (error: unknown) => void;
  /** Clock, for tests. */
  now?: () => Date;
}

export interface DailySchedule {
  /** Run once now (skipped if a run is already going). Resolves with the report, or undefined if skipped or failed. */
  runNow(): Promise<DailyReport | undefined>;
  /** When the next run is due. */
  nextRunAt(): Date;
  /** Stop scheduling runs. */
  stop(): void;
}

/** Milliseconds from `now` until the next local `hours:minutes`. */
export function msUntil(now: Date, hours: number, minutes: number): number {
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Run `dpdp.daily()` every day at a set local time, in this process, with no dependencies. Runs
 * never overlap, and the timer doesn't keep the process alive on its own. If several servers each
 * call this, each runs the job; that's safe (erasure tasks are claimed atomically), but you'll get
 * one report per server. To run it once across servers, use your platform's cron or a BullMQ
 * repeatable job with `dpdp.daily()` instead.
 *
 * ```ts
 * import { startDaily } from "dpdp-kit/schedule";
 * startDaily(dpdp, { at: "03:00", onReport: (r) => r.retention?.failed.length && alert(r) });
 * ```
 */
export function startDaily<P extends string>(dpdp: Dpdp<P>, options: StartDailyOptions = {}): DailySchedule {
  const at = options.at ?? "03:00";
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!match) throw new DpdpError("invalid-input", `at must be "HH:MM" in 24-hour time, e.g. "03:00"; got ${JSON.stringify(at)}`);
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? ((err: unknown) => console.error("dpdp-kit: the daily run failed", err));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<DailyReport | undefined> | undefined;
  let stopped = false;
  let next = new Date(now().getTime() + msUntil(now(), hours, minutes));

  async function run(): Promise<DailyReport | undefined> {
    if (running) return undefined;
    running = (async () => {
      try {
        const report = await dpdp.daily();
        await options.onReport?.(report);
        return report;
      } catch (err) {
        onError(err);
        return undefined;
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  function arm() {
    if (stopped) return;
    const wait = msUntil(now(), hours, minutes);
    next = new Date(now().getTime() + wait);
    timer = setTimeout(() => {
      void run().finally(arm);
    }, wait);
    timer.unref?.();
  }
  arm();

  return {
    runNow: run,
    nextRunAt: () => next,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
