# Chai & Co on Next.js and SQLite

The shop from the other examples, on the Next.js App Router, with dpdp-kit's records and the shop's own tables in one SQLite file (`node:sqlite`, Node.js 22.5+).

- `/` signs up, then shows `<ConsentNotice>` from `dpdp-kit/react`: the notice's own text, every purpose switched off, "Accept selected" and "Reject all" alike.
- `/privacy` is `<PrivacyCentre>`: choices, your data, requests, a nominee, and how to reach us.
- `app/privacy/[...path]/route.ts` mounts the API those screens call, with `createHandlers` from `dpdp-kit/next`.
- `app/[...path]/route.ts` is the rest of the shop's API (orders, a promo that needs consent, logged support reads, breaches, the evidence report), the same as the Express examples, so `../journey.mjs` runs against it.

```bash
npm install
npm run build && DEMO_CLOCK=1 npm start   # DEMO_CLOCK lets the journey move time forward
npm run journey                            # in another terminal
```

Sign-in is a cookie set at sign-up, or an `x-user-id` header: replace `lib/auth.ts` with your own authentication. `DB_FILE` picks the database file (default `.data/chai.db`).
