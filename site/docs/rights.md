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

Request types: `access`, `correction`, `erasure`, `grievance` and `nomination`.

## Access (Section 11)

`summary()` reads the person's personal fields from your tables, with the purposes each is held for, their consents, and the processors their data goes to:

```ts
const summary = await dpdp.rights.summary(userId);
// { data: [{ table: "users", fields: [...], rows: [{ phone: "98…", name: "Asha" }] }],
//   consents: ["order_updates"], legitimateUses: ["account"],
//   sharedWith: [{ name: "msg91", purposes: ["order_updates"] }] }
```

## Erasure (Section 12(3))

Every purpose ends except those you still need for the specified purpose. Legal holds and `minimumRetention` still apply:

```ts
await dpdp.rights.erase(userId, { keepFor: ["account"], requestId: request.id }); // schedules, resolves the request
```

## Corrections and nominations

These are recorded with the request (`details`). Your app applies them, then calls `resolve()`.

## Your own answer times

Set them in the config. The Rules set ninety days for grievances only, and the audit fails above that:

```ts
rights: { responseWithin: { grievance: "30d", access: "30d" } },
```
