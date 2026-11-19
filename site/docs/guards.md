---
title: Route guards
description: Guards for Express, Hono, Fastify and NestJS that block a route without consent, and log access.
---

```ts
// Express
import { requireConsent } from "dpdp-kit/express";
app.post("/promo", requireConsent(dpdp, "marketing_sms", { subject: (req) => req.user?.id }), handler);
```

```ts
// Hono
import { requireConsent } from "dpdp-kit/hono";
app.post("/promo", requireConsent(dpdp, "marketing_sms", { subject: (c) => c.get("userId") }), handler);
```

```ts
// Fastify: a preHandler hook
import { requireConsent } from "dpdp-kit/fastify";
app.post("/promo", { preHandler: requireConsent(dpdp, "marketing_sms", { subject: (req) => req.user?.id }) }, handler);
```

```ts
// NestJS: a guard for @UseGuards(); dpdp-kit doesn't depend on @nestjs/common
import { ForbiddenException, Post, UseGuards } from "@nestjs/common";
import { CONSENT_REQUIRED_BODY } from "dpdp-kit";
import { consentGuard } from "dpdp-kit/nestjs";

@UseGuards(consentGuard(dpdp, "marketing_sms", {
  subject: (req) => req.user?.id,
  onDenied: (purpose) => new ForbiddenException(CONSENT_REQUIRED_BODY(purpose)),
}))
@Post("promo")
sendPromo() {}
```

Without `onDenied`, the NestJS guard returns `false` and NestJS answers its standard 403. The guards read HTTP requests; for GraphQL, pass `request: (ctx) => GqlExecutionContext.create(ctx).getContext().req`. In Fastify, if your `onDenied` sends nothing, the default 403 is sent so the request never hangs.

`subject` tells the guard who the person is, from your own session or auth. The guard never reads it from the request body.

Without consent, the middleware responds:

```json
{ "error": "consent_required", "purpose": "marketing_sms", "message": "…" }
```

When the purpose is a Section 7(a) use the person [objected](../objections/) to, the body also has `"reason": "objected"`, and the message tells them they can change it in their privacy settings.

with status `403`. The message is plain enough to show to people. Pass `onDenied` to send your own response instead.

Legitimate-use purposes always pass, because they don't need consent.

## Log access to a route

Each framework also has an access-log guard that records the request before the handler runs (Rule 6(1)(c)). See [Security and access logs](../security/).

| Framework | Import |
|---|---|
| Express | `logAccess` from `dpdp-kit/express` |
| Hono | `logAccess` from `dpdp-kit/hono` |
| Fastify | `logAccess` from `dpdp-kit/fastify`, as a `preHandler` |
| NestJS | `accessLogGuard` from `dpdp-kit/nestjs`, in `@UseGuards()` |
