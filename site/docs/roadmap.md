---
title: Roadmap
description: What's shipped, what's being built now, and what's planned.
---

dpdp-kit is growing from a backend toolkit into a full-stack one: the same `dpdp.config.ts` will drive the screens people see, on the web and on mobile. It ships in milestones, each tested end to end before its npm release.

## Shipped

| Version | Adds |
|---|---|
| **0.1** | Config and types, `audit` and the CLI, consent records, erasure plans, the Drizzle store, Express and Hono guards |
| **0.1.2** | Schema drift check: `audit --schema`, `checkSchema`, `drizzleSchema`, `notPersonal` |
| **0.2.0** | Rights requests (Sections 11–14, Rule 14), the retention runner that carries out erasure (Section 8(7), Rule 8(3), legal holds), processor hooks, `drizzleData`, and the GitHub Action with pull request annotations |
| **0.3.0** | [Security safeguards and access logs](../security/) (Rule 6), Fastify and NestJS [guards](../guards/), [events](../events/), `erase` replacements for `NOT NULL` columns, and [daily upkeep](../daily/) |
| **0.4.0** | [Breach records](../breaches/) (Section 8(6), Rule 7) with the 72-hour Board report; [Prisma, MongoDB and Mongoose](../storage/) stores and data access; drift checks on Prisma schemas and Mongoose models; [example apps](https://github.com/yogesh2902/dpdp-kit/tree/main/examples) run in CI |
| **0.5.0** | [Notices](../notices/) that meet Rule 3, built from the config and saved as proof; [objections](../objections/) to a Section 7(a) use; [rights requests](../rights/) completed (corrections, identity checks, nominees, acknowledgements); [cross-border transfers](../transfers/) (Section 16); an [HTTP API](../http/) for Express, Hono and Next.js; the [evidence report](../evidence/); npm releases with provenance |

## Building now: 0.6

- **React and React Native** components on top of the HTTP API: a consent notice with every toggle off by default, and a privacy centre.
- **MySQL and SQLite** data access.
- **Example apps** for Next.js and Expo, run in CI like the Prisma and Mongoose ones.

## Later

- **Children's data**: an age gate and verifiable guardian consent (Section 9, Rule 10).
- **Inactivity erasure** with 48 hours' warning, for the platforms in the Third Schedule (Rule 8(1)–(2)).
- **Erasure beyond SQL**: files in object storage, caches, search indexes and logs.
- **Consent Manager interop** (Sections 6(7)–6(9), Rule 4).

Plans can change as the law and the community shape them. Ideas and requests are welcome as [GitHub issues](https://github.com/yogesh2902/dpdp-kit/issues).
