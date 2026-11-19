// The evidence report: built from the config alone, and from a store with a month of records;
// the database counts agree with counting in memory on every built-in store.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DPDP_DDL } from "../src/drizzle.js";
import { type ConsentStore, createDpdp, type DpdpConfig, formatEvidence, isUnavailable, memoryData, memoryStore, staticEvidence, type StatsStore } from "../src/index.js";
import { mongoStore } from "../src/mongodb.js";
import { runEvidence } from "../src/run-audit.js";
import { config } from "./fixtures/config.js";
import { backends } from "./pg-backends.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-01T10:00:00.000Z");

/** A month at Acme: consents, a withdrawal, requests, an out-of-purpose read and a breach. */
async function aMonth(store: Parameters<typeof createDpdp>[0]["store"]) {
  let t = START;
  const data = memoryData({ users: [{ id: "u1", phone: "98xxxxxx01", name: "Asha", interests: "cricket" }] });
  const dpdp = createDpdp({ config, store, data, now: () => new Date(t) });
  const at = (days: number) => {
    t = START + days * DAY;
  };
  await dpdp.consent.grant("u1", ["order_updates", "marketing_sms"]);
  await dpdp.consent.grant("u2", ["analytics"]);
  at(2);
  await dpdp.consent.withdraw("u1", ["marketing_sms"]);
  const late = await dpdp.rights.open("u1", "grievance");
  await dpdp.rights.open("u2", "access");
  at(5);
  await dpdp.access.log({ actor: "growth", subjectId: "u1", purpose: "analytics", fields: ["users.phone"] }); // phone isn't held for analytics
  await dpdp.breach.open({ description: "Laptop lost", fields: ["users.phone"] });
  at(20);
  await dpdp.rights.resolve(late.id, "Answered");
  at(29);
  return Object.assign(dpdp, { at });
}

describe("evidence from the config alone", () => {
  it("lists the data map, processors, safeguards and Rule 14 information, and what needs attention", () => {
    const report = staticEvidence(config, "2026-12-01T00:00:00.000Z");
    expect(report.period).toBeUndefined();
    expect(report.purposes.find((p) => p.purpose === "marketing_sms")).toEqual({ purpose: "marketing_sms", basis: "consent", retain: "until consent is withdrawn" });
    expect(report.processors).toContainEqual({ name: "posthog", purposes: ["analytics"], contract: "PostHog DPA, section 4", countries: ["US"] });
    expect(report.rights.how).toBe(config.rights?.how);
    expect(report.gaps).toEqual(["Rule 6(1)(a) Encryption, obfuscation, masking or virtual tokens: not recorded"]);
    const md = formatEvidence(report);
    expect(md).toContain("# DPDP Act evidence: Acme Pvt Ltd");
    expect(md).toContain("from the configuration only");
    expect(md).toContain("| posthog | analytics | PostHog DPA, section 4 | US |");
    expect(md).not.toContain("## Consent"); // no records in a static report
  });

  it("escapes pipes in table cells", () => {
    const c = { ...config, processors: { ...config.processors, posthog: { purposes: ["analytics"], contract: "DPA | annex 2" } } };
    expect(formatEvidence(staticEvidence(c as unknown as DpdpConfig<string>))).toContain("DPA \\| annex 2");
  });
});

describe("evidence from the records", () => {
  it("counts the month and says what needs attention", async () => {
    const dpdp = await aMonth(memoryStore());
    const report = await dpdp.evidence();
    expect(report.period).toEqual({ from: "2026-10-31T10:00:00.000Z", to: "2026-11-30T10:00:00.000Z" });
    expect(report.consent).toMatchObject({ events: 3, people: 2, byAction: { grant: 2, withdraw: 1 }, grantedNow: { order_updates: 1, analytics: 1 } });
    expect(report.requests).toEqual({ opened: { grievance: 1, access: 1 }, closed: 1, closedLate: 0, byStatus: { resolved: 1, open: 1 }, overdue: 0 });
    expect(report.erasure).toMatchObject({ byStatus: expect.objectContaining({ pending: expect.any(Number) }) });
    expect(report.access).toMatchObject({ scanned: 1, findings: { "out-of-purpose": 1, "no-consent": 1 } });
    expect(isUnavailable(report.breaches)).toBe(false);
    expect((report.breaches as { status: string }[])[0]).toMatchObject({ status: "open", boardNotified: false });
    expect(report.gaps).toEqual(
      expect.arrayContaining([
        "2 access review finding(s) in the period", // out of purpose, and analytics without consent
        "1 erasure task(s) past their due date: is the retention runner running?",
        expect.stringMatching(/^Breach .+: The detailed report to the Board was due 504 hours ago/),
      ]),
    );
    const md = formatEvidence(report);
    expect(md).toContain("for 2026-10-31 to 2026-11-30");
    expect(md).toContain("3 consent event(s) from 2 person(s) in the period: grant: 2, withdraw: 1.");
    expect(md).toContain("| marketing_sms | grant: 1, withdraw: 1 | 0 | 0 |");
    expect(md).toContain("## Breaches (Section 8(6), Rule 7)");
  });

  it("reads from and to as instants, whatever offset they're written with", async () => {
    const dpdp = await aMonth(memoryStore());
    const utc = await dpdp.evidence({ from: "2026-11-01T04:30:00Z", to: "2026-11-01T11:00:00Z" });
    const ist = await dpdp.evidence({ from: "2026-11-01T10:00:00+05:30", to: "2026-11-01T16:30:00+05:30" });
    expect(ist.period).toEqual(utc.period);
    expect(ist.consent).toEqual(utc.consent);
    expect(ist.requests).toEqual(utc.requests);
  });

  it("counts overdue requests as of now", async () => {
    const dpdp = await aMonth(memoryStore());
    dpdp.at(200); // the access request was due on day 92
    const later = await dpdp.evidence({ from: new Date(START).toISOString() });
    expect(later.gaps).toContain("1 rights request(s) open past their due date");
  });

  it("says what a store without records can't provide", async () => {
    const events = memoryStore();
    const minimal: ConsentStore = { lastEvent: events.lastEvent, insert: events.insert, events: events.events };
    const report = await createDpdp({ config, store: minimal }).evidence();
    expect(report.consent).toEqual({ unavailable: "the store can't count consent events (add consentStats)" });
    expect(report.requests).toEqual({ unavailable: "the store doesn't keep rights requests" });
    expect(formatEvidence(report)).toContain("_Not available: the store doesn't keep breaches._");
  });
});

describe("dpdp-kit evidence", () => {
  it("prints Markdown, or writes JSON to a file", async () => {
    const fixtures = join(import.meta.dirname, "fixtures");
    const lines: string[] = [];
    expect(await runEvidence(["--config", "config.ts"], fixtures, (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toContain("## Security safeguards (Rule 6(1))");
    const out = join(mkdtempSync(join(tmpdir(), "dpdp-kit-")), "evidence.json");
    expect(await runEvidence(["--config", "config.ts", "--static", "--format", "json", "--out", out], fixtures, () => {})).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).fiduciary.name).toBe("Acme Pvt Ltd");
    expect(await runEvidence(["--config", "config.ts", "--format", "pdf"], fixtures, () => {})).toBe(1);
  });
});

// The database counts must agree with counting the same events in memory.
async function sameCounts(store: StatsStore & Parameters<typeof createDpdp>[0]["store"]) {
  const reference = memoryStore();
  await aMonth(reference);
  await aMonth(store);
  const from = new Date(START - DAY).toISOString();
  const to = new Date(START + 30 * DAY).toISOString();
  const now = new Date(START + 29 * DAY).toISOString();
  expect(await store.consentStats(from, to)).toEqual(await reference.consentStats(from, to));
  const objectedLater = await store.consentStats(from, new Date(START + 3 * DAY).toISOString());
  expect(objectedLater.events).toBe(3); // the period cuts off at its end
  expect(await store.taskCounts(now)).toEqual(await reference.taskCounts(now));
}

describe.each(backends)("$name store counts in the database (Postgres via PGlite)", (backend) => {
  it("agrees with counting in memory", async () => {
    const client = new PGlite();
    await client.exec(DPDP_DDL);
    await sameCounts(backend.store(client) as never);
    await client.close();
  });
});

describe("mongo store counts in the database", () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
  }, 120_000);
  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });
  it("agrees with counting in memory", async () => {
    await sameCounts(mongoStore(client.db("evidence")));
  });
});
