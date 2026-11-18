---
title: Security and access logs
description: Rule 6 safeguards in code: an access log with review, field encryption, virtual tokens, masking, and a report of what's in place.
---

Rule 6(1) of the DPDP Rules lists the minimum "reasonable security safeguards to prevent personal data breach", (a) to (g). Failing to take them (Section 8(5)) carries the Act's highest penalty: up to **₹250 crore** (Schedule, item 1).

| Rule 6(1) | What it asks | In dpdp-kit |
|---|---|---|
| (a) | Encryption, obfuscation, masking or virtual tokens | `dpdp-kit/protect`, and `protect` on each field |
| (b) | Control access to computer resources | `security.accessControl`, as evidence |
| (c) | Logs, monitoring and review of access | `dpdp.access.log()`, `review()`, `logAccess` middleware |
| (d) | Continued processing after a compromise, such as backups | `security.backups`, as evidence |
| (e) | Keep the logs and personal data for one year | the access log keeps a year; `minimumRetention` |
| (f) | Security provisions in contracts with Data Processors | `contract` on each processor |
| (g) | Technical and organisational measures | `security.measures`, as evidence |

> dpdp-kit can't secure your servers. It gives you the safeguards that belong in application code, and a place to write down the rest so the audit can tell you what's missing.

## The access log

Rule 6(1)(c) asks for "visibility on the accessing of such personal data, through appropriate logs, monitoring and review". Record each access with who, whose, why and what:

```ts
await dpdp.access.log({
  actor: "support:priya",            // who: a staff user or a service
  subjectId: userId,                 // whose data (or subjectIds: [...] for an export)
  purpose: "account",                // why: one of your purposes
  fields: ["users.phone", "orders"], // what: "table.field", or a whole table
  action: "read",                    // read (default), export, update, delete, search…
  reason: "ticket 4411",
  evidence: { ip: req.ip },
});
```

Fields are checked against the data map. A field that isn't held for the purpose is recorded as `outOfPurpose`. To refuse such reads instead, create the instance with `access: { outOfPurpose: "throw" }`: the attempt is still logged, then `DpdpError("out-of-purpose")` is thrown.

### Log whole routes

```ts
import { logAccess } from "dpdp-kit/express"; // or "dpdp-kit/hono"

app.get("/admin/users/:id", logAccess(dpdp, {
  purpose: "account",
  fields: ["users"],
  actor: (req) => req.staff?.id,
  subject: (req) => req.params.id,
  evidence: (req) => ({ ip: req.ip }),
}), handler);
```

The entry is written before the handler runs. If the route has no person, nothing is logged; if it has no actor, the request fails, because every access to personal data needs someone accountable.

### Review it

```ts
const { findings } = await dpdp.access.review(); // the last day; run it daily
```

It reports three kinds of finding:

| Kind | Means |
|---|---|
| `out-of-purpose` | Fields were read for a purpose they aren't held for |
| `no-consent` | Data was used for a consent purpose when the person hadn't consented, at that moment |
| `bulk-access` | One actor reached more than `maxSubjects` people (default 100) within `window` (default `"1h"`) |

```ts
await dpdp.access.review({ from: "2027-06-01T00:00:00Z", to: "2027-06-08T00:00:00Z", window: "1h", maxSubjects: 50 });
await dpdp.access.list({ actor: "support:priya", from: "2027-06-01T00:00:00Z" }); // investigate
```

### Keep a year

Rule 6(1)(e) requires keeping the logs for a year "for enabling the detection of unauthorised access, its investigation, remediation". `prune()` deletes only what's older than `security.accessLogRetention` (default and minimum `"1y"`):

```ts
await dpdp.access.prune(); // from the same daily job as retention.run()
```

## Encryption, tokens and masking

Rule 6(1)(a) names "encryption, obfuscation, masking or the use of virtual tokens mapped to that personal data". `dpdp-kit/protect` has all three, built on Node's own `crypto`.

### Encrypt fields

```ts
import { createEncryptor, generateKey } from "dpdp-kit/protect";

// generateKey() once, then keep the key in your secrets manager
const enc = createEncryptor({ keys: { k1: process.env.DPDP_KEY_1! }, current: "k1" });

const stored = enc.encrypt(user.aadhaar, `users.aadhaar:${user.id}`);
const aadhaar = enc.decrypt(stored, `users.aadhaar:${user.id}`);
```

- **AES-256-GCM**, with a random IV for every value, so the same value never encrypts the same way twice.
- **Tamper-evident:** decrypting a changed value throws `DpdpError("decrypt-failed")`.
- **Bound to its row:** the optional context (`users.aadhaar:42`) must match on decrypt, so a value copied to another row won't decrypt there.
- **Key rotation:** add a key and make it `current`. Old values still decrypt; `needsRotation(value)` tells you which to re-encrypt.

### Look values up without storing them in the clear

Encrypted values can't be searched, so store a token beside them:

```ts
import { createTokenizer } from "dpdp-kit/protect";

const tokens = createTokenizer({ key: process.env.DPDP_TOKEN_KEY!, normalize: (v) => v.trim().toLowerCase() });
const emailToken = tokens.token(email); // the same email always gives the same token
// WHERE email_token = $1
```

Use a different key from encryption. Without the key, a token reveals nothing about the value.

### Mask for screens and logs

```ts
import { maskAadhaar, maskEmail, maskPan, maskPhone } from "dpdp-kit/protect";

maskAadhaar("1234 5678 9012");  // "XXXX XXXX 9012"
maskPan("ABCDE1234F");          // "XXXXXX234F"
maskPhone("+91 98765 43210");   // "+91 ••••••3210"
maskEmail("asha.k@gmail.com");  // "a•••••@gmail.com"
```

## Write down the rest

Say how each field is stored, where each processor's contract covers security, and what you do outside code:

```ts
export default defineConfig({
  // …
  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        aadhaar: { category: "identity", purposes: ["kyc"], protect: "encrypted" },
        email:   { category: "contact", purposes: ["account"], protect: "hashed" },
      },
    },
  },
  processors: {
    msg91: { purposes: ["marketing_sms"], contract: "DPA signed 2026-03-01, clause 7" }, // Rule 6(1)(f)
  },
  security: {
    accessControl: "SSO with least-privilege roles; production through a bastion",   // (b)
    backups: "Encrypted daily backups, restore tested monthly",                       // (d)
    measures: "Annual security training and quarterly access reviews",                // (g)
    accessLogRetention: "1y",                                                         // (e)
  },
});
```

`protect` is one of `"encrypted"`, `"tokenised"`, `"masked"` or `"hashed"`. The audit warns when a high-risk identifier (Aadhaar, PAN, passport, voter ID, driving licence, ABHA, bank account, card number, or any health or biometric field) has none, when a processor has no `contract`, and when a `security` entry is missing.

## The safeguards report

```bash
npx dpdp-kit safeguards
```

```
Rule 6(1) of the DPDP Rules: reasonable security safeguards

✔ (a) Encryption, obfuscation, masking or virtual tokens  [declared]
      users.aadhaar: encrypted
✔ (b) Access control to computer resources  [declared]
      SSO with least-privilege roles; production through a bastion
◆ (c) Logs, monitoring and review of access  [in-code]
      Record access with dpdp.access.log() and run dpdp.access.review() daily to find unauthorised access.
…
```

`--strict` exits with 1 when a safeguard is missing or partly recorded, so it can gate CI. The report reads your config, not your infrastructure: keep the descriptions true.

## Storage

The access log needs the `dpdp_access_log` table. Export `accessLog` from `dpdp-kit/drizzle` in your schema, or run `ACCESS_LOG_DDL`. See [Storage](../storage/).
