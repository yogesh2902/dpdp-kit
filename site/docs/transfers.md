---
title: Transfers outside India
description: Record where each processor handles personal data, and let the audit check it against the restrictions you list.
---

> New in 0.5.

The Act allows personal data to go abroad, with two limits:

- **Section 16(1)**: the Central Government may restrict transfers to countries it notifies. None are notified as of November 2026.
- **Rule 15**: making data available to a foreign State, or to an entity it controls, is subject to requirements the Central Government sets by order.

Section 16(2) also keeps stricter sector laws in force, such as the RBI's rule that payment data is stored only in India.

dpdp-kit doesn't know which countries are restricted, and doesn't guess. You record where each processor handles the data and what restricts you; the audit checks one against the other.

## Say where each processor is

```ts
processors: {
  razorpay: { purposes: ["payments"], contract: "MSA clause 12", countries: ["IN"] },
  posthog:  { purposes: ["analytics"], contract: "DPA s.4", countries: ["US", "DE"] },
},
transfers: {
  restricted: [],              // countries notified under Section 16(1), when there are any
  keepInIndia: ["payments"],   // purposes another law keeps in India (Section 16(2))
},
```

- **`countries`**: ISO 3166-1 alpha-2 codes in capitals. List every country where the processor's servers or support staff can reach the data, not only where it is stored.
- **`foreignState: true`**: the processor is a foreign State, or an entity under its control or one of its agencies (Rule 15).
- **`transfers.restricted`**: you keep this list up to date as notifications are made.
- **`transfers.keepInIndia`**: purposes whose data must stay in India.

## What the audit checks

| Code | Level | When |
|---|---|---|
| `transfer-restricted` | error | A processor is in a country in `transfers.restricted`. |
| `transfer-outside-india` | error | A processor for a `keepInIndia` purpose is anywhere other than `"IN"`. |
| `invalid-country` | error | A code isn't two capital letters. |
| `processor-countries-missing` | warning | A processor has no `countries`. |
| `foreign-state-transfer` | warning | A processor has `foreignState: true`: check for an order that applies. |

The two warnings are new in 0.5, so they don't fail `--strict` until 0.6. See [Audit and CI](../audit/).

## What people see

`rights.summary()` adds `countries` to each processor in `sharedWith`, so a person asking what you hold (Section 11(1)(b)) also learns where it goes.

> This is a check of what you declared, not of where data really flows. It can't see a vendor that isn't in `processors`, or a processor that moves data without telling you.
