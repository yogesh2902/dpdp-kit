// Runs against a real Postgres server through node-postgres, when DPDP_PG_URL is set
// (CI starts one; locally: DPDP_PG_URL=postgres://user@127.0.0.1:5432/db pnpm test).
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DPDP_DDL, drizzleData, drizzleStore } from "../src/drizzle.js";
import { buildNotice, createDpdp, defineConfig } from "../src/index.js";
import { postgresStore } from "../src/postgres.js";

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
    await pool.query("DROP TABLE IF EXISTS dpdp_consent_events, dpdp_requests, dpdp_erasure_tasks, dpdp_access_log, dpdp_breaches, dpdp_breach_notices, dpdp_privacy_notices, pg_people");
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

  it("records a breach, its affected people and notices", async () => {
    const breach = await dpdp.breach.open({ description: "Exposed export", fields: ["people.email"] });
    expect(await dpdp.breach.addAffectedFromAccessLog(breach.id, { actor: "crm" })).toBe(2);
    expect(await dpdp.breach.markNotified(breach.id, ["p3"], { channel: "email" })).toBe(1);
    expect((await dpdp.breach.boardReport(breach.id)).intimations).toMatchObject({ total: 2, sent: 1, pending: 1 });
  });

  it("daily() runs every step against the server", async () => {
    const report = await dpdp.daily();
    expect(report.errors).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("keeps notice snapshots exactly, on a server set to Asia/Kolkata", async () => {
    const ist = new pg.Pool({ connectionString: url, max: 2, options: "-c TimeZone=Asia/Kolkata" });
    const withNotice = { ...config, purposes: { ...config.purposes, promo: { ...config.purposes.promo, description: "Offers by email" } }, notice: { links: { website: "https://acme.example", withdraw: "Settings", rights: "https://acme.example/rights" } } };
    const notice = buildNotice(withNotice);
    for (const store of [drizzleStore(drizzle(ist)), postgresStore(async (text, params) => (await ist.query(text, [...params])).rows)]) {
      await ist.query("DELETE FROM dpdp_privacy_notices");
      expect(await store.savePrivacyNotice(notice, "2026-12-01T10:00:00.123Z")).toBe(true);
      expect(await store.savePrivacyNotice(notice, "2026-12-02T10:00:00.000Z")).toBe(false);
      expect(await store.getPrivacyNotice(notice.version, "en", "consent")).toEqual({ notice, firstShownAt: "2026-12-01T10:00:00.123Z" });
      expect(await store.listPrivacyNotices()).toHaveLength(1);
    }
    // And through createDpdp: the grant records the version saved.
    const d = createDpdp({ config: withNotice, store: drizzleStore(drizzle(ist)) });
    const event = await d.consent.grant("n1", ["promo"]);
    expect(event.noticeVersion).toBe(notice.version);
    await ist.end();
  });
});
