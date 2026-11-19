---
title: Evidence report
description: One document of what your config declares and what your records show, for an auditor, a lawyer or the Data Protection Board.
---

> New in 0.5.

"Are we compliant?" is a question for a lawyer. "What do we actually do?" can be answered from your records. The evidence report puts it in one document: what personal data you hold and why, who you share it with, your safeguards, the notices people saw, how many consents and requests you handled, whether erasure is on time, what the access review found, and where your breaches stand. It ends with what needs attention.

## From your app

```ts
import { formatEvidence } from "dpdp-kit";
import { writeFileSync } from "node:fs";

const report = await dpdp.evidence({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" });
writeFileSync("evidence-2026-10.md", formatEvidence(report));
```

Without `from` and `to`, it covers the last 30 days. `report` is plain data too, if you'd rather build your own page or PDF.

| Section | From | Law |
|---|---|---|
| What needs attention | Everything below | |
| Data Fiduciary, purposes, personal data held, processors and countries | The config | Sections 4 to 8, 16 |
| Security safeguards | The config | Rule 6(1) |
| How people exercise their rights | `rights.how`, answer times | Rule 14 |
| Notices shown | Saved notices: version, language, kind, first shown | Section 5, Rule 3 |
| Consent | Events in the period by action and purpose; people granting or objecting now | Sections 6, 7(a) |
| Rights requests | Opened and answered in the period, answered late, open past due | Sections 11 to 14 |
| Erasure | Tasks by status, and tasks past their due date | Section 8(7), Rule 8 |
| Access review | `access.review()` for the period | Rule 6(1)(c) |
| Breaches | Each open breach, or one that began in the period | Section 8(6), Rule 7 |
| Configuration audit | `audit()` | |

The built-in stores count consent events and erasure tasks in the database, so a large consent record isn't loaded into memory. Rights requests are counted in memory, and the access review reads every log entry in the period, so use shorter periods if either is large. A store that doesn't keep something says so in that section ("Not available") rather than leaving it out.

## From the command line

The config-only parts need no database:

```bash
npx dpdp-kit evidence --static --out evidence.md
npx dpdp-kit evidence --static --format json --out evidence.json
```

It exits 1 when the config has audit errors.

## What it is, and isn't

The report says what dpdp-kit recorded and what your config declares. It is evidence of practice, and it says so at the top. It isn't a certificate of compliance: it can't see systems dpdp-kit isn't connected to, a safeguard described in the config is only as true as the description, and whether your purposes, notices and retention periods are right is for your lawyer. See [Who does what](../responsibility/).
