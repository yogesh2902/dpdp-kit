---
title: Storage
description: Drizzle and Postgres out of the box, or bring your own store.
---

## Drizzle (Postgres)

Add the tables to your schema so drizzle-kit creates them:

```ts
// schema.ts
export { accessLog, consentEvents, erasureTasks, rightsRequests } from "dpdp-kit/drizzle";
```

If you don't use drizzle-kit, run `DPDP_DDL` (exported from `dpdp-kit/drizzle`). This works with any Drizzle Postgres driver: node-postgres, postgres.js, Neon and PGlite.

| Table | Holds |
|---|---|
| `dpdp_consent_events` | the consent records (hash chain) |
| `dpdp_requests` | rights requests |
| `dpdp_erasure_tasks` | scheduled erasure tasks |
| `dpdp_access_log` | who accessed whose data, and why (Rule 6) |

> **Upgrading from 0.1.x?** Add `rightsRequests` and `erasureTasks` to your schema and generate a migration, or run `RECORDS_DDL`. `withdraw()` now schedules erasure tasks, so it needs the `dpdp_erasure_tasks` table.
>
> **Upgrading from 0.2.x?** Add `accessLog` to your schema and generate a migration, or run `ACCESS_LOG_DDL`, before using `dpdp.access`.

## Reaching your own tables

`drizzleData(db, { schema })` reads and erases personal data in your tables. Pass your schema module when the data map uses Drizzle property names (`userId`) rather than column names (`user_id`).

## Anything else

Implement `DpdpStore`:

- consent events: `lastEvent`, `insert`, `events`
- requests and tasks: see `RequestStore` and `TaskStore`
- the access log: `insertAccess`, `listAccess`, `pruneAccess` (see `AccessLogStore`)

`insert` must throw `SeqConflictError` on a duplicate `(subjectId, seq)`, and `claimTask` must be atomic. A store with only the three consent methods still works for consent; rights and retention then throw `store-unsupported`.

Implement `DataAccess` (`read`, `eraseFields`, `deleteRows`) for another database.

## For tests

`memoryStore()` and `memoryData()` keep everything in memory:

```ts
import { createDpdp, memoryData, memoryStore } from "dpdp-kit";

const dpdp = createDpdp({ config, store: memoryStore(), data: memoryData() });
```
