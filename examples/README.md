# Example apps

Chai & Co is a small online tea shop. The same shop is built twice, so you can copy whichever one matches your stack:

| Example | Stack |
|---|---|
| [`prisma-express`](prisma-express/) | Express 5, Prisma 7, Postgres |
| [`mongoose-express`](mongoose-express/) | Express 5, Mongoose 9, MongoDB |

Each one shows the whole of dpdp-kit in about 150 lines of app code:

- **Sign-up** records consent against the notice version and language the person saw (Section 6).
- **`requireConsent`** blocks a promo SMS for anyone who didn't agree.
- **`logAccess`** logs every support read of a customer record (Rule 6(1)(c)).
- **`/me/data`** answers a request to see your data (Section 11).
- **Withdrawal and account deletion** are carried out a year later (Rule 8(3)). Invoices are kept for 8 years under GST.
- **Grievances** come with their 90-day deadline (Rule 14(3)).
- **Breach records:** a compromised support account, the people it read found from the access log, and the 72-hour Board report (Rule 7).
- **`npm run audit`** checks the data map against the schema, and fails when someone adds an unmapped personal field.

## The journey

[`journey.mjs`](journey.mjs) plays a customer, a support agent and the privacy team through a year of that shop, over HTTP, and checks what the law asks for at each step. CI runs it against both apps on every change, using the packed npm package, a Postgres server in IST and MongoDB 8.

```bash
cd prisma-express        # or mongoose-express
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
