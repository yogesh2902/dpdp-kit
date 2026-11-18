# Changelog

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
- **Daily upkeep**: `dpdp.daily()` (erasure, access-log pruning and review, overdue requests) and `startDaily()` in `dpdp-kit/schedule`.

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
