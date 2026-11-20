// MySQL end to end on a real server, with the session in IST (+05:30): dpdp-kit's records and the
// app's own tables in one database, from consent to erasure a year later, plus the data access.
// Runs when DPDP_MYSQL_URL is set: CI runs MySQL 8.4; locally, e.g.
//   docker run -d -p 33061:3306 -e MYSQL_ROOT_PASSWORD=dpdp mysql:8.4 --default-time-zone=+05:30
//   DPDP_MYSQL_URL=mysql://root:dpdp@127.0.0.1:33061/mysql npx vitest run test/mysql-server.test.ts
import { int, mysqlTable, varchar, datetime } from "drizzle-orm/mysql-core";
import mysql from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import { drizzleSchema } from "../src/drizzle.js";
import { createDpdp } from "../src/index.js";
import { MYSQL_DDL, mysqlData, mysqlStore } from "../src/mysql.js";
import { config } from "./fixtures/config.js";

const URL_ = process.env.DPDP_MYSQL_URL;
const DAY = 24 * 60 * 60 * 1000;
const pools: mysql.Pool[] = [];

async function database(name: string) {
  const admin = await mysql.createConnection(URL_!);
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(URL_!);
  url.pathname = `/${name}`;
  const pool = mysql.createPool({ uri: url.toString(), timezone: "+05:30", multipleStatements: true });
  pools.push(pool);
  await pool.query("SET time_zone = '+05:30'");
  return pool;
}

describe.skipIf(!URL_)("dpdp-kit on a real MySQL server (IST)", () => {
  afterAll(async () => {
    for (const p of pools) await p.end();
  });

  it("runs a year: consent, withdrawal, a correction, erasure on time, account deletion with a legal hold", async () => {
    const db = await database(`dpdp_year_${process.pid}`);
    await db.query(MYSQL_DDL);
    await db.query(`CREATE TABLE users (id varchar(64) PRIMARY KEY, phone varchar(32), name varchar(255), interests varchar(255));
      CREATE TABLE orders (id int AUTO_INCREMENT PRIMARY KEY, user_id varchar(64), address varchar(255));
      CREATE TABLE analytics_events (id int AUTO_INCREMENT PRIMARY KEY, user_id varchar(64), device varchar(255));
      INSERT INTO users VALUES ('u1', '98xxxxxx01', 'Asha', 'cricket');
      INSERT INTO orders (user_id, address) VALUES ('u1', '12 MG Road');
      INSERT INTO analytics_events (user_id, device) VALUES ('u1', 'Pixel 7'), ('u1', 'iPad');`);
    let t = Date.parse("2026-11-21T00:00:00.000Z"); // 05:30 in IST: a shift would show
    const dpdp = createDpdp({ config, store: mysqlStore(db), data: mysqlData(db), now: () => new Date(t) });

    const granted = await dpdp.consent.grant("u1", ["order_updates", "marketing_sms", "analytics"], { language: "hi" });
    expect((await dpdp.consent.history("u1"))[0]).toEqual(granted); // exactly as written, time included
    t += DAY;
    await dpdp.consent.withdraw("u1", ["analytics"]);
    const fix = await dpdp.rights.open("u1", "correction");
    expect((await dpdp.rights.get(fix.id))?.openedAt).toBe(new Date(t).toISOString());
    await dpdp.rights.correct(fix.id, { "users.name": "Asha Patil" });
    const again = await dpdp.rights.open("u1", "correction");
    await dpdp.rights.correct(again.id, { "users.name": "Asha Patil" }); // the same value: still a match, not "no rows"

    t += 400 * DAY;
    expect((await dpdp.retention.run()).failed).toEqual([]);
    const [devices] = await db.query("SELECT device FROM analytics_events");
    expect(devices).toEqual([{ device: null }, { device: null }]);

    await dpdp.consent.withdraw("u1", ["marketing_sms"]);
    await dpdp.erasure.deleteAccount("u1");
    t += 400 * DAY;
    await dpdp.retention.run();
    const [users] = await db.query("SELECT count(*) AS n FROM users");
    expect(users).toEqual([{ n: 0 }]);
    const [orders] = await db.query("SELECT user_id, address FROM orders");
    expect(orders).toEqual([{ user_id: "u1", address: "12 MG Road" }]); // GST records kept
    expect(await dpdp.consent.verify("u1")).toEqual({ ok: true, events: 3 });
    const report = await dpdp.evidence({ from: new Date(Date.parse("2026-11-01T00:00:00Z")).toISOString(), to: new Date(t).toISOString() });
    expect(report.consent).toMatchObject({ events: 3, people: 1, byAction: { grant: 1, withdraw: 2 } });
  });

  it("reads, erases, corrects and deletes the person's rows, with dates read as stored", async () => {
    const db = await database(`dpdp_data_${process.pid}`);
    await db.query(`CREATE TABLE people (id varchar(64) PRIMARY KEY, email varchar(255) NOT NULL, prefs json, nick_name varchar(64), joined_at datetime(3));
      CREATE TABLE addresses (id int PRIMARY KEY, person_id varchar(64) NOT NULL, line varchar(255) NOT NULL);
      INSERT INTO people VALUES ('p1', 'old@example.in', '{"sms": true}', 'Pi', '2026-01-01 09:30:00.000'), ('p2', 'b@example.in', NULL, 'Bee', NULL);
      INSERT INTO addresses VALUES (1, 'p1', '12 MG Road'), (2, 'p1', '13 MG Road');`);
    const people = mysqlTable("people", { id: varchar("id", { length: 64 }).primaryKey(), email: varchar("email", { length: 255 }), nickName: varchar("nick_name", { length: 64 }), joinedAt: datetime("joined_at", { fsp: 3 }) });
    const addresses = mysqlTable("addresses", { id: int("id").primaryKey(), personId: varchar("person_id", { length: 64 }), line: varchar("line", { length: 255 }) });
    const data = mysqlData(db, { schema: drizzleSchema({ people, addresses }) });

    expect(await data.read("people", "id", "p1", ["email", "nickName", "joinedAt"])).toEqual([{ email: "old@example.in", nickName: "Pi", joinedAt: "2026-01-01 09:30:00.000" }]);
    expect(await data.updateFields!("people", "id", "p1", { email: "new@example.in", prefs: { sms: false } })).toBe(1);
    expect(await data.read("people", "id", "p1", ["prefs"])).toEqual([{ prefs: { sms: false } }]);
    expect(await data.updateFields!("addresses", "personId", "p1", { line: "14 MG Road" }, { id: 2 })).toBe(1);
    expect(await data.updateFields!("people", "id", "nobody", { email: "x" })).toBe(0);
    expect(await data.eraseFields("people", "id", "p1", ["email", "nickName"], { email: "erased-p1@invalid" })).toBe(1);
    expect(await data.read("people", "id", "p1", ["email", "nickName"])).toEqual([{ email: "erased-p1@invalid", nickName: null }]);
    expect(await data.deleteRows("addresses", "personId", "p1")).toBe(2);
    expect(await data.read("people", "id", "p2", ["email"])).toEqual([{ email: "b@example.in" }]);
  });
});
