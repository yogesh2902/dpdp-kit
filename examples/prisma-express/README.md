# Chai & Co: Express + Prisma + Postgres

An online tea shop using [dpdp-kit](https://github.com/yogesh2902/dpdp-kit) for consent, rights requests, erasure, access logs and breach records. See [the examples overview](../README.md) for what it covers.

```bash
npm install
export DATABASE_URL=postgresql://user:password@localhost:5432/chai
npm run db:push     # creates your tables and dpdp-kit's, generates the client
npm run audit       # checks dpdp.config.ts against prisma/schema.prisma
npm start
```

## The files

- [`dpdp.config.ts`](dpdp.config.ts) is the data map: every personal field, why it's held, and what happens when it's erased. It uses Prisma model and field names (`User`, `userId`).
- [`prisma/schema.prisma`](prisma/schema.prisma) holds the shop's models, then dpdp-kit's tables, pasted from `PRISMA_MODELS`.
- [`src/dpdp.ts`](src/dpdp.ts) sets up dpdp-kit: `prismaStore` for its records, and `prismaData` for your tables.
- [`src/server.ts`](src/server.ts) is the API: sign-up with consent, the consent guard, access logging, the data summary, withdrawal, deletion, grievances and breaches.

## Two things this example gets right

- **`NOT NULL` columns say what erasing writes.** Erasing `email` to null would fail, so the config writes `erased-<id>@invalid` instead. `npm run audit` refuses a config that would fail, so the mistake is caught now rather than a year from now, when the erasure runs.
- **Orders don't use a foreign key to the user.** GST law keeps invoices for 8 years after the account is deleted. A relation would either block deleting the user, or set `userId` to null and lose track of whose invoice to anonymise later. It's a plain indexed column instead.

## Try the drift check

Add a column to `User` in `prisma/schema.prisma`:

```prisma
  panNumber String? @map("pan_number")
```

`npm run audit` now fails: `schema.users.pan_number` looks personal but isn't in the data map.
