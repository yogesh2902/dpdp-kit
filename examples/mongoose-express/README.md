# Chai & Co: Express + Mongoose + MongoDB

An online tea shop using [dpdp-kit](https://github.com/yogesh2902/dpdp-kit) for consent, rights requests, erasure, access logs and breach records. See [the examples overview](../README.md) for what it covers.

```bash
npm install
export MONGODB_URL=mongodb://localhost:27017/chai
npm run audit       # checks dpdp.config.ts against the models in src/models.ts
npm start
```

dpdp-kit creates its own collections and indexes (`dpdp_*`) on first use.

## The files

- [`dpdp.config.ts`](dpdp.config.ts) is the data map: every personal field, why it's held, and what happens when it's erased. It uses Mongoose model names (`User`), and `id` means `_id`.
- [`src/models.ts`](src/models.ts) holds the shop's Mongoose models.
- [`src/dpdp.ts`](src/dpdp.ts) sets up dpdp-kit: `mongoStore` for its records, and `mongoData` for your collections. It's given `() => mongoose.connection.db`, so it can be created before Mongoose connects.
- [`src/server.ts`](src/server.ts) is the API: sign-up with consent, the consent guard, access logging, the data summary, withdrawal, deletion, grievances and breaches.

## Try the drift check

Add a field to the `User` schema in `src/models.ts`:

```ts
      aadhaarNumber: String,
```

`npm run audit` now fails: `schema.users.aadhaarNumber` looks personal but isn't in the data map. Fields inside subdocuments and arrays (`addresses: [addressSchema]`) are checked too.
