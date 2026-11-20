---
title: Storage
description: Postgres through Drizzle, Prisma or any client, MySQL, SQLite, MongoDB and Mongoose, or bring your own store.
---

## Drizzle (Postgres)

Add the tables to your schema so drizzle-kit creates them:

```ts
// schema.ts
export { accessLog, breachNotices, breaches, consentEvents, erasureTasks, privacyNotices, rightsRequests } from "dpdp-kit/drizzle";
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
| `dpdp_privacy_notices` | each privacy notice as shown, kept as proof (Section 6(10)) |

> **Upgrading from 0.4.x?** Run `MIGRATE_0_5_DDL` once, or add `privacyNotices` to your schema and generate a Drizzle migration. The consent table then accepts [objections](../objections/), and [notices](../notices/) have somewhere to be saved. With Prisma, add the new `DpdpPrivacyNotice` model from `PRISMA_MODELS` and run `prisma migrate dev`. MongoDB needs nothing.

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

- It runs parameterised SQL through `prisma.$queryRawUnsafe`. Postgres only. Tested on Prisma 7 with `@prisma/adapter-pg`. Every parameter has an explicit cast, so earlier versions should work too, but they aren't tested.
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

## MySQL

> New in 0.6.

```ts
import mysql from "mysql2/promise";
import { createDpdp } from "dpdp-kit";
import { MYSQL_DDL, mysqlData, mysqlStore } from "dpdp-kit/mysql";

const pool = mysql.createPool({ uri: process.env.DATABASE_URL, multipleStatements: true });
await pool.query(MYSQL_DDL); // once; every statement is IF NOT EXISTS
const dpdp = createDpdp({ config, store: mysqlStore(pool), data: mysqlData(pool) });
```

- MySQL 8.0.16 or later (for `JSON_TABLE`, window functions and `CHECK`). `MYSQL_DDL` creates the same tables as `DPDP_DDL` on InnoDB with utf8mb4: `JSON` columns and `DATETIME(3)` timestamps in UTC. Without `multipleStatements`, run it statement by statement (split on `;`).
- Timestamps are written as UTC and read back as text, so neither the driver's `timezone` option nor a server in `Asia/Kolkata` can shift them. CI runs a MySQL server in IST.
- A task is claimed in one `UPDATE`: InnoDB locks the row, so two runners never carry out the same task.
- `mysqlData(pool, { schema })` takes a `drizzleSchema()` of your `mysqlTable`s, or a `prismaSchema()`. Date and time columns are read back as text, as stored.
- With Prisma on MySQL, pass a function: `mysqlStore((sql, params) => /^\s*SELECT/i.test(sql) ? prisma.$queryRawUnsafe(sql, ...params) : prisma.$executeRawUnsafe(sql, ...params).then((affectedRows) => ({ affectedRows })))`.

## SQLite

> New in 0.6.

```ts
import { DatabaseSync } from "node:sqlite";
import { createDpdp } from "dpdp-kit";
import { SQLITE_DDL, sqliteData, sqliteStore } from "dpdp-kit/sqlite";

const db = new DatabaseSync("app.db");
db.exec(SQLITE_DDL); // once; every statement is IF NOT EXISTS
const dpdp = createDpdp({ config, store: sqliteStore(db), data: sqliteData(db) });
```

- Pass a `node:sqlite` `DatabaseSync` (Node 22.5+), a better-sqlite3 `Database`, a libsql / Turso `Client`, or your own `(sql, params) => Promise<rows>` function.
- `SQLITE_DDL` creates the same tables as `DPDP_DDL`, with timestamps as ISO 8601 text in UTC and JSON as text, so everything reads back exactly as written.
- Task claims are a single `UPDATE … RETURNING`, so two runners never carry out the same task. SQLite lets one process write at a time; with several servers, use Turso or Postgres.
- `sqliteData(db, { schema })` takes a `drizzleSchema()` of your `sqliteTable`s, or a `prismaSchema()`, when the data map uses names from code. Corrections write objects and arrays as JSON text, since SQLite has no JSON or array columns.
- Needs SQLite 3.35 or later (2021) for `RETURNING`; `node:sqlite` and current better-sqlite3 and libsql all have it.

## MongoDB and Mongoose

```ts
import { createDpdp } from "dpdp-kit";
import { mongoData, mongooseSchema, mongoStore } from "dpdp-kit/mongodb";

// the official driver
const dpdp = createDpdp({ config, store: mongoStore(client.db()), data: mongoData(client.db(), { ObjectId }) });

// Mongoose: a function, so dpdp can be created before mongoose.connect()
const db = () => mongoose.connection.db;
const dpdp = createDpdp({
  config,
  store: mongoStore(db),
  data: mongoData(db, { schema: mongooseSchema(mongoose), ObjectId: mongoose.Types.ObjectId }),
});
```

- Records go into `dpdp_*` collections. The store creates their indexes before its first write, including the unique `(subjectId, seq)` index that keeps each consent chain from forking. Call `createMongoIndexes(db)` from a deploy script if the app's user can't create indexes.
- In the data map, `table` is a collection, or a Mongoose model name with `schema`. Fields are document paths, so `"address.city"` works. With a Mongoose schema, `id` means `_id`.
- Pass `ObjectId` to find people by an ObjectId `_id`. Ids that look like numbers also match number fields.
- Erasure removes a field (`$unset`), or sets the field's `erase` replacement.
- `dpdp-kit audit --schema src/models.ts` reads the Mongoose models a file exports.

## Anything else

Implement `DpdpStore`:

- consent events: `lastEvent`, `insert`, `events`
- requests and tasks: see `RequestStore` and `TaskStore`
- the access log: `insertAccess`, `listAccess`, `pruneAccess` (see `AccessLogStore`)
- breaches: see `BreachStore`. `updateBreach` must save only over the version that was read (the stored history is one entry shorter) and return `false` otherwise, so changes made at once aren't lost.
- optionally `accessSubjects`, the distinct people in matching access-log entries, so `addAffectedFromAccessLog` doesn't load every entry

`insert` must throw `SeqConflictError` on a duplicate `(subjectId, seq)`, and `claimTask` must be atomic. The built-in stores all pass the same contract tests (`test/store-contract.test.ts` in the repository); running them against your store is the quickest way to check it. A store with only the three consent methods still works for consent; rights and retention then throw `store-unsupported`.

Implement `DataAccess` (`read`, `eraseFields`, `deleteRows`) for another database. `eraseFields` receives the replacement for each column (from each field's `erase` setting); a column without one becomes null. Add `updateFields(table, subject, subjectId, values, where?)` to support `rights.correct()`.

## For tests

`memoryStore()` and `memoryData()` keep everything in memory:

```ts
import { createDpdp, memoryData, memoryStore } from "dpdp-kit";

const dpdp = createDpdp({ config, store: memoryStore(), data: memoryData() });
```
