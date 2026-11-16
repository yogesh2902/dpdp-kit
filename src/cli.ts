#!/usr/bin/env node
import { runAudit } from "./run-audit.js";

const HELP = `dpdp-kit — DPDP Act tooling for Node.js

Usage:
  dpdp-kit audit [--config <file>] [--schema <file>] [--strict]

  Checks your data map and purposes. With --schema, also compares the data map with your
  Drizzle schema: personal-looking columns missing from the map, and map entries that no
  longer exist.

Options:
  --config <file>   Config file (default: dpdp.config.ts / .mts / .js / .mjs)
  --schema <file>   Drizzle schema file (Postgres, MySQL or SQLite), e.g. src/db/schema.ts
  --strict          Fail on warnings too
`;

const [command, ...rest] = process.argv.slice(2);

if (command === "audit") {
  runAudit(rest, process.cwd(), (line) => console.log(line)).then(
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
