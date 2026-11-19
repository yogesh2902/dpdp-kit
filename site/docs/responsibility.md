---
title: Who does what
description: For each duty in the DPDP Act and Rules, what dpdp-kit does for you and what your company still does.
---

dpdp-kit does the engineering part of the law. Your company still decides its purposes and retention periods, writes its notices, signs its contracts and runs its processes. No library makes a company compliant: that is for the Data Protection Board to judge. This map shows where the line is, so you can plan the rest and show an auditor who does what.

Each duty is marked:

- **Built in**: dpdp-kit does it, once your config describes your data.
- **Shared**: dpdp-kit does the system part; your company does the rest.
- **Yours**: not covered yet. The roadmap column says when it's planned.

## Purpose, notice and consent

| Duty | Law | Who | dpdp-kit does | Your company does |
|---|---|---|---|---|
| Process data only for a stated purpose, with consent or a legitimate use | Sections 4, 6, 7 | Shared | A typed data map: each field lists its purposes, each purpose its basis. `audit` and `audit --schema` fail the build when a field has no purpose. | Decides the purposes, and checks that each legitimate use fits Section 7. |
| Give a notice before asking for consent | Section 5, Rule 3 | Shared | From 0.5: builds the notice from the config (itemised data, purposes, the links Rule 3(c) requires), versions it by content, records the version with each consent and saves the notice as proof. The audit checks it's complete in every language you offer. | Writes the descriptions, labels and translations, and shows the notice clearly before asking for consent. |
| Take consent that is free, specific, informed and unambiguous | Section 6(1)–(3) | Shared | Records each grant with its channel and evidence. `requireConsent` blocks processing for anyone who hasn't agreed. | Asks for consent with a clear affirmative action, per purpose, in the person's language. |
| Prove that notice and consent were given | Section 6(10) | Built in | Hash-chained consent records; `verify()` finds edited, reordered or removed events. | Keeps the latest hash somewhere the database admin can't change, so deleting the newest events is caught too. |
| Make withdrawal as easy as giving consent, then stop | Section 6(4)–(6) | Shared | `withdraw()` stops guarded processing at once, tells processors through their hooks and schedules erasure. | Puts a withdraw option in the app that is as easy to use as the one that gave consent. |
| Stop a Section 7(a) use when the person says no | Section 7(a) | Shared | From 0.5: `consent.object()` records it, and `has()`, the guards, summaries and access reviews respect it. See [Objections](../objections/). | Records and respects them in the app. |

## Keeping and erasing data

| Duty | Law | Who | dpdp-kit does | Your company does |
|---|---|---|---|---|
| Keep data complete, accurate and consistent when it is used for decisions or shared | Section 8(3) | Shared | Records correction requests with due dates; from 0.5, `rights.correct()` writes the correction and records which fields changed. | Decides what's accurate, and checks data quality where decisions depend on it. |
| Erase when consent is withdrawn or the purpose ends, unless another law says keep it | Section 8(7) | Built in | Erasure plans and the retention runner for every table or collection in the data map, with legal holds (for example GST invoices for 8 years, then anonymised). `audit --schema` checks that each column can be erased and that no foreign key breaks a hold. | Decides retention periods and legal holds, and erases copies outside the database: files, backups, caches, search indexes, analytics. |
| Keep personal data and logs of processing for at least a year | Rule 8(3) | Built in | `minimumRetention` delays erasure, and the audit enforces at least a year. | Nothing more, beyond setting the config. |
| Erase after a period of inactivity, with 48 hours' warning | Rule 8(1)–(2), Third Schedule | Yours | Not yet. Planned for a later release. | Only for the classes in the Third Schedule: e-commerce and social media platforms with at least two crore registered users, and online gaming with at least fifty lakh. |

## Processors

| Duty | Law | Who | dpdp-kit does | Your company does |
|---|---|---|---|---|
| Use a processor only under a valid contract | Section 8(2), Rule 6(1)(f) | Shared | Lists each processor with its purposes and where its contract has security provisions; the audit warns when that is missing. | Signs the contracts. |
| Make processors stop, and erase, when purposes end | Sections 6(6), 8(7)(b) | Shared | `processor-stop` and `processor-erase` tasks call your hooks on time, or become manual tasks to track. | Connects each vendor's API to its hook, or handles the manual task. |
| Transfer data outside India only where the government allows it | Section 16, Rule 15 | Shared | From 0.5: records the countries of each processor; the audit fails on a country you list as restricted, or on data another law keeps in India going abroad. See [Transfers](../transfers/). | Finds out where each vendor really handles the data, and keeps the list of restrictions current. |

## Security and breaches

| Duty | Law | Who | dpdp-kit does | Your company does |
|---|---|---|---|---|
| Encryption, obfuscation, masking or virtual tokens | Section 8(5), Rule 6(1)(a) | Shared | `dpdp-kit/protect`: AES-256-GCM with key rotation, lookup tokens, masking. The audit warns about Aadhaar, PAN, bank or health fields without `protect`. | Uses it on those fields, and keeps the keys in a secrets manager. |
| Access control | Rule 6(1)(b) | Yours | Records your measures in `security.accessControl` as evidence. | Runs access control: least-privilege roles, SSO, production access. |
| Logs, monitoring and review of access, kept a year | Rule 6(1)(c), (e) | Built in | The access log, `logAccess` middleware, a daily `review()` and pruning that keeps at least a year. | Acts on what the review finds. |
| Continued processing, such as backups | Rule 6(1)(d) | Yours | Records your measures in `security.backups` as evidence. | Runs backups and tests restores. |
| Technical and organisational measures | Rule 6(1)(g) | Yours | Records them in `security.measures`; `dpdp-kit safeguards` reports (a) to (g) and what's missing. | Training, access reviews, incident response. |
| Tell each affected person and the Board about a breach; detailed report within 72 hours | Section 8(6), Rule 7 | Shared | Breach records: the 72-hour deadline, affected people (including from the access log), a draft notice for each person, and the Board's report, parts (i) to (vi). | Detects and investigates the breach, and sends the notices and the report. |

## Contact, grievances and rights

| Duty | Law | Who | dpdp-kit does | Your company does |
|---|---|---|---|---|
| Publish a contact for questions about personal data | Section 8(9), Rule 9 | Shared | `fiduciary.dpo` in the config, checked by the audit and used in breach notices. | Publishes it on the website and in the app. |
| Run a grievance mechanism and answer within 90 days | Sections 8(10), 13, Rule 14(3) | Shared | Grievances as requests with 90-day due dates; `daily()` lists the overdue ones. | Runs the channel and writes the answers. |
| Access, correction and erasure on request, and nominations | Sections 11, 12, 14, Rule 14 | Shared | Rights requests with due dates and acknowledgements; `summary()` lists what is held; `erase()` schedules the erasure; from 0.5, `correct()` writes corrections, `nominate()` keeps nominees, `verifyIdentity()` records the identity check and can be required, and `rights.how` holds what Rule 14(1) asks you to publish. | Checks the person's identity, decides each request, and publishes how to make one on the website or app. |

## Not covered yet

| Duty | Law | Who | Your company does | Planned |
|---|---|---|---|---|
| Verifiable consent of a parent or guardian; no tracking, behavioural monitoring or targeted advertising directed at children | Section 9, Rules 10, 11 | Yours | Builds age checks and guardian consent. | Later |
| Extra duties of a Significant Data Fiduciary: a DPO based in India, an independent data auditor, periodic Data Protection Impact Assessments | Section 10, Rule 13 | Yours | Only if the government notifies the company as one. dpdp-kit's records, access logs and the [evidence report](../evidence/) can serve as evidence for the audit. | Not planned |
| Consent Managers | Sections 6(7)–6(9), Rule 4 | Yours | Integrates with a registered Consent Manager if it uses one. | Later |

## Using this map

- **To plan:** every "Shared" and "Yours" row is a task for your team. The "Your company does" column is the list.
- **With an auditor or the Board:** your config, the audit report, `dpdp-kit safeguards`, the consent history, the access log and breach records show what the system does; the rest of this map shows who owns the other parts.
- **With your lawyer:** have them review your purposes, notices and retention periods. dpdp-kit's Section and Rule references are checked against the official texts (see [The law, mapped](../law/)), but they are not legal advice.
