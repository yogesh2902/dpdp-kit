import { describe, expect, it, vi } from "vitest";
import { type ConsentStore, createDpdp, DpdpError, memoryData, memoryStore } from "../src/index.js";
import { config } from "./fixtures/config.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-17T10:00:00.000Z");

function setup(options: { hooks?: boolean } = {}) {
  let t = START;
  const clock = {
    advance: (ms: number) => {
      t += ms;
    },
    iso: (offsetMs = 0) => new Date(START + offsetMs).toISOString(),
  };
  const store = memoryStore();
  const data = memoryData({
    users: [
      { id: "u1", phone: "98xxxxxx01", name: "Asha", interests: "cricket" },
      { id: "u2", phone: "98xxxxxx02", name: "Ravi", interests: "chess" },
    ],
    orders: [{ id: "o1", user_id: "u1", address: "12 MG Road" }],
    analytics_events: [{ id: "e1", user_id: "u1", device: "Pixel 9" }],
  });
  const msg91 = { stop: vi.fn(), erase: vi.fn() };
  const dpdp = createDpdp({
    config,
    store,
    data,
    ...(options.hooks === false ? {} : { processors: { msg91 } }),
    now: () => new Date(t),
  });
  return { dpdp, store, data, msg91, clock };
}

describe("retention: scheduling", () => {
  it("withdrawal schedules dated tasks: processors stop now, erasure waits for Rule 8(3)", async () => {
    const { dpdp, clock } = setup();
    await dpdp.consent.grant("u1", ["analytics", "marketing_sms"]);
    const { tasks } = await dpdp.consent.withdraw("u1", ["analytics"]);

    const summary = tasks.map((t) => [t.kind, t.table ?? t.processor, t.fields?.join(",") ?? "", t.dueAt]);
    expect(summary).toEqual([
      // users.interests stays: it is also held for marketing_sms, which is still granted.
      // afterWithdrawal is 30d, but minimumRetention 1y wins.
      ["erase-fields", "events", "device", clock.iso(365 * DAY)],
      ["processor-stop", "posthog", "", clock.iso()],
      ["processor-erase", "posthog", "", clock.iso(365 * DAY)],
    ]);
  });

  it("account deletion deletes rows, and a legal hold waits for its own period", async () => {
    const { dpdp, clock } = setup();
    const { tasks } = await dpdp.erasure.deleteAccount("u1");
    const byTable = Object.fromEntries(tasks.filter((t) => t.table).map((t) => [t.table, [t.kind, t.fields, t.dueAt]]));
    expect(byTable).toEqual({
      users: ["delete-rows", undefined, clock.iso(365 * DAY)],
      orders: ["erase-fields", ["address"], clock.iso(8 * 365 * DAY)], // GST hold, then anonymise
      events: ["delete-rows", undefined, clock.iso(365 * DAY)],
    });
  });
});

describe("retention: running", () => {
  it("does nothing early, stops processors at once, erases when due", async () => {
    const { dpdp, data, msg91, clock } = setup();
    await dpdp.consent.grant("u1", ["order_updates", "marketing_sms"]);
    await dpdp.consent.withdraw("u1", ["marketing_sms", "order_updates"]);

    const first = await dpdp.retention.run();
    expect(first.done.map((t) => t.kind)).toEqual(["processor-stop"]);
    expect(msg91.stop).toHaveBeenCalledWith({ subjectId: "u1", purposes: ["order_updates", "marketing_sms"], reason: "withdrawal" });
    expect(data.tables.users![0]).toMatchObject({ interests: "cricket" }); // not yet

    clock.advance(366 * DAY);
    const later = await dpdp.retention.run();
    expect(later.done.map((t) => t.kind).sort()).toEqual(["erase-fields", "processor-erase"]);
    expect(later.done.find((t) => t.kind === "erase-fields")?.affected).toBe(1);
    expect(data.tables.users![0]).toEqual({ id: "u1", phone: "98xxxxxx01", name: "Asha", interests: null });
    expect(data.tables.users![1]).toMatchObject({ interests: "chess" }); // other people untouched
    expect(msg91.erase).toHaveBeenCalledOnce();

    expect((await dpdp.retention.run()).done).toEqual([]); // nothing runs twice
  });

  it("deletes rows and anonymises held rows on account deletion", async () => {
    const { dpdp, data, clock } = setup();
    await dpdp.erasure.deleteAccount("u1");
    clock.advance(366 * DAY);
    await dpdp.retention.run();
    expect(data.tables.users!.map((r) => r.id)).toEqual(["u2"]);
    expect(data.tables.orders![0]).toMatchObject({ address: "12 MG Road" }); // still held for GST

    clock.advance(8 * 365 * DAY);
    await dpdp.retention.run();
    expect(data.tables.orders![0]).toEqual({ id: "o1", user_id: "u1", address: null });
  });

  it("leaves processors without hooks for a person, and lets them mark the task done", async () => {
    const { dpdp } = setup({ hooks: false });
    await dpdp.consent.grant("u1", ["marketing_sms"]);
    await dpdp.consent.withdraw("u1", ["marketing_sms"]);
    const report = await dpdp.retention.run();
    expect(report.manual.map((t) => [t.kind, t.processor])).toEqual([["processor-stop", "msg91"]]);

    const [task] = await dpdp.retention.tasks({ status: "manual" });
    const done = await dpdp.retention.markDone(task!.id, "Emailed MSG91 support, ticket 4411");
    expect(done).toMatchObject({ status: "done", note: "Emailed MSG91 support, ticket 4411" });
    await expect(dpdp.retention.markDone(task!.id, "again")).rejects.toMatchObject({ code: "task-not-manual" });
  });

  it("retries a failing task up to 5 times, keeping the error for developers", async () => {
    const { dpdp, store, clock } = setup();
    const failing = createDpdp({ config, store, now: () => new Date(Date.parse(clock.iso(400 * DAY))) }); // no `data`
    await dpdp.erasure.deleteAccount("u2");
    for (let i = 0; i < 6; i++) await failing.retention.run();
    const users = (await failing.retention.tasks({ subjectId: "u2" })).find((t) => t.table === "users")!;
    expect(users).toMatchObject({ status: "failed", attempts: 5 });
    expect(users.lastError).toMatch(/No data access configured/);
  });

  it("never carries out a task twice when runners overlap", async () => {
    const { dpdp, msg91 } = setup();
    await dpdp.consent.grant("u1", ["marketing_sms"]);
    await dpdp.consent.withdraw("u1", ["marketing_sms"]);
    const reports = await Promise.all([dpdp.retention.run(), dpdp.retention.run(), dpdp.retention.run()]);
    expect(reports.flatMap((r) => r.done)).toHaveLength(1);
    expect(msg91.stop).toHaveBeenCalledOnce();
  });

  it("keeps working for consent alone with a store that can't hold tasks", async () => {
    const base = memoryStore();
    const consentOnly: ConsentStore = { lastEvent: base.lastEvent, insert: base.insert, events: base.events };
    const dpdp = createDpdp({ config, store: consentOnly });
    await dpdp.consent.grant("u1", ["marketing_sms"]);
    expect((await dpdp.consent.withdraw("u1", ["marketing_sms"])).tasks).toEqual([]);
    await expect(dpdp.retention.run()).rejects.toBeInstanceOf(DpdpError);
    await expect(dpdp.rights.open("u1", "access")).rejects.toMatchObject({ code: "store-unsupported" });
  });
});

describe("erase values in memory", () => {
  it("sets each field to its replacement, including false and 0", async () => {
    const data = memoryData({ t: [{ id: "a", x: "secret", y: true, z: 5, w: "gone" }] });
    await data.eraseFields("t", "id", "a", ["x", "y", "z", "w"], { x: "[erased]", y: false, z: 0 });
    expect(data.tables.t).toEqual([{ id: "a", x: "[erased]", y: false, z: 0, w: null }]);
  });
});

describe("erase functions are checked when they run", () => {
  it("fails the task with a clear message when the function returns nothing", async () => {
    let t = Date.parse("2026-01-01T00:00:00.000Z");
    const users = config.data.users!;
    const broken = {
      ...config,
      data: {
        ...config.data,
        users: { ...users, fields: { ...users.fields, interests: { ...users.fields.interests!, erase: { value: () => undefined as unknown as string } } } },
      },
    } as typeof config;
    const data = memoryData({ users: [{ id: "u1", phone: "1", name: "A", interests: "x" }] });
    const dpdp = createDpdp({ config: broken, store: memoryStore(), data, now: () => new Date(t) });
    await dpdp.consent.grant("u1", ["marketing_sms", "analytics"]);
    await dpdp.consent.withdraw("u1", ["marketing_sms", "analytics"]);
    t += 400 * DAY;
    const report = await dpdp.retention.run();
    expect(report.failed.map((f) => f.lastError)).toEqual([expect.stringContaining("does the function return?")]);
    expect(data.tables.users![0]!.interests).toBe("x");
  });
});
