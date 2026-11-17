---
title: Route guards
description: Middleware for Express and Hono that blocks a route without consent.
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

`subject` tells the guard who the person is, from your own session or auth. The guard never reads it from the request body.

Without consent, the middleware responds:

```json
{ "error": "consent_required", "purpose": "marketing_sms", "message": "…" }
```

with status `403`. The message is plain enough to show to people. Pass `onDenied` to send your own response instead.

Legitimate-use purposes always pass, because they don't need consent.
