---
title: Breach records
description: Record a personal data breach, tell the people affected, and meet the Board's 72-hour deadline.
---

Section 8(6) of the Act and Rule 7 of the DPDP Rules set out what to do on becoming aware of a personal data breach. Failing to notify carries a penalty of up to **₹200 crore** (Schedule, item 2).

| Who | When | What (Rule 7) |
|---|---|---|
| Each affected person | Without delay | (a) what happened, how much and when, (b) the likely consequences for them, (c) what you're doing about it, (d) what they can do to protect themselves, (e) who can answer their questions |
| The Board | Without delay | The nature, extent, timing, location and likely impact |
| The Board | **Within 72 hours** of becoming aware, or a longer period the Board allows on a written request | (i) updated details, (ii) the facts and reasons, (iii) mitigation, (iv) findings about who caused it, (v) remedial measures, (vi) a report on the notices given to people |

> dpdp-kit keeps the record and the clocks. It doesn't contact the Board or send messages for you: you send them, then record that you did.

## Open a breach

```ts
const breach = await dpdp.breach.open({
  awareAt: "2027-06-01T08:00:00Z",       // when you became aware: the 72 hours start here (default now)
  occurredAt: "2027-05-30T22:00:00Z",
  description: "A misconfigured storage bucket exposed order exports.",
  extent: "About 1,200 customers' phone numbers and addresses.",
  location: "ap-south-1 storage bucket",
  likelyImpact: "Phishing calls and messages",
  fields: ["users.phone", "orders"],      // what was exposed, from the data map
});
// breach.reportDueAt: "2027-06-04T08:00:00.000Z"
```

## Find who's affected

```ts
await dpdp.breach.addAffected(breach.id, userIds);

// everyone a compromised account read, from the access log
await dpdp.breach.addAffectedFromAccessLog(breach.id, { actor: "support:ravi", from: "2027-05-01T00:00:00Z" });
```

People already recorded are left as they are, so you can add from several sources.

## Tell them

```ts
await dpdp.breach.update(breach.id, {
  consequences: "You may receive unwanted calls or messages.",
  measures: "We closed the bucket and are reviewing all storage permissions.",
  safetySteps: "Be careful with calls asking for OTPs; we never ask for them.",
});

const notice = await dpdp.breach.notice(breach.id);
// notice.text: Rule 7(1)(a)–(e) in plain words, with your fiduciary.dpo as the contact
// notice.missing: parts still to fill in; send only when it's empty

for (const batch of await dpdp.breach.pending(breach.id, 500)) { /* … */ }
await dpdp.breach.markNotified(breach.id, sentIds, { channel: "email" });
```

The notice comes in English: translate it into each person's language before sending. Rule 7(1) asks for "a concise, clear and plain manner", through their account or a contact they registered with you.

## Tell the Board

```ts
await dpdp.breach.boardNotified(breach.id);            // the first intimation, without delay

await dpdp.breach.updateReport(breach.id, {
  details: "…",     // (i)
  facts: "…",       // (ii)
  mitigation: "…",  // (iii)
  findings: "…",    // (iv)
  remedial: "…",    // (v)
});
const report = await dpdp.breach.boardReport(breach.id);
// report.intimations, part (vi): { total, sent, pending, firstSentAt, lastSentAt }
// report.missing: parts (i)–(v) still empty

await dpdp.breach.reportSent(breach.id);
```

If the Board allows more time on your written request, record it:

```ts
await dpdp.breach.extend(breach.id, { until: "2027-06-06T08:00:00Z", reference: "Board letter DPB/2027/118" });
```

## Track it

```ts
const status = await dpdp.breach.status(breach.id);
// { boardNotified, report: { dueAt, hoursLeft, overdue, missing }, people: { total, sent, pending }, todo: [...] }
```

`todo` lists what's left in plain words. [`dpdp.daily()`](../daily/) includes the status of every open breach, so a missed deadline shows up in your daily report, and the `breach.opened`, `breach.reported` and `breach.closed` [events](../events/) let you alert your team.

```ts
await dpdp.breach.close(breach.id, "All notices sent, report filed");
```

## Storage

Breaches need the `dpdp_breaches` and `dpdp_breach_notices` tables: export `breaches` and `breachNotices` from `dpdp-kit/drizzle`, or run `BREACH_DDL`. See [Storage](../storage/).
