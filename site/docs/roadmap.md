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

## Building now: 0.4

- **Notices that meet Rule 3**, built from the config: per-language text for each purpose, labels for each field, your Data Protection Officer's contact and how to complain to the Board. Every edit gives a new notice version automatically, and each consent event stores the version the person saw.
- **Objections to a legitimate use** (Section 7(a)): a new `object` action in the consent ledger, respected by `has()`.
- **An HTTP API** for notices, consent and rights requests, on the standard Fetch `Request` and `Response`, with adapters for Express, Hono and the Next.js App Router.

## Next: 0.5 and 0.6

- **Prisma and MongoDB** stores and data access, so most Node.js teams can use dpdp-kit with the database they already have.
- **MySQL and SQLite** data access.
- **React and React Native** components: a consent notice with every toggle off by default, and a privacy centre with choices, "my data", requests and contacts.
- **Example apps** for Next.js and Expo, run in CI.

## Later

- **Children's data**: an age gate and verifiable guardian consent (Section 9, Rule 10).
- **Breach records** with the deadlines of Section 8(6) and Rule 7.
- **Inactivity erasure** with 48 hours' warning, for the platforms in the Third Schedule (Rule 8(1)–(2)).
- **Erasure beyond SQL**: files in object storage, caches, search indexes and logs.
- **Consent Manager interop** (Sections 6(7)–6(9), Rule 4).

Plans can change as the law and the community shape them. Ideas and requests are welcome as [GitHub issues](https://github.com/yogesh2902/dpdp-kit/issues).
