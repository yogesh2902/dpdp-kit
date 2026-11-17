import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DPDP_DDL, drizzleStore } from "../src/drizzle.js";
import { createDpdp, SeqConflictError } from "../src/index.js";
import { config } from "./fixtures/config.js";

describe("drizzle store (Postgres via PGlite)", () => {
  const client = new PGlite();
  const db = drizzle(client);
  const store = drizzleStore(db);
  const dpdp = createDpdp({ config, store });

  beforeAll(async () => {
    await client.exec(DPDP_DDL);
  });
  afterAll(async () => {
    await client.close();
  });

  it("round-trips events so the chain still verifies", async () => {
    await dpdp.consent.grant("u1", ["analytics", "marketing_sms"], {
      noticeVersion: "2026-11",
      language: "ta",
      channel: "android",
      evidence: { ip: "203.0.113.7", ua: "Acme/1.0" },
    });
    await dpdp.consent.withdraw("u1", ["analytics"]);

    const history = await dpdp.consent.history("u1");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ language: "ta", evidence: { ip: "203.0.113.7", ua: "Acme/1.0" } });
    expect(history[1]).not.toHaveProperty("language");
    expect(await dpdp.consent.verify("u1")).toEqual({ ok: true, events: 2 });
    expect(await dpdp.consent.active("u1")).toEqual(["marketing_sms"]);
  });

  it("turns a duplicate (subject, seq) into SeqConflictError", async () => {
    const [first] = await dpdp.consent.history("u1");
    await expect(store.insert(first!)).rejects.toBeInstanceOf(SeqConflictError);
  });

  it("keeps one chain under concurrent writes", async () => {
    await Promise.all(Array.from({ length: 5 }, () => dpdp.consent.grant("u2", ["analytics"])));
    expect((await dpdp.consent.history("u2")).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(await dpdp.consent.verify("u2")).toEqual({ ok: true, events: 5 });
  });

  it("finds tampering done directly in the database", async () => {
    await client.query(`UPDATE dpdp_consent_events SET action = 'grant' WHERE subject_id = 'u1' AND seq = 2`);
    expect(await dpdp.consent.verify("u1")).toMatchObject({ ok: false, brokenAt: 2, reason: "hash-mismatch" });
  });
});
