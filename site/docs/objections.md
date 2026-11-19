---
title: Objections
description: Record when someone says they don't want their data used for a Section 7(a) purpose, and stop using it.
---

> New in 0.5.

Section 7(a) lets you use data a person gave you voluntarily, for the purpose they gave it, without asking for consent: an SMS receipt for an order, a delivery to the address they typed in. It holds only while the person "has not indicated … that she does not consent". Once they tell you they don't want it, you must stop. dpdp-kit records that objection in the same tamper-evident chain as consent, and everything that checks purposes respects it.

## Mark the purposes that can be objected to

Only purposes that rely on Section 7(a) accept objections. Say which clause each legitimate use relies on:

```ts
purposes: {
  account:  { basis: "legitimate-use", legitimateUse: "7(b)", retain: "while-active" },
  receipts: { basis: "legitimate-use", legitimateUse: "7(a)", retain: "while-active" },
  offers:   { basis: "consent", retain: { afterWithdrawal: "0d" } },
},
```

`legitimateUse` is one of `"7(a)"` to `"7(i)"`. A purpose without it behaves as before 0.5: it is always allowed. The audit reports an error for a clause that doesn't exist, or for `legitimateUse` on a consent purpose.

## Object and change your mind

```ts
await dpdp.consent.has(userId, "receipts");        // true: nobody has objected
const { erasure, tasks } = await dpdp.consent.object(userId, ["receipts"], { channel: "app" });
await dpdp.consent.has(userId, "receipts");        // false
await dpdp.consent.objections(userId);             // ["receipts"]

await dpdp.consent.liftObjection(userId, ["receipts"]);
await dpdp.consent.has(userId, "receipts");        // true again
```

- `object()` and `liftObjection()` accept only Section 7(a) purposes. Anything else throws a `DpdpError` with code `not-objectable`: for a consent purpose, use `withdraw()` instead.
- Objections are events in the consent record, with `action: "object"` or `"lift-objection"`. `history()` and `verify()` include them; `active()` still lists only granted consent.
- Repeating an objection records it again but schedules nothing twice.

## What an objection erases

An objection plans erasure the way a withdrawal does (see [Erasure and retention](../erasure/)): each field held only for objected or ended purposes is erased, after your `minimumRetention` where you set one. Fields still needed for another purpose are kept, and whole rows are never deleted, because the person still has an account with you.

When the person later withdraws consent too, data held "for" the purpose they objected to is no longer kept on its account.

Lifting an objection cancels the erasure tasks it scheduled that haven't run yet (their status becomes `cancelled`). Data already erased stays erased.

## Everything else that respects it

| Where | What happens |
|---|---|
| `consent.has()` and the [route guards](../guards/) | Refuse the purpose. The guard's 403 body has `reason: "objected"` and a message that points to privacy settings. |
| `rights.summary()` | Lists the purpose under `objections`, not `legitimateUses`. Processors used only for it drop out of `sharedWith`. |
| `access.review()` | An access logged for the purpose after the objection is an `objected` finding. |
| [Events](../events/) | `consent.objected` with `{ event, erasure, tasks }`, and `consent.objection-lifted` with `{ event, cancelled, tasks }`. |

## Upgrading the database

Tables created with 0.4's `DPDP_DDL` or `CONSENT_EVENTS_DDL` only accept `grant` and `withdraw`. Run `MIGRATE_0_5_DDL` once (exported by `dpdp-kit/postgres` and `dpdp-kit/drizzle`). It is safe to run twice, and on tables created by drizzle-kit or Prisma. Drizzle users can generate a migration instead: the schema now declares the same check. MongoDB needs nothing. See [Storage](../storage/).
