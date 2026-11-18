import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DPDP_DDL, drizzleData, drizzleStore } from "../src/drizzle.js";
import { createDpdp, defineConfig } from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;

// The app's own schema: Drizzle property names differ from the database column names.
const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  mobileNo: text("mobile_no"),
  fullName: text("full_name"),
  favouriteTeam: text("favourite_team"),
});
const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  customerId: text("customer_id"),
  billingAddress: text("billing_address"),
});
const schema = { customers, invoices };

const config = defineConfig({
  fiduciary: { name: "Acme", grievanceUrl: "/g" },
  purposes: {
    account: { basis: "legitimate-use", retain: "while-active" },
    promo: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },
  data: {
    customers: {
      table: "customers",
      subject: "id",
      fields: {
        mobileNo: { category: "contact", purposes: ["account", "promo"] },
        fullName: { category: "identity", purposes: ["account"] },
        favouriteTeam: { category: "behavioural", purposes: ["promo"] },
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

describe("rights and retention on Postgres (PGlite)", () => {
  const client = new PGlite();
  const db = drizzle(client);
  let t = Date.parse("2026-11-17T10:00:00.000Z");
  const sms = { stop: vi.fn(), erase: vi.fn() };
  const dpdp = createDpdp({
    config,
    store: drizzleStore(db),
    data: drizzleData(db, { schema }),
    processors: { sms },
    now: () => new Date(t),
  });
  const row = async (sqlText: string) => (await client.query<Record<string, unknown>>(sqlText)).rows;

  beforeAll(async () => {
    await client.exec(DPDP_DDL);
    await client.exec(`
      CREATE TABLE customers (id text PRIMARY KEY, mobile_no text, full_name text, favourite_team text);
      CREATE TABLE invoices (id text PRIMARY KEY, customer_id text, billing_address text);
      INSERT INTO customers VALUES ('c1', '98xxxxxx01', 'Asha K', 'RCB'), ('c2', '98xxxxxx02', 'Ravi M', 'CSK');
      INSERT INTO invoices VALUES ('i1', 'c1', '12 MG Road, Bengaluru');
    `);
  });
  afterAll(async () => {
    await client.close();
  });

  it("summarises a person's data by mapping property names to columns", async () => {
    await dpdp.consent.grant("c1", ["promo"]);
    const s = await dpdp.rights.summary("c1");
    expect(s.data.map((d) => [d.key, d.rows])).toEqual([
      ["customers", [{ mobileNo: "98xxxxxx01", fullName: "Asha K", favouriteTeam: "RCB" }]],
      ["invoices", [{ billingAddress: "12 MG Road, Bengaluru" }]],
    ]);
    expect(s.sharedWith).toEqual([{ name: "sms", purposes: ["promo"] }]);
  });

  it("stores requests and finds overdue ones", async () => {
    const r = await dpdp.rights.open("c1", "grievance", { text: "Too many SMS" });
    expect(await dpdp.rights.get(r.id)).toEqual(r);
    t += 91 * DAY;
    expect((await dpdp.rights.list({ overdue: true })).map((x) => x.id)).toEqual([r.id]);
    const resolved = await dpdp.rights.resolve(r.id, "Promo SMS turned off");
    expect(await dpdp.rights.get(r.id)).toEqual(resolved);
    expect(await dpdp.rights.list({ overdue: true })).toEqual([]);
  });

  it("withdrawal: processor stopped now, column nulled a year later", async () => {
    const { tasks } = await dpdp.consent.withdraw("c1", ["promo"]);
    expect(tasks.map((x) => x.kind).sort()).toEqual(["erase-fields", "processor-erase", "processor-stop"]);

    expect((await dpdp.retention.run()).done.map((x) => x.kind)).toEqual(["processor-stop"]);
    expect(sms.stop).toHaveBeenCalledOnce();
    expect(await row("SELECT favourite_team FROM customers WHERE id = 'c1'")).toEqual([{ favourite_team: "RCB" }]);

    t += 366 * DAY;
    const report = await dpdp.retention.run();
    expect(report.failed).toEqual([]);
    expect(report.done.find((x) => x.kind === "erase-fields")).toMatchObject({ table: "customers", fields: ["favouriteTeam"], affected: 1 });
    expect(await row("SELECT * FROM customers ORDER BY id")).toEqual([
      { id: "c1", mobile_no: "98xxxxxx01", full_name: "Asha K", favourite_team: null },
      { id: "c2", mobile_no: "98xxxxxx02", full_name: "Ravi M", favourite_team: "CSK" },
    ]);
  });

  it("account deletion: rows deleted after a year, invoices anonymised after the GST hold", async () => {
    await dpdp.erasure.deleteAccount("c1");
    t += 366 * DAY;
    await dpdp.retention.run();
    expect(await row("SELECT id FROM customers ORDER BY id")).toEqual([{ id: "c2" }]);
    expect(await row("SELECT billing_address FROM invoices")).toEqual([{ billing_address: "12 MG Road, Bengaluru" }]);

    t += 8 * 365 * DAY;
    await dpdp.retention.run();
    expect(await row("SELECT * FROM invoices")).toEqual([{ id: "i1", customer_id: "c1", billing_address: null }]);
  });

  it("only one runner gets each task when several run at once", async () => {
    await dpdp.consent.grant("c2", ["promo"]);
    await dpdp.consent.withdraw("c2", ["promo"]);
    sms.stop.mockClear();
    const reports = await Promise.all([dpdp.retention.run(), dpdp.retention.run(), dpdp.retention.run()]);
    expect(reports.flatMap((r) => r.done)).toHaveLength(1);
    expect(sms.stop).toHaveBeenCalledOnce();
  });

  it("records the database's message when an erasure can't run", async () => {
    await client.exec("ALTER TABLE customers ALTER COLUMN favourite_team SET NOT NULL");
    await dpdp.consent.grant("c2", ["promo"]);
    await dpdp.consent.withdraw("c2", ["promo"]);
    t += 366 * DAY;
    const report = await dpdp.retention.run();
    const failed = report.failed.find((x) => x.kind === "erase-fields");
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toMatch(/null/i);
  });
});

describe("access log on Postgres (PGlite)", () => {
  const client = new PGlite();
  const db = drizzle(client);
  let t = Date.parse("2026-01-01T09:00:00.000Z");
  const dpdp = createDpdp({ config, store: drizzleStore(db), now: () => new Date(t) });

  beforeAll(async () => {
    await client.exec(DPDP_DDL);
  });
  afterAll(async () => {
    await client.close();
  });

  it("writes, filters and reviews entries", async () => {
    await dpdp.consent.grant("c1", ["promo"]);
    t += 60_000;
    await dpdp.access.log({ actor: "crm", subjectIds: ["c1", "c2"], purpose: "promo", fields: ["customers.mobileNo"], evidence: { ip: "10.0.0.7" } });
    await dpdp.access.log({ actor: "support", subjectId: "c1", purpose: "account", fields: ["customers.favouriteTeam"], reason: "ticket 9" });

    const forC1 = await dpdp.access.list({ subjectId: "c1" });
    expect(forC1.map((e) => e.actor)).toEqual(["crm", "support"]);
    expect(forC1[0]).toMatchObject({ purpose: "promo", fields: ["customers.mobileNo"], evidence: { ip: "10.0.0.7" } });
    expect(forC1[1]).toMatchObject({ outOfPurpose: ["customers.favouriteTeam"], reason: "ticket 9" });
    expect(await dpdp.access.list({ actor: "crm", limit: 1 })).toHaveLength(1);

    const { findings } = await dpdp.access.review();
    expect(findings.map((f) => `${f.kind}:${f.actor}:${f.subjectId}`).sort()).toEqual([
      "no-consent:crm:c2", // c2 never agreed to promo
      "out-of-purpose:support:c1", // favouriteTeam is held for promo, not account
    ]);
  });

  it("keeps entries written in the same millisecond in the order they were written", async () => {
    for (const actor of ["a", "b", "c", "d", "e"]) await dpdp.access.log({ actor, subjectId: "same-ms", purpose: "account" });
    expect((await dpdp.access.list({ subjectId: "same-ms" })).map((e) => e.actor)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("prunes only entries older than a year", async () => {
    t = Date.parse("2027-01-01T09:00:30.000Z"); // the entries were logged at 09:01, so not quite a year ago
    expect((await dpdp.access.prune()).deleted).toBe(0);
    t = Date.parse("2027-01-02T09:00:00.000Z");
    expect((await dpdp.access.prune()).deleted).toBe(8);
    expect(await dpdp.access.list()).toEqual([]);
  });
});

describe("erasing NOT NULL columns on Postgres (PGlite)", () => {
  const client = new PGlite();
  const db = drizzle(client);
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  const members = pgTable("members", { id: text("id").primaryKey(), email: text("email"), nickname: text("nickname"), points: text("points") });
  const eraseConfig = defineConfig({
    fiduciary: { name: "Acme", grievanceUrl: "/g" },
    purposes: {
      account: { basis: "legitimate-use", retain: "while-active" },
      newsletter: { basis: "consent", retain: { afterWithdrawal: "0d" } },
    },
    data: {
      members: {
        table: "members",
        subject: "id",
        fields: {
          email: { category: "contact", purposes: ["newsletter"], erase: { value: ({ subjectId }) => `erased-${subjectId}@invalid` } },
          nickname: { category: "identity", purposes: ["newsletter"], erase: "redact" },
          points: { category: "behavioural", purposes: ["newsletter"], erase: { value: 0 } },
        },
      },
    },
    minimumRetention: "1y",
  });
  const dpdp = createDpdp({ config: eraseConfig, store: drizzleStore(db), data: drizzleData(db, { schema: { members } }), now: () => new Date(t) });

  beforeAll(async () => {
    await client.exec(DPDP_DDL);
    await client.exec(`
      CREATE TABLE members (id text PRIMARY KEY, email text NOT NULL UNIQUE, nickname text NOT NULL, points integer NOT NULL);
      INSERT INTO members VALUES ('m1', 'asha@example.com', 'ash', 120), ('m2', 'ravi@example.com', 'rav', 40);
    `);
  });
  afterAll(async () => {
    await client.close();
  });

  it("writes each field's replacement, so constraints hold", async () => {
    for (const id of ["m1", "m2"]) {
      await dpdp.consent.grant(id, ["newsletter"]);
      await dpdp.consent.withdraw(id, ["newsletter"]);
    }
    t += 366 * 24 * 60 * 60 * 1000;
    const report = await dpdp.retention.run();
    expect(report.failed).toEqual([]);
    expect(report.done).toHaveLength(2);
    const rows = (await client.query("SELECT id, email, nickname, points FROM members ORDER BY id")).rows;
    expect(rows).toEqual([
      { id: "m1", email: "erased-m1@invalid", nickname: "[erased]", points: 0 },
      { id: "m2", email: "erased-m2@invalid", nickname: "[erased]", points: 0 },
    ]);
  });
});

describe("breach records on Postgres (PGlite)", () => {
  const client = new PGlite();
  const db = drizzle(client);
  let t = Date.parse("2027-06-01T10:00:00.000Z");
  const dpdp = createDpdp({ config, store: drizzleStore(db), now: () => new Date(t) });

  beforeAll(async () => {
    await client.exec(DPDP_DDL);
  });
  afterAll(async () => {
    await client.close();
  });

  it("stores breaches and notices, counts them, and lists open ones newest first", async () => {
    const first = await dpdp.breach.open({ description: "First", awareAt: "2027-06-01T08:00:00Z", fields: ["customers"] });
    const second = await dpdp.breach.open({ description: "Second", awareAt: "2027-06-01T09:00:00Z" });
    const ids = Array.from({ length: 2500 }, (_, i) => `c${i}`);
    expect(await dpdp.breach.addAffected(first.id, ids)).toBe(2500);
    expect(await dpdp.breach.addAffected(first.id, ["c1", "c2", "new"])).toBe(1);

    t += 60_000;
    expect(await dpdp.breach.markNotified(first.id, ids.slice(0, 1500), { channel: "email" })).toBe(1500);
    t += 60_000;
    expect(await dpdp.breach.markNotified(first.id, ["c1600"], { channel: "sms" })).toBe(1);

    const report = await dpdp.breach.boardReport(first.id);
    expect(report.intimations).toEqual({
      total: 2501,
      sent: 1501,
      pending: 1000,
      firstSentAt: "2027-06-01T10:01:00.000Z",
      lastSentAt: "2027-06-01T10:02:00.000Z",
    });
    expect((await dpdp.breach.pending(first.id, 2)).map((n) => n.subjectId)).toEqual(["c1500", "c1501"]);
    expect((await dpdp.breach.list({ status: "open" })).map((b) => b.description)).toEqual(["Second", "First"]);

    await dpdp.breach.updateReport(first.id, { details: "d" });
    await dpdp.breach.close(second.id);
    expect((await dpdp.breach.get(first.id))!.report).toEqual({ details: "d" });
    expect((await dpdp.breach.list({ status: "open" })).map((b) => b.id)).toEqual([first.id]);
  });
});
