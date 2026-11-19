---
title: Declare your data
description: One typed file says what personal data you hold, why, and for how long.
---

Everything in dpdp-kit starts from `dpdp.config.ts`. The audit, the consent guard, erasure plans and rights requests all read it.

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
    msg91:   { purposes: ["order_updates", "marketing_sms"], countries: ["IN"] },
    posthog: { purposes: ["analytics"], countries: ["US"] },
  },

  minimumRetention: "1y", // Rule 8(3)
});
```

Purposes are typed: a field that lists `"acount"` instead of `"account"` is a type error in your editor, and an error in the audit.

## fiduciary

Who you are, as the Data Fiduciary.

- **`name`**: your organisation's name.
- **`grievanceUrl`**: where people can raise a grievance. Section 8(10) requires a grievance mechanism, and Section 5(1)(ii) requires the notice to say how to use it. The audit warns when it's missing.
- **`dpo`**: your Data Protection Officer, or a person who can answer questions about personal data, with their business contact, e.g. `"Meera Iyer, privacy@acme.in, +91 80 4000 1234"`. Section 8(9) requires publishing it, and it's the contact in every [breach notice](../breaches/) (Rule 7(1)(e)). The audit warns when it's missing.

## purposes

Each purpose you hold personal data for.

- **`basis`**: `"consent"` (Section 6) or `"legitimate-use"` (Section 7). For most apps a legitimate use means Section 7(a): data the person voluntarily gave you for a specified purpose, until they tell you they don't want it used. Keeping data because a law requires it is not a legitimate use; use `legalHold` for that.
- **`legitimateUse`**: for a legitimate-use purpose, the clause of Section 7 it relies on, `"7(a)"` to `"7(i)"`. Purposes with `"7(a)"` accept [objections](../objections/).
- **`retain`**: `"while-active"`, a duration such as `"1y"`, or `{ afterWithdrawal: "7d" }` for consent purposes. Durations use `h`, `d` or `y`. Section 8(7)(a) says to erase upon withdrawal, so keep `afterWithdrawal` to the delay your systems really need.
- **`description`**: in plain words, what the purpose is and what it gives the person. Required for consent purposes when you build [notices](../notices/).

## data

Your tables, keyed by a name you choose.

- **`table`**: the database table name.
- **`subject`**: the column that identifies the person (the Data Principal), such as `id` or `user_id`.
- **`fields`**: each personal column, with a `category` (`contact`, `identity`, `behavioural`…) and the `purposes` it's held for. Add `label` ("Mobile number") for how the [notice](../notices/) names it.
- **`legalHold`**: another law makes you keep these rows, for example tax or KYC records. Section 8(7) requires erasure "unless retention is necessary for compliance with any law". Held rows wait `keep`, then are anonymised or deleted, as `then` says.

A field can say what it becomes when it's erased, with `erase`: `"null"` (the default), `"redact"` (the text `"[erased]"`), or `{ value }`, a fixed value or a function of the person, for `NOT NULL` or `UNIQUE` columns. See [Erasure and retention](../erasure/).

Each field can also say how it's protected where it's stored, with `protect`: `"encrypted"`, `"tokenised"`, `"masked"` or `"hashed"` (Rule 6(1)(a)). The audit warns when a high-risk identifier, such as Aadhaar, PAN or a bank account number, has none. See [Security and access logs](../security/).

## processors

Third parties that process data for you (Data Processors), with the purposes they serve. When a purpose ends, dpdp-kit tells you which processors to notify, and the retention runner calls their hooks. See [Erasure and retention](../erasure/).

Add `contract`: where your contract with the processor requires reasonable security safeguards, for example `"DPA signed 2026-03-01, clause 7"`. Rule 6(1)(f) requires such a provision, and the audit warns when it's missing.

Add `countries`: where the processor handles the data, such as `["IN"]` or `["IN", "US"]`. The audit checks it against `transfers`. See [Transfers outside India](../transfers/).

## security

The security safeguards of Rule 6(1) that live outside your code, described in a sentence each as evidence. The audit warns about any you leave out.

```ts
security: {
  accessControl: "SSO with least-privilege roles",               // Rule 6(1)(b)
  backups: "Encrypted daily backups, restore tested monthly",     // Rule 6(1)(d)
  measures: "Annual security training, quarterly access reviews", // Rule 6(1)(g)
  accessLogRetention: "1y",                                       // Rule 6(1)(e): default and minimum
},
```

## minimumRetention

Rule 8(3) requires keeping the personal data, traffic data and logs of each processing for at least one year from that processing, even after the account is deleted, but only for the purposes in the Seventh Schedule (requests from the State). The audit fails if this is under `"1y"`.

## notPersonal

Columns that only look personal, by database table and column name. The schema drift check skips them:

```ts
notPersonal: ["products.name", "branches.*"],
```

## rights

How long you give yourself to answer each kind of rights request. The Rules set ninety days for grievances only (Rule 14(3)), and the audit fails above that:

```ts
rights: { responseWithin: { grievance: "30d", access: "30d" } },
```

## notice

Links for the privacy notice, and translations. With it, dpdp-kit builds the notice from your purposes and fields, and `consent.grant()` records the version each person saw. See [Notices](../notices/).
