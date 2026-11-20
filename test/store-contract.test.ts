// One set of tests for every store method, run on every built-in store, so a new store (or a
// change to one) can't quietly behave differently: memory, Postgres three ways (PGlite), MongoDB and
// SQLite (node:sqlite, and through the better-sqlite3 and libsql adapter shapes), and a real MySQL
// server when DPDP_MYSQL_URL is set (CI runs one with its session in IST).
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessEntry, AccessLogStore } from "../src/access.js";
import type { Breach, BreachStore } from "../src/breach.js";
import { DPDP_DDL } from "../src/ddl.js";
import { SeqConflictError } from "../src/errors.js";
import { memoryStore } from "../src/index.js";
import { mongoStore } from "../src/mongodb.js";
import { MYSQL_DDL, mysqlStore } from "../src/mysql.js";
import type { NoticeStore, PrivacyNotice } from "../src/notice.js";
import type { ErasureTask, RightsRequest } from "../src/records.js";
import { SQLITE_DDL, sqliteStore } from "../src/sqlite.js";
import type { StatsStore } from "../src/stats.js";
import type { ConsentEvent, DpdpStore } from "../src/store.js";
import { backends } from "./pg-backends.js";

type FullStore = DpdpStore & AccessLogStore & BreachStore & NoticeStore & StatsStore;

const T = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 10, 0) + minutes * 60_000).toISOString();

const event = (subjectId: string, seq: number, extra: Partial<ConsentEvent> = {}): ConsentEvent => ({
  subjectId,
  seq,
  action: "grant",
  purposes: ["offers"],
  at: T(seq),
  prevHash: seq === 1 ? null : `h${seq - 1}`,
  hash: `h${seq}`,
  ...extra,
});
const request = (id: string, subjectId: string, minute: number, extra: Partial<RightsRequest> = {}): RightsRequest => ({
  id,
  subjectId,
  type: "access",
  status: "open",
  openedAt: T(minute),
  dueAt: T(minute + 90 * 24 * 60),
  history: [{ at: T(minute), status: "open" }],
  ...extra,
});
const task = (id: string, subjectId: string, dueMinute: number, extra: Partial<ErasureTask> = {}): ErasureTask => ({
  id,
  subjectId,
  reason: "withdrawal",
  kind: "erase-fields",
  table: "users",
  fields: ["interests"],
  createdAt: T(0),
  dueAt: T(dueMinute),
  status: "pending",
  attempts: 0,
  ...extra,
});
const access = (id: string, minute: number, extra: Partial<AccessEntry> = {}): AccessEntry => ({
  id,
  at: T(minute),
  actor: "support:anita",
  subjectId: "u1",
  action: "read",
  purpose: "account",
  fields: ["users.phone"],
  ...extra,
});
const breach = (id: string, minute: number, extra: Partial<Breach> = {}): Breach =>
  ({
    id,
    description: "Laptop lost",
    fields: ["users.phone"],
    awareAt: T(minute),
    reportDueAt: T(minute + 72 * 60),
    report: {},
    status: "open",
    history: [{ at: T(minute), event: "opened" }],
    ...extra,
  }) as Breach;
const notice = (version: string, language: "en" | "hi" = "en"): PrivacyNotice => ({
  version,
  language,
  kind: "consent",
  fiduciary: "Chai & Co",
  items: [{ purpose: "offers", description: "Offers by SMS", data: [{ label: "Mobile number", category: "contact", fields: ["users.phone"] }] }],
  links: { website: "https://chai.example", withdraw: "Settings", rights: "https://chai.example/privacy" },
  text: "Privacy notice: Chai & Co",
});

function contract(make: () => Promise<FullStore>) {
  it("consent events: in order, exactly as saved, and a second event at the same seq refused", async () => {
    const store = await make();
    const first = event("u1", 1, { noticeVersion: "abc123", language: "hi", channel: "web", evidence: { ip: "10.0.0.1", userAgent: "x" } });
    const second = event("u1", 2, { action: "object", purposes: ["receipts", "offers"] });
    await store.insert(first);
    await store.insert(second);
    await store.insert(event("u2", 1));
    expect(await store.events("u1")).toEqual([first, second]);
    expect(await store.lastEvent("u1")).toEqual(second);
    expect(await store.lastEvent("nobody")).toBeUndefined();
    await expect(store.insert(event("u1", 2, { hash: "other" }))).rejects.toBeInstanceOf(SeqConflictError);
  });

  it("rights requests: saved, updated and listed by person and status, oldest first", async () => {
    const store = await make();
    const a = request("r1", "u1", 0, { details: { note: "New number" } });
    await store.insertRequest(a);
    await store.insertRequest(request("r2", "u2", 5));
    await store.insertRequest(request("r3", "u1", 10, { type: "erasure" }));
    expect(await store.getRequest("r1")).toEqual(a);
    const closed: RightsRequest = { ...a, status: "resolved", closedAt: T(60), history: [...a.history, { at: T(60), status: "resolved", note: "Done", by: "anita" }] };
    await store.updateRequest(closed);
    expect(await store.getRequest("r1")).toEqual(closed);
    expect((await store.listRequests({ subjectId: "u1" })).map((r) => r.id)).toEqual(["r1", "r3"]);
    expect((await store.listRequests({ status: "open" })).map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(await store.getRequest("nope")).toBeUndefined();
  });

  it("erasure tasks: due ones in order, claimed once, failed ones retried up to the limit, stale ones taken over", async () => {
    const store = await make();
    const now = T(100);
    const opts = { now, staleBefore: T(40), maxAttempts: 5, limit: 10 };
    await store.insertTasks([
      task("t1", "u1", 50, { purposes: ["receipts"], reason: "objection" }),
      task("t2", "u1", 20),
      task("t3", "u2", 200), // not due yet
      task("t4", "u2", 30, { status: "failed", attempts: 2, lastError: "timeout" }),
      task("t5", "u2", 30, { status: "failed", attempts: 5 }), // out of attempts
      task("t6", "u3", 10, { status: "running", claimedAt: T(30) }), // runner died
      task("t7", "u3", 10, { status: "running", claimedAt: T(90) }), // still running
      task("t8", "u3", 10, { status: "cancelled" }),
    ]);
    expect((await store.dueTasks(opts)).map((t) => t.id)).toEqual(["t6", "t2", "t4", "t1"]);
    expect(await store.getTask("t1")).toEqual(task("t1", "u1", 50, { purposes: ["receipts"], reason: "objection" }));

    // Several runners at once: exactly one gets the task.
    const claims = await Promise.all([1, 2, 3].map(() => store.claimTask({ id: "t2", now, staleBefore: T(40), maxAttempts: 5 })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimTask({ id: "t3", now, staleBefore: T(40), maxAttempts: 5 })).toBe(false);
    expect(await store.claimTask({ id: "t6", now, staleBefore: T(40), maxAttempts: 5 })).toBe(true);
    expect((await store.getTask("t2"))?.status).toBe("running");

    const done: ErasureTask = { ...(await store.getTask("t2"))!, status: "done", doneAt: T(101), affected: 3 };
    await store.updateTask(done);
    expect(await store.getTask("t2")).toEqual(done);
    expect((await store.listTasks({ subjectId: "u3" })).map((t) => t.id).sort()).toEqual(["t6", "t7", "t8"]);
    expect((await store.listTasks({ status: "cancelled" })).map((t) => t.id)).toEqual(["t8"]);
    expect((await store.taskCounts(now)).byStatus).toMatchObject({ pending: 2, done: 1, failed: 2, running: 2, cancelled: 1 });
  });

  it("access log: listed by person, actor, purpose and time, limited, and pruned", async () => {
    const store = await make();
    await store.insertAccess([
      access("a1", 0, { outOfPurpose: ["users.interests"], reason: "ticket 42", evidence: { ip: "10.0.0.2" } }),
      access("a2", 10, { actor: "job:export", subjectId: "u2", action: "export" }),
      access("a3", 20, { purpose: "marketing_sms" }),
    ]);
    expect(await store.listAccess({ subjectId: "u1" })).toEqual([
      access("a1", 0, { outOfPurpose: ["users.interests"], reason: "ticket 42", evidence: { ip: "10.0.0.2" } }),
      access("a3", 20, { purpose: "marketing_sms" }),
    ]);
    expect((await store.listAccess({ actor: "job:export" })).map((e) => e.id)).toEqual(["a2"]);
    expect((await store.listAccess({ purpose: "marketing_sms" })).map((e) => e.id)).toEqual(["a3"]);
    expect((await store.listAccess({ from: T(5), to: T(20) })).map((e) => e.id)).toEqual(["a2"]);
    expect((await store.listAccess({ limit: 2 })).map((e) => e.id)).toEqual(["a1", "a2"]);
    expect((await store.accessSubjects!({ from: T(0), to: T(30) })).sort()).toEqual(["u1", "u2"]);
    expect(await store.pruneAccess(T(15))).toBe(2);
    expect((await store.listAccess({})).map((e) => e.id)).toEqual(["a3"]);
  });

  it("breaches: saved over only the version that was read; notices added once, marked and counted", async () => {
    const store = await make();
    const b = breach("b1", 0);
    await store.insertBreach(b);
    await store.insertBreach(breach("b2", 60, { status: "closed", closedAt: T(120) }));
    expect(await store.getBreach("b1")).toEqual(b);
    const next: Breach = { ...b, boardNotifiedAt: T(5), history: [...b.history, { at: T(5), event: "board-notified" }] };
    expect(await store.updateBreach(next)).toBe(true);
    expect(await store.updateBreach({ ...b, history: [...b.history, { at: T(6), event: "stale" }] })).toBe(false); // read before the first save
    expect(await store.getBreach("b1")).toEqual(next);
    expect((await store.listBreaches({})).map((x) => x.id)).toEqual(["b2", "b1"]);
    expect((await store.listBreaches({ status: "open" })).map((x) => x.id)).toEqual(["b1"]);

    const added = (s: string, m: number) => ({ breachId: "b1", subjectId: s, status: "pending" as const, addedAt: T(m) });
    expect(await store.addNotices([added("u1", 1), added("u2", 2), added("u3", 3)])).toBe(3);
    expect(await store.addNotices([added("u2", 4), added("u4", 4)])).toBe(1); // u2 is already there
    expect(await store.markNotices("b1", ["u1", "u2", "nobody"], T(10), "sms")).toBe(2);
    expect(await store.markNotices("b1", ["u1"], T(11), "sms")).toBe(0); // already sent
    expect((await store.listNotices("b1", { status: "pending" })).map((n) => n.subjectId)).toEqual(["u3", "u4"]);
    expect(await store.listNotices("b1", { status: "sent", limit: 1 })).toEqual([{ ...added("u1", 1), status: "sent", sentAt: T(10), channel: "sms" }]);
    expect(await store.countNotices("b1")).toEqual({ total: 4, sent: 2, firstSentAt: T(10), lastSentAt: T(10) });
    expect(await store.countNotices("b2")).toEqual({ total: 0, sent: 0 });
  });

  it("privacy notices: saved once per version, language and kind, read back exactly", async () => {
    const store = await make();
    expect(await store.savePrivacyNotice(notice("v1"), T(0))).toBe(true);
    expect(await store.savePrivacyNotice(notice("v1"), T(5))).toBe(false);
    expect(await store.savePrivacyNotice(notice("v1", "hi"), T(10))).toBe(true);
    expect(await store.getPrivacyNotice("v1", "en", "consent")).toEqual({ notice: notice("v1"), firstShownAt: T(0) });
    expect(await store.getPrivacyNotice("v1", "en", "existing-users")).toBeUndefined();
    expect((await store.listPrivacyNotices()).map((n) => `${n.notice.language}@${n.firstShownAt}`)).toEqual([`en@${T(0)}`, `hi@${T(10)}`]);
  });

  it("consent counts: the same as counting in memory", async () => {
    const store = await make();
    const reference = memoryStore();
    const events = [
      event("u1", 1),
      event("u1", 2, { action: "withdraw" }),
      event("u2", 1, { purposes: ["offers", "analytics"] }),
      event("u2", 2, { action: "object", purposes: ["receipts"] }),
      event("u3", 1, { at: T(500) }),
    ];
    for (const e of events) {
      await store.insert(e);
      await reference.insert(e);
    }
    expect(await store.consentStats(T(0), T(100))).toEqual(await reference.consentStats(T(0), T(100)));
  });
}

describe("memory store", () => contract(async () => memoryStore()));

describe.each(backends)("$name store (Postgres via PGlite)", (backend) => {
  const clients: PGlite[] = [];
  afterAll(async () => {
    for (const c of clients) await c.close();
  });
  contract(async () => {
    const client = new PGlite();
    clients.push(client);
    await client.exec(DPDP_DDL);
    return backend.store(client) as FullStore;
  });
});

describe("mongo store", () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let n = 0;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
  }, 120_000);
  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });
  contract(async () => mongoStore(client.db(`contract${++n}`)));
});

/** A fresh in-memory SQLite database with the tables. */
function sqlite() {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_DDL);
  return db;
}

describe("sqlite store (node:sqlite)", () => contract(async () => sqliteStore(sqlite())));

describe("sqlite store through a better-sqlite3-shaped database", () =>
  contract(async () => {
    const db = sqlite();
    // better-sqlite3 refuses all() on a statement that returns nothing and says so with `reader`.
    return sqliteStore({
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        const reader = stmt.columns().length > 0;
        return {
          reader,
          all: (...p: unknown[]) => {
            if (!reader) throw new TypeError("This statement does not return data. Use run() instead");
            return stmt.all(...(p as never[]));
          },
          run: (...p: unknown[]) => stmt.run(...(p as never[])),
        };
      },
    });
  }));

describe("sqlite store through a libsql-shaped client", () =>
  contract(async () => {
    const db = sqlite();
    // libsql answers rows as arrays, with the column names alongside.
    return sqliteStore({
      async execute({ sql, args }) {
        const stmt = db.prepare(sql);
        const columns = stmt.columns().map((c) => c.name);
        const rows = (stmt.all(...(args as never[])) as Record<string, unknown>[]).map((r) => columns.map((c) => r[c]));
        return { rows, columns };
      },
    });
  }));

const MYSQL = process.env.DPDP_MYSQL_URL;
describe.skipIf(!MYSQL)("mysql store (real server)", () => {
  const pools: mysql.Pool[] = [];
  let n = 0;
  afterAll(async () => {
    for (const p of pools) await p.end();
  });
  contract(async () => {
    const admin = await mysql.createConnection(MYSQL!);
    const name = `dpdp_contract_${process.pid}_${++n}`;
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(MYSQL!);
    url.pathname = `/${name}`;
    // The session runs in IST, as many Indian servers do: nothing may shift by +05:30.
    const pool = mysql.createPool({ uri: url.toString(), timezone: "+05:30" });
    pools.push(pool);
    await pool.query("SET time_zone = '+05:30'");
    for (const statement of MYSQL_DDL.split(/;\n/)) await pool.query(statement);
    return mysqlStore(pool);
  });
});
