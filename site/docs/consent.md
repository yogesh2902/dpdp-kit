---
title: Consent records
description: Record consent with what people saw, and keep a record that shows tampering.
---

Section 6(10) puts the burden on you: if consent is questioned in a proceeding, the Data Fiduciary must prove that a notice was given and consent was given. dpdp-kit records each grant and withdrawal with the evidence you need.

## Grant and check

```ts
await dpdp.consent.grant(userId, ["marketing_sms", "analytics"], {
  noticeVersion: "2026-11",
  language: "hi",          // English or any of the 22 Eighth Schedule languages (Sections 5(3), 6(3))
  channel: "android",
  evidence: { ip: req.ip },
});

await dpdp.consent.has(userId, "marketing_sms");   // true
await dpdp.consent.active(userId);                 // ["marketing_sms", "analytics"]
await dpdp.consent.history(userId);                // every event, oldest first
await dpdp.consent.verify(userId);                 // { ok: true, events: 1 }
```

`has()` answers "do I hold consent, or not need it, for this purpose?". It is always `true` for legitimate-use purposes. Under Section 7(a) you must still stop once the person tells you they don't want their data used; recording that objection is on the [roadmap](../roadmap/).

## Withdraw

```ts
const { erasure } = await dpdp.consent.withdraw(userId, ["analytics"]);
```

Withdrawal is recorded in the same chain, and the erasure it causes is scheduled. See [Erasure and retention](../erasure/).

## How the record works

- Events are only ever added. Each has `seq` (1, 2, 3… per person), `prevHash` and `hash`, a SHA-256 over the event's fields and the previous hash.
- Two writes for the same person at once can't fork the chain. The second hits the `(subjectId, seq)` key and retries on top of the first.
- `verify()` recomputes every hash. It catches an edited event, a deleted event in the middle, and reordering.
- Consent records are never erased by the retention runner: you need them to prove consent, and Rule 8(3) requires keeping records of processing.

> **Limitation:** deleting the *latest* events leaves a shorter chain that still verifies. To catch that, save `history().at(-1).hash` somewhere the database admin can't change, such as your logs or another system, and compare.

## Languages

`language` accepts English (`"en"`) and the 22 languages of the Eighth Schedule to the Constitution. Sections 5(3) and 6(3) give people the right to a notice, and a consent request, in any of them. The language is stored with each event, so you can show which notice text someone agreed to.
