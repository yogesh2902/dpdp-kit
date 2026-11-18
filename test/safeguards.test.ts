import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type DpdpConfig, safeguardsReport } from "../src/index.js";
import { runSafeguards } from "../src/run-audit.js";
import { config } from "./fixtures/config.js";

const status = (c: DpdpConfig<string>) => Object.fromEntries(safeguardsReport(c).map((s) => [s.clause, s.status]));

describe("safeguardsReport", () => {
  it("reports each clause of Rule 6(1)", () => {
    expect(status(config)).toEqual({
      "(a)": "missing", // no field declares protect
      "(b)": "declared",
      "(c)": "in-code",
      "(d)": "declared",
      "(e)": "declared",
      "(f)": "declared",
      "(g)": "declared",
    });
  });

  it("is partial when only some fields or processors are covered", () => {
    const c = {
      ...config,
      data: {
        users: {
          table: "users",
          subject: "id",
          fields: {
            aadhaar: { category: "identity", purposes: ["account"], protect: "encrypted" },
            pan: { category: "identity", purposes: ["account"] },
          },
        },
      },
      processors: { a: { purposes: ["account"], contract: "DPA" }, b: { purposes: ["account"] } },
      security: {},
      minimumRetention: undefined,
    } as unknown as DpdpConfig<string>;
    const report = safeguardsReport(c);
    expect(status(c)).toMatchObject({ "(a)": "partly", "(b)": "missing", "(e)": "partly", "(f)": "partly" });
    expect(report[0]!.details).toEqual(["users.aadhaar: encrypted", expect.stringContaining("users.pan: high-risk and unprotected")]);
  });
});

describe("dpdp-kit safeguards", () => {
  const fixtures = resolve(import.meta.dirname, "fixtures");
  const run = async (argv: string[]) => {
    const lines: string[] = [];
    const code = await runSafeguards(argv, fixtures, (l) => lines.push(l));
    return { code, out: lines.join("\n") };
  };

  it("prints the report, and fails with --strict when something is missing", async () => {
    const plain = await run(["--config", "config.ts"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("✖ (a) Encryption, obfuscation, masking or virtual tokens  [missing]");
    expect(plain.out).toContain("msg91: DPA signed 2026-03-01, clause 7");
    expect((await run(["--config", "config.ts", "--strict"])).code).toBe(1);
    expect((await run(["--config", "nope.ts"])).code).toBe(1);
  });
});
