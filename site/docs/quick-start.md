---
title: Quick start
description: From install to a passing audit and your first consent record, in five steps.
---

## 1. Install

```bash
npm install dpdp-kit
```

## 2. Declare your data

Create `dpdp.config.ts` at the root of your project. List each purpose you hold personal data for, then map each personal field to its purposes:

```ts
// dpdp.config.ts
import { defineConfig } from "dpdp-kit";

export default defineConfig({
  fiduciary: { name: "Acme Pvt Ltd", grievanceUrl: "https://acme.in/privacy/grievance" },

  purposes: {
    account:       { basis: "legitimate-use", retain: "while-active" },
    marketing_sms: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },

  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        phone: { category: "contact", purposes: ["account", "marketing_sms"] },
        name:  { category: "identity", purposes: ["account"] },
      },
    },
  },

  minimumRetention: "1y", // Rule 8(3)
});
```

Every option is explained in [Declare your data](../config/).

## 3. Run the audit

```bash
npx dpdp-kit audit --schema src/db/schema.ts
```

It exits with code 1 on errors, so it can gate CI. `--schema` also compares the data map with your Drizzle schema. See [Audit and CI](../audit/).

## 4. Create the dpdp instance

Add dpdp-kit's tables to your Drizzle schema so drizzle-kit creates them:

```ts
// src/db/schema.ts
export { consentEvents, erasureTasks, rightsRequests } from "dpdp-kit/drizzle";
```

Then create one instance for your app:

```ts
// src/dpdp.ts
import { createDpdp } from "dpdp-kit";
import { drizzleData, drizzleStore } from "dpdp-kit/drizzle";
import * as schema from "./db/schema";
import config from "../dpdp.config";

export const dpdp = createDpdp({
  config,
  store: drizzleStore(db),             // consent records, rights requests, erasure tasks
  data: drizzleData(db, { schema }),   // reads and erases personal data in your tables
});
```

`createDpdp` runs the same checks as the audit and throws if the config has errors.

## 5. Record consent, and run the retention runner

```ts
await dpdp.consent.grant(userId, ["marketing_sms"], {
  noticeVersion: "2026-11",
  language: "en",
  channel: "web",
});

await dpdp.consent.has(userId, "marketing_sms"); // true
```

When someone withdraws, `withdraw()` schedules the erasure. Run the daily upkeep to carry it out, prune old access logs and review access:

```ts
await dpdp.consent.withdraw(userId, ["marketing_sms"]);

import { startDaily } from "dpdp-kit/schedule";
startDaily(dpdp, { at: "03:00" }); // or call dpdp.daily() from node-cron, BullMQ or your platform's cron
```

See [Daily upkeep](../daily/) for the options.

## Next

- Put the audit on every pull request with the [GitHub Action](../audit/#in-github-actions).
- Learn how [erasure and retention](../erasure/) handle legal holds and the one-year rule.
- Record [rights requests](../rights/) with their due dates.
