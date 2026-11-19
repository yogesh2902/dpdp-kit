// Section 16 and Rule 15: say where each processor handles the data, and the audit checks it
// against the restrictions you list.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audit, createDpdp, defineConfig, type DpdpConfig, memoryData, memoryStore } from "../src/index.js";
import { runAudit } from "../src/run-audit.js";

const base = defineConfig({
  fiduciary: { name: "Chai & Co", grievanceUrl: "/g", dpo: "privacy@chai.example" },
  purposes: {
    payments: { basis: "legitimate-use", legitimateUse: "7(a)", retain: "while-active" },
    analytics: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },
  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        card: { category: "financial", purposes: ["payments"], protect: "tokenised" },
        clicks: { category: "behavioural", purposes: ["analytics"] },
      },
    },
  },
  processors: {
    razorpay: { purposes: ["payments"], contract: "MSA clause 12", countries: ["IN"] },
    posthog: { purposes: ["analytics"], contract: "DPA s.4", countries: ["US", "DE"] },
  },
  minimumRetention: "1y",
  rights: { how: "In the app: Settings → Privacy, or email privacy@example.in" },
  security: { accessControl: "SSO", backups: "Daily", measures: "Training" },
});

const transferIssues = (config: DpdpConfig<string>) =>
  audit(config)
    .filter((i) => ["invalid-country", "transfer-restricted", "transfer-outside-india", "processor-countries-missing", "foreign-state-transfer"].includes(i.code))
    .map((i) => `${i.level}:${i.code}:${i.path}`);

describe("transfers outside India", () => {
  it("passes when every processor says where it is and nothing is restricted", () => {
    expect(audit(base)).toEqual([]);
  });

  it("fails when a processor is in a country you list as restricted", () => {
    const config = { ...base, transfers: { restricted: ["US"] } };
    expect(transferIssues(config)).toEqual(["error:transfer-restricted:processors.posthog.countries"]);
  });

  it("fails when data another law keeps in India goes abroad", () => {
    const config = {
      ...base,
      processors: { ...base.processors, stripe: { purposes: ["payments"], contract: "DPA", countries: ["IN", "US"] } },
      transfers: { keepInIndia: ["payments"] },
    } as DpdpConfig<string>;
    const issues = audit(config).filter((i) => i.code === "transfer-outside-india");
    expect(issues.map((i) => i.path)).toEqual(["processors.stripe.countries"]); // razorpay is IN only
    expect(issues[0]!.message).toContain("in US");
  });

  it("warns about processors with no countries, and foreign State entities", () => {
    const config = {
      ...base,
      processors: { razorpay: { purposes: ["payments"], contract: "MSA" }, gov: { purposes: ["analytics"], contract: "MoU", countries: ["FR"], foreignState: true } },
    } as DpdpConfig<string>;
    expect(transferIssues(config)).toEqual([
      "warning:processor-countries-missing:processors.razorpay.countries",
      "warning:foreign-state-transfer:processors.gov.foreignState",
    ]);
    expect(audit(config).filter((i) => i.level === "warning").every((i) => i.since === "0.5")).toBe(true);
  });

  it("rejects country codes that aren't ISO 3166-1 alpha-2", () => {
    const config = {
      ...base,
      processors: { posthog: { purposes: ["analytics"], contract: "DPA", countries: ["USA", "de"] } },
      transfers: { restricted: ["China"], keepInIndia: ["nope"] },
    } as unknown as DpdpConfig<string>;
    const codes = audit(config)
      .filter((i) => i.code === "invalid-country" || i.code === "unknown-purpose")
      .map((i) => `${i.code}:${i.path}`);
    expect(codes).toEqual([
      "invalid-country:transfers.restricted.0",
      "unknown-purpose:transfers.keepInIndia",
      "invalid-country:processors.posthog.countries.0",
      "invalid-country:processors.posthog.countries.1",
    ]);
  });

  it("tells the person where their data goes, in the data summary", async () => {
    const dpdp = createDpdp({ config: base, store: memoryStore(), data: memoryData({ users: [{ id: "u1", card: "tok_1", clicks: 4 }] }) });
    await dpdp.consent.grant("u1", ["analytics"]);
    const { sharedWith } = await dpdp.rights.summary("u1");
    expect(sharedWith).toEqual([
      { name: "razorpay", purposes: ["payments"], countries: ["IN"] },
      { name: "posthog", purposes: ["analytics"], countries: ["US", "DE"] },
    ]);
  });
});

describe("--strict and warnings added in 0.5", () => {
  it("doesn't fail a 0.4 config on the new warning, but still fails on older ones", async () => {
    // A new folder each time: the CLI imports the config, and Node caches modules by path.
    const write = (contract: string) => {
      const dir = mkdtempSync(join(tmpdir(), "dpdp-kit-"));
      writeFileSync(
        join(dir, "dpdp.config.mjs"),
        `export const config = {
          fiduciary: { name: "X", grievanceUrl: "/g", dpo: "dpo@x.in" },
          purposes: { account: { basis: "legitimate-use", retain: "while-active" } },
          data: { users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: ["account"] } } } },
          processors: { sms: { purposes: ["account"]${contract} } },
          minimumRetention: "1y",
          security: { accessControl: "SSO", backups: "Daily", measures: "Training" },
        };`,
      );
      return dir;
    };
    const run = async (dir: string) => {
      const lines: string[] = [];
      const code = await runAudit(["--strict"], dir, (l) => lines.push(l));
      return { code, out: lines.join("\n") };
    };

    const fresh = await run(write(`, contract: "DPA"`)); // only processor-countries-missing, new in 0.5
    expect(fresh.out).toContain("processors.sms.countries");
    expect(fresh.out).toContain("don't fail --strict until the next minor version");
    expect(fresh.code).toBe(0);

    // processor-contract-missing is from 0.3, so --strict still fails
    expect((await run(write(""))).code).toBe(1);
  });
});
