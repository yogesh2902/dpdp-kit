---
title: Roadmap
description: What's shipped, and what's coming next.
---

## Shipped

| Version | Adds |
|---|---|
| **0.1** | Config and types, `audit` and the CLI, consent records, erasure plans, the Drizzle store, Express and Hono guards |
| **0.1.2** | Schema drift check: `audit --schema`, `checkSchema`, `drizzleSchema`, `notPersonal` |
| **0.2.0** | Rights requests (Sections 11–14, Rule 14), the retention runner that carries out erasure (Section 8(7), Rule 8(3), legal holds), processor hooks, `drizzleData`, and the GitHub Action with pull request annotations |

## Next

- **Notices** that meet Rule 3, built from the config in every offered language, with an automatic notice version.
- **Objections to a legitimate use** (Section 7(a)), recorded in the consent ledger and respected by `has()`.
- **An HTTP API** for notices, consent and rights requests, with Express, Hono and Next.js adapters.
- **React and React Native** consent screens and a privacy centre.
- **Children's data** and verifiable guardian consent (Section 9, Rule 10).
- **Breach records** with their deadlines (Section 8(6), Rule 7).
- **Inactivity erasure** with 48 hours' warning, for the platforms in the Third Schedule (Rule 8(1)–(2)).
- **More databases:** MySQL and SQLite data access, and a Prisma store.

Ideas and requests are welcome as [GitHub issues](https://github.com/yogesh2902/dpdp-kit/issues).
