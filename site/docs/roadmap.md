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

## Building now: 0.3

- **Security safeguards and access logs** (Rule 6): **built**, shipping in 0.3. An access log with review and one-year retention, `dpdp-kit/protect` for encryption, virtual tokens and masking, `protect` / `contract` / `security` in the config, the `dpdp-kit safeguards` report, and `logAccess` middleware. See [Security and access logs](../security/).
- **Notices that meet Rule 3**, built from the config: per-language text for each purpose, labels for each field, your Data Protection Officer's contact and how to complain to the Board. Every edit gives a new notice version automatically, and each consent event stores the version the person saw. The audit checks that every offered language is complete.
- **Objections to a legitimate use** (Section 7(a)): a new `object` action in the consent ledger, respected by `has()`.
- **An HTTP API** for notices, consent and rights requests, on the standard Fetch `Request` and `Response`, with adapters for Express, Hono and the Next.js App Router. The person is always taken from your session, never the request body, and a stale notice version is rejected.

## Next: 0.4 and 0.5

- **A typed client** (`dpdp-kit/client`) for browsers, React Native and Node, with zero dependencies.
- **React hooks and components** (`dpdp-kit/react`): a consent notice with every toggle off by default, and a privacy centre with choices, "my data", requests and contacts. Accessible, themable, and safe for Next.js.
- **React Native screens** (`dpdp-kit/react-native`) built from core components only, so they work in Expo Go.
- **Example apps** for Next.js and Expo, run in CI.

## Later: 0.6 and beyond

- **Children's data**: an age gate and verifiable guardian consent (Section 9, Rule 10).
- **Breach records** with the deadlines of Section 8(6) and Rule 7.
- **Inactivity erasure** with 48 hours' warning, for the platforms in the Third Schedule (Rule 8(1)–(2)).
- **More databases**: MySQL and SQLite data access, and a Prisma store.
- **Consent Manager interop** (Sections 6(7)–6(9), Rule 4).

Plans can change as the law and the community shape them. Ideas and requests are welcome as [GitHub issues](https://github.com/yogesh2902/dpdp-kit/issues).
