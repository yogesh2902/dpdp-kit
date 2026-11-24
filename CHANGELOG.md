# Changelog

## 0.6.0

**From the database to the consent screen.** A ready-made consent screen and privacy centre for React, Next.js and React Native, a typed client for the HTTP API, and stores on SQLite and MySQL. A 0.5 app that changes nothing keeps working; the one deliberate change is that warnings added in 0.5 now fail `--strict`, as 0.5 announced.

### Added

- **`dpdp-kit/client`**: a typed client for the HTTP API, one method per route (`notice`, `languages`, `consents`, `grant`, `withdraw`, `object`, `liftObjection`, `data`, `requests`, `openRequest`, `nominees`, `nominate`, `revokeNominee`, and `admin.*`). Errors throw `DpdpClientError { status, code }`. `headers` (for a mobile app's Bearer token) and `credentials` (cookies on another origin). It imports types only: 4 KB, nothing from Node.js.
- **`dpdp-kit/react`**, for React and the Next.js App Router (marked `"use client"`):
  - `<ConsentNotice>`: the notice's own text (what the server saves as proof) in the person's language, a switch per purpose with **every switch off to start**, and "Accept selected" and "Reject all" alike. The grant is recorded with the notice's version.
  - `<PrivacyCentre>` with `<ConsentSettings>` (each consent purpose in the notice's words with the full notice beside it, Section 5(1); objecting to a Section 7(a) use asks for confirmation), `<MyData>` (with a JSON download), `<Requests>`, `<Nominees>` and `<HowToReachUs>`, each usable alone.
  - Hooks: `DpdpProvider`, `useConsents` (changes show at once and are undone if refused), `useNotice`, `useNoticeLanguages`, `useMyData`, `useRequests`, `useNominees`, `useRights`, `useDpdpClient`.
  - Unstyled semantic HTML with `dpdp-*` classes, `role="switch"` and live regions, checked with axe-core; all text in `labels`. Optional `dpdp-kit/react/styles.css`: no specificity (`:where()`), custom properties, dark mode with `data-dpdp-theme="dark" | "auto"`.
- **`dpdp-kit/react-native`**: the same screens from `View`, `Text`, `Switch`, `Pressable` and `TextInput`, on the same hooks; `theme` (`light`, `dark`, `auto`), `colors`, `labels`; VoiceOver and TalkBack labels; a share sheet for the data copy.
- **`dpdp-kit/sqlite`**: `sqliteStore` and `sqliteData` for `node:sqlite`, better-sqlite3, libsql/Turso or any query function. `SQLITE_DDL` is `DPDP_DDL` with timestamps as UTC text and JSON as text.
- **`dpdp-kit/mysql`**: `mysqlStore` and `mysqlData` for MySQL 8 through mysql2 or Prisma. `MYSQL_DDL` uses `JSON` and `DATETIME(3)` in UTC, read back as text so no driver or server time zone shifts them (tested on a server in IST).
- **HTTP API**: `GET /notice/languages`; `channel` can be a function of the request (record `"ios"` or `"android"` from your mobile app); the response types (`ConsentsResponse`, `PersonRequest`, …) are exported and the handler is checked against them.
- **Data summaries** carry each field's `label`, so people see "Mobile number" rather than "phone".
- **Examples**: `examples/next-app` (Next.js App Router on SQLite, with the consent screen and privacy centre; the year-long journey runs against it in CI) and `examples/expo-app` (the React Native screens, calling the Next.js example with a Bearer token).
- **A store contract suite** runs the same tests for every store method on every built-in store: memory, Postgres three ways, MongoDB, SQLite and MySQL.

### Upgrading from 0.5.x

1. **`--strict`**: the warnings added in 0.5 (`legitimate-use-clause-missing`, `rights-how-missing`, `processor-countries-missing`, `foreign-state-transfer`, `notice-label-missing`) now fail `dpdp-kit audit --strict`. Set `legitimateUse` on each legitimate use, `rights.how`, `countries` on each processor and field `label`s, or run without `--strict`.
2. **Nothing else to do.** The new entry points are opt-in. `react` and `react-native` are optional peer dependencies; SQLite and MySQL users create the tables with `SQLITE_DDL` or `MYSQL_DDL`.
3. **Custom stores** can be checked against the contract tests in `test/store-contract.test.ts` in the repository.

## 0.5.1

**Dual licence.** dpdp-kit is now available under MIT or Apache-2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE`). Apache-2.0 adds an explicit patent grant. Versions up to 0.5.0 remain MIT. No changes to the library.

## 0.5.0

**Notices, objections, complete rights requests, transfers, an HTTP API and an evidence report.** A 0.4 app that changes nothing keeps working: everything new is opt-in, and new audit warnings don't fail `--strict` until 0.6.

### Added

- **Privacy notices** (Section 5, Rule 3), with `notice` in the config:
  - `dpdp.notice.build()` / `show()` build the notice from the config: each consent purpose with its description, the itemised data (`label` on fields), the links Rule 3(c) requires and how to complain to the Board.
  - English is built in; other languages come from `notice.translations`, which you supply. The audit checks each translation is complete.
  - Each notice is versioned by its content, per language and kind (`"consent"` or `"existing-users"`), and saved the first time it's shown (`dpdp_privacy_notices`), as proof under Section 6(10). Reusing a version label for different text throws `notice-version-conflict`.
  - `consent.grant()` records the version and language shown, when `config.notice` is set and you don't pass a `noticeVersion`.
- **Objections** (Section 7(a)): `legitimateUse: "7(a)"` … `"7(i)"` on legitimate-use purposes.
  - `consent.object()` and `consent.liftObjection()` add `object` and `lift-objection` events to the same hash chain.
  - `has()` is false for an objected 7(a) purpose; guards answer `reason: "objected"`; `access.review()` reports `objected` reads; `rights.summary()` lists `objections`.
  - An objection plans erasure like a withdrawal (fields, never rows). Lifting it cancels the tasks it scheduled that haven't run (new task status `cancelled`).
- **Rights requests, completed** (Sections 11 to 14, Rule 14):
  - `rights.correct(requestId, { "users.phone": "…" }, { where })` writes a correction through the new optional `DataAccess.updateFields` (all built-in data access have it) and records which fields changed, never the values.
  - `rights.verifyIdentity()` records the identity check; `rights: { verify: "required" }` makes summaries, erasure and corrections for a request wait for it.
  - `rights.acknowledgement()` gives the reference, due date and contact to send; `rights.how()` and `rights.how` / `rights.identifiers` in the config publish Rule 14(1) information.
  - `rights.nominate()`, `nominees()` and `revokeNominee()` (Section 14). `resolve`, `reject`, `erase` and `correct` take `by`, recorded in the history.
  - New events: `rights.verified`, `rights.corrected`, `rights.nominated`.
- **Cross-border transfers** (Section 16, Rule 15): `countries` and `foreignState` on processors, and `transfers: { restricted, keepInIndia }`. The audit errors on a processor in a restricted country, or abroad for a purpose that must stay in India. `rights.summary().sharedWith` lists countries.
- **HTTP API** for a privacy centre, a consent screen or a mobile app: `dpdpRouter` (`dpdp-kit/express`), `dpdpRoutes` (`dpdp-kit/hono`) and `createHandlers` (new `dpdp-kit/next`, Web `Request`/`Response` only), over `handle()`.
  - Routes for the notice, consents, objections, the person's data, rights requests and nominees, plus optional `/admin` routes for your privacy team.
  - The person comes only from your authentication; POST must be JSON; bodies are limited; `limitWrites` can refuse floods; errors answer `{ error: code }` only. Paths it doesn't serve go on to your own handlers.
- **Evidence report**: `dpdp.evidence({ from, to })` and `formatEvidence()`: the data map, processors and countries, Rule 6 safeguards, Rule 14 information, notices shown, consent counts, rights requests, erasure, the access review and breaches, ending with what needs attention. The built-in stores count consent events and tasks in the database. `npx dpdp-kit evidence` writes the config-only parts.
- **New audit checks**: errors for invalid clauses, countries, notice links, descriptions and translations (only when you use those settings); warnings `legitimate-use-clause-missing`, `rights-how-missing`, `processor-countries-missing`, `foreign-state-transfer` and `notice-label-missing`. Warnings new in 0.5 are reported but don't fail `--strict` until 0.6 (`Issue.since`).
- **Releases from GitHub Actions** with npm provenance.

### Upgrading from 0.4.x

1. **Storage.**
   - Plain SQL or Drizzle tables from `DPDP_DDL`: run `MIGRATE_0_5_DDL` once (from `dpdp-kit/postgres` or `dpdp-kit/drizzle`). It lets the consent table accept objections and creates `dpdp_privacy_notices`. It's safe to run twice. Drizzle users can instead add `privacyNotices` to their schema and generate a migration.
   - Prisma: add the new `DpdpPrivacyNotice` model from `PRISMA_MODELS` and run `prisma migrate dev`.
   - MongoDB: nothing to do.
2. **Types that grew.** `ConsentAction` adds `"object" | "lift-objection"`, `ErasureReason` adds `"objection"`, `TaskStatus` adds `"cancelled"`, and there are new events and error codes. A `switch` that lists every case needs the new ones. `consent.history()` now includes objections when there are any.
3. **Guards** may answer `{ error: "consent_required", reason: "objected" }` for a 7(a) purpose the person objected to.
4. **`rights.erase({ requestId })`** now needs an open `erasure` request for that person, checked before anything is scheduled. `summary(subjectId, { requestId })` checks that the request is the person's and open. With `verify: "required"`, both also need the identity check.
5. **Custom stores and data access.** `NoticeStore`, `StatsStore` and `DataAccess.updateFields` are optional: without them, saved notices, database counts in the evidence report and corrections aren't available, and everything else works.
6. **Audit.** Run `npx dpdp-kit audit` and fill in what the new warnings ask for (`legitimateUse` on each legitimate use, `rights.how`, `countries` on processors) before 0.6, when they start failing `--strict`.

## 0.4.1

The GitHub Action's description is now short enough for the GitHub Marketplace (under 125 characters), so this release can be listed there. No changes to the library.

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
