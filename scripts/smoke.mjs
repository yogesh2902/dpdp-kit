// Runs the built package (dist/) the way users will: ESM import, require(), and the CLI.
// CI runs this on the oldest Node version the package supports.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

// 1. ESM import through the package's own exports map
const { createDpdp, defineConfig, memoryStore } = await import("dpdp-kit");
const { requireConsent } = await import("dpdp-kit/express");
await import("dpdp-kit/hono");
await import("dpdp-kit/drizzle");

const config = defineConfig({
  fiduciary: { name: "Smoke Test", grievanceUrl: "/grievance" },
  purposes: {
    account: { basis: "legitimate-use", retain: "while-active" },
    promo: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },
  data: {
    users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: ["account", "promo"] } } },
  },
  logs: { minimumRetention: "1y" },
});

const dpdp = createDpdp({ config, store: memoryStore() });
await dpdp.consent.grant("u1", ["promo"], { language: "hi" });
if (!(await dpdp.consent.has("u1", "promo"))) fail("grant was not recorded");
const { erasure } = await dpdp.consent.withdraw("u1", ["promo"]);
if (erasure.tables[0]?.fields[0]?.action !== "keep") fail("phone should be kept for account");
if (!(await dpdp.consent.verify("u1")).ok) fail("chain did not verify");
if (typeof requireConsent(dpdp, "promo", { subject: () => "u1" }) !== "function") fail("express guard");
console.log("✔ ESM import");

// 2. require() of the ESM build (Node 20.19+)
const require = createRequire(import.meta.url);
if (typeof require("dpdp-kit").createDpdp !== "function") fail("require('dpdp-kit')");
console.log("✔ require()");

// 3. CLI on a TypeScript config
const out = execFileSync(process.execPath, ["dist/cli.js", "audit", "--config", "test/fixtures/config.ts"], {
  encoding: "utf8",
});
if (!out.includes("No problems found")) fail(`CLI output:\n${out}`);
console.log("✔ dpdp-kit audit");

console.log(`All smoke checks passed on Node ${process.version}`);
