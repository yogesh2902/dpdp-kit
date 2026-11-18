// Guards and access logging in real Express, Hono and NestJS apps, over real HTTP.
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { Controller, ForbiddenException, Get, Module, Post, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express from "express";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logAccess as expressLogAccess, requireConsent as expressGuard } from "../src/express.js";
import { logAccess as honoLogAccess, requireConsent as honoGuard } from "../src/hono.js";
import { CONSENT_REQUIRED_BODY, createDpdp, memoryStore } from "../src/index.js";
import { accessLogGuard, consentGuard } from "../src/nestjs.js";
import { config } from "./fixtures/config.js";

async function setup() {
  const dpdp = createDpdp({ config, store: memoryStore(), access: { outOfPurpose: "throw" } });
  await dpdp.consent.grant("yes", ["marketing_sms"]);
  return dpdp;
}

describe("a real Express app", () => {
  let base = "";
  let close = () => {};
  let dpdp: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    dpdp = await setup();
    const app = express();
    app.post("/promo", expressGuard(dpdp, "marketing_sms", { subject: (req) => req.header("x-user") }), (_req, res) => {
      res.json({ sent: true });
    });
    app.get(
      "/admin/users/:id",
      expressLogAccess(dpdp, { purpose: "account", fields: ["users.phone"], actor: (req) => req.header("x-staff"), subject: (req) => req.params.id }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.get(
      "/growth/:id",
      expressLogAccess(dpdp, { purpose: "analytics", fields: ["users.phone"], actor: () => "growth", subject: (req) => req.params.id }),
      (_req, res) => {
        res.json({ reached: true });
      },
    );
    app.use((err: { code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.code === "out-of-purpose" ? 403 : 500).json({ error: err.code });
    });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it("requireConsent lets consenting people through and answers 403 for the rest", async () => {
    const ok = await fetch(`${base}/promo`, { method: "POST", headers: { "x-user": "yes" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sent: true });
    const denied = await fetch(`${base}/promo`, { method: "POST", headers: { "x-user": "no" } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual(CONSENT_REQUIRED_BODY("marketing_sms"));
  });

  it("logAccess records the request, and refused reads reach the error handler", async () => {
    expect((await fetch(`${base}/admin/users/u1`, { headers: { "x-staff": "priya" } })).status).toBe(200);
    expect(await dpdp.access.list({ actor: "priya" })).toEqual([expect.objectContaining({ subjectId: "u1", purpose: "account" })]);
    const refused = await fetch(`${base}/growth/u2`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "out-of-purpose" });
    expect(await dpdp.access.list({ actor: "growth" })).toHaveLength(1);
  });
});

describe("a real Hono app", () => {
  it("guards and logs routes", async () => {
    const dpdp = await setup();
    const app = new Hono();
    app.post("/promo", honoGuard(dpdp, "marketing_sms", { subject: (c) => c.req.header("x-user") }), (c) => c.json({ sent: true }));
    app.get(
      "/admin/users/:id",
      honoLogAccess(dpdp, { purpose: "account", fields: ["users.phone"], actor: (c) => c.req.header("x-staff"), subject: (c) => c.req.param("id") }),
      (c) => c.json({ ok: true }),
    );
    app.get(
      "/growth/:id",
      honoLogAccess(dpdp, { purpose: "analytics", fields: ["users.phone"], actor: () => "growth", subject: (c) => c.req.param("id") }),
      (c) => c.json({ reached: true }),
    );
    app.onError((err, c) => c.json({ error: (err as { code?: string }).code }, 403));

    expect((await app.request("/promo", { method: "POST", headers: { "x-user": "yes" } })).status).toBe(200);
    const denied = await app.request("/promo", { method: "POST", headers: { "x-user": "no" } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual(CONSENT_REQUIRED_BODY("marketing_sms"));

    expect((await app.request("/admin/users/u1", { headers: { "x-staff": "priya" } })).status).toBe(200);
    expect(await dpdp.access.list({ actor: "priya" })).toHaveLength(1);
    const refused = await app.request("/growth/u2");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "out-of-purpose" });
  });
});

describe("a real NestJS app", () => {
  let base = "";
  let close = async () => {};
  let dpdp: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    dpdp = await setup();
    // Decorators applied as functions, so the test needs no decorator syntax in the compiler.
    class PromoController {
      promo() {
        return { sent: true };
      }
      promoStrict() {
        return { sent: true };
      }
      user() {
        return { ok: true };
      }
    }
    const method = (name: keyof PromoController, ...decorators: MethodDecorator[]) => {
      const descriptor = Object.getOwnPropertyDescriptor(PromoController.prototype, name)!;
      for (const d of decorators) d(PromoController.prototype, name, descriptor);
    };
    method("promo", Post("promo"), UseGuards(consentGuard(dpdp, "marketing_sms", { subject: (req: express.Request) => req.header("x-user") })));
    method(
      "promoStrict",
      Post("promo-strict"),
      UseGuards(
        consentGuard(dpdp, "marketing_sms", {
          subject: (req: express.Request) => req.header("x-user"),
          onDenied: (purpose) => new ForbiddenException(CONSENT_REQUIRED_BODY(purpose)),
        }),
      ),
    );
    method(
      "user",
      Get("admin/users/:id"),
      UseGuards(
        accessLogGuard(dpdp, {
          purpose: "account",
          fields: ["users.phone"],
          actor: (req: express.Request) => req.header("x-staff"),
          subject: (req: express.Request) => req.params.id,
        }),
      ),
    );
    Controller()(PromoController);
    class AppModule {}
    Module({ controllers: [PromoController] })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    close = () => app.close();
  });
  afterAll(() => close());

  it("consentGuard answers Nest's 403 without consent, or your exception", async () => {
    expect((await fetch(`${base}/promo`, { method: "POST", headers: { "x-user": "yes" } })).status).toBe(201);
    expect((await fetch(`${base}/promo`, { method: "POST", headers: { "x-user": "no" } })).status).toBe(403);
    const strict = await fetch(`${base}/promo-strict`, { method: "POST", headers: { "x-user": "no" } });
    expect(strict.status).toBe(403);
    expect(await strict.json()).toEqual(CONSENT_REQUIRED_BODY("marketing_sms"));
  });

  it("accessLogGuard records the request and lets it through", async () => {
    expect((await fetch(`${base}/admin/users/u7`, { headers: { "x-staff": "priya" } })).status).toBe(200);
    expect(await dpdp.access.list({ subjectId: "u7" })).toEqual([expect.objectContaining({ actor: "priya", purpose: "account" })]);
  });
});
