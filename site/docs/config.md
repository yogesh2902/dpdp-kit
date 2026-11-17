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
    msg91:   { purposes: ["order_updates", "marketing_sms"] },
    posthog: { purposes: ["analytics"] },
  },

  minimumRetention: "1y", // Rule 8(3)
});
```

Purposes are typed: a field that lists `"acount"` instead of `"account"` is a type error in your editor, and an error in the audit.

## fiduciary

Who you are, as the Data Fiduciary.

- **`name`**: your organisation's name.
- **`grievanceUrl`**: where people can raise a grievance. Section 8(10) requires a grievance mechanism, and Section 5(1)(ii) requires the notice to say how to use it. The audit warns when it's missing.
- **`dpo`**: optional, your Data Protection Officer or contact person.

## purposes

Each purpose you hold personal data for.

- **`basis`**: `"consent"` (Section 6) or `"legitimate-use"` (Section 7). For most apps a legitimate use means Section 7(a): data the person voluntarily gave you for a specified purpose, until they tell you they don't want it used. Keeping data because a law requires it is not a legitimate use; use `legalHold` for that.
- **`retain`**: `"while-active"`, a duration such as `"1y"`, or `{ afterWithdrawal: "7d" }` for consent purposes. Durations use `h`, `d` or `y`. Section 8(7)(a) says to erase upon withdrawal, so keep `afterWithdrawal` to the delay your systems really need.
- **`description`**: optional, in plain words.

## data

Your tables, keyed by a name you choose.

- **`table`**: the database table name.
- **`subject`**: the column that identifies the person (the Data Principal), such as `id` or `user_id`.
- **`fields`**: each personal column, with a `category` (`contact`, `identity`, `behavioural`…) and the `purposes` it's held for.
- **`legalHold`**: another law makes you keep these rows, for example tax or KYC records. Section 8(7) requires erasure "unless retention is necessary for compliance with any law". Held rows wait `keep`, then are anonymised or deleted, as `then` says.

## processors

Third parties that process data for you (Data Processors), with the purposes they serve. When a purpose ends, dpdp-kit tells you which processors to notify, and the retention runner calls their hooks. See [Erasure and retention](../erasure/).

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
