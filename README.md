# dpdp-kit

[![CI](https://github.com/yogesh2902/dpdp-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/yogesh2902/dpdp-kit/actions/workflows/ci.yml)

**The Node.js-native toolkit for India's Digital Personal Data Protection Act, 2023.** Build it into your Node.js backend.

- **Declare why you hold each piece of personal data**, in one typed config file. A misspelt purpose is a type error.
- **Keep consent records that show tampering.** Each person's grants and withdrawals form a hash chain, with the notice version and language they saw.
- **Know what to erase.** When consent is withdrawn or an account is deleted, get a plan: which fields go, which stay (and why), which tables are under a legal hold, which third parties to tell.
- **Check it in CI.** `dpdp-kit audit` fails the build when the data map is inconsistent.
- **Catch drift.** `dpdp-kit audit --schema` reads your Drizzle schema and fails the build when someone adds a `phone`, `email` or `aadhaar_number` column without saying what it's for, or when the data map points at columns that no longer exist. Compliance that can't quietly fall out of date.

## Node-native

dpdp-kit is a TypeScript library that runs **inside your Node.js process**, not a service you call.

- **No separate server.** There's nothing to deploy, no sidecar to keep running, and no REST API between your code and your consent records.
- **No hosted service.** No account, no API key, and no network calls. Personal data never leaves your infrastructure.
- **Your own database.** Consent records go into your own Postgres, through the Drizzle setup you already have, in the same database as the rest of your data.
- **Fits your Node stack.** Typed config, middleware for Express and Hono, a CLI for CI, and works with ESM, `require()` and TypeScript.

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
    analytics:     { basis: "consent", retain: { afterWithdrawal: "7d" } }, // time for the batch job to run
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

  minimumRetention: "1y", // Rule 8(3): keep data and logs of each processing at least one year
});
```

- **`basis`**: `"consent"` (Section 6) or `"legitimate-use"` (Section 7). For most apps a legitimate use means Section 7(a): data the person voluntarily gave you for a specified purpose, until they tell you they don't want it used. Keeping data because a law requires it is not a legitimate use; use `legalHold`.
- **`retain`**: `"while-active"`, a duration such as `"1y"`, or `{ afterWithdrawal: "7d" }` for consent purposes. Durations use `h`, `d` or `y`. Section 8(7)(a) says to erase upon withdrawal, so keep `afterWithdrawal` to the delay your systems really need.
- **`legalHold`**: another law makes you keep these rows (tax, KYC). Section 8(7) requires erasure "unless retention is necessary for compliance with any law". They are held, not erased.
- **`minimumRetention`**: Rule 8(3) requires keeping the personal data, traffic data and logs of each processing for at least one year from that processing, even after the account is deleted, but only for the purposes in the Seventh Schedule (requests from the State). The audit fails if this is under `"1y"`.

## 2. Check it

```bash
npx dpdp-kit audit            # exit code 1 on errors
npx dpdp-kit audit --strict   # also fail on warnings
```

```
✖ error    data.users.fields.phone.purposes
             Unknown purpose "acount". Declare it under `purposes` or fix the spelling.
⚠ warning  fiduciary.grievanceUrl
             Add where people can raise a grievance. Section 8(10) requires a grievance mechanism, and Section 5(1)(ii) requires the notice to say how to use it.
```

The same checks run when the app starts: `createDpdp` throws if the config has errors.

### Catch schema drift

A data map is only useful while it matches the database. Point the audit at your Drizzle schema (Postgres, MySQL or SQLite):

```bash
npx dpdp-kit audit --schema src/db/schema.ts
```

```
✖ error    schema.users.aadhaar_number
             Looks like personal data (identity, matched "aadhaar") but isn't in the data map. Add it under `data`
             with the purposes it's held for, or add "users.aadhaar_number" to `notPersonal`.
✖ error    data.users.fields.interests
             Column "interests" isn't in table "users". Fix the name, or remove it if the column was dropped.
⚠ warning  schema.users.gender
             Looks like personal data (identity, matched "gender") but isn't in the data map. ...
```

It checks both directions:

- **New personal columns nobody mapped.** Columns are recognised by name: phone and email, Aadhaar, PAN, passport and voter ID, date of birth, names, addresses and PIN codes, UPI, IFSC and bank details, IP addresses and device IDs, health, biometric and location data. Clear cases are errors. Columns that are personal only sometimes, like `name`, `gender` or `city`, or anything named for a company or branch, are warnings.
- **A data map that points at nothing.** Tables or columns that were renamed or dropped.

Columns that describe data rather than hold it, such as `email_verified_at`, `phone_confirmed` and `address_type`, are not flagged. For anything that only looks personal, list it in the config:

```ts
notPersonal: ["products.name", "branches.*"], // database table and column names
```

From code, `checkSchema(config, drizzleSchema(schema))` returns the same issues. `drizzleSchema` comes from `dpdp-kit/drizzle`. Matching is by column name, so it can't see personal data hidden inside a JSON column or a vaguely named field. Review those by hand.

## 3. Record consent

```ts
import { createDpdp } from "dpdp-kit";
import { drizzleStore } from "dpdp-kit/drizzle";
import config from "./dpdp.config";

export const dpdp = createDpdp({ config, store: drizzleStore(db) });

await dpdp.consent.grant(userId, ["marketing_sms", "analytics"], {
  noticeVersion: "2026-11",
  language: "hi",          // English or any of the 22 Eighth Schedule languages (Sections 5(3), 6(3))
  channel: "android",
  evidence: { ip: req.ip },
});

await dpdp.consent.has(userId, "marketing_sms");   // true
await dpdp.consent.active(userId);                 // ["marketing_sms", "analytics"]
await dpdp.consent.history(userId);                // every event, oldest first
await dpdp.consent.verify(userId);                 // { ok: true, events: 1 }
```

`has()` answers "do I hold consent, or not need it, for this purpose?". It is always `true` for legitimate-use purposes. Under Section 7(a) you must still stop once the person tells you they don't want their data used; v0.1 doesn't record that yet.

## 4. Withdrawals and deletions

```ts
const { erasure } = await dpdp.consent.withdraw(userId, ["analytics"]);
```

```jsonc
{
  "tables": [
    { "table": "users", "action": "erase-fields",
      "fields": [{ "field": "interests", "action": "erase", "after": "7d" }] }
  ],
  "processors": [{ "name": "posthog", "action": "erase", "ended": ["analytics"] }]
}
```

A field is erased only when **none** of its purposes remain. `phone` above stays because `account` and `order_updates` still need it, and the plan says so (`action: "keep", keptFor: [...]`).

```ts
await dpdp.erasure.plan(userId, { reason: "account-deletion" });
// users → delete-rows, orders → hold (GST records, 8y, then anonymise), processors → erase
```

**"Erase" is not "delete this second".** Every plan carries `minimumRetention` from your config. Under Rule 8(3), stop using the data now, keep a restricted copy only for the Seventh Schedule purposes, and delete it once a year has passed since its last processing. The Rule's own example is an e-book platform that keeps order details and logs for a year "even if X deletes her account".

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

Section 6(10) puts the burden on you: if consent is questioned in a proceeding, the Data Fiduciary must prove that a notice was given and consent was given. That's why each event stores the notice version, language, channel and evidence, and why the record shows edits.

- Events are only ever added. Each has `seq` (1, 2, 3… per person), `prevHash` and `hash`, a sha256 over the event's fields and the previous hash.
- Two writes for the same person at once can't fork the chain. The second hits the `(subjectId, seq)` key and retries on top of the first.
- `verify()` recomputes every hash. It catches an edited event, a deleted event in the middle, and reordering.
- **Limitation:** deleting the *latest* events leaves a shorter chain that still verifies. To catch that, save `history().at(-1).hash` somewhere the database admin can't change, such as your logs or another system, and compare.

## Roadmap

| Version | Adds |
|---|---|
| **v0.1** | Config and types, `audit` + CLI, consent records, erasure plans, Drizzle store, Express/Hono guards |
| **next** | Schema drift check: `audit --schema`, `checkSchema`, `drizzleSchema`, `notPersonal` |
| v0.2 | User rights requests (Sections 11–14, Rule 14; grievances answered within 90 days, Rule 14(3)), recording objections to a Section 7(a) use, applying erasure plans, processor hooks, React notice that meets Rule 3 + privacy centre |
| v0.3 | Breach records with deadlines (Section 8(6), Rule 7: people and the Board without delay, detailed report to the Board within 72 hours), children and guardian consent (Section 9, Rule 10), inactivity erasure with 48 hours' warning for large e-commerce, gaming and social media platforms (Rule 8(1)–(2), Third Schedule), Consent Manager interop (Sections 6(7)–6(9), Rule 4), Prisma store |

## When the Rules apply

The DPDP Rules, 2025 were published on 13 November 2025 and start in phases (Rule 1):

- **Rule 4** (Consent Managers): one year after publication, November 2026.
- **Rules 3, 5 to 16, 22 and 23**, including notices, security safeguards, breaches, retention and erasure, children, and rights requests: **18 months after publication, May 2027.**

Building this in now gives you time to test before those obligations start.

## Legal sources

- **The Digital Personal Data Protection Act, 2023** (No. 22 of 2023), Gazette of India Extraordinary, Part II Section 1, 11 August 2023 (CG-DL-E-12082023-248045). Every Section reference here has been checked against this text.
- **The Digital Personal Data Protection Rules, 2025**, G.S.R. 846(E), 13 November 2025 (MeitY copy). Every Rule reference here has been checked against this text.
- **Corrigendum G.S.R. 892(E)**, 10 December 2025, published 11 December 2025 (CG-DL-E-12122025-268455). It makes 8 wording corrections, to Rule 1(3)–(4), Rule 11, Rule 19, the First Schedule and the Fourth Schedule. None changes anything cited here. Rule 1's "of this Gazette" becoming "in the Official Gazette" leaves the start dates unchanged.

Report a wrong or outdated reference as an issue. It's treated as a bug.

## Licence

MIT
