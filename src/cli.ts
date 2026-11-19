#!/usr/bin/env node
import { runAudit, runEvidence, runSafeguards } from "./run-audit.js";

const HELP = `dpdp-kit — DPDP Act tooling for Node.js

Usage:
  dpdp-kit audit [--config <file>] [--schema <file>] [--strict] [--format text|github]
  dpdp-kit safeguards [--config <file>] [--strict]
  dpdp-kit evidence [--config <file>] [--static] [--format markdown|json] [--out <file>]

  Checks your data map and purposes. With --schema, also compares the data map with your
  Drizzle, Prisma or Mongoose schema: personal-looking columns missing from the map, map entries that no
  longer exist, and erase settings a column can't take.

Options:
  --config <file>   Config file (default: dpdp.config.ts / .mts / .js / .mjs)
  --schema <file>   Drizzle schema file (Postgres, MySQL or SQLite), e.g. src/db/schema.ts,
                    or Prisma schema, e.g. prisma/schema.prisma (or a folder of .prisma files)
                    or a file that exports Mongoose models, e.g. src/models.ts
  --strict          Fail on warnings too
  --format github   Also print GitHub Actions annotations, so problems show on the pull request

  safeguards reports each security safeguard of Rule 6(1), (a) to (g): what your config records
  and what's missing. With --strict, exits 1 when one is missing.

  evidence writes the parts of the evidence report that come from the config: purposes, the data
  map, processors and countries, Rule 6 safeguards, Rule 14 information, the audit and what needs
  attention. For consent counts, requests, erasure, the access review and breaches, call
  dpdp.evidence() in your app and pass it to formatEvidence().
`;

const [command, ...rest] = process.argv.slice(2);

const commands: Record<string, typeof runAudit> = { audit: runAudit, safeguards: runSafeguards, evidence: runEvidence };
const run = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;

if (run) {
  run(rest, process.cwd(), (line) => console.log(line)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
} else {
  console.log(HELP);
  process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 1;
}
