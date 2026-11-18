// Runs against a real Postgres server through node-postgres, when DPDP_PG_URL is set
// (CI starts one; locally: DPDP_PG_URL=postgres://user@127.0.0.1:5432/db pnpm test).
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DPDP_DDL, drizzleData, drizzleStore } from "../src/drizzle.js";
import { createDpdp, defineConfig } from "../src/index.js";

const url = process.env.DPDP_PG_URL;
const DAY = 24 * 60 * 60 * 1000;

const people = pgTable("pg_people", {
  id: text("id").primaryKey(),
  email: text("email"),
  nickname: text("nickname"),
  points: text("points"),
  city: text("city"),
});

const config = defineConfig({
  fiduciary: { name: "Acme", grievanceUrl: "/g" },
  purposes: {
    account: { basis: "legitimate-use", retain: "while-active" },
    promo: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },
  data: {
    people: {
      table: "pg_people",
      subject: "id",
      fields: {
        email: { category: "contact", purposes: ["promo"], erase: { value: ({ subjectId }) => `erased-${subjectId}@invalid` } },
        nickname: { category: "identity", purposes: ["promo"], erase: "redact" },
        points: { category: "behavioural", purposes: ["promo"], erase: { value: 0 } },
        city: { category: "contact", purposes: ["account"] },
      },
    },
  },
  minimumRetention: "1y",
  security: { accessControl: "x", backups: "x", measures: "x" },
});

describe.skipIf(!url)("on a real Postgres server (node-postgres)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  const db = drizzle(pool);
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  const now = () => new Date(t);
  const dpdp = createDpdp({ config, store: drizzleStore(db), data: drizzleData(db, { schema: { people } }), now });

  beforeAll(async () => {
    await pool.query("DROP TABLE IF EXISTS dpdp_consent_events, dpdp_requests, dpdp_erasure_tasks, dpdp_access_log, pg_people");
    await pool.query(DPDP_DDL);
    await pool.query(DPDP_DDL); // idempotent
    await pool.query(`CREATE TABLE pg_people (id text PRIMARY KEY, email text NOT NULL UNIQUE, nickname text NOT NULL, points integer NOT NULL, city text)`);
    await pool.query(`INSERT INTO pg_people SELECT 'p' || i, 'p' || i || '@example.com', 'nick' || i, i, 'Pune' FROM generate_series(1, 20) i`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("keeps one unbroken chain when one person's consent is written from many connections at once", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => (i % 2 ? dpdp.consent.withdraw("p1", ["promo"]) : dpdp.consent.grant("p1", ["promo"]))),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const history = await dpdp.consent.history("p1");
    expect(history.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await dpdp.consent.verify("p1")).toEqual({ ok: true, events: 6 });
  });

  it("erases NOT NULL and UNIQUE columns with their replacements, each task exactly once across racing runners", async () => {
    for (let i = 2; i <= 20; i++) {
      await dpdp.consent.grant(`p${i}`, ["promo"]);
      await dpdp.consent.withdraw(`p${i}`, ["promo"]);
    }
    t += 400 * DAY;
    const reports = await Promise.all([dpdp.retention.run(), dpdp.retention.run(), dpdp.retention.run()]);
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    const done = reports.flatMap((r) => r.done);
    expect(new Set(done).size).toBe(done.length); // nothing ran twice
    const { rows } = await pool.query("SELECT id, email, nickname, points, city FROM pg_people WHERE id IN ('p2', 'p20') ORDER BY id");
    expect(rows).toEqual([
      { id: "p2", email: "erased-p2@invalid", nickname: "[erased]", points: 0, city: "Pune" },
      { id: "p20", email: "erased-p20@invalid", nickname: "[erased]", points: 0, city: "Pune" },
    ]);
  });

  it("keeps the access log in write order and prunes it in batches", async () => {
    for (const actor of ["a", "b", "c", "d"]) await dpdp.access.log({ actor, subjectId: "p1", purpose: "account", fields: ["people.city"] });
    expect((await dpdp.access.list({ subjectId: "p1" })).map((e) => e.actor)).toEqual(["a", "b", "c", "d"]);

    await pool.query(`
      INSERT INTO dpdp_access_log (id, at, actor, subject_id, action, purpose)
      SELECT 'old-' || i, now() - interval '3 years', 'job', 'p' || (i % 20), 'read', 'account' FROM generate_series(1, 12000) i`);
    t = Date.now();
    const { deleted } = await dpdp.access.prune();
    expect(deleted).toBe(12000);
    expect(await dpdp.access.list({ actor: "job" })).toEqual([]);
    expect(await dpdp.access.list({ subjectId: "p1" })).toHaveLength(4); // recent entries stay
  });

  it("reviews access against the consent history stored in Postgres", async () => {
    await dpdp.consent.grant("p3", ["promo"]);
    t += 60_000;
    await dpdp.access.log({ actor: "crm", subjectIds: ["p3", "p4"], purpose: "promo" });
    const { findings } = await dpdp.access.review({ from: new Date(t - 1000).toISOString() });
    expect(findings.map((f) => `${f.kind}:${f.subjectId}`)).toEqual(["no-consent:p4"]);
  });

  it("daily() runs every step against the server", async () => {
    const report = await dpdp.daily();
    expect(report.errors).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});
