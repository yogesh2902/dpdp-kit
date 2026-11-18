import { describe, expect, it } from "vitest";
import { type ConsentStore, createDpdp, DpdpError, memoryStore } from "../src/index.js";
import { config } from "./fixtures/config.js";

function setup(start = "2027-06-01T10:00:00.000Z", extra: Parameters<typeof createDpdp>[0]["access"] = undefined) {
  let clock = new Date(start);
  const store = memoryStore();
  const dpdp = createDpdp({ config, store, now: () => clock, ...(extra ? { access: extra } : {}) });
  const tick = (ms: number) => (clock = new Date(clock.getTime() + ms));
  return { dpdp, store, tick };
}

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

describe("access log", () => {
  it("records who accessed whose data, why, and which fields", async () => {
    const { dpdp } = setup();
    const [entry] = await dpdp.access.log({
      actor: "support:priya",
      subjectId: "u1",
      purpose: "account",
      fields: ["users.phone", "users.name"],
      reason: "ticket 4411",
      evidence: { ip: "10.0.0.7" },
    });
    expect(entry).toMatchObject({
      actor: "support:priya",
      subjectId: "u1",
      action: "read",
      purpose: "account",
      fields: ["users.phone", "users.name"],
      reason: "ticket 4411",
      evidence: { ip: "10.0.0.7" },
      at: "2027-06-01T10:00:00.000Z",
    });
    expect(entry!.outOfPurpose).toBeUndefined();
    expect(await dpdp.access.list({ subjectId: "u1" })).toEqual([entry]);
  });

  it("expands a table to its personal fields and writes one entry per person", async () => {
    const { dpdp } = setup();
    const entries = await dpdp.access.log({ actor: "job:export", subjectIds: ["u1", "u2", "u1"], purpose: "account", action: "export", fields: ["orders"] });
    expect(entries.map((e) => e.subjectId)).toEqual(["u1", "u2"]);
    expect(entries[0]!.fields).toEqual(["orders.address"]);
    expect(entries[0]!.action).toBe("export");
  });

  it("marks fields that aren't held for the purpose", async () => {
    const { dpdp } = setup();
    const [entry] = await dpdp.access.log({ actor: "growth:raj", subjectId: "u1", purpose: "analytics", fields: ["users.phone", "users.interests"] });
    expect(entry!.outOfPurpose).toEqual(["users.phone"]); // phone isn't held for analytics; interests is
  });

  it("with outOfPurpose: throw, logs the attempt and then refuses", async () => {
    const { dpdp } = setup(undefined, { outOfPurpose: "throw" });
    await expect(dpdp.access.log({ actor: "growth:raj", subjectId: "u1", purpose: "analytics", fields: ["users.phone"] })).rejects.toMatchObject({
      code: "out-of-purpose",
    });
    expect(await dpdp.access.list({ actor: "growth:raj" })).toHaveLength(1);
  });

  it("rejects unknown purposes and fields, and entries without an actor or a person", async () => {
    const { dpdp } = setup();
    // @ts-expect-error not a declared purpose
    await expect(dpdp.access.log({ actor: "a", subjectId: "u1", purpose: "nope" })).rejects.toMatchObject({ code: "unknown-purpose" });
    await expect(dpdp.access.log({ actor: "a", subjectId: "u1", purpose: "account", fields: ["users.salary", "nope"] })).rejects.toMatchObject({
      code: "unknown-field",
    });
    await expect(dpdp.access.log({ actor: "", subjectId: "u1", purpose: "account" })).rejects.toMatchObject({ code: "invalid-actor" });
    await expect(dpdp.access.log({ actor: "a", purpose: "account" })).rejects.toMatchObject({ code: "invalid-subject" });
  });

  it("filters by actor, purpose and time", async () => {
    const { dpdp, tick } = setup();
    await dpdp.access.log({ actor: "a", subjectId: "u1", purpose: "account" });
    tick(DAY);
    await dpdp.access.log({ actor: "b", subjectId: "u1", purpose: "order_updates" });
    expect((await dpdp.access.list({ actor: "b" })).map((e) => e.purpose)).toEqual(["order_updates"]);
    expect(await dpdp.access.list({ purpose: "account" })).toHaveLength(1);
    expect(await dpdp.access.list({ from: "2027-06-02T00:00:00.000Z" })).toHaveLength(1);
    expect(await dpdp.access.list({ to: "2027-06-02T00:00:00.000Z" })).toHaveLength(1);
    expect(await dpdp.access.list({ limit: 1 })).toHaveLength(1);
  });

  it("needs a store that keeps the access log", async () => {
    const { lastEvent, insert, events } = memoryStore();
    const consentOnly: ConsentStore = { lastEvent, insert, events };
    const dpdp = createDpdp({ config, store: consentOnly });
    await expect(dpdp.access.log({ actor: "a", subjectId: "u1", purpose: "account" })).rejects.toMatchObject({ code: "store-unsupported" });
  });
});

describe("access review", () => {
  it("reports reads outside the purpose", async () => {
    const { dpdp, tick } = setup();
    await dpdp.consent.grant("u1", ["analytics"]);
    tick(MIN);
    await dpdp.access.log({ actor: "growth:raj", subjectId: "u1", purpose: "analytics", fields: ["users.phone"] });
    const review = await dpdp.access.review();
    expect(review.scanned).toBe(1);
    expect(review.findings).toEqual([expect.objectContaining({ kind: "out-of-purpose", actor: "growth:raj", subjectId: "u1" })]);
  });

  it("reports both problems when a read is out of purpose and without consent", async () => {
    const { dpdp } = setup();
    await dpdp.access.log({ actor: "growth:raj", subjectId: "u1", purpose: "analytics", fields: ["users.phone"] });
    const { findings } = await dpdp.access.review();
    expect(findings.map((f) => f.kind).sort()).toEqual(["no-consent", "out-of-purpose"]);
  });

  it("checks consent as it was at the time of each access", async () => {
    const { dpdp, tick } = setup();
    await dpdp.access.log({ actor: "crm", subjectId: "early", purpose: "marketing_sms" }); // before any consent
    tick(MIN);
    await dpdp.consent.grant("early", ["marketing_sms"]);
    await dpdp.consent.grant("later", ["marketing_sms"]);
    tick(MIN);
    await dpdp.access.log({ actor: "crm", subjectId: "later", purpose: "marketing_sms" }); // consent held then
    tick(MIN);
    await dpdp.consent.withdraw("later", ["marketing_sms"]); // withdrawn afterwards: the access was fine
    await dpdp.access.log({ actor: "crm", subjectId: "u9", purpose: "account" }); // legitimate use needs no consent

    const { findings } = await dpdp.access.review();
    expect(findings.map((f) => `${f.kind}:${f.subjectId}`)).toEqual(["no-consent:early"]);
  });

  it("reports one actor reaching many people within the window", async () => {
    const { dpdp, tick } = setup();
    for (let i = 0; i < 12; i++) {
      await dpdp.access.log({ actor: "intern", subjectId: `u${i}`, purpose: "account" });
      tick(MIN);
    }
    await dpdp.access.log({ actor: "support", subjectId: "u1", purpose: "account" });

    const quiet = await dpdp.access.review({ maxSubjects: 12 });
    expect(quiet.findings).toEqual([]);

    const { findings } = await dpdp.access.review({ maxSubjects: 10, window: "1h" });
    expect(findings).toEqual([expect.objectContaining({ kind: "bulk-access", actor: "intern", subjects: 12 })]);
    expect(findings[0]!.entries).toHaveLength(12);

    const exempt = await dpdp.access.review({ maxSubjects: 10, ignoreActors: ["intern"] });
    expect(exempt.findings).toEqual([]); // e.g. a nightly export job

    const narrow = await dpdp.access.review({ maxSubjects: 10, from: "2027-06-01T10:05:00.000Z" });
    expect(narrow.findings).toEqual([]); // only 7 people after 10:05
  });

  it("reviews the last day by default", async () => {
    const { dpdp, tick } = setup();
    await dpdp.access.log({ actor: "growth:raj", subjectId: "u1", purpose: "analytics", fields: ["users.phone"] });
    tick(2 * DAY);
    const review = await dpdp.access.review();
    expect(review.scanned).toBe(0);
    expect(review.from).toBe("2027-06-02T10:00:00.000Z");
  });
});

describe("access log retention", () => {
  it("prunes entries older than a year, and never sooner", async () => {
    const { dpdp, tick } = setup("2026-01-01T00:00:00.000Z");
    await dpdp.access.log({ actor: "a", subjectId: "old", purpose: "account" });
    tick(200 * DAY);
    await dpdp.access.log({ actor: "a", subjectId: "recent", purpose: "account" });
    tick(200 * DAY);

    const { deleted, before } = await dpdp.access.prune();
    expect(deleted).toBe(1);
    expect(before).toBe(new Date(Date.parse("2027-02-05T00:00:00.000Z") - 365 * DAY).toISOString());
    expect((await dpdp.access.list()).map((e) => e.subjectId)).toEqual(["recent"]);
  });

  it("keeps longer when the config says so", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const dpdp = createDpdp({ config: { ...config, security: { ...config.security, accessLogRetention: "2y" } }, store: memoryStore(), now: () => clock });
    await dpdp.access.log({ actor: "a", subjectId: "old", purpose: "account" });
    clock = new Date("2027-06-01T00:00:00.000Z");
    expect((await dpdp.access.prune()).deleted).toBe(0);
  });

  it("rejects a config that keeps access logs under a year", () => {
    expect(() => createDpdp({ config: { ...config, security: { accessLogRetention: "90d" } }, store: memoryStore() })).toThrow(DpdpError);
  });
});
