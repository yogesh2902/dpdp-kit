// SQLite end to end: dpdp-kit's records and the app's own tables in one node:sqlite database,
// from consent to erasure a year later, plus the data access on its own and through a Drizzle schema.
import { DatabaseSync } from "node:sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { drizzleSchema } from "../src/drizzle.js";
import { createDpdp } from "../src/index.js";
import { SQLITE_DDL, sqliteData, sqliteStore } from "../src/sqlite.js";
import { config } from "./fixtures/config.js";

const DAY = 24 * 60 * 60 * 1000;

function shop() {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_DDL);
  db.exec(`CREATE TABLE users (id text PRIMARY KEY, phone text, name text, interests text);
    CREATE TABLE orders (id integer PRIMARY KEY, user_id text, address text);
    CREATE TABLE analytics_events (id integer PRIMARY KEY, user_id text, device text);
    INSERT INTO users VALUES ('u1', '98xxxxxx01', 'Asha', 'cricket');
    INSERT INTO orders (user_id, address) VALUES ('u1', '12 MG Road');
    INSERT INTO analytics_events (user_id, device) VALUES ('u1', 'Pixel 7'), ('u1', 'iPad');`);
  return db;
}

describe("dpdp-kit on SQLite", () => {
  it("runs a year: consent, withdrawal, a correction, erasure on time, account deletion with a legal hold", async () => {
    const db = shop();
    let t = Date.parse("2026-11-21T10:00:00.000Z");
    const dpdp = createDpdp({ config, store: sqliteStore(db), data: sqliteData(db), now: () => new Date(t) });

    await dpdp.consent.grant("u1", ["order_updates", "marketing_sms", "analytics"], { language: "hi", channel: "android" });
    t += DAY;
    const { tasks } = await dpdp.consent.withdraw("u1", ["analytics"]);
    expect(tasks.map((x) => x.table)).toContain("events");

    const fix = await dpdp.rights.open("u1", "correction");
    await dpdp.rights.correct(fix.id, { "users.name": "Asha Patil" });
    expect((await dpdp.rights.summary("u1")).data.find((d) => d.key === "users")?.rows).toEqual([{ phone: "98xxxxxx01", name: "Asha Patil", interests: "cricket" }]);

    t += 400 * DAY; // past the 30 days for analytics, and past minimumRetention
    const run = await dpdp.retention.run();
    expect(run.failed).toEqual([]);
    expect(db.prepare("SELECT device FROM analytics_events").all()).toEqual([{ device: null }, { device: null }]);

    await dpdp.consent.withdraw("u1", ["marketing_sms"]);
    await dpdp.erasure.deleteAccount("u1");
    t += 400 * DAY;
    await dpdp.retention.run();
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT user_id, address FROM orders").all()).toEqual([{ user_id: "u1", address: "12 MG Road" }]); // GST records kept
    expect(await dpdp.consent.verify("u1")).toEqual({ ok: true, events: 3 });
  });

  it("reads, erases, corrects and deletes the person's rows, by database names or a Drizzle schema's", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE people (id text PRIMARY KEY, email text NOT NULL, prefs text, nick_name text, visits integer);
      CREATE TABLE addresses (id integer PRIMARY KEY, person_id text NOT NULL, line text NOT NULL);
      INSERT INTO people VALUES ('p1', 'old@example.in', '{"sms":true}', 'Pi', 3), ('p2', 'b@example.in', NULL, 'Bee', 1);
      INSERT INTO addresses VALUES (1, 'p1', '12 MG Road'), (2, 'p1', '13 MG Road');`);
    const people = sqliteTable("people", { id: text("id").primaryKey(), email: text("email").notNull(), prefs: text("prefs"), nickName: text("nick_name"), visits: integer("visits") });
    const data = sqliteData(db, { schema: drizzleSchema({ people }) });

    expect(await data.read("people", "id", "p1", ["email", "nickName", "visits"])).toEqual([{ email: "old@example.in", nickName: "Pi", visits: 3 }]);
    expect(await data.updateFields!("people", "id", "p1", { email: "new@example.in", prefs: { sms: false } })).toBe(1);
    expect(await data.read("people", "id", "p1", ["prefs"])).toEqual([{ prefs: '{"sms":false}' }]); // SQLite keeps JSON as text
    expect(await data.updateFields!("addresses", "person_id", "p1", { line: "14 MG Road" }, { id: 2 })).toBe(1);
    expect(db.prepare("SELECT line FROM addresses ORDER BY id").all()).toEqual([{ line: "12 MG Road" }, { line: "14 MG Road" }]);
    expect(await data.eraseFields("people", "id", "p1", ["email", "nickName"], { email: "erased-p1@invalid" })).toBe(1);
    expect(db.prepare("SELECT email, nick_name FROM people WHERE id = 'p1'").get()).toEqual({ email: "erased-p1@invalid", nick_name: null });
    expect(await data.deleteRows("addresses", "person_id", "p1")).toBe(2);
    expect(await data.read("people", "id", "p2", ["email"])).toEqual([{ email: "b@example.in" }]); // someone else's row untouched
  });
});
