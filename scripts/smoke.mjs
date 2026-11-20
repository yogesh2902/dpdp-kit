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
{
  const { formatEvidence, staticEvidence } = await import("dpdp-kit");
  const md = formatEvidence(staticEvidence(defineConfig({ fiduciary: { name: "Smoke" }, purposes: { a: { basis: "legitimate-use", retain: "while-active" } }, data: {} })));
  if (!md.startsWith("# DPDP Act evidence: Smoke")) fail("formatEvidence");
}
{
  const { createHandlers } = await import("dpdp-kit/next");
  const { GET } = createHandlers(createDpdp({ config: defineConfig({ fiduciary: { name: "S" }, purposes: { a: { basis: "legitimate-use", retain: "while-active" } }, data: {}, rights: { how: "email" } }), store: memoryStore() }), { base: "/p", subject: () => undefined });
  const res = await GET(new Request("http://x/p/rights"));
  if (res.status !== 200 || (await res.json()).how !== "email") fail("dpdp-kit/next GET /rights");
}
{
  // The client, against the real API through a fetch that calls the Next.js handlers.
  const { createHandlers } = await import("dpdp-kit/next");
  const { createClient, DpdpClientError } = await import("dpdp-kit/client");
  const dpdp = createDpdp({ config: defineConfig({ fiduciary: { name: "S" }, purposes: { a: { basis: "consent", retain: "while-active" } }, data: {}, rights: { how: "email" } }), store: memoryStore() });
  const handlers = createHandlers(dpdp, { base: "/p", subject: (req) => req.headers.get("x-user") ?? undefined });
  const client = createClient({ base: "http://x/p", headers: { "x-user": "u1" }, fetch: (url, init) => handlers[init.method](new Request(url, init)) });
  await client.grant(["a"]);
  if ((await client.consents()).consents[0] !== "a") fail("dpdp-kit/client grant + consents");
  const anonymous = createClient({ base: "http://x/p", fetch: (url, init) => handlers[init.method](new Request(url, init)) });
  const err = await anonymous.consents().catch((e) => e);
  if (!(err instanceof DpdpClientError) || err.status !== 401 || err.code !== "unauthenticated") fail("dpdp-kit/client errors");
}
{
  // dpdp-kit/react renders on the server (Next.js) without touching the network or the DOM.
  const { DpdpProvider, useConsents } = await import("dpdp-kit/react");
  const { createElement } = await import("react");
  const { renderToString } = await import("react-dom/server");
  let fetched = false;
  const Screen = () => createElement("p", null, useConsents().loading ? "loading" : "ready");
  const html = renderToString(createElement(DpdpProvider, { options: { fetch: () => ((fetched = true), Promise.reject(new Error("no"))) } }, createElement(Screen)));
  if (html !== "<p>loading</p>" || fetched) fail(`dpdp-kit/react server render: ${html}`);
  const { PrivacyCentre } = await import("dpdp-kit/react");
  const centre = renderToString(createElement(DpdpProvider, { options: { fetch: () => Promise.reject(new Error("no")) } }, createElement(PrivacyCentre)));
  if (!centre.includes('class="dpdp-centre"') || !centre.includes("Loading…")) fail("dpdp-kit/react <PrivacyCentre> server render");
  const css = createRequire(import.meta.url).resolve("dpdp-kit/react/styles.css");
  if (!css.endsWith("dist/react.css")) fail(`dpdp-kit/react/styles.css resolves to ${css}`);
}
await import("dpdp-kit/fastify");
await import("dpdp-kit/nestjs");
await import("dpdp-kit/schedule");
await import("dpdp-kit/drizzle");
await import("dpdp-kit/postgres");
// node:sqlite arrived in Node 22.5; on 20.19 the sqlite entry still loads, for better-sqlite3 or libsql.
{
  const { SQLITE_DDL, sqliteStore } = await import("dpdp-kit/sqlite");
  const sqlite = await import("node:sqlite").catch(() => undefined);
  if (sqlite) {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(SQLITE_DDL);
    const dpdp = createDpdp({ config: defineConfig({ fiduciary: { name: "S" }, purposes: { a: { basis: "consent", retain: "while-active" } }, data: {} }), store: sqliteStore(db) });
    await dpdp.consent.grant("u1", ["a"]);
    if (!(await dpdp.consent.verify("u1")).ok) fail("dpdp-kit/sqlite");
  }
}

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

// 7. Breach records
{
  const kit = createDpdp({ config, store: memoryStore() });
  const breach = await kit.breach.open({ description: "Smoke test breach" });
  await kit.breach.addAffected(breach.id, ["u1"]);
  const status = await kit.breach.status(breach.id);
  if (status.people.total !== 1 || status.report.hoursLeft !== 72) fail(`breach status: ${JSON.stringify(status)}`);
}
console.log("✔ breach records");


// 8. Prisma and plain-SQL Postgres, on PGlite
{
  const { PGlite } = await import("@electric-sql/pglite");
  const { DPDP_DDL } = await import("dpdp-kit/postgres");
  const { prismaStore, prismaSchema, PRISMA_MODELS } = await import("dpdp-kit/prisma");
  const db = new PGlite();
  await db.exec(DPDP_DDL);
  const prisma = { $queryRawUnsafe: async (text, ...params) => (await db.query(text, params)).rows };
  const kit = createDpdp({ config, store: prismaStore(prisma) });
  await kit.consent.grant("u1", ["promo"]);
  if ((await kit.consent.verify("u1")).ok !== true) fail("prisma store chain");
  if (prismaSchema(PRISMA_MODELS).tables.length !== 7) fail("PRISMA_MODELS parse");
  await db.close();
}
console.log("✔ dpdp-kit/prisma + dpdp-kit/postgres");
// 9. MongoDB: the module loads without the driver, and reads a Mongoose-shaped model
{
  const { mongoStore, mongoData, mongooseSchema } = await import("dpdp-kit/mongodb");
  const User = { modelName: "User", collection: { collectionName: "users" }, schema: { paths: { phone: { instance: "String" }, _id: { instance: "ObjectId" } }, virtuals: { id: {} } } };
  const schema = mongooseSchema([User]);
  if (schema.tables[0]?.name !== "users" || schema.tables[0].columns[1]?.key !== "id") fail(`mongooseSchema: ${JSON.stringify(schema)}`);
  if (typeof mongoStore(() => undefined).insert !== "function" || typeof mongoData(() => undefined).read !== "function") fail("mongo store shape");
}
console.log("✔ dpdp-kit/mongodb");
console.log(`All smoke checks passed on Node ${process.version}`);
