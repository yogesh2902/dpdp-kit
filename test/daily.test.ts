import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConsentStore, createDpdp, memoryData, memoryStore } from "../src/index.js";
import { msUntil, startDaily } from "../src/schedule.js";
import { config } from "./fixtures/config.js";

const DAY = 24 * 60 * 60 * 1000;

describe("dpdp.daily()", () => {
  it("runs erasure, prunes and reviews the access log, and lists overdue requests", async () => {
    let t = Date.parse("2026-01-01T00:00:00.000Z");
    const data = memoryData({ users: [{ id: "u1", phone: "98xxxxxx01", name: "Asha", interests: "cricket" }] });
    const dpdp = createDpdp({ config, store: memoryStore(), data, now: () => new Date(t) });

    await dpdp.consent.grant("u1", ["marketing_sms"]);
    await dpdp.consent.withdraw("u1", ["marketing_sms"]);
    await dpdp.rights.open("u1", "grievance");
    await dpdp.access.log({ actor: "old", subjectId: "u1", purpose: "account" });
    t += 400 * DAY;
    await dpdp.access.log({ actor: "growth", subjectId: "u1", purpose: "analytics", fields: ["users.phone"] });
    const ran = vi.fn();
    dpdp.on("daily.ran", ran);

    const report = await dpdp.daily();
    expect(report.skipped).toEqual([]);
    expect(report.retention!.done.length).toBeGreaterThan(0);
    expect(report.accessPruned).toBe(1);
    expect(report.review!.findings.map((f) => f.kind).sort()).toEqual(["no-consent", "out-of-purpose"]);
    expect(report.overdueRequests!.map((r) => r.type)).toEqual(["grievance"]);
    expect(data.tables.users![0]!.interests).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toHaveBeenCalledWith({ report });
  });

  it("skips what a consent-only store can't do", async () => {
    const { lastEvent, insert, events } = memoryStore();
    const store: ConsentStore = { lastEvent, insert, events };
    const report = await createDpdp({ config, store }).daily();
    expect(report.skipped).toEqual(["retention", "rights", "access"]);
  });
});

describe("startDaily", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("works out the time to the next run", () => {
    const at = (iso: string) => new Date(iso);
    expect(msUntil(at("2026-06-01T01:00:00"), 3, 0)).toBe(2 * 60 * 60 * 1000);
    expect(msUntil(at("2026-06-01T03:00:00"), 3, 0)).toBe(DAY); // exactly now: tomorrow
    expect(msUntil(at("2026-06-01T04:30:00"), 3, 0)).toBe(DAY - 90 * 60 * 1000);
  });

  it("runs at the set time every day, and stops", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-01T01:00:00") });
    const dpdp = createDpdp({ config, store: memoryStore() });
    const reports: unknown[] = [];
    const schedule = startDaily(dpdp, { at: "03:00", onReport: (r) => void reports.push(r) });
    expect(schedule.nextRunAt()).toEqual(new Date("2026-06-01T03:00:00"));

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(reports).toHaveLength(1);
    expect(schedule.nextRunAt()).toEqual(new Date("2026-06-02T03:00:00"));

    await vi.advanceTimersByTimeAsync(DAY);
    expect(reports).toHaveLength(2);

    schedule.stop();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(reports).toHaveLength(2);
  });

  it("never overlaps runs, and keeps going after a failure", async () => {
    const dpdp = createDpdp({ config, store: memoryStore() });
    let release!: () => void;
    const slow = vi.spyOn(dpdp, "daily").mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ at: "x", skipped: [], errors: [] }))),
    );
    const errors: unknown[] = [];
    const schedule = startDaily(dpdp, { onError: (e) => errors.push(e) });

    const first = schedule.runNow();
    expect(await schedule.runNow()).toBeUndefined(); // already running
    release();
    expect(await first).toEqual({ at: "x", skipped: [], errors: [] });

    slow.mockRejectedValueOnce(new Error("db down"));
    expect(await schedule.runNow()).toBeUndefined();
    expect(errors).toEqual([new Error("db down")]);
    expect(await schedule.runNow()).toMatchObject({ skipped: [] }); // the next run works
    schedule.stop();
  });

  it("rejects a bad time", () => {
    const dpdp = createDpdp({ config, store: memoryStore() });
    expect(() => startDaily(dpdp, { at: "3am" })).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => startDaily(dpdp, { at: "24:00" })).toThrow();
  });
});

describe("daily() and startDaily() after the pre-publish review", () => {
  it("keeps going when one step fails, and reports it", async () => {
    let t = Date.parse("2026-01-01T00:00:00.000Z");
    const store = memoryStore();
    const data = memoryData({ users: [{ id: "u1", phone: "98xxxxxx01", name: "Asha", interests: "cricket" }] });
    const dpdp = createDpdp({ config, store, data, now: () => new Date(t) });
    await dpdp.consent.grant("u1", ["marketing_sms"]);
    await dpdp.consent.withdraw("u1", ["marketing_sms"]);
    t += 400 * DAY;
    vi.spyOn(store, "pruneAccess").mockRejectedValue(new Error('relation "dpdp_access_log" does not exist'));

    const report = await dpdp.daily();
    expect(report.retention!.done.length).toBeGreaterThan(0); // erasure still ran
    expect(report.review).toBeDefined(); // and so did the review
    expect(report.errors.map((e) => `${e.step}: ${e.message}`)).toEqual(['access-prune: relation "dpdp_access_log" does not exist']);
  });

  it("startDaily reports failed steps to onError, and starts the next review where the last one ended", async () => {
    let t = Date.parse("2026-06-01T03:00:00.000Z");
    const store = memoryStore();
    const dpdp = createDpdp({ config, store, now: () => new Date(t) });
    const daily = vi.spyOn(dpdp, "daily");
    const errors: unknown[] = [];
    const schedule = startDaily(dpdp, { onError: (e) => errors.push(e), now: () => new Date(t) });

    const first = await schedule.runNow();
    expect(daily).toHaveBeenLastCalledWith({});
    t += 2 * DAY; // a night was missed
    await schedule.runNow();
    expect(daily).toHaveBeenLastCalledWith({ review: { from: first!.review!.to } });

    vi.spyOn(store, "listAccess").mockRejectedValueOnce(new Error("timeout"));
    const failed = await schedule.runNow();
    expect(failed!.errors.map((e) => e.step)).toEqual(["access-review"]);
    expect(errors).toEqual([new Error("timeout")]);
    schedule.stop();
  });
});
