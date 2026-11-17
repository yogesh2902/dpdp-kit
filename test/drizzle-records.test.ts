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
