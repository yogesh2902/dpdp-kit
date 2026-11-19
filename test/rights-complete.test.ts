// Sections 11 to 14 and Rule 14, end to end: acknowledging a request, checking who's asking,
// correcting data, nominations, and publishing how to make a request.
import { PGlite } from "@electric-sql/pglite";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataAccess } from "../src/data-access.js";
import { audit, createDpdp, type DpdpConfig, memoryData, memoryStore } from "../src/index.js";
import { mongoData, mongooseSchema } from "../src/mongodb.js";
import { config } from "./fixtures/config.js";
import { backends } from "./pg-backends.js";

const START = Date.parse("2026-11-19T10:00:00.000Z");

function setup(cfg: DpdpConfig<string> = config) {
  let t = START;
  const data = memoryData({
    users: [{ id: "u1", phone: "98xxxxxx01", name: "Asha", interests: "cricket" }],
    orders: [{ id: "o1", user_id: "u1", address: "12 MG Road" }],
    analytics_events: [
      { id: 1, user_id: "u1", device: "Pixel 7" },
      { id: 2, user_id: "u1", device: "iPad" },
    ],
  });
  const dpdp = createDpdp({ config: cfg, store: memoryStore(), data, now: () => new Date((t += 60_000)) });
  return { dpdp, data };
}
const verified = { ...config, rights: { ...config.rights, verify: "required" as const } };

describe("acknowledging a request", () => {
  it("gives the reference, the due date and the contact, in plain words", async () => {
    const { dpdp } = setup();
    const request = await dpdp.rights.open("u1", "correction", { field: "phone" });
    const ack = await dpdp.rights.acknowledgement(request.id);
    expect(ack).toMatchObject({ reference: request.id, type: "correction", receivedAt: request.openedAt, dueAt: request.dueAt });
    expect(ack.text).toBe(
      `We received your request to correct your personal data on 19 November 2026. Your reference is ${request.id}. ` +
        "We'll respond by 17 February 2027. Questions in the meantime: Meera Iyer, Data Protection Officer, privacy@acme.example, +91 80 4000 1234.",
    );
  });

  it("publishes how to make a request (Rule 14(1)) and how long answers take (Rule 14(3))", () => {
    const { dpdp } = setup({ ...config, rights: { ...config.rights, identifiers: ["registered mobile number"], responseWithin: { access: "30d" } } });
    expect(dpdp.rights.how()).toEqual({
      how: "In the app: Settings → Privacy, or email privacy@example.in",
      identifiers: ["registered mobile number"],
      responseWithin: { access: "30d", correction: "90d", erasure: "90d", grievance: "90d", nomination: "90d" },
      contact: config.fiduciary.dpo,
      grievanceUrl: config.fiduciary.grievanceUrl,
      verify: "optional",
    });
  });
});

describe("checking who's asking", () => {
  it("holds summaries, erasure and corrections for a request until identity is checked", async () => {
    const { dpdp } = setup(verified);
    const access = await dpdp.rights.open("u1", "access");
    await expect(dpdp.rights.summary("u1", { requestId: access.id })).rejects.toMatchObject({ code: "request-not-verified" });
    const erasure = await dpdp.rights.open("u1", "erasure");
    await expect(dpdp.rights.erase("u1", { requestId: erasure.id })).rejects.toMatchObject({ code: "request-not-verified" });
    const correction = await dpdp.rights.open("u1", "correction");
    await expect(dpdp.rights.correct(correction.id, { "users.phone": "98xxxxxx02" })).rejects.toMatchObject({ code: "request-not-verified" });

    const after = await dpdp.rights.verifyIdentity(access.id, { method: "OTP to registered mobile", by: "support:anita" });
    expect(after.history.at(-1)).toMatchObject({ event: "verified", method: "OTP to registered mobile", by: "support:anita", status: "open" });
    expect((await dpdp.rights.summary("u1", { requestId: access.id })).subjectId).toBe("u1");
    // Without a request (the person signed in and asking for themselves) nothing is held back.
    expect((await dpdp.rights.summary("u1")).subjectId).toBe("u1");
  });

  it("refuses a request for someone else, and a closed one, before scheduling anything", async () => {
    const { dpdp } = setup();
    const other = await dpdp.rights.open("u2", "erasure");
    await expect(dpdp.rights.summary("u1", { requestId: other.id })).rejects.toMatchObject({ code: "request-not-found" });
    const done = await dpdp.rights.open("u1", "erasure");
    await dpdp.rights.resolve(done.id, "Handled by phone", { by: "support:anita" });
    await expect(dpdp.rights.erase("u1", { requestId: done.id })).rejects.toMatchObject({ code: "request-closed" });
    expect(await dpdp.retention.tasks({ subjectId: "u1" })).toEqual([]); // 0.4 scheduled the tasks, then failed to close
    expect((await dpdp.rights.get(done.id))?.history.at(-1)).toMatchObject({ status: "resolved", by: "support:anita" });
  });

  it("needs a method and who checked", async () => {
    const { dpdp } = setup();
    const r = await dpdp.rights.open("u1", "access");
    await expect(dpdp.rights.verifyIdentity(r.id, { method: "", by: "x" })).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("correcting data (Section 12(2))", () => {
  it("writes the new values, records only which fields changed, and resolves the request", async () => {
    const { dpdp, data } = setup();
    const request = await dpdp.rights.open("u1", "correction", { note: "New number" });
    const { request: done, changed } = await dpdp.rights.correct(request.id, { "users.phone": "98xxxxxx02", "users.name": "Asha R." }, { by: "support:anita" });
    expect(changed).toEqual({ users: 1 });
    expect(data.tables.users).toEqual([{ id: "u1", phone: "98xxxxxx02", name: "Asha R.", interests: "cricket" }]);
    expect(done.status).toBe("resolved");
    expect(done.history.slice(1)).toEqual([
      expect.objectContaining({ event: "corrected", fields: ["users.phone", "users.name"], by: "support:anita" }),
      expect.objectContaining({ status: "resolved", note: "Corrected users.phone, users.name (1 row)", by: "support:anita" }),
    ]);
    expect(JSON.stringify(done)).not.toContain("98xxxxxx02"); // the new value isn't kept in the request
  });

  it("narrows to one row with where, and can leave the request open", async () => {
    const { dpdp, data } = setup();
    const request = await dpdp.rights.open("u1", "correction");
    const { changed, request: still } = await dpdp.rights.correct(request.id, { "events.device": "Pixel 8" }, { where: { id: 1 }, resolve: false });
    expect(changed).toEqual({ events: 1 });
    expect(data.tables.analytics_events!.map((r) => r.device)).toEqual(["Pixel 8", "iPad"]);
    expect(still.status).toBe("open");
  });

  it("refuses what it can't correct safely", async () => {
    const { dpdp } = setup();
    const request = await dpdp.rights.open("u1", "correction");
    await expect(dpdp.rights.correct(request.id, { "users.email": "x" })).rejects.toMatchObject({ code: "unknown-field" });
    await expect(dpdp.rights.correct(request.id, { "orders.address": "x" })).rejects.toMatchObject({ code: "not-correctable" }); // GST records
    await expect(dpdp.rights.correct(request.id, {})).rejects.toMatchObject({ code: "invalid-input" });
    await expect(dpdp.rights.correct(request.id, { "users.phone": "x", "events.device": "y" }, { where: { id: 1 } })).rejects.toMatchObject({ code: "invalid-input" });
    const access = await dpdp.rights.open("u1", "access");
    await expect(dpdp.rights.correct(access.id, { "users.phone": "x" })).rejects.toMatchObject({ code: "wrong-request-type" });
    const { updateFields: _, ...readOnly } = memoryData({});
    const noWrites = createDpdp({ config, store: memoryStore(), data: readOnly as DataAccess });
    const r2 = await noWrites.rights.open("u1", "correction");
    await expect(noWrites.rights.correct(r2.id, { "users.phone": "x" })).rejects.toMatchObject({ code: "data-access-unsupported" });
  });
});

describe("nominations (Section 14, Rule 14(4))", () => {
  it("records, lists and revokes nominees", async () => {
    const { dpdp } = setup();
    const ravi = await dpdp.rights.nominate("u1", { name: "Ravi", contact: "ravi@example.in", relation: "brother" });
    const meena = await dpdp.rights.nominate("u1", { name: "Meena", contact: "+91 98xxxxxx09" }, { by: "support:anita" });
    expect(await dpdp.rights.nominees("u1")).toEqual([
      { id: ravi.id, subjectId: "u1", name: "Ravi", contact: "ravi@example.in", relation: "brother", nominatedAt: ravi.nominatedAt },
      { id: meena.id, subjectId: "u1", name: "Meena", contact: "+91 98xxxxxx09", nominatedAt: meena.nominatedAt },
    ]);
    await dpdp.rights.revokeNominee("u1", ravi.id);
    expect((await dpdp.rights.nominees("u1")).map((n) => n.name)).toEqual(["Meena"]);
    expect((await dpdp.rights.get(ravi.id))?.history.at(-1)).toMatchObject({ event: "revoked" });
    await expect(dpdp.rights.revokeNominee("u2", meena.id)).rejects.toMatchObject({ code: "nominee-not-found" });
  });

  it("uses a verified nomination request when you pass one", async () => {
    const { dpdp } = setup(verified);
    const request = await dpdp.rights.open("u1", "nomination", { via: "letter" });
    await expect(dpdp.rights.nominate("u1", { name: "Ravi", contact: "ravi@example.in" }, { requestId: request.id })).rejects.toMatchObject({
      code: "request-not-verified",
    });
    await dpdp.rights.verifyIdentity(request.id, { method: "Signed letter, ID checked", by: "dpo" });
    const nominee = await dpdp.rights.nominate("u1", { name: "Ravi", contact: "ravi@example.in" }, { requestId: request.id });
    expect(nominee.id).toBe(request.id);
    expect((await dpdp.rights.get(request.id))?.details).toEqual({ via: "letter", name: "Ravi", contact: "ravi@example.in" });
  });
});

describe("auditing rights settings", () => {
  it("warns when how to make a request isn't published, without failing --strict in 0.5", () => {
    const { how: _, ...rest } = config.rights ?? {};
    const issue = audit({ ...config, rights: rest }).find((i) => i.code === "rights-how-missing");
    expect(issue).toMatchObject({ level: "warning", path: "rights.how", since: "0.5" });
  });

  it("rejects an unknown verify setting", () => {
    const bad = { ...config, rights: { ...config.rights, verify: "always" } } as unknown as DpdpConfig<string>;
    expect(audit(bad).map((i) => i.code)).toEqual(["invalid-rights-verify"]);
  });
});

// Every built-in data access writes corrections the same way.
async function updateContract(data: DataAccess) {
  expect(await data.updateFields!("people", "id", "p1", { email: "new@example.in", prefs: { sms: false } })).toBe(1);
  expect(await data.read("people", "id", "p1", ["email", "prefs", "nickname"])).toEqual([{ email: "new@example.in", prefs: { sms: false }, nickname: "Pi" }]);
  expect(await data.updateFields!("addresses", "person_id", "p1", { line: "14 MG Road" }, { id: 2 })).toBe(1);
  expect((await data.read("addresses", "person_id", "p1", ["line"])).map((r) => r.line).sort()).toEqual(["12 MG Road", "14 MG Road"]);
  expect(await data.updateFields!("people", "id", "p1", { nickname: null })).toBe(1);
  expect(await data.read("people", "id", "p1", ["nickname"])).toEqual([{ nickname: null }]);
  expect(await data.updateFields!("people", "id", "nobody", { email: "x" })).toBe(0);
}

describe("memory data access writes corrections", () => {
  it("updates the person's rows, or the ones where picks", async () => {
    await updateContract(
      memoryData({
        people: [{ id: "p1", email: "old@example.in", prefs: { sms: true }, nickname: "Pi" }],
        addresses: [
          { id: 1, person_id: "p1", line: "12 MG Road" },
          { id: 2, person_id: "p1", line: "13 MG Road" },
        ],
      }),
    );
  });
});

describe.each(backends)("$name data access writes corrections (Postgres via PGlite)", (backend) => {
  it("updates the person's rows, or the ones where picks", async () => {
    const client = new PGlite();
    await client.exec(`CREATE TABLE people (id text PRIMARY KEY, email text NOT NULL, prefs jsonb, nickname text);
      CREATE TABLE addresses (id integer PRIMARY KEY, person_id text NOT NULL, line text NOT NULL);
      INSERT INTO people VALUES ('p1', 'old@example.in', '{"sms": true}', 'Pi');
      INSERT INTO addresses VALUES (1, 'p1', '12 MG Road'), (2, 'p1', '13 MG Road');`);
    await updateContract(backend.data(client, {}));
    await client.close();
  });
});

describe("mongo data access writes corrections", () => {
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

  it("updates the person's documents, or the ones where picks", async () => {
    const db = client.db("corrections");
    await db.collection("people").insertOne({ id: "p1", email: "old@example.in", prefs: { sms: true }, nickname: "Pi" });
    await db.collection("addresses").insertMany([
      { id: 1, person_id: "p1", line: "12 MG Road" },
      { id: 2, person_id: "p1", line: "13 MG Road" },
    ]);
    await updateContract(mongoData(db));
  });

  it("refuses to correct a field inside an array", async () => {
    const db = client.db("arrays");
    const User = {
      modelName: "User",
      collection: { collectionName: "users" },
      schema: { paths: { _id: { instance: "ObjectId" }, addresses: { instance: "Array", schema: { paths: { phone: { instance: "String" } } } } }, virtuals: {} },
    };
    const data = mongoData(db, { schema: mongooseSchema([User]) });
    await expect(data.updateFields!("users", "_id", "u1", { "addresses.phone": "x" })).rejects.toMatchObject({ code: "not-correctable" });
  });
});
