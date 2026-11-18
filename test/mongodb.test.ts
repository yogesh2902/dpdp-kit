// The MongoDB store, data access and Mongoose schema reader, on a real mongod started in-process
// (mongodb-memory-server downloads it on first use).
import { type Db, MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDpdp, defineConfig, SeqConflictError } from "../src/index.js";
import { type MongoDbLike, mongoData, mongooseSchema, mongoStore } from "../src/mongodb.js";
import { checkSchema } from "../src/schema-check.js";
import { config as shopConfig } from "./fixtures/config.js";
import * as models from "./fixtures/models.js";

const DAY = 24 * 60 * 60 * 1000;

let server: MongoMemoryServer;
let client: MongoClient;
let dbCount = 0;
/** A fresh database for each suite. */
const freshDb = () => client.db(`dpdp_test_${++dbCount}`);

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
}, 300_000);
afterAll(async () => {
  await client?.close();
  await server?.stop();
});

// The driver's Db fits the shape dpdp-kit asks for, so no cast is needed.
const asDbLike = (db: Db): MongoDbLike => db;

describe("mongo store: consent records", () => {
  let db: Db;
  let dpdp: ReturnType<typeof createDpdp>;
  let store: ReturnType<typeof mongoStore>;
  beforeAll(() => {
    db = freshDb();
    store = mongoStore(asDbLike(db));
    dpdp = createDpdp({ config: shopConfig, store });
  });

  it("round-trips events so the chain still verifies", async () => {
    await dpdp.consent.grant("u1", ["analytics", "marketing_sms"], { noticeVersion: "2026-11", language: "ta", channel: "android", evidence: { ip: "203.0.113.7" } });
    await dpdp.consent.withdraw("u1", ["analytics"]);
    const history = await dpdp.consent.history("u1");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ language: "ta", evidence: { ip: "203.0.113.7" }, prevHash: null });
    expect(history[1]).not.toHaveProperty("language");
    expect(await dpdp.consent.verify("u1")).toEqual({ ok: true, events: 2 });
    expect(await dpdp.consent.active("u1")).toEqual(["marketing_sms"]);
  });

  it("creates its indexes, and turns a duplicate (subject, seq) into SeqConflictError", async () => {
    const [first] = await dpdp.consent.history("u1");
    await expect(store.insert(first!)).rejects.toBeInstanceOf(SeqConflictError);
    const names = (await db.collection("dpdp_consent_events").indexes()).map((i) => i.name);
    expect(names).toContain("dpdp_subject_seq");
  });

  it("keeps one chain under concurrent writes", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => (i % 2 ? dpdp.consent.withdraw("u2", ["analytics"]) : dpdp.consent.grant("u2", ["analytics"]))));
    expect((await dpdp.consent.history("u2")).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(await dpdp.consent.verify("u2")).toEqual({ ok: true, events: 5 });
  });

  it("finds tampering done directly in the database", async () => {
    await db.collection("dpdp_consent_events").updateOne({ subjectId: "u1", seq: 2 }, { $set: { action: "grant" } });
    expect(await dpdp.consent.verify("u1")).toMatchObject({ ok: false, brokenAt: 2, reason: "hash-mismatch" });
  });
});

describe("mongo store and data access: rights and retention", () => {
  const config = defineConfig({
    fiduciary: { name: "Acme", grievanceUrl: "/g" },
    purposes: {
      account: { basis: "legitimate-use", retain: "while-active" },
      promo: { basis: "consent", retain: { afterWithdrawal: "0d" } },
    },
    data: {
      customers: {
        table: "customers",
        subject: "_id",
        fields: {
          mobileNo: { category: "contact", purposes: ["account", "promo"] },
          "address.city": { category: "contact", purposes: ["promo"] },
          favouriteTeam: { category: "behavioural", purposes: ["promo"] },
          points: { category: "behavioural", purposes: ["promo"], erase: { value: 0 } },
        },
      },
      invoices: {
        table: "invoices",
        subject: "customerId",
        fields: { billingAddress: { category: "contact", purposes: ["account"] } },
        legalHold: { reason: "GST records", keep: "8y", then: "anonymise" },
      },
    },
    processors: { sms: { purposes: ["promo"] } },
    minimumRetention: "1y",
  });
  const c1 = new ObjectId();
  const c2 = new ObjectId();
  let db: Db;
  let t = Date.parse("2026-11-17T10:00:00.000Z");
  const sms = { stop: vi.fn(), erase: vi.fn() };
  let dpdp: ReturnType<typeof createDpdp>;

  beforeAll(async () => {
    db = freshDb();
    dpdp = createDpdp({ config, store: mongoStore(db), data: mongoData(db, { ObjectId }), processors: { sms }, now: () => new Date(t) });
    await db.collection("customers").insertMany([
      { _id: c1, mobileNo: "98xxxxxx01", address: { city: "Pune", pin: "411001" }, favouriteTeam: "RCB", points: 120 },
      { _id: c2, mobileNo: "98xxxxxx02", address: { city: "Chennai", pin: "600001" }, favouriteTeam: "CSK", points: 40 },
    ]);
    await db.collection("invoices").insertMany([{ _id: "i1" as never, customerId: 1001, billingAddress: "12 MG Road, Bengaluru" }]);
  });

  it("summarises a person's data, by ObjectId and by a number id, including nested fields", async () => {
    const s = await dpdp.rights.summary(c1.toHexString());
    expect(s.data.map((d) => [d.key, d.rows])).toEqual([["customers", [{ mobileNo: "98xxxxxx01", address: { city: "Pune" }, favouriteTeam: "RCB", points: 120 }]]]);
    expect((await dpdp.rights.summary("1001")).data.map((d) => [d.key, d.rows])).toEqual([["invoices", [{ billingAddress: "12 MG Road, Bengaluru" }]]]);
  });

  it("stores requests and finds overdue ones", async () => {
    const r = await dpdp.rights.open(c1.toHexString(), "grievance", { text: "Too many SMS" });
    expect(await dpdp.rights.get(r.id)).toEqual(r);
    t += 91 * DAY;
    expect((await dpdp.rights.list({ overdue: true })).map((x) => x.id)).toEqual([r.id]);
    const resolved = await dpdp.rights.resolve(r.id, "Promo SMS turned off");
    expect(await dpdp.rights.get(r.id)).toEqual(resolved);
    expect(await dpdp.rights.list({ overdue: true })).toEqual([]);
  });

  it("withdrawal: processor stopped now, fields erased a year later (removed, or replaced)", async () => {
    const id = c1.toHexString();
    await dpdp.consent.grant(id, ["promo"]);
    const { tasks } = await dpdp.consent.withdraw(id, ["promo"]);
    expect(tasks.map((x) => x.kind).sort()).toEqual(["erase-fields", "processor-erase", "processor-stop"]);
    expect((await dpdp.retention.run()).done.map((x) => x.kind)).toEqual(["processor-stop"]);

    t += 366 * DAY;
    const report = await dpdp.retention.run();
    expect(report.failed).toEqual([]);
    expect(report.done.find((x) => x.kind === "erase-fields")).toMatchObject({ affected: 1 });
    expect(await db.collection("customers").find({}, { sort: { mobileNo: 1 } }).toArray()).toEqual([
      { _id: c1, mobileNo: "98xxxxxx01", address: { pin: "411001" }, points: 0 },
      { _id: c2, mobileNo: "98xxxxxx02", address: { city: "Chennai", pin: "600001" }, favouriteTeam: "CSK", points: 40 },
    ]);
  });

  it("account deletion: documents deleted after a year, invoices anonymised after the GST hold", async () => {
    await dpdp.erasure.deleteAccount("1001");
    await dpdp.erasure.deleteAccount(c2.toHexString());
    t += 366 * DAY;
    await dpdp.retention.run();
    expect((await db.collection("customers").find().toArray()).map((d) => d._id)).toEqual([c1]);
    expect(await db.collection("invoices").find().toArray()).toEqual([{ _id: "i1", customerId: 1001, billingAddress: "12 MG Road, Bengaluru" }]);
    t += 8 * 365 * DAY;
    await dpdp.retention.run();
    expect(await db.collection("invoices").find().toArray()).toEqual([{ _id: "i1", customerId: 1001 }]);
  });

  it("only one runner gets each task when several run at once", async () => {
    for (const id of ["a", "b", "c"]) {
      await dpdp.consent.grant(id, ["promo"]);
      await dpdp.consent.withdraw(id, ["promo"]);
    }
    sms.stop.mockClear();
    const reports = await Promise.all([dpdp.retention.run(), dpdp.retention.run(), dpdp.retention.run(), dpdp.retention.run()]);
    const done = reports.flatMap((r) => r.done).map((x) => x.id);
    expect(done).toHaveLength(3);
    expect(new Set(done).size).toBe(3);
    expect(sms.stop).toHaveBeenCalledTimes(3);
  });
});

describe("mongo store: access log and breaches", () => {
  let t = Date.parse("2027-01-01T09:00:00.000Z");
  let dpdp: ReturnType<typeof createDpdp>;
  beforeAll(() => {
    dpdp = createDpdp({ config: shopConfig, store: mongoStore(freshDb()), now: () => new Date(t) });
  });

  it("writes, filters and reviews entries, in write order within a millisecond", async () => {
    await dpdp.consent.grant("c1", ["analytics"]);
    t += 60_000;
    await dpdp.access.log({ actor: "crm", subjectIds: ["c1", "c2"], purpose: "analytics", fields: ["users.interests"], evidence: { ip: "10.0.0.7" } });
    for (const actor of ["a", "b", "c", "d", "e"]) await dpdp.access.log({ actor, subjectId: "same-ms", purpose: "account" });
    expect((await dpdp.access.list({ subjectId: "same-ms" })).map((e) => e.actor)).toEqual(["a", "b", "c", "d", "e"]);
    expect(await dpdp.access.list({ subjectId: "c1" })).toMatchObject([{ actor: "crm", fields: ["users.interests"], evidence: { ip: "10.0.0.7" } }]);
    expect(await dpdp.access.list({ actor: "crm", limit: 1 })).toHaveLength(1);
    expect(await dpdp.access.list({ from: "2027-01-01T09:01:00.000Z", to: "2027-01-01T09:01:00.001Z", limit: 2 })).toHaveLength(2);
    const { findings } = await dpdp.access.review();
    expect(findings.map((f) => `${f.kind}:${f.subjectId}`)).toContain("no-consent:c2");
  });

  it("prunes only entries older than a year", async () => {
    t = Date.parse("2028-01-01T09:00:30.000Z");
    expect((await dpdp.access.prune()).deleted).toBe(0);
    t = Date.parse("2028-01-02T09:00:00.000Z");
    expect((await dpdp.access.prune()).deleted).toBe(7);
  });

  it("stores breaches and thousands of notices, counts them, and lists open ones newest first", async () => {
    t = Date.parse("2027-06-01T10:00:00.000Z");
    const first = await dpdp.breach.open({ description: "First", awareAt: "2027-06-01T08:00:00Z", fields: ["users"] });
    const second = await dpdp.breach.open({ description: "Second", awareAt: "2027-06-01T09:00:00Z" });
    const ids = Array.from({ length: 2500 }, (_, i) => `c${i}`);
    expect(await dpdp.breach.addAffected(first.id, ids)).toBe(2500);
    expect(await dpdp.breach.addAffected(first.id, ["c1", "c2", "new"])).toBe(1);

    t += 60_000;
    expect(await dpdp.breach.markNotified(first.id, ids.slice(0, 1500), { channel: "email" })).toBe(1500);
    t += 60_000;
    expect(await dpdp.breach.markNotified(first.id, ["c1600"])).toBe(1);

    expect((await dpdp.breach.boardReport(first.id)).intimations).toEqual({
      total: 2501,
      sent: 1501,
      pending: 1000,
      firstSentAt: "2027-06-01T10:01:00.000Z",
      lastSentAt: "2027-06-01T10:02:00.000Z",
    });
    expect((await dpdp.breach.pending(first.id, 2)).map((n) => n.subjectId)).toEqual(["c1500", "c1501"]);
    expect(await dpdp.breach.pending(first.id, 1)).toEqual([{ breachId: first.id, subjectId: "c1500", status: "pending", addedAt: "2027-06-01T10:00:00.000Z" }]);
    expect((await dpdp.breach.list({ status: "open" })).map((b) => b.description)).toEqual(["Second", "First"]);

    await dpdp.breach.updateReport(first.id, { details: "d" });
    await dpdp.breach.close(second.id);
    expect((await dpdp.breach.get(first.id))!.report).toEqual({ details: "d" });
    expect((await dpdp.breach.list({ status: "open" })).map((b) => b.id)).toEqual([first.id]);
    expect((await dpdp.daily()).breaches!.map((b) => b.id)).toEqual([first.id]);
  });
});

describe("Mongoose", () => {
  it("mongooseSchema reads models into tables and columns", () => {
    const schema = mongooseSchema(models);
    expect(schema.tables.map((t) => [t.name, t.key])).toEqual([
      ["users", "User"],
      ["orders", "Order"],
      ["analytics_events", "AnalyticsEvent"],
      ["products", "Product"],
    ]);
    expect(schema.tables[0]!.columns).toEqual([
      { name: "phone", notNull: false, type: "string" },
      { name: "name", notNull: false, type: "string" },
      { name: "interests", notNull: false, type: "string" },
      { name: "emailVerifiedAt", notNull: false, type: "other" },
      { name: "createdAt", notNull: true, type: "other" },
      { name: "_id", key: "id", notNull: true, type: "other" },
    ]);
    expect(checkSchema(shopConfig, schema)).toEqual([]);
  });

  it("finds drift, and nested paths", () => {
    const m = new mongoose.Mongoose();
    const Lead = m.model("Lead", new m.Schema({ email: { type: String, required: true }, profile: { aadhaarNumber: String, company: String } }));
    const codes = checkSchema(shopConfig, mongooseSchema([Lead, ...Object.values(models)])).map((i) => `${i.level}:${i.path}`);
    expect(codes).toEqual(["error:schema.leads.email", "error:schema.leads.profile.aadhaarNumber"]); // "company" alone isn't personal
    expect(mongooseSchema(m).tables.map((t) => t.name)).toEqual(["leads"]);
  });

  it("runs on a Mongoose connection, created before it connects", async () => {
    const m = new mongoose.Mongoose();
    const Member = m.model("Member", new m.Schema({ email: String, nickname: { type: String, required: true } }), "members");
    const config = defineConfig({
      fiduciary: { name: "Acme", grievanceUrl: "/g" },
      purposes: { promo: { basis: "consent", retain: { afterWithdrawal: "0d" } } },
      data: { members: { table: "Member", subject: "id", fields: { email: { category: "contact", purposes: ["promo"] }, nickname: { category: "identity", purposes: ["promo"], erase: "redact" } } } },
      minimumRetention: "1y",
    });
    let t = Date.parse("2026-01-01T00:00:00.000Z");
    const db = () => m.connection.db as MongoDbLike | undefined;
    const dpdp = createDpdp({
      config,
      store: mongoStore(db),
      data: mongoData(db, { schema: mongooseSchema(m), ObjectId: m.Types.ObjectId }),
      now: () => new Date(t),
    });
    await expect(dpdp.consent.history("x")).rejects.toThrow(/isn't connected yet/);

    await m.connect(server.getUri(), { dbName: `dpdp_test_${++dbCount}` });
    const member = await Member.create({ email: "asha@example.com", nickname: "ash" });
    const id = member._id.toString();
    await dpdp.consent.grant(id, ["promo"]);
    expect((await dpdp.rights.summary(id)).data[0]!.rows).toEqual([{ email: "asha@example.com", nickname: "ash" }]);
    await dpdp.consent.withdraw(id, ["promo"]);
    t += 366 * DAY;
    expect((await dpdp.retention.run()).failed).toEqual([]);
    const after = await Member.findById(member._id).lean();
    expect(after).toMatchObject({ nickname: "[erased]" });
    expect(after).not.toHaveProperty("email");
    await m.disconnect();
  });
});
