---
title: Storage
description: Postgres through Drizzle, Prisma or any client, or bring your own store.
---

## Drizzle (Postgres)

Add the tables to your schema so drizzle-kit creates them:

```ts
// schema.ts
export { accessLog, breachNotices, breaches, consentEvents, erasureTasks, rightsRequests } from "dpdp-kit/drizzle";
```

If you don't use drizzle-kit, run `DPDP_DDL` (exported from `dpdp-kit/drizzle`). This works with any Drizzle Postgres driver: node-postgres, postgres.js, Neon and PGlite.

| Table | Holds |
|---|---|
| `dpdp_consent_events` | the consent records (hash chain) |
| `dpdp_requests` | rights requests |
| `dpdp_erasure_tasks` | scheduled erasure tasks |
| `dpdp_access_log` | who accessed whose data, and why (Rule 6) |
| `dpdp_breaches` | personal data breaches and their deadlines (Rule 7) |
| `dpdp_breach_notices` | who each breach affected, and whether they were told |

> **Upgrading from 0.1.x?** Add `rightsRequests` and `erasureTasks` to your schema and generate a migration, or run `RECORDS_DDL`. `withdraw()` now schedules erasure tasks, so it needs the `dpdp_erasure_tasks` table.
>
> **Upgrading from 0.3.x?** Add `breaches` and `breachNotices` to your schema and generate a migration, or run `BREACH_DDL`.
>
> **Upgrading from 0.2.x?** Add `accessLog` to your schema and generate a migration, or run `ACCESS_LOG_DDL`, before using `dpdp.access`.

`drizzleData(db, { schema })` reads and erases personal data in your own tables. Pass your schema module when the data map uses Drizzle property names (`userId`) rather than column names (`user_id`).

## Prisma (Postgres)

Add dpdp-kit's models to your Prisma schema. Print them once and paste them into `schema.prisma`, or save them as `prisma/schema/dpdp.prisma` if you use a multi-file schema:

```bash
node -e 'import("dpdp-kit/prisma").then((m) => console.log(m.PRISMA_MODELS))' >> prisma/schema.prisma
npx prisma migrate dev --name dpdp-kit
```

They create the same tables as `DPDP_DDL`, so a database set up either way works with both.

```ts
import { readFileSync } from "node:fs";
import { createDpdp } from "dpdp-kit";
import { prismaData, prismaSchema, prismaStore } from "dpdp-kit/prisma";
import { prisma } from "./db";

const schema = prismaSchema(readFileSync("prisma/schema.prisma", "utf8"));

export const dpdp = createDpdp({
  config,
  store: prismaStore(prisma),               // consent, requests, tasks, access log, breaches
  data: prismaData(prisma, { schema }),     // reads and erases personal data in your tables
});
```

- It runs parameterised SQL through `prisma.$queryRawUnsafe`, so it works with Prisma 5, 6 and 7, with or without a driver adapter. Postgres only.
- The schema lets the data map use model and field names (`User`, `phoneNumber`) where the database has others (`users`, `phone_number`), and casts values to each column's type, so `Int` ids, `@db.Uuid` columns and enums work.
- Inside a transaction, pass the transaction client: `createDpdp({ config, store: prismaStore(tx) })` within `prisma.$transaction(async (tx) => …)`. The consent record then commits or rolls back with your own writes.

## Any other Postgres client

`dpdp-kit/postgres` needs only a function that runs one query with `$1`, `$2`… parameters and returns its rows. That covers node-postgres, postgres.js, Kysely, Knex and Slonik.

```ts
import pg from "pg";
import { postgresData, postgresStore } from "dpdp-kit/postgres";

const pool = new pg.Pool();
const query = async (text: string, params: readonly unknown[]) => (await pool.query(text, [...params])).rows;

export const dpdp = createDpdp({ config, store: postgresStore(query), data: postgresData(query) });
```

Create the tables by running `DPDP_DDL`, a plain SQL string exported by `dpdp-kit/postgres` (and `dpdp-kit/drizzle`). Pass `postgresData(query, { schema })` a schema from `prismaSchema()` or `drizzleSchema()` to map names and cast values to column types.

> Timestamps are read back as UTC text, so they come back exactly as written whatever the server's time zone (many Indian servers run in `Asia/Kolkata`) and however the driver parses dates.

## Anything else

Implement `DpdpStore`:

- consent events: `lastEvent`, `insert`, `events`
- requests and tasks: see `RequestStore` and `TaskStore`
- the access log: `insertAccess`, `listAccess`, `pruneAccess` (see `AccessLogStore`)
- breaches: see `BreachStore`

`insert` must throw `SeqConflictError` on a duplicate `(subjectId, seq)`, and `claimTask` must be atomic. A store with only the three consent methods still works for consent; rights and retention then throw `store-unsupported`.

Implement `DataAccess` (`read`, `eraseFields`, `deleteRows`) for another database. `eraseFields` receives the replacement for each column (from each field's `erase` setting); a column without one becomes null.

## For tests

`memoryStore()` and `memoryData()` keep everything in memory:

```ts
import { createDpdp, memoryData, memoryStore } from "dpdp-kit";

const dpdp = createDpdp({ config, store: memoryStore(), data: memoryData() });
```
