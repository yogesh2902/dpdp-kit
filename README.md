# dpdp-kit

[![CI](https://github.com/yogesh2902/dpdp-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/yogesh2902/dpdp-kit/actions/workflows/ci.yml)

Build India's **Digital Personal Data Protection Act, 2023** into your Node.js backend.

- **Declare why you hold each piece of personal data**, in one typed config file. A misspelt purpose is a type error.
- **Keep consent records that show tampering.** Each person's grants and withdrawals form a hash chain, with the notice version and language they saw.
- **Know what to erase.** When consent is withdrawn or an account is deleted, get a plan: which fields go, which stay (and why), which tables are under a legal hold, which third parties to tell.
- **Check it in CI.** `dpdp-kit audit` fails the build when the data map is inconsistent.

It runs inside your app and writes to your own Postgres. There's no hosted service and no account.

> **Not legal advice.** dpdp-kit helps you put compliance into practice; it does not make an app compliant on its own. Section and rule references point you to the text so you can check them. Have your own lawyer review your purposes, notices and retention periods.

## Install

```bash
npm install dpdp-kit
```

Node.js 20.19 or later. The package is ESM-only; `require("dpdp-kit")` also works on those Node versions.

## 1. Declare your data

```ts
// dpdp.config.ts
import { defineConfig } from "dpdp-kit";

export default defineConfig({
  fiduciary: { name: "Acme Pvt Ltd", grievanceUrl: "https://acme.in/privacy/grievance" },

  purposes: {
    account:       { basis: "legitimate-use", retain: "while-active" },
    order_updates: { basis: "consent", retain: "while-active" },
    marketing_sms: { basis: "consent", retain: { afterWithdrawal: "0d" } },
    analytics:     { basis: "consent", retain: { afterWithdrawal: "30d" } },
  },

  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        phone:     { category: "contact", purposes: ["account", "order_updates", "marketing_sms"] },
        name:      { category: "identity", purposes: ["account"] },
        interests: { category: "behavioural", purposes: ["marketing_sms", "analytics"] },
      },
    },
    orders: {
      table: "orders",
      subject: "user_id",
      fields: { address: { category: "contact", purposes: ["account"] } },
      legalHold: { reason: "GST records", keep: "8y", then: "anonymise" },
    },
  },

  processors: {
    msg91:   { purposes: ["order_updates", "marketing_sms"] },
    posthog: { purposes: ["analytics"] },
  },

  logs: { minimumRetention: "1y" }, // Rule 8(3): at least one year
});
```

- **`basis`**: `"consent"` (Section 6) or `"legitimate-use"` (Section 7).
- **`retain`**: `"while-active"`, a duration such as `"1y"`, or `{ afterWithdrawal: "30d" }` for consent purposes. Durations use `h`, `d` or `y`.
- **`legalHold`**: another law makes you keep these rows (Section 8(7) allows it). They are held, not erased.

## 2. Check it

```bash
npx dpdp-kit audit            # exit code 1 on errors
npx dpdp-kit audit --strict   # also fail on warnings
```

```
✖ error    data.users.fields.phone.purposes
             Unknown purpose "acount". Declare it under `purposes` or fix the spelling.
⚠ warning  fiduciary.grievanceUrl
             Add where people can raise a grievance (Section 13). Notices need to point to it.
```

The same checks run when the app starts: `createDpdp` throws if the config has errors.

## 3. Record consent

```ts
import { createDpdp } from "dpdp-kit";
import { drizzleStore } from "dpdp-kit/drizzle";
import config from "./dpdp.config";

export const dpdp = createDpdp({ config, store: drizzleStore(db) });

await dpdp.consent.grant(userId, ["marketing_sms", "analytics"], {
  noticeVersion: "2026-11",
  language: "hi",          // English or any of the 22 Eighth Schedule languages (Section 5(3))
  channel: "android",
  evidence: { ip: req.ip },
});

await dpdp.consent.has(userId, "marketing_sms");   // true
await dpdp.consent.active(userId);                 // ["marketing_sms", "analytics"]
await dpdp.consent.history(userId);                // every event, oldest first
await dpdp.consent.verify(userId);                 // { ok: true, events: 1 }
```

`has()` answers "may I process this person's data for this purpose?". It is always `true` for legitimate-use purposes.

## 4. Withdrawals and deletions

```ts
const { erasure } = await dpdp.consent.withdraw(userId, ["analytics"]);
```

```jsonc
{
  "tables": [
    { "table": "users", "action": "erase-fields",
      "fields": [{ "field": "interests", "action": "erase", "after": "30d" }] }
  ],
  "processors": [{ "name": "posthog", "action": "erase", "ended": ["analytics"] }]
}
```

A field is erased only when **none** of its purposes remain. `phone` above stays because `account` and `order_updates` still need it, and the plan says so (`action: "keep", keptFor: [...]`).

```ts
await dpdp.erasure.plan(userId, { reason: "account-deletion" });
// users → delete-rows, orders → hold (GST records, 8y, then anonymise), processors → erase
```

**In v0.1 the plan only describes what to do; nothing is deleted for you.** Applying it (with your own `onErase` hooks for third parties) arrives in v0.2.

## 5. Guard routes

```ts
// Express
import { requireConsent } from "dpdp-kit/express";
app.post("/promo", requireConsent(dpdp, "marketing_sms", { subject: (req) => req.user?.id }), handler);

// Hono
import { requireConsent } from "dpdp-kit/hono";
app.post("/promo", requireConsent(dpdp, "marketing_sms", { subject: (c) => c.get("userId") }), handler);
```

Without consent, the middleware responds `403 { error: "consent_required", purpose, message }`. The message is plain enough to show to people. Pass `onDenied` to send your own response.

## Storage

### Drizzle (Postgres)

Add the table to your schema so drizzle-kit creates it:

```ts
// schema.ts
export { consentEvents } from "dpdp-kit/drizzle";
```

If you don't use drizzle-kit, run `CONSENT_EVENTS_DDL` (exported from `dpdp-kit/drizzle`). This works with any Drizzle Postgres driver: node-postgres, postgres.js, Neon, PGlite.

### Anything else

Implement `ConsentStore`: three methods (`lastEvent`, `insert`, `events`). `insert` must throw `SeqConflictError` on a duplicate `(subjectId, seq)`; a primary key on those columns does that. `memoryStore()` is included for tests.

## How the consent record works

- Events are only ever added. Each has `seq` (1, 2, 3… per person), `prevHash` and `hash`, a sha256 over the event's fields and the previous hash.
- Two writes for the same person at once can't fork the chain. The second hits the `(subjectId, seq)` key and retries on top of the first.
- `verify()` recomputes every hash. It catches an edited event, a deleted event in the middle, and reordering.
- **Limitation:** deleting the *latest* events leaves a shorter chain that still verifies. To catch that, save `history().at(-1).hash` somewhere the database admin can't change, such as your logs or another system, and compare.

## Roadmap

| Version | Adds |
|---|---|
| **v0.1** (this) | Config and types, `audit` + CLI, consent records, erasure plans, Drizzle store, Express/Hono guards |
| v0.2 | User rights requests (access, correction, erasure, grievance, nominee), applying erasure plans, processor hooks, React notice + privacy centre |
| v0.3 | Breach records with deadlines (Rule 7), children and guardian consent (Section 9), Consent Manager interop, Prisma store |

## Licence

MIT
