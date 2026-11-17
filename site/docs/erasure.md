---
title: Erasure and retention
description: Plans that say what to erase and why, and a runner that carries them out on time.
---

## Erasure plans

When consent is withdrawn, dpdp-kit works out what to erase:

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

A field is erased only when **none** of its purposes remain. In the [example config](../config/), `phone` stays because `account` and `order_updates` still need it, and the plan says so (`action: "keep", keptFor: [...]`).

For an account deletion:

```ts
await dpdp.erasure.plan(userId, { reason: "account-deletion" });
// users → delete-rows, orders → hold (GST records, 8y, then anonymise), processors → erase
```

## "Erase" is not "delete this second"

Every plan carries `minimumRetention` from your config. Under Rule 8(3), stop using the data now, keep a restricted copy only for the Seventh Schedule purposes, and delete it once a year has passed since its last processing. The Rule's own example is an e-book platform that keeps order details and logs for a year "even if X deletes her account".

## Carrying it out

`withdraw()` schedules the plan as dated tasks, and `erasure.deleteAccount(userId)` plans and schedules an account deletion. Then run the retention runner on a schedule; once a day is plenty:

```ts
const report = await dpdp.retention.run();   // { done, failed, manual }
```

| Task | When it runs | What it does |
|---|---|---|
| `processor-stop` | straight away | calls the processor's `stop` hook (Section 6(6)) |
| `erase-fields` | after `minimumRetention` (and `afterWithdrawal`) | sets the fields to `NULL` in the person's rows |
| `delete-rows` | after `minimumRetention` | deletes the person's rows (account deletion) |
| held table | after the legal hold (`keep`) | then anonymises (`NULL`s) or deletes, as `then` says |
| `processor-erase` | after `minimumRetention` | calls the processor's `erase` hook (Section 8(7)(b)) |

- **Safe to run from several servers.** Each task is claimed atomically, so it runs once.
- **Failures are retried**, up to 5 times. `lastError` keeps the database's message for developers, for example when a column is `NOT NULL`.
- **A processor with no hook** gives a `manual` task. Handle it yourself (email their support), then `retention.markDone(taskId, "ticket 4411")`.
- **Consent records are never erased.**
- **Erasure sets columns to `NULL`**, so erasable columns must be nullable. Data access currently covers Postgres.

## Processor hooks

Tell third parties to stop, and later to erase:

```ts
export const dpdp = createDpdp({
  config,
  store: drizzleStore(db),
  data: drizzleData(db, { schema }),
  processors: {
    msg91: {
      stop:  ({ subjectId }) => msg91.optOut(subjectId),
      erase: ({ subjectId }) => msg91.deleteContact(subjectId),
    },
  },
});
```

## Looking at tasks

```ts
await dpdp.retention.tasks({ status: "manual" }); // what needs a human
await dpdp.retention.markDone(taskId, "ticket 4411");
```
