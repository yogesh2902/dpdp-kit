---
title: Introduction
description: dpdp-kit builds India's Digital Personal Data Protection Act, 2023 into your Node.js backend.
---

If your app has users in India and stores even a phone number, the **Digital Personal Data Protection Act, 2023** applies to you. The **DPDP Rules, 2025** were notified on 13 November 2025, and most of their obligations start in **May 2027**: notices, security safeguards, breach reporting, erasure and rights requests.

Most teams handle this with a privacy policy page and a spreadsheet. Nothing in the code enforces either, so they drift. dpdp-kit puts the obligations in your code, where CI can check them.

## What it does

- **Declare why you hold each piece of personal data**, in one typed config file. A misspelt purpose is a type error.
- **Keep consent records that show tampering.** Each person's grants and withdrawals form a hash chain, with the notice version and language they saw.
- **Know what to erase, and erase it.** When consent is withdrawn or an account is deleted, get a plan (which fields go, which stay and why, which tables are under a legal hold, which third parties to tell), then let the retention runner carry it out on time.
- **Handle a breach on time.** Record it, find and tell the people affected, and track the Board's 72-hour deadline (Section 8(6), Rule 7).
- **Show who touched what.** An access log records who read whose data and why, flags reads outside a field's purpose, and keeps a year of entries (Rule 6). Encryption, tokens and masking come in `dpdp-kit/protect`.
- **Answer rights requests on time.** Access, correction, erasure, grievance and nomination requests are recorded with due dates.
- **Check it in CI.** `dpdp-kit audit` fails the build when the data map is inconsistent, and `--schema` catches drift between the map and your Drizzle, Prisma or Mongoose schema. The GitHub Action puts each problem on the pull request.

## Node-native

dpdp-kit is a TypeScript library that runs **inside your Node.js process**, not a service you call.

- **No separate server.** Nothing to deploy, no sidecar, no REST API between your code and your consent records.
- **No hosted service.** No account, no API key, no network calls. Personal data never leaves your infrastructure.
- **Your own database.** Records go into your own Postgres through the Drizzle setup you already have.
- **Fits your Node stack.** Typed config, guards for Express, Hono, Fastify and NestJS, a CLI for CI. Works with ESM, `require()` and TypeScript.

> **Not legal advice.** dpdp-kit helps you put compliance into practice; it does not make an app compliant on its own. Section and Rule references point you to the text so you can check them. Have your own lawyer review your purposes, notices and retention periods. [Who does what](../responsibility/) lists every duty, and which part dpdp-kit does.

## Requirements

- Node.js 20.19 or later. The package is ESM-only; `require("dpdp-kit")` also works on those Node versions.
- For storage and data access: Drizzle ORM 0.38 or later with Postgres. Anything else can implement the store interfaces.

Next: the [quick start](quick-start/) takes you from install to a passing audit and your first consent record.
