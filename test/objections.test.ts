// Section 7(a): data the person gave voluntarily may be used for that purpose until they say they
// don't want it used. consent.object() records that, and everything that checks purposes respects it.
import { describe, expect, it } from "vitest";
import { audit, CONSENT_REQUIRED_BODY, createDpdp, defineConfig, memoryData, memoryStore } from "../src/index.js";
import { consentDeniedBody } from "../src/guard.js";

const DAY = 24 * 60 * 60 * 1000;

const config = defineConfig({
  fiduciary: { name: "Chai & Co", grievanceUrl: "/g", dpo: "privacy@chai.example" },
  purposes: {
    account: { basis: "legitimate-use", legitimateUse: "7(b)", retain: "while-active" },
    receipts: { basis: "legitimate-use", legitimateUse: "7(a)", retain: "while-active", description: "SMS receipts for your orders" },
    offers: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },
  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        name: { category: "identity", purposes: ["account"] },
        phone: { category: "contact", purposes: ["receipts", "offers"] },
      },
    },
    receiptLog: { table: "receipt_log", subject: "user_id", fields: { phone: { category: "contact", purposes: ["receipts"] } } },
  },
  processors: { sms: { purposes: ["receipts", "offers"], contract: "DPA clause 7" } },
  minimumRetention: "1y",
});

function setup() {
  let t = Date.parse("2026-12-01T10:00:00.000Z");
  const store = memoryStore();
  const data = memoryData({
    users: [{ id: "u1", name: "Asha", phone: "98xxxxxx01" }],
    receipt_log: [{ user_id: "u1", phone: "98xxxxxx01" }],
  });
  const dpdp = createDpdp({ config, store, data, now: () => new Date((t += 1000)) });
  return { dpdp, store, data, advance: (ms: number) => (t += ms) };
}

describe("objections to a Section 7(a) use", () => {
  it("lets a 7(a) purpose run until the person objects, then stops it", async () => {
    const { dpdp } = setup();
    expect(await dpdp.consent.has("u1", "receipts")).toBe(true);
    const { event } = await dpdp.consent.object("u1", ["receipts"], { channel: "app" });
    expect(event).toMatchObject({ action: "object", purposes: ["receipts"], seq: 1 });
    expect(await dpdp.consent.has("u1", "receipts")).toBe(false);
    expect(await dpdp.consent.objections("u1")).toEqual(["receipts"]);
    expect(await dpdp.consent.has("u1", "account")).toBe(true); // other legitimate uses aren't affected
    expect(await dpdp.consent.verify("u1")).toEqual({ ok: true, events: 1 });
  });

  it("only accepts objections to 7(a) purposes", async () => {
    const { dpdp } = setup();
    await expect(dpdp.consent.object("u1", ["offers"])).rejects.toMatchObject({ code: "not-objectable" });
    await expect(dpdp.consent.object("u1", ["account"])).rejects.toMatchObject({ code: "not-objectable" });
    await expect(dpdp.consent.grant("u1", ["receipts"])).rejects.toMatchObject({ code: "not-a-consent-purpose" });
  });

  it("keeps consent and objections apart in the record", async () => {
    const { dpdp } = setup();
    await dpdp.consent.grant("u1", ["offers"]);
    await dpdp.consent.object("u1", ["receipts"]);
    expect(await dpdp.consent.active("u1")).toEqual(["offers"]); // an objection isn't a withdrawal
    expect(await dpdp.consent.has("u1", "offers")).toBe(true);
    expect((await dpdp.consent.history("u1")).map((e) => e.action)).toEqual(["grant", "object"]);
  });

  it("erases fields the objection leaves without a purpose, never whole rows", async () => {
    const { dpdp } = setup();
    const { erasure, tasks } = await dpdp.consent.object("u1", ["receipts"]);
    // receipt_log has only the phone, held only for receipts: a withdrawal-style erase, not a row delete
    expect(erasure.tables.find((t) => t.key === "receiptLog")).toMatchObject({ action: "erase-fields" });
    expect(erasure.tables.find((t) => t.key === "users")).toMatchObject({ action: "erase-fields" }); // offers wasn't granted
    expect(tasks.map((t) => t.kind).sort()).toEqual(["erase-fields", "erase-fields", "processor-erase", "processor-stop"]);
    expect(tasks.filter((t) => t.kind === "erase-fields").every((t) => t.purposes?.includes("receipts"))).toBe(true);
  });

  it("doesn't keep data for an objected purpose when consent is later withdrawn", async () => {
    const { dpdp } = setup();
    await dpdp.consent.grant("u1", ["offers"]);
    const objection = await dpdp.consent.object("u1", ["receipts"]);
    expect(objection.erasure.tables.find((t) => t.key === "users")?.fields).toEqual([{ field: "phone", action: "keep", keptFor: ["offers"] }]);
    const { erasure } = await dpdp.consent.withdraw("u1", ["offers"]);
    // Before 0.5 the phone was kept "for receipts", although the person had objected to it.
    expect(erasure.tables.find((t) => t.key === "users")?.fields).toEqual([{ field: "phone", action: "erase", after: "0d" }]);
  });

  it("schedules nothing twice when the same objection is repeated", async () => {
    const { dpdp } = setup();
    await dpdp.consent.object("u1", ["receipts"]);
    const again = await dpdp.consent.object("u1", ["receipts"]);
    expect(again.tasks).toEqual([]);
  });

  it("cancels the objection's pending erasure when it's lifted, and nothing is erased", async () => {
    const { dpdp, data, advance } = setup();
    await dpdp.consent.object("u1", ["receipts"]);
    const { cancelled, tasks } = await dpdp.consent.liftObjection("u1", ["receipts"]);
    // Both field erasures and both processor tasks; the processor stop was due at once but hadn't run.
    expect(cancelled.map((t) => t.kind).sort()).toEqual(["erase-fields", "erase-fields", "processor-erase", "processor-stop"]);
    expect(cancelled.every((t) => t.status === "cancelled" && t.note === "Objection lifted")).toBe(true);
    expect(tasks).toEqual([]);
    expect(await dpdp.consent.has("u1", "receipts")).toBe(true);
    advance(400 * DAY);
    const report = await dpdp.retention.run();
    expect(report.done).toEqual([]);
    expect(data.tables.users).toEqual([{ id: "u1", name: "Asha", phone: "98xxxxxx01" }]);
  });

  it("still erases a year later when the objection stands", async () => {
    const { dpdp, data, advance } = setup();
    await dpdp.consent.object("u1", ["receipts"]);
    advance(366 * DAY);
    const report = await dpdp.retention.run();
    expect(report.failed).toEqual([]);
    expect(data.tables.users).toEqual([{ id: "u1", name: "Asha", phone: null }]);
    expect(data.tables.receipt_log).toEqual([{ user_id: "u1", phone: null }]);
  });

  it("shows objections in the data summary", async () => {
    const { dpdp } = setup();
    await dpdp.consent.object("u1", ["receipts"]);
    const summary = await dpdp.rights.summary("u1");
    expect(summary.objections).toEqual(["receipts"]);
    expect(summary.legitimateUses).toEqual(["account"]);
    expect(summary.sharedWith).toEqual([]); // sms only had receipts and offers
  });

  it("flags access to an objected purpose in the review", async () => {
    const { dpdp } = setup();
    await dpdp.access.log({ actor: "billing", subjectId: "u1", purpose: "receipts" });
    await dpdp.consent.object("u1", ["receipts"]);
    await dpdp.access.log({ actor: "billing", subjectId: "u1", purpose: "receipts" });
    const { findings } = await dpdp.access.review();
    expect(findings.map((f) => f.kind)).toEqual(["objected"]); // only the read after the objection
  });

  it("tells the person why a guarded route refused them", () => {
    const { dpdp } = setup();
    expect(consentDeniedBody(dpdp, "receipts")).toMatchObject({ error: "consent_required", reason: "objected" });
    expect(consentDeniedBody(dpdp, "offers")).toEqual(CONSENT_REQUIRED_BODY("offers"));
  });

  it("checks legitimateUse in the audit", () => {
    const bad = {
      ...config,
      purposes: {
        ...config.purposes,
        offers: { basis: "consent", legitimateUse: "7(a)", retain: { afterWithdrawal: "0d" } },
        account: { basis: "legitimate-use", legitimateUse: "7(z)", retain: "while-active" },
      },
    } as unknown as typeof config;
    expect(audit(bad).filter((i) => i.code === "invalid-legitimate-use").map((i) => i.path)).toEqual([
      "purposes.account.legitimateUse",
      "purposes.offers.legitimateUse",
    ]);
  });
});
