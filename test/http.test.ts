// The HTTP API end to end: the same journey over real Express (with and without express.json()),
// Hono and the Next.js handlers, then the safety rules on the core handler.
import type { AddressInfo } from "node:net";
import express from "express";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dpdpRouter } from "../src/express.js";
import { dpdpRoutes } from "../src/hono.js";
import { createDpdp, defineConfig, handle, memoryData, memoryStore } from "../src/index.js";
import { createHandlers } from "../src/next.js";

const config = defineConfig({
  fiduciary: { name: "Chai & Co", grievanceUrl: "https://chai.example/grievance", dpo: "privacy@chai.example" },
  purposes: {
    account: { basis: "legitimate-use", legitimateUse: "7(i)", retain: "while-active" },
    receipts: { basis: "legitimate-use", legitimateUse: "7(a)", retain: "while-active", description: "SMS receipts" },
    offers: { basis: "consent", retain: { afterWithdrawal: "0d" }, description: "Offers by SMS" },
  },
  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        name: { category: "identity", purposes: ["account"], label: "Name" },
        phone: { category: "contact", purposes: ["account", "receipts", "offers"], label: "Mobile number" },
      },
    },
  },
  notice: { links: { website: "https://chai.example/privacy", withdraw: "Settings → Privacy", rights: "https://chai.example/privacy" } },
  rights: { how: "Settings → Privacy, or email privacy@chai.example" },
  minimumRetention: "1y",
  security: { accessControl: "SSO", backups: "Daily", measures: "Training" },
});

function makeDpdp() {
  const data = memoryData({ users: [{ id: "u1", name: "Asha", phone: "98xxxxxx01" }] });
  return { dpdp: createDpdp({ config, store: memoryStore(), data }), data };
}

type Call = (
  method: string,
  path: string,
  opts?: { body?: unknown; raw?: string; user?: string; staff?: string; contentType?: string },
) => Promise<{ status: number; body: any }>;

/** What a privacy centre does, through whichever adapter `call` goes through. */
async function journey(call: Call, data: ReturnType<typeof memoryData>) {
  const notice = await call("GET", "/notice");
  expect(notice.status).toBe(200);
  expect(notice.body.items.map((i: { purpose: string }) => i.purpose)).toEqual(["offers"]);
  expect((await call("GET", "/rights")).body.how).toBe("Settings → Privacy, or email privacy@chai.example");

  expect(await call("GET", "/consents")).toEqual({ status: 401, body: { error: "unauthenticated" } });
  const granted = await call("POST", "/consents", { user: "u1", body: { purposes: ["offers"] } });
  expect(granted.status).toBe(201);
  expect(granted.body.event).toMatchObject({ subjectId: "u1", action: "grant", noticeVersion: notice.body.version, channel: "web" });
  expect(granted.body.event.evidence.userAgent).toBeTruthy();
  expect((await call("POST", "/consents", { user: "u1", body: { purposes: ["account"] } })).body).toEqual({ error: "not-a-consent-purpose" });
  expect((await call("POST", "/consents", { user: "u1", contentType: "text/plain", raw: '{"purposes":["offers"]}' })).status).toBe(415);

  expect((await call("POST", "/objections", { user: "u1", body: { purposes: ["receipts"] } })).status).toBe(201);
  const consents = await call("GET", "/consents", { user: "u1" });
  expect(consents.body).toMatchObject({ consents: ["offers"], objections: ["receipts"] });
  expect(consents.body.purposes).toEqual([
    { purpose: "account", basis: "legitimate-use", legitimateUse: "7(i)", active: true },
    { purpose: "receipts", basis: "legitimate-use", description: "SMS receipts", legitimateUse: "7(a)", active: false },
    { purpose: "offers", basis: "consent", description: "Offers by SMS", active: true },
  ]);
  const lifted = await call("DELETE", "/objections?purposes=receipts", { user: "u1" });
  // The phone is still held for offers and the account, so the objection had scheduled nothing.
  expect(lifted.body).toMatchObject({ event: { action: "lift-objection" }, cancelled: 0 });
  const withdrawn = await call("POST", "/consents/withdraw", { user: "u1", body: { purposes: ["offers"] } });
  expect(withdrawn.body).toMatchObject({ event: { action: "withdraw", purposes: ["offers"] }, scheduled: 0 }); // the phone is still needed for the account

  const mine = await call("GET", "/data", { user: "u1" });
  expect(mine.body.data[0].rows).toEqual([{ name: "Asha", phone: "98xxxxxx01" }]);

  const opened = await call("POST", "/requests", { user: "u1", body: { type: "correction", details: { note: "New number" } } });
  expect(opened.status).toBe(201);
  expect(opened.body.acknowledgement.text).toContain(`Your reference is ${opened.body.request.id}`);
  const id = opened.body.request.id;
  expect(await call("GET", `/requests/${id}`, { user: "u2" })).toEqual({ status: 404, body: { error: "request-not-found" } });
  expect((await call("POST", "/requests", { user: "u1", body: { type: "complaint" } })).body).toEqual({ error: "invalid-request-type" });

  const nominee = await call("POST", "/nominees", { user: "u1", body: { name: "Ravi", contact: "ravi@example.in", relation: "brother" } });
  expect(nominee.status).toBe(201);
  expect((await call("GET", "/nominees", { user: "u1" })).body.nominees).toHaveLength(1);
  expect((await call("DELETE", `/nominees/${nominee.body.nominee.id}`, { user: "u1" })).body).toEqual({ revoked: true });
  expect((await call("GET", "/nominees", { user: "u1" })).body.nominees).toEqual([]);

  // The privacy team answers the correction.
  expect((await call("GET", "/admin/requests", { user: "u1" })).status).toBe(403);
  expect((await call("GET", "/admin/requests", { staff: "anita" })).body.requests.map((r: { id: string }) => r.id)).toContain(id);
  const checked = await call("POST", `/admin/requests/${id}/verify`, { staff: "anita", body: { method: "OTP to registered mobile" } });
  expect(checked.body.history.at(-1)).toMatchObject({ event: "verified", by: "anita" });
  const fixed = await call("POST", `/admin/requests/${id}/correct`, { staff: "anita", body: { changes: { "users.phone": "98xxxxxx02" } } });
  expect(fixed.body.changed).toEqual({ users: 1 });
  expect(data.tables.users![0]!.phone).toBe("98xxxxxx02");
  // The person sees the outcome, but not which staff member handled it or how they checked.
  const seen = await call("GET", `/requests/${id}`, { user: "u1" });
  expect(seen.body.status).toBe("resolved");
  expect(JSON.stringify(seen.body)).not.toMatch(/anita|OTP/);

  expect((await call("POST", "/consents", { user: "u1", raw: "{not json" })).status).toBe(400);
  expect((await call("POST", "/consents", { user: "u1", raw: JSON.stringify({ purposes: ["offers"], pad: "x".repeat(20_000) }) })).status).toBe(413);
  expect((await call("GET", "/nowhere", { user: "u1" })).status).toBe(404);
}

const headers = (opts: Parameters<Call>[2] = {}) => ({
  "user-agent": "journey-test",
  ...(opts.user ? { "x-user": opts.user } : {}),
  ...(opts.staff ? { "x-staff": opts.staff } : {}),
  ...(opts.body !== undefined || opts.raw !== undefined ? { "content-type": opts.contentType ?? "application/json" } : {}),
});
const payload = (opts: Parameters<Call>[2] = {}) => opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
const read = async (res: Response) => ({ status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() });

describe.each([
  ["with express.json()", true],
  ["without a body parser", false],
])("a real Express app %s", (_, parse) => {
  let base = "";
  let close = () => {};
  const { dpdp, data } = makeDpdp();
  beforeAll(async () => {
    const app = express();
    if (parse) app.use(express.json({ limit: "16kb" }));
    app.use("/privacy", dpdpRouter(dpdp, { subject: (req) => req.header("x-user"), admin: (req) => req.header("x-staff") }));
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/privacy`;
    close = () => server.close();
  });
  afterAll(() => close());

  it("serves the whole journey", async () => {
    const body = payload;
    await journey(async (method, path, opts) => read(await fetch(base + path, { method, headers: headers(opts), body: body(opts) ?? null })), data);
  });
});

describe("a Hono app", () => {
  it("serves the whole journey", async () => {
    const { dpdp, data } = makeDpdp();
    const app = new Hono();
    app.all("/privacy/*", dpdpRoutes(dpdp, { base: "/privacy", subject: (c) => c.req.header("x-user"), admin: (c) => c.req.header("x-staff") }));
    await journey(async (method, path, opts) => read(await app.request(`/privacy${path}`, { method, headers: headers(opts), body: payload(opts) ?? null })), data);
  });
});

describe("Next.js route handlers", () => {
  it("serves the whole journey", async () => {
    const { dpdp, data } = makeDpdp();
    const handlers = createHandlers(dpdp, {
      base: "/api/privacy",
      subject: (req) => req.headers.get("x-user") ?? undefined,
      admin: (req) => req.headers.get("x-staff") ?? undefined,
    });
    await journey(async (method, path, opts) => {
      const req = new Request(`http://chai.example/api/privacy${path}`, { method, headers: headers(opts), body: payload(opts) ?? null });
      return read(await handlers[method as "GET" | "POST" | "DELETE"](req));
    }, data);
  });
});

describe("the core handler's safety rules", () => {
  it("takes the person only from authentication, never from the request", async () => {
    const { dpdp } = makeDpdp();
    const res = await handle(dpdp, { method: "POST", path: "/consents", contentType: "application/json", body: { purposes: ["offers"], subjectId: "u2" }, subjectId: "u1" });
    expect(res.status).toBe(201);
    expect(await dpdp.consent.active("u2")).toEqual([]);
  });

  it("answers 404 for paths it doesn't serve before asking who's signed in, so adapters can pass them on", async () => {
    const { dpdp } = makeDpdp();
    expect(await handle(dpdp, { method: "GET", path: "/policy" })).toEqual({ status: 404, body: { error: "not-found" } });
    expect(await handle(dpdp, { method: "POST", path: "/feedback", contentType: "text/plain", subjectId: "u1" }, { limitWrites: () => false })).toEqual({
      status: 404,
      body: { error: "not-found" },
    });
    expect(await handle(dpdp, { method: "GET", path: "/requests/%E0%A4" })).toEqual({ status: 404, body: { error: "not-found" } }); // not percent-encoding
    expect(await handle(dpdp, { method: "GET", path: "/consents" })).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("leaves the app's own routes under the same path to the app, body and all", async () => {
    const { dpdp } = makeDpdp();
    const app = express();
    app.use("/privacy", dpdpRouter(dpdp, { subject: (req) => req.header("x-user") }));
    app.get("/privacy/policy", (_req, res) => res.send("policy"));
    app.post("/privacy/feedback", express.text(), (req, res) => res.send(`got ${req.body}`));
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/privacy`;
    try {
      expect(await (await fetch(`${base}/policy`)).text()).toBe("policy");
      expect(await (await fetch(`${base}/feedback`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" })).text()).toBe("got hello");
    } finally {
      server.close();
    }
  });

  it("records the channel each request says it came from", async () => {
    const { dpdp } = makeDpdp();
    const handlers = createHandlers(dpdp, {
      base: "/p",
      subject: () => "u1",
      channel: (req) => req.headers.get("x-app-platform") ?? undefined,
    });
    const post = (headers: Record<string, string>) =>
      handlers.POST(new Request("http://x/p/consents", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ purposes: ["offers"] }) }));
    expect((await (await post({ "x-app-platform": "ios" })).json()).event.channel).toBe("ios");
    expect((await (await post({})).json()).event.channel).toBe("web"); // no channel: the default
  });

  it("has no /admin routes unless you turn them on", async () => {
    const { dpdp } = makeDpdp();
    expect(await handle(dpdp, { method: "GET", path: "/admin/requests", actor: "anita" })).toEqual({ status: 404, body: { error: "not-found" } });
  });

  it("refuses writes when limitWrites says so", async () => {
    const { dpdp } = makeDpdp();
    const res = await handle(dpdp, { method: "POST", path: "/consents", contentType: "application/json", body: { purposes: ["offers"] }, subjectId: "u1" }, { limitWrites: () => false });
    expect(res).toEqual({ status: 429, body: { error: "too-many-requests" } });
    expect(await dpdp.consent.history("u1")).toEqual([]);
  });

  it("answers unexpected errors with 500 and no details", async () => {
    const { dpdp } = makeDpdp();
    const broken = { ...dpdp, consent: { ...dpdp.consent, active: async () => Promise.reject(new Error("connection refused at 10.0.0.5")) } };
    const errors: unknown[] = [];
    const res = await handle(broken as typeof dpdp, { method: "GET", path: "/consents", subjectId: "u1" }, { onError: (e) => errors.push(e) });
    expect(res).toEqual({ status: 500, body: { error: "internal" } });
    expect(errors).toHaveLength(1);
  });

  it("validates purposes and requires JSON for POST", async () => {
    const { dpdp } = makeDpdp();
    expect((await handle(dpdp, { method: "POST", path: "/consents", contentType: "application/json", body: { purposes: "offers" }, subjectId: "u1" })).body).toEqual({ error: "invalid-purposes" });
    expect((await handle(dpdp, { method: "POST", path: "/consents", body: { purposes: ["offers"] }, subjectId: "u1" })).status).toBe(415);
    expect((await handle(dpdp, { method: "POST", path: "/consents", contentType: "application/vnd.api+json", body: { purposes: ["offers"] }, subjectId: "u1" })).status).toBe(201);
  });
});
