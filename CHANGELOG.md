# Changelog

## 0.4.0

**Prisma, MongoDB and Mongoose, and breach records (Section 8(6), Rule 7).** dpdp-kit now runs on the database you already have, and it records a personal data breach against the Board's 72-hour deadline.

### Added

- **Breach records** (Section 8(6), Rule 7): `dpdp.breach.open()` starts the 72-hour clock from when you became aware.
  - Record who is affected (`addAffected`), or everyone a compromised account read (`addAffectedFromAccessLog`).
  - `notice()` drafts the message to each person, Rule 7(1)(a)–(e), with your DPO as the contact.
  - `markNotified()`, `boardNotified()`, `updateReport()` and `boardReport()` cover the detailed report to the Board, Rule 7(2)(b)(i)–(vi). `reportSent()` records sending it, and `extend()` records the Board's written extension.
  - `status()` says what's left to do. `daily()` includes every open breach.
  - New events: `breach.opened`, `breach.reported` and `breach.closed`.
  - Changes made at the same time are all kept, and a closed breach can't change.
- **`dpdp-kit/prisma`**:
  - `prismaStore(prisma)` keeps consent, requests, tasks, the access log and breaches. `prismaData(prisma, { schema })` reaches your own tables.
  - `prismaSchema(text)` reads `schema.prisma`: models, `@map` and `@@map`, native types, enums and lists.
  - `PRISMA_MODELS` holds dpdp-kit's tables as Prisma models. `prisma migrate diff` finds no difference from `DPDP_DDL`.
  - Works inside `prisma.$transaction` with `prismaStore(tx)`. Tested on Prisma 7 with `@prisma/adapter-pg`.
- **`dpdp-kit/postgres`**: the same store and data access for any client that runs a `$1`-parameterised query: node-postgres, postgres.js, Kysely, Knex. Also exports `DPDP_DDL` without needing `drizzle-orm`.
- **`dpdp-kit/mongodb`**:
  - `mongoStore(db)` keeps dpdp-kit's records in `dpdp_*` collections and creates its indexes itself.
  - `mongoData(db, { schema, ObjectId })` reaches your own collections, including nested fields and fields inside arrays of subdocuments.
  - `mongooseSchema(models)` feeds the drift check.
  - Accepts the driver's `Db`, or `() => mongoose.connection.db` so dpdp can be created before Mongoose connects.
- **`audit --schema` reads Prisma and Mongoose:**
  - `--schema prisma/schema.prisma`, or a folder of `.prisma` files.
  - `--schema src/models.ts` for a file that exports Mongoose models.
  - The data map and `notPersonal` can use model and field names (`User`, `phoneNumber`) as well as the database's names.
- **Foreign keys that break a legal hold** (`audit --schema`, Drizzle and Prisma). A link from a held table, like invoices kept for GST, to the users table:
  - `ON DELETE CASCADE` would delete the invoices with the account: error `held-rows-cascade`.
  - `SET NULL` on the subject column would lose whose they are: error `held-link-lost`.
  - `RESTRICT`, Prisma's default for a required relation, makes the deletion fail: warning `held-rows-block-delete`.
- **A `contact-missing` audit warning** when `fiduciary.dpo` isn't set. Section 8(9) requires publishing it, and every breach notice needs it (Rule 7(1)(e)).
- **Example apps** in `examples/`: the same shop on Express + Prisma + Postgres and on Express + Mongoose + MongoDB. `examples/journey.mjs` takes them through a year: consent, a blocked promo, access logs, a data request, withdrawal, a grievance, deletion, a breach and erasure. CI runs the journey on every change.

### Fixed

- **Timestamps on a server in IST.** Prisma's pg adapter shifts `timestamptz` values by the server's time zone. The SQL store reads timestamps back as UTC text, so consent records, deadlines and summaries are exact on a server set to `Asia/Kolkata`. CI now runs its Postgres in IST.

### Upgrading from 0.3.x

1. **New tables.**
   - Drizzle: add `breaches` and `breachNotices` to your schema and generate a migration, or run `BREACH_DDL`.
   - Prisma: add `PRISMA_MODELS`.
   - MongoDB: nothing to do; the collections are created on first use.
2. **New audit checks.**
   - If you run `dpdp-kit audit --strict`, set `fiduciary.dpo` (your Data Protection Officer, or a contact person, with their business contact) first.
   - With `--schema`, a foreign key from a table with a `legalHold` to a table whose rows account deletion removes is now reported. Keep that link as a plain, indexed column (see the messages).
3. **Custom stores.**
   - Breach records need `BreachStore`. Without it, `dpdp.breach` throws `store-unsupported` and `daily()` skips breaches.
   - `updateBreach` must save only over the version it read, and return `false` otherwise (see `BreachStore`).
   - `AccessLogStore.accessSubjects` is optional and new.

## 0.3.0

**Security safeguards and access logs (Rule 6 of the DPDP Rules)**, plus Fastify and NestJS guards, events, `NOT NULL` erasure and daily upkeep.

### Added

- **Access log** (Rule 6(1)(c), (e)): `dpdp.access.log()`, `list()`, `review()` and `prune()`. Records who accessed whose personal data, for which purpose and which fields; flags fields read for a purpose they aren't held for (or refuses them with `access: { outOfPurpose: "throw" }`). `review()` reports out-of-purpose reads, consent purposes used without consent at the time, and bulk access (`ignoreActors` exempts batch jobs). `prune()` keeps at least a year.
- **`dpdp-kit/protect`** (Rule 6(1)(a)): `createEncryptor` (AES-256-GCM, tamper detection, row-binding context, key rotation), `createTokenizer` (keyed HMAC tokens for lookups), `mask`, `maskPhone`, `maskEmail`, `maskAadhaar`, `maskPan`, `generateKey`.
- **Rule 6 in the config and audit**: `protect` on fields, `contract` on processors, a `security` block (`accessControl`, `backups`, `measures`, `accessLogRetention`). New audit warnings: `unprotected-high-risk-field`, `processor-contract-missing`, `security-measure-missing`; new errors: `access-log-retention-too-short`, `invalid-erase`.
- **`npx dpdp-kit safeguards`**: Rule 6(1)(a)–(g), what's recorded and what's missing; `--strict` fails on gaps.
- **Guards**: `dpdp-kit/fastify` (`requireConsent`, `logAccess` as `preHandler` hooks) and `dpdp-kit/nestjs` (`consentGuard`, `accessLogGuard`), plus `logAccess` for Express and Hono.
- **Events**: `dpdp.on()` for `consent.granted`, `consent.withdrawn`, `erasure.scheduled`, `retention.ran`, `rights.opened`, `rights.closed`, `access.logged`, `daily.ran`.
- **`erase` on fields**: `"null"` (default), `"redact"` or `{ value }` (fixed or a function), so `NOT NULL` and `UNIQUE` columns can be erased.
- **Daily upkeep**: `dpdp.daily()` (erasure, access-log pruning and review, overdue requests) and `startDaily()` in `dpdp-kit/schedule`. Each step runs even if another fails (failures are in `report.errors`), and `startDaily` starts each review where the last successful one ended, so a failed night isn't skipped.
- **`audit --schema` checks erase settings against the columns**: `erase-not-null` when a `NOT NULL` column would be erased to `NULL`, `erase-type-mismatch` when the replacement doesn't fit the column. Without it, such a mistake shows up only when the task runs, often a year later.
- NestJS guards take a `request` option for GraphQL and other non-HTTP contexts; the Fastify guard falls back to 403 if `onDenied` sends nothing; event listeners each get their own copy of the payload; concurrent consent writes for one person back off with jitter.

### Upgrading from 0.2.x

1. **New table.** Add `accessLog` to your Drizzle schema (`export { accessLog } from "dpdp-kit/drizzle"`) and generate a migration, or run `ACCESS_LOG_DDL`.
2. **New audit warnings.** If you run `dpdp-kit audit --strict`, add a `security` block and a `contract` for each processor first, and mark high-risk fields with `protect` (or the build will fail on the new warnings).
3. **Custom `DataAccess`.** `eraseFields` now gets an optional fifth argument with each column's replacement value. Implementations that ignore it keep writing `NULL`, as before.
4. **Custom stores.** The access log needs `AccessLogStore` (`insertAccess`, `listAccess`, `pruneAccess`). Without it, `dpdp.access` throws `store-unsupported` and `daily()` skips it.

## 0.2.0

Rights requests (Sections 11–14, Rule 14), the retention runner (Section 8(7), Rule 8(3), legal holds), processor hooks, `drizzleData`, and the GitHub Action with pull request annotations.

## 0.1.2

Schema drift check: `audit --schema`, `checkSchema`, `drizzleSchema`, `notPersonal`.

## 0.1.0

Typed config, `audit` and the CLI, hash-chained consent records, erasure plans, the Drizzle store, Express and Hono guards.
