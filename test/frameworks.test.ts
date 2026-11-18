import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { logAccess as fastifyLogAccess, requireConsent as fastifyGuard } from "../src/fastify.js";
import { createDpdp, CONSENT_REQUIRED_BODY, memoryStore } from "../src/index.js";
import { accessLogGuard, consentGuard, type ExecutionContextLike } from "../src/nestjs.js";
import { config } from "./fixtures/config.js";

async function setup(outOfPurpose?: "throw") {
  const dpdp = createDpdp({ config, store: memoryStore(), ...(outOfPurpose ? { access: { outOfPurpose } } : {}) });
  await dpdp.consent.grant("yes", ["marketing_sms"]);
  return dpdp;
}

describe("fastify", () => {
  it("requireConsent passes people who consented and answers 403 for the rest", async () => {
    const dpdp = await setup();
    const app = Fastify();
    app.post("/promo", { preHandler: fastifyGuard(dpdp, "marketing_sms", { subject: (req: any) => req.headers["x-user"] }) }, async () => ({ sent: true }));

    const ok = await app.inject({ method: "POST", url: "/promo", headers: { "x-user": "yes" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ sent: true });

    const denied = await app.inject({ method: "POST", url: "/promo", headers: { "x-user": "no" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual(CONSENT_REQUIRED_BODY("marketing_sms"));

    expect((await app.inject({ method: "POST", url: "/promo" })).statusCode).toBe(403);
  });

  it("requireConsent can send its own reply", async () => {
    const dpdp = await setup();
    const app = Fastify();
    const preHandler = fastifyGuard(dpdp, "marketing_sms", {
      subject: () => "no",
      onDenied: (_req, reply: any) => reply.code(451).send({ custom: true }),
    });
    app.get("/x", { preHandler }, async () => ({ reached: true }));
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.statusCode).toBe(451);
    expect(res.json()).toEqual({ custom: true });
  });

  it("logAccess records the request, and stops it when the write is refused", async () => {
    const dpdp = await setup("throw");
    const app = Fastify();
    app.get(
      "/admin/users/:id",
      { preHandler: fastifyLogAccess(dpdp, { purpose: "account", fields: ["users.phone", "users.name"], actor: (req: any) => req.headers["x-staff"], subject: (req: any) => req.params.id }) },
      async () => ({ ok: true }),
    );
    app.get(
      "/growth/:id",
      { preHandler: fastifyLogAccess(dpdp, { purpose: "analytics", fields: ["users.phone"], actor: () => "growth", subject: (req: any) => req.params.id }) },
      async () => ({ ok: true }),
    );

    expect((await app.inject({ method: "GET", url: "/admin/users/u1", headers: { "x-staff": "priya" } })).statusCode).toBe(200);
    expect(await dpdp.access.list()).toEqual([expect.objectContaining({ actor: "priya", subjectId: "u1", purpose: "account" })]);

    expect((await app.inject({ method: "GET", url: "/admin/users/u1" })).statusCode).toBe(500); // no actor
    expect((await app.inject({ method: "GET", url: "/growth/u2" })).statusCode).toBe(500); // out of purpose
    expect(await dpdp.access.list({ actor: "growth" })).toHaveLength(1); // still logged
  });
});

const ctx = (request: unknown): ExecutionContextLike => ({ switchToHttp: () => ({ getRequest: <T>() => request as T }) });

describe("nestjs", () => {
  it("consentGuard returns true or false, or throws your exception", async () => {
    const dpdp = await setup();
    const guard = consentGuard(dpdp, "marketing_sms", { subject: (req: { user?: string }) => req.user });
    expect(await guard.canActivate(ctx({ user: "yes" }))).toBe(true);
    expect(await guard.canActivate(ctx({ user: "no" }))).toBe(false);
    expect(await guard.canActivate(ctx({}))).toBe(false);

    class ForbiddenException extends Error {
      constructor(readonly body: unknown) {
        super("Forbidden");
      }
    }
    const throwing = consentGuard(dpdp, "marketing_sms", {
      subject: (req: { user?: string }) => req.user,
      onDenied: (purpose) => new ForbiddenException(CONSENT_REQUIRED_BODY(purpose)),
    });
    await expect(throwing.canActivate(ctx({ user: "no" }))).rejects.toMatchObject({ body: { error: "consent_required" } });
  });

  it("accessLogGuard records the request and lets it through", async () => {
    const dpdp = await setup("throw");
    const guard = accessLogGuard(dpdp, { purpose: "account", actor: (req: any) => req.staff, subject: (req: any) => req.params.id });
    expect(await guard.canActivate(ctx({ staff: "priya", params: { id: "u1" } }))).toBe(true);
    expect(await dpdp.access.list()).toHaveLength(1);

    const outside = accessLogGuard(dpdp, { purpose: "analytics", fields: ["users.phone"], actor: () => "growth", subject: () => "u1" });
    await expect(outside.canActivate(ctx({}))).rejects.toMatchObject({ code: "out-of-purpose" });
  });
});
