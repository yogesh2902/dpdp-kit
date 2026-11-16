#!/usr/bin/env node
import { runAudit } from "./run-audit.js";

const HELP = `dpdp-kit — DPDP Act tooling for Node.js

Usage:
  dpdp-kit audit [--config <file>] [--strict]   Check your data map and purposes

Options:
  --config <file>   Config file (default: dpdp.config.ts / .mts / .js / .mjs)
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
