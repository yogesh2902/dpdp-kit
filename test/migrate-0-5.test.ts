// Tables created by 0.4 only accept grant/withdraw. MIGRATE_0_5_DDL lets them record objections,
// keeps every existing event, and is safe to run twice or on a table that never had the constraint.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { DPDP_DDL, MIGRATE_0_5_DDL } from "../src/drizzle.js";
import { createDpdp, defineConfig } from "../src/index.js";
import { backends } from "./pg-backends.js";

const config = defineConfig({
  fiduciary: { name: "Chai & Co" },
  purposes: {
    receipts: { basis: "legitimate-use", legitimateUse: "7(a)", retain: "while-active" },
    offers: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },
  data: { users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: ["receipts", "offers"] } } } },
});

// The consent table exactly as 0.4's CONSENT_EVENTS_DDL created it.
const TABLE_0_4 = `CREATE TABLE dpdp_consent_events (
  subject_id text NOT NULL,
  seq integer NOT NULL,
  action text NOT NULL CHECK (action IN ('grant', 'withdraw')),
  purposes jsonb NOT NULL,
  notice_version text,
  language text,
  channel text,
  evidence jsonb,
  at timestamptz NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  PRIMARY KEY (subject_id, seq)
);`;
// drizzle-kit and Prisma tables from 0.4 had no CHECK at all.
const TABLE_NO_CHECK = TABLE_0_4.replace(" CHECK (action IN ('grant', 'withdraw'))", "");

describe.each(backends)("0.5 migration with the $name store", (backend) => {
  it.each([
    ["a 0.4 plain-SQL table", TABLE_0_4],
    ["a table with no constraint", TABLE_NO_CHECK],
  ])("upgrades %s and keeps its history", async (_, table) => {
    const client = new PGlite();
    await client.exec(table);
    await client.exec(DPDP_DDL); // the other tables; the consent table already exists
    const dpdp = createDpdp({ config, store: backend.store(client) });
    await dpdp.consent.grant("u1", ["offers"]);

    if (table === TABLE_0_4) await expect(dpdp.consent.object("u1", ["receipts"])).rejects.toThrow();
    await client.exec(MIGRATE_0_5_DDL);
    await client.exec(MIGRATE_0_5_DDL); // twice is fine

    await dpdp.consent.object("u1", ["receipts"]);
    await dpdp.consent.liftObjection("u1", ["receipts"]);
    expect((await dpdp.consent.history("u1")).map((e) => e.action)).toEqual(["grant", "object", "lift-objection"]);
    expect(await dpdp.consent.verify("u1")).toEqual({ ok: true, events: 3 });
    await expect(client.exec(`INSERT INTO dpdp_consent_events (subject_id, seq, action, purposes, at, hash) VALUES ('u2', 1, 'nonsense', '[]', now(), 'x')`)).rejects.toThrow(/dpdp_consent_events_action_check/);
    await client.close();
  });
});

it("new tables accept objections without the migration", async () => {
  const client = new PGlite();
  await client.exec(DPDP_DDL);
  const dpdp = createDpdp({ config, store: backends[1]!.store(client) });
  await dpdp.consent.object("u1", ["receipts"]);
  expect(await dpdp.consent.has("u1", "receipts")).toBe(false);
  await client.close();
});
