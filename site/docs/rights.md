---
title: Rights requests
description: Access, correction, erasure, grievances and nominations, each with a due date.
---

People can ask to see their data (Section 11), correct or erase it (Section 12), raise a grievance (Section 13) or name a nominee (Section 14). Each request is recorded with a due date.

## Open and answer requests

```ts
const request = await dpdp.rights.open(userId, "grievance", { text: "I keep getting promo SMS" });
// request.dueAt is 90 days out: Rule 14(3) caps grievance responses at ninety days

await dpdp.rights.list({ overdue: true });               // your inbox of late answers
await dpdp.rights.resolve(request.id, "Promo SMS turned off");
await dpdp.rights.reject(otherId, "Duplicate of an earlier grievance");
```

Request types: `access`, `correction`, `erasure`, `grievance` and `nomination`. Pass `{ by: "support:anita" }` to `resolve()` and `reject()` to record who answered.

## Acknowledge it (from 0.5)

```ts
const ack = await dpdp.rights.acknowledgement(request.id);
ack.text;
// "We received your grievance on 19 November 2026. Your reference is 5f0c…. We'll respond by
//  17 February 2027. Questions in the meantime: Meera Iyer, privacy@chai.example."
```

`ack` also has `reference`, `receivedAt`, `dueAt` and `contact`, if you'd rather write your own message.

## Publish how to make a request (Rule 14(1), from 0.5)

Rule 14(1) requires publishing, prominently on your website or app, how people make a request and what you need to identify them. Rule 14(3) requires publishing your answer time for grievances. Put them in the config:

```ts
rights: {
  how: "In the app: Settings → Privacy → Your data, or email privacy@chai.example",
  identifiers: ["registered mobile number"],   // Rule 14(5): a customer id, email, mobile number…
  responseWithin: { grievance: "30d" },
},
```

`dpdp.rights.how()` returns all of it, with the contact and grievance link, to show on your privacy page. The audit warns when `how` is missing.

## Check who's asking (from 0.5)

A request that arrives by email, phone or letter could come from anyone. Record how you checked:

```ts
await dpdp.rights.verifyIdentity(request.id, { method: "OTP to registered mobile", by: "support:anita" });
```

With `rights: { verify: "required" }`, `summary()`, `erase()`, `correct()` and `nominate()` refuse to act for a request (`requestId`) until this is recorded (`request-not-verified`). Calls without a request, such as a signed-in person asking about their own account, aren't held back: your sign-in is the check.

## Access (Section 11)

`summary()` reads the person's personal fields from your tables, with the purposes each is held for, their consents, and the processors their data goes to:

```ts
const summary = await dpdp.rights.summary(userId, { requestId: request.id });
// { data: [{ table: "users", fields: [...], rows: [{ phone: "98…", name: "Asha" }] }],
//   consents: ["order_updates"], legitimateUses: ["account"],
//   sharedWith: [{ name: "msg91", purposes: ["order_updates"], countries: ["IN"] }] }
```

## Erasure (Section 12(3))

Every purpose ends except those you still need for the specified purpose. Legal holds and `minimumRetention` still apply:

```ts
await dpdp.rights.erase(userId, { keepFor: ["account"], requestId: request.id }); // schedules, resolves the request
```

Before 0.5, `erase()` with a closed request scheduled the erasure and then failed. Now the request is checked first: it must be the person's, still open, and verified if you require that.

## Corrections (Section 12(2), from 0.5)

```ts
const request = await dpdp.rights.open(userId, "correction", { asked: "New mobile number" });
await dpdp.rights.correct(request.id, { "users.phone": "98xxxxxx02" }, { by: "support:anita" });
// writes the new value, records that users.phone changed (never the value), resolves the request
```

- Keys are data map fields. `where` picks some of the person's rows in one table: `{ where: { id: 42 } }` for one address of several.
- Fields in a table under a legal hold can't be corrected this way (`not-correctable`): tax and KYC records have their own procedures, and Section 12(1) defers to them.
- In MongoDB, a field inside an array can't be corrected this way either: your code knows which element is meant.
- `resolve: false` leaves the request open, for corrections in several steps.
- Needs `data` with `updateFields`. The built-in data access all have it.

## Nominations (Section 14, from 0.5)

Section 14 lets a person nominate someone to exercise their rights if they die or can no longer act; Rule 14(4) allows more than one.

```ts
const nominee = await dpdp.rights.nominate(userId, { name: "Ravi", contact: "ravi@example.in", relation: "brother" });
await dpdp.rights.nominees(userId);              // [{ id, name, contact, relation, nominatedAt }]
await dpdp.rights.revokeNominee(userId, nominee.id);
```

Each nomination is a resolved `nomination` request, so it has a history like any other. Pass `requestId` to use a nomination request you opened and verified. When a nominee later acts for the person, record that in the request's `details`; checking the death or incapacity is up to you.

## Your own answer times

Set them in the config. The Rules set ninety days for grievances only, and the audit fails above that:

```ts
rights: { responseWithin: { grievance: "30d", access: "30d" } },
```
