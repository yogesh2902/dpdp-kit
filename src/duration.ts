/** A length of time: hours, days or years, e.g. `"48h"`, `"30d"`, `"1y"`. A year counts as 365 days. */
export type Duration = `${number}${"h" | "d" | "y"}`;

const PATTERN = /^(\d+)(h|d|y)$/;
const HOUR_MS = 60 * 60 * 1000;
const UNIT_MS = { h: HOUR_MS, d: 24 * HOUR_MS, y: 365 * 24 * HOUR_MS } as const;

export function isDuration(value: unknown): value is Duration {
  return typeof value === "string" && PATTERN.test(value);
}

/** Milliseconds in a duration. Throws on anything that isn't `<whole number><h|d|y>`. */
export function durationMs(value: Duration): number {
  const match = PATTERN.exec(value);
  if (!match) throw new TypeError(`Not a duration: ${JSON.stringify(value)} (use e.g. "48h", "30d", "1y")`);
  const [, amount, unit] = match as unknown as [string, string, keyof typeof UNIT_MS];
  return Number(amount) * UNIT_MS[unit];
}

/** The longer of two durations. */
export function maxDuration(a: Duration, b: Duration): Duration {
  return durationMs(b) > durationMs(a) ? b : a;
}
