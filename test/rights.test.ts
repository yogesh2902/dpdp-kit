import { describe, expect, it } from "vitest";
import { audit, createDpdp, memoryData, memoryStore } from "../src/index.js";
import { config } from "./fixtures/config.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-17T10:00:00.000Z");

function setup(cfg = config) {
  let t = START;
  const data = memoryData({
    users: [{ id: "u1", phone: "98xxxxxx01", name: "Asha", interests: "cricket" }],
    orders: [{ id: "o1", user_id: "u1", address: "12 MG Road" }],
  });
  const dpdp = createDpdp({ config: cfg, store: memoryStore(), data, now: () => new Date(t) });
  return { dpdp, data, advance: (ms: number) => (t += ms) };
}

describe("rights requests", () => {
  it("opens with a due date 90 days out (Rule 14(3)) and keeps a history", async () => {
    const { dpdp } = setup();
    const r = await dpdp.rights.open("u1", "grievance", { text: "I keep getting promo SMS" });
    expect(r).toMatchObject({
      subjectId: "u1",
      type: "grievance",
      status: "open",
      openedAt: new Date(START).toISOString(),
      dueAt: new Date(START + 90 * DAY).toISOString(),
      details: { text: "I keep getting promo SMS" },
      history: [{ status: "open" }],
    });
    expect(await dpdp.rights.get(r.id)).toEqual(r);
  });

  it("uses per-type response times from the config", async () => {
    const { dpdp } = setup({ ...config, rights: { responseWithin: { access: "30d", grievance: "15d" } } });
    expect((await dpdp.rights.open("u1", "access")).dueAt).toBe(new Date(START + 30 * DAY).toISOString());
    expect((await dpdp.rights.open("u1", "grievance")).dueAt).toBe(new Date(START + 15 * DAY).toISOString());
    expect((await dpdp.rights.open("u1", "nomination")).dueAt).toBe(new Date(START + 90 * DAY).toISOString());
  });

  it("lists overdue requests, and resolves or rejects each only once", async () => {
    const { dpdp, advance } = setup();
    const a = await dpdp.rights.open("u1", "correction", { field: "name", to: "Asha K" });
    const b = await dpdp.rights.open("u1", "grievance");
    expect(await dpdp.rights.list({ overdue: true })).toEqual([]);

    advance(91 * DAY);
    expect((await dpdp.rights.list({ overdue: true })).map((r) => r.id)).toEqual([a.id, b.id]);

    const resolved = await dpdp.rights.resolve(a.id, "Name corrected");
    expect(resolved).toMatchObject({ status: "resolved", history: [{ status: "open" }, { status: "resolved", note: "Name corrected" }] });
    await dpdp.rights.reject(b.id, "Duplicate of an earlier grievance");
    expect(await dpdp.rights.list({ overdue: true })).toEqual([]);
    await expect(dpdp.rights.resolve(a.id)).rejects.toMatchObject({ code: "request-closed" });
    await expect(dpdp.rights.resolve("nope")).rejects.toMatchObject({ code: "request-not-found" });
    // @ts-expect-error not a request type
    await expect(dpdp.rights.open("u1", "delete-me")).rejects.toMatchObject({ code: "invalid-request-type" });
  });

  it("summarises what is held and who it was shared with (Section 11)", async () => {
    const { dpdp } = setup();
    await dpdp.consent.grant("u1", ["order_updates"]);
    const s = await dpdp.rights.summary("u1");

    expect(s.consents).toEqual(["order_updates"]);
    expect(s.legitimateUses).toEqual(["account"]);
    expect(s.data.map((d) => [d.key, d.rows])).toEqual([
      ["users", [{ phone: "98xxxxxx01", name: "Asha", interests: "cricket" }]],
      ["orders", [{ address: "12 MG Road" }]],
    ]);
    expect(s.data[0]!.fields[0]).toEqual({ field: "phone", category: "contact", purposes: ["account", "order_updates", "marketing_sms"] });
    // msg91 gets data for order_updates; posthog only for analytics, which isn't granted
    expect(s.sharedWith).toEqual([{ name: "msg91", purposes: ["order_updates"], countries: ["IN"] }]);
  });

  it("erases on request, keeping what is still needed, and resolves the request", async () => {
    const { dpdp } = setup();
    const request = await dpdp.rights.open("u1", "erasure");
    const { plan, tasks } = await dpdp.rights.erase("u1", { keepFor: ["account"], requestId: request.id });

    expect(plan.reason).toBe("erasure-request");
    const users = plan.tables.find((t) => t.key === "users")!;
    expect(users.action).toBe("erase-fields"); // phone and name stay for the account
    expect(users.fields.filter((f) => f.action === "erase").map((f) => f.field)).toEqual(["interests"]);
    expect(tasks.length).toBeGreaterThan(0);
    expect(await dpdp.rights.get(request.id)).toMatchObject({ status: "resolved", history: [{}, { note: `Erasure scheduled: ${tasks.length} task(s)` }] });
  });

  it("audit enforces the 90-day grievance limit and known request types", () => {
    const tooLong = { ...config, rights: { responseWithin: "120d" as const } };
    expect(audit(tooLong).map((i) => i.code)).toEqual(["grievance-response-too-long"]);
    const accessSlow = { ...config, rights: { responseWithin: { access: "120d" as const } } };
    expect(audit(accessSlow)).toEqual([]); // the Rules set no period for access requests
    const badType = { ...config, rights: { responseWithin: { complaints: "30d" } } } as unknown as typeof config;
    expect(audit(badType).map((i) => i.code)).toEqual(["invalid-request-type"]);
  });
});
