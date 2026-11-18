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
  minimumRetention: "1y",
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

// 4. Schema drift check against a Drizzle schema: a matching schema passes, a drifted one fails
const audit = (schema) => {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["dist/cli.js", "audit", "--config", "test/fixtures/config.ts", "--schema", schema],
      { encoding: "utf8" },
    );
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout) };
  }
};
if (audit("test/fixtures/schema.ts").code !== 0) fail("matching schema should pass");
const drifted = audit("test/fixtures/schema-drift.ts");
if (drifted.code !== 1 || !drifted.stdout.includes("schema.users.aadhaar_number")) {
  fail(`drifted schema should fail and name aadhaar_number:\n${drifted.stdout}`);
}
console.log("✔ dpdp-kit audit --schema");

// 5. Rights request + erasure running through the built package
{
  const { memoryData } = await import("dpdp-kit");
  let t = Date.parse("2026-11-17T00:00:00Z");
  const data = memoryData({ users: [{ id: "u1", phone: "98xxxxxx01" }] });
  const kit = createDpdp({ config, store: memoryStore(), data, now: () => new Date(t) });
  const request = await kit.rights.open("u1", "erasure");
  await kit.rights.erase("u1", { requestId: request.id });
  t += 366 * 24 * 60 * 60 * 1000;
  const report = await kit.retention.run();
  if (report.failed.length > 0 || data.tables.users.length !== 0) fail("erasure did not run");
  if ((await kit.rights.get(request.id)).status !== "resolved") fail("erasure request not resolved");
}
console.log("✔ rights + retention");

// 6. Security safeguards: access log, field encryption, and the Rule 6 report
{
  const { createEncryptor, generateKey, maskAadhaar } = await import("dpdp-kit/protect");
  const kit = createDpdp({ config, store: memoryStore() });
  await kit.access.log({ actor: "support", subjectId: "u1", purpose: "account", fields: ["users.phone"] });
  if ((await kit.access.list({ subjectId: "u1" })).length !== 1) fail("access log entry missing");
  const enc = createEncryptor({ keys: { k1: generateKey() }, current: "k1" });
  if (enc.decrypt(enc.encrypt("123412341234", "u1"), "u1") !== "123412341234") fail("encryption round trip");
  if (maskAadhaar("123412341234") !== "XXXX XXXX 1234") fail("aadhaar mask");
  const report = execFileSync(process.execPath, ["dist/cli.js", "safeguards", "--config", "test/fixtures/config.ts"], { encoding: "utf8" });
  if (!report.includes("(f) Security safeguards in contracts")) fail(`safeguards output:\n${report}`);
}
console.log("✔ access log + dpdp-kit/protect + dpdp-kit safeguards");

console.log(`All smoke checks passed on Node ${process.version}`);
