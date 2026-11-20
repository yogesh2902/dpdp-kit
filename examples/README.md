# Example apps

Chai & Co is a small online tea shop. The same shop is built three times on the server, plus a mobile app, so you can copy whichever matches your stack:

| Example | Stack |
|---|---|
| [`prisma-express`](prisma-express/) | Express 5, Prisma 7, Postgres |
| [`mongoose-express`](mongoose-express/) | Express 5, Mongoose 9, MongoDB |
| [`next-app`](next-app/) | Next.js 16 App Router, SQLite (`node:sqlite`), with `dpdp-kit/react`'s consent screen and privacy centre |
| [`expo-app`](expo-app/) | Expo 58 (React Native), with `dpdp-kit/react-native`'s screens, calling `next-app`'s API with a Bearer token |

Each one shows the whole of dpdp-kit in about 150 lines of app code:

- **The notice** is built from the config (Rule 3), and sign-up records consent against its version (Sections 5, 6).
- **`requireConsent`** blocks a promo SMS for anyone who didn't agree.
- **`logAccess`** logs every support read of a customer record (Rule 6(1)(c)).
- **`dpdpRouter`** serves the privacy centre under `/privacy`: consents, an objection to order SMS (Section 7(a)), the person's data (Section 11), requests with acknowledgements, a correction after an identity check (Section 12), and a nominee (Section 14).
- **Withdrawal and account deletion** are carried out a year later (Rule 8(3)). Invoices are kept for 8 years under GST.
- **Grievances** come with their 90-day deadline (Rule 14(3)).
- **Breach records:** a compromised support account, the people it read found from the access log, and the 72-hour Board report (Rule 7).
- **`npm run audit`** checks the data map against the schema, and fails when someone adds an unmapped personal field.

## The journey

[`journey.mjs`](journey.mjs) plays a customer, a support agent and the privacy team through a year of that shop, over HTTP, and checks what the law asks for at each step. CI runs it against all three apps on every change, using the packed npm package, a Postgres server in IST, MongoDB 8 and SQLite.

```bash
cd prisma-express        # or mongoose-express, or next-app (npm run build first)
npm install
# see the example's README to set up the database, then:
DEMO_CLOCK=1 npm start   # in one terminal
npm run journey          # in another
```

```
1. Sign-up, with consent recorded against the notice they saw
   ✔ Asha consented to marketing_sms (notice 2026-11, in Marathi); Ravi to nothing
2. Promo SMS only to people who agreed (Section 6)
   ✔ Asha got it; Ravi was refused with 403 "You haven't agreed to this yet. ..."
...
9. A year later (Rule 8(3)): erasure runs, the GST-held invoice stays
   ✔ Asha's interests erased, phone kept; Ravi's profile deleted, invoice held 8 years; msg91 told to erase
10. Consent records survive erasure and still verify (Section 6(10))
   ✔ both hash chains verify

The whole journey passed.
```

`DEMO_CLOCK=1` adds routes that let the journey move time forward a year. Leave it off in production.

The `x-user-id` and `x-staff-id` headers stand in for your own authentication.
