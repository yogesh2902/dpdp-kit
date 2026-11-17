---
title: The law, mapped
description: Which Sections and Rules dpdp-kit implements, when they apply, and the texts they were checked against.
---

| The law says | Where | dpdp-kit |
|---|---|---|
| Process data only for a stated purpose, with consent or a legitimate use | Sections 4, 6, 7 | Typed data map: every field lists its purposes |
| Prove that a notice was given and consent was given | Section 6(10) | Hash-chained consent records with notice version and language |
| A notice in English or any Eighth Schedule language | Sections 5(3), 6(3) | All 22 languages built in |
| Tell processors to stop when consent is withdrawn | Section 6(6) | `processor-stop` tasks and hooks |
| Erase when consent is withdrawn or the purpose ends, unless another law says keep it | Section 8(7) | Erasure plans and the retention runner, with legal holds |
| Have processors erase too | Section 8(7)(b) | `processor-erase` tasks and hooks |
| A grievance mechanism, named in the notice | Sections 8(10), 5(1)(ii) | `fiduciary.grievanceUrl`, checked by the audit |
| Keep data, traffic data and logs of processing for at least a year | Rule 8(3) | `minimumRetention`, enforced by the audit |
| Access, correction, erasure, grievance and nomination | Sections 11–14 | Rights requests with due dates |
| Answer grievances within 90 days | Rule 14(3) | A default due date, enforced by the audit |
| Maximum penalty | Schedule, item 1 | ₹250 crore, for failing to take reasonable security safeguards |

## When the Rules apply

The DPDP Rules, 2025 were published on 13 November 2025 and start in phases (Rule 1):

- **Rule 4** (Consent Managers): one year after publication, November 2026.
- **Rules 3, 5 to 16, 22 and 23**, including notices, security safeguards, breaches, retention and erasure, children, and rights requests: **18 months after publication, May 2027.**

Building this in now gives you time to test before those obligations start.

## Legal sources

- **The Digital Personal Data Protection Act, 2023** (No. 22 of 2023), Gazette of India Extraordinary, Part II Section 1, 11 August 2023 (CG-DL-E-12082023-248045). Every Section reference has been checked against this text.
- **The Digital Personal Data Protection Rules, 2025**, G.S.R. 846(E), 13 November 2025 (MeitY copy). Every Rule reference has been checked against this text.
- **Corrigendum G.S.R. 892(E)**, 10 December 2025, published 11 December 2025 (CG-DL-E-12122025-268455). It makes 8 wording corrections, to Rule 1(3)–(4), Rule 11, Rule 19, the First Schedule and the Fourth Schedule. None changes anything cited here.

Report a wrong or outdated reference as an [issue on GitHub](https://github.com/yogesh2902/dpdp-kit/issues). It's treated as a bug.

> **Not legal advice.** dpdp-kit helps you put compliance into practice; it does not make an app compliant on its own. Have your own lawyer review your purposes, notices and retention periods.
