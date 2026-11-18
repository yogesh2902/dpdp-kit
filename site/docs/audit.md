---
title: Audit and CI
description: Fail the build when the data map is wrong, or when it drifts from your database.
---

## Run the audit

```bash
npx dpdp-kit audit            # exit code 1 on errors
npx dpdp-kit audit --strict   # also fail on warnings
```

```
✖ error    data.users.fields.phone.purposes
             Unknown purpose "acount". Declare it under `purposes` or fix the spelling.
⚠ warning  fiduciary.grievanceUrl
             Add where people can raise a grievance. Section 8(10) requires a grievance mechanism, and Section 5(1)(ii) requires the notice to say how to use it.
```

The config is found automatically (`dpdp.config.ts` and similar), or pass `--config path`. The same checks run when the app starts: `createDpdp` throws if the config has errors.

## Catch schema drift

A data map is only useful while it matches the database. Point the audit at your Drizzle schema (Postgres, MySQL or SQLite), your Prisma schema or your Mongoose models:

```bash
npx dpdp-kit audit --schema src/db/schema.ts
npx dpdp-kit audit --schema prisma/schema.prisma   # or a folder of .prisma files
npx dpdp-kit audit --schema src/models.ts          # a file that exports Mongoose models
```

```
✖ error    schema.users.aadhaar_number
             Looks like personal data (identity, matched "aadhaar") but isn't in the data map. Add it under `data`
             with the purposes it's held for, or add "users.aadhaar_number" to `notPersonal`.
✖ error    data.users.fields.interests
             Column "interests" isn't in table "users". Fix the name, or remove it if the column was dropped.
⚠ warning  schema.users.gender
             Looks like personal data (identity, matched "gender") but isn't in the data map. ...
```

It checks both directions:

- **New personal columns nobody mapped.** Columns are recognised by name: phone and email, Aadhaar, PAN, passport and voter ID, date of birth, names, addresses and PIN codes, UPI, IFSC and bank details, IP addresses and device IDs, health, biometric and location data. Clear cases are errors. Columns that are personal only sometimes, like `name`, `gender` or `city`, or anything named for a company or branch, are warnings.
- **A data map that points at nothing.** Tables or columns that were renamed or dropped.
- **Erase settings a column can't take.** Erasing a `NOT NULL` column to null, or writing text into a number column. See [Erasure](../erasure/).
- **Foreign keys that break a legal hold.** Account deletion deletes the person's rows but keeps held ones, like invoices kept for GST. A foreign key from the held table to the users table defeats that:
  - `ON DELETE CASCADE` deletes the invoices with the account (an error).
  - `SET NULL` on the subject column loses whose invoices they are (an error).
  - `RESTRICT`, Prisma's default for a required relation, makes the deletion fail (a warning).

  Keep the link as a plain, indexed column instead.

Columns that describe data rather than hold it, such as `email_verified_at`, `phone_confirmed` and `address_type`, are not flagged. For anything that only looks personal, list it under `notPersonal` in the config:

```ts
notPersonal: ["products.name", "branches.*"], // database table and column names
```

From code, `checkSchema(config, drizzleSchema(schema))` returns the same issues. `drizzleSchema` comes from `dpdp-kit/drizzle`, `prismaSchema(text)` from `dpdp-kit/prisma`, and `mongooseSchema(models)` from `dpdp-kit/mongodb`. Mongoose models are tables named after their collections, with the model name as a key; nested fields are paths like `profile.phone`, and `id` means `_id`.

With Prisma, the data map can use model and field names or the database's: `table: "User"` and `table: "users"` both work for a model with `@@map("users")`, and so do `phoneNumber` and `phone_number` for a field with `@map("phone_number")`. The same goes for `notPersonal`.

> Matching is by column name, so it can't see personal data hidden inside a JSON column or a vaguely named field. Review those by hand.

## In GitHub Actions

Add the audit to any workflow (it's on the [GitHub Marketplace](https://github.com/marketplace/actions/dpdp-kit-audit) as DPDP Kit Audit). Problems show up as annotations on the pull request, plus a summary on the run page:

```yaml
# .github/workflows/dpdp.yml
name: DPDP
on: [pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci                       # so your config can import dpdp-kit
      - uses: yogesh2902/dpdp-kit@main
        with:
          schema: src/db/schema.ts        # optional: also check for drift
          # config: dpdp.config.ts        # default: found automatically
          # strict: true                  # fail on warnings too
          # working-directory: apps/api   # for monorepos
```

`@main` follows the latest code; to pin a released version, use its tag, e.g. `yogesh2902/dpdp-kit@v0.3.0` (each release is on the [releases page](https://github.com/yogesh2902/dpdp-kit/releases)). The Action runs the dpdp-kit your project installed, falling back to `npx dpdp-kit@latest`. It sets `errors` and `warnings` outputs. Annotations need dpdp-kit 0.2.0 or later; with 0.1.x the check still runs and fails the build, without annotations.

## Other CI systems

`npx dpdp-kit audit --format github` prints the same annotation lines anywhere. In any other CI, the plain `audit` command and its exit code are enough to fail a build.
