#!/usr/bin/env node
import { runAudit, runSafeguards } from "./run-audit.js";

const HELP = `dpdp-kit — DPDP Act tooling for Node.js

Usage:
  dpdp-kit audit [--config <file>] [--schema <file>] [--strict] [--format text|github]
  dpdp-kit safeguards [--config <file>] [--strict]

  Checks your data map and purposes. With --schema, also compares the data map with your
  Drizzle schema: personal-looking columns missing from the map, and map entries that no
  longer exist.

Options:
  --config <file>   Config file (default: dpdp.config.ts / .mts / .js / .mjs)
  --schema <file>   Drizzle schema file (Postgres, MySQL or SQLite), e.g. src/db/schema.ts
  --strict          Fail on warnings too
  --format github   Also print GitHub Actions annotations, so problems show on the pull request

  safeguards reports each security safeguard of Rule 6(1), (a) to (g): what your config records
  and what's missing. With --strict, exits 1 when one is missing.
`;

const [command, ...rest] = process.argv.slice(2);

const commands: Record<string, typeof runAudit> = { audit: runAudit, safeguards: runSafeguards };
const run = command ? commands[command] : undefined;

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
