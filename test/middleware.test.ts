import { describe, expect, it, vi } from "vitest";
import { logAccess as expressLogAccess, requireConsent as expressGuard } from "../src/express.js";
import { logAccess as honoLogAccess, requireConsent as honoGuard } from "../src/hono.js";
import { createDpdp, memoryStore } from "../src/index.js";
import { config } from "./fixtures/config.js";

async function setup() {
  const dpdp = createDpdp({ config, store: memoryStore() });
  await dpdp.consent.grant("yes", ["marketing_sms"]);
  return dpdp;
}

function fakeRes() {
  const res = { code: 0, body: undefined as unknown, status: vi.fn(), json: vi.fn() };
  res.status.mockImplementation((code: number) => ((res.code = code), res));
  res.json.mockImplementation((body: unknown) => ((res.body = body), res));
  return res;
}

const run = (mw: (req: any, res: any, next: any) => void, req: unknown, res: unknown) =>
  new Promise<unknown>((resolve) => {
    mw(req, res, (err?: unknown) => resolve(err ?? "next"));
    setTimeout(() => resolve("responded"), 20);
  });

describe("express requireConsent", () => {
  it("passes people who consented and blocks the rest with 403", async () => {
    const dpdp = await setup();
    const mw = expressGuard(dpdp, "marketing_sms", { subject: (req: { user?: string }) => req.user });

    expect(await run(mw, { user: "yes" }, fakeRes())).toBe("next");

    const res = fakeRes();
    expect(await run(mw, { user: "no" }, res)).toBe("responded");
    expect(res.code).toBe(403);
    expect(res.body).toMatchObject({ error: "consent_required", purpose: "marketing_sms" });

    const anon = fakeRes();
    expect(await run(mw, {}, anon)).toBe("responded");
    expect(anon.code).toBe(403);
  });

  it("passes store errors to next()", async () => {
    const dpdp = await setup();
    const boom = new Error("db down");
    const mw = expressGuard(dpdp, "marketing_sms", { subject: () => Promise.reject(boom) });
    expect(await run(mw, {}, fakeRes())).toBe(boom);
  });
});

describe("hono requireConsent", () => {
  const ctx = (userId?: string) => ({
    userId,
    json: (body: unknown, status?: number) => Response.json(body, status ? { status } : {}),
  });

  it("calls next for consent and returns 403 otherwise", async () => {
    const dpdp = await setup();
    const mw = honoGuard(dpdp, "marketing_sms", { subject: (c: ReturnType<typeof ctx>) => c.userId });

    const next = vi.fn(async () => {});
    expect(await mw(ctx("yes"), next)).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();

    const denied = (await mw(ctx("no"), next)) as Response;
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "consent_required" });
  });

  it("uses onDenied when given", async () => {
    const dpdp = await setup();
    const mw = honoGuard(dpdp, "analytics", {
      subject: (c: ReturnType<typeof ctx>) => c.userId,
      onDenied: () => new Response("nope", { status: 451 }),
    });
    expect(((await mw(ctx("yes"), async () => {})) as Response).status).toBe(451);
  });
});

describe("logAccess", () => {
  const accessSetup = (outOfPurpose?: "throw") =>
    createDpdp({ config, store: memoryStore(), ...(outOfPurpose ? { access: { outOfPurpose } } : {}) });

  it("express: logs the request, then calls the handler", async () => {
    const dpdp = accessSetup();
    const mw = expressLogAccess(dpdp, {
      purpose: "account",
      fields: ["users"],
      actor: (req: any) => req.staff,
      subject: (req: any) => req.params.id,
      evidence: (req: any) => ({ ip: req.ip }),
    });
    expect(await run(mw, { staff: "priya", params: { id: "u1" }, ip: "10.0.0.7" }, fakeRes())).toBe("next");
    expect(await dpdp.access.list()).toEqual([
      expect.objectContaining({ actor: "priya", subjectId: "u1", purpose: "account", evidence: { ip: "10.0.0.7" } }),
    ]);
  });

  it("express: skips logging without a person, and errors without an actor", async () => {
    const dpdp = accessSetup();
    const mw = expressLogAccess(dpdp, { purpose: "account", actor: (req: any) => req.staff, subject: (req: any) => req.params?.id });
    expect(await run(mw, { staff: "priya" }, fakeRes())).toBe("next");
    expect(await dpdp.access.list()).toEqual([]);
    expect(await run(mw, { params: { id: "u1" } }, fakeRes())).toMatchObject({ code: "invalid-actor" });
  });

  it("express: refuses out-of-purpose reads in throw mode, after logging them", async () => {
    const dpdp = accessSetup("throw");
    const mw = expressLogAccess(dpdp, { purpose: "analytics", fields: ["users.phone"], actor: () => "growth", subject: () => "u1" });
    expect(await run(mw, {}, fakeRes())).toMatchObject({ code: "out-of-purpose" });
    expect(await dpdp.access.list()).toHaveLength(1);
  });

  it("hono: logs the request, and throws to the error handler on failure", async () => {
    const dpdp = accessSetup("throw");
    const ok = honoLogAccess(dpdp, { purpose: "account", actor: (c: any) => c.staff, subject: (c: any) => c.ids });
    const next = vi.fn(async () => {});
    await ok({ staff: "priya", ids: ["u1", "u2"] }, next);
    expect(next).toHaveBeenCalledOnce();
    expect((await dpdp.access.list()).map((e) => e.subjectId)).toEqual(["u1", "u2"]);

    const bad = honoLogAccess(dpdp, { purpose: "analytics", fields: ["users.phone"], actor: () => "growth", subject: () => "u1" });
    const never = vi.fn(async () => {});
    await expect(bad({}, never)).rejects.toMatchObject({ code: "out-of-purpose" });
    expect(never).not.toHaveBeenCalled();
  });
});
