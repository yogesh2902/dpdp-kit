import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAudit } from "../src/run-audit.js";

const fixtures = resolve(import.meta.dirname, "fixtures");

async function audit(argv: string[], cwd: string) {
  const lines: string[] = [];
  const code = await runAudit(argv, cwd, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}

describe("dpdp-kit audit", () => {
  it("passes a clean TypeScript config", async () => {
    const { code, out } = await audit(["--config", "config.ts"], fixtures);
    expect(code).toBe(0);
    expect(out).toContain("No problems found");
  });

  it("fails with exit code 1 and explains each error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dpdp-kit-"));
    writeFileSync(
      join(dir, "dpdp.config.mjs"),
      `export default {
        fiduciary: { name: "X" },
        purposes: { account: { basis: "legitimate-use", retain: "while-active" } },
        data: { users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: ["acount"] } } } },
        minimumRetention: "1y",
      };`,
    );
    const { code, out } = await audit([], dir);
    expect(code).toBe(1);
    expect(out).toContain("data.users.fields.phone.purposes");
    expect(out).toContain('Unknown purpose "acount"');
    // the misspelling also leaves "account" unused, there is no grievance URL, and the three
    // Rule 6 safeguards that live outside code aren't described
    expect(out).toMatch(/1 error\(s\), 5 warning\(s\)/);
    expect(out).toContain("security.backups");
  });

  it("fails on warnings with --strict, and when no config exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dpdp-kit-"));
    writeFileSync(
      join(dir, "dpdp.config.mjs"),
      `export const config = {
        fiduciary: { name: "X" },
        purposes: { account: { basis: "legitimate-use", retain: "while-active" } },
        data: { users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: ["account"] } } } },
        minimumRetention: "1y",
      };`,
    );
    expect((await audit([], dir)).code).toBe(0);
    expect((await audit(["--strict"], dir)).code).toBe(1);
    expect((await audit([], tmpdir())).code).toBe(1);
  });

  it("--schema passes when the Drizzle schema matches the data map", async () => {
    const { code, out } = await audit(["--config", "config.ts", "--schema", "schema.ts"], fixtures);
    expect(code).toBe(0);
    expect(out).toContain("No problems found");
  });

  it("--schema fails on drift and names each column", async () => {
    const { code, out } = await audit(["--config", "config.ts", "--schema", "schema-drift.ts"], fixtures);
    expect(code).toBe(1);
    expect(out).toContain("schema.users.aadhaar_number");
    expect(out).toContain("schema.leads.email");
    expect(out).toContain("data.events.table");
    expect(out).toMatch(/4 error\(s\), 2 warning\(s\)/);
  });

  it("--schema reports a missing file, or a file with no tables", async () => {
    expect((await audit(["--config", "config.ts", "--schema", "nope.ts"], fixtures)).code).toBe(1);
    await expect(audit(["--config", "config.ts", "--schema", "config.ts"], fixtures)).rejects.toThrow(/no Drizzle tables/);
  });

  it("--format github prints annotations on the right files, escaped", async () => {
    const { formatGithubAnnotations } = await import("../src/run-audit.js");
    const text = formatGithubAnnotations(
      [
        { level: "error", code: "unknown-column", path: "data.users.fields.x", message: "100% wrong,\nreally" },
        { level: "warning", code: "unmapped-personal-column", path: "schema.users.gender", message: "Looks personal" },
      ],
      { config: "/repo/app/dpdp.config.ts", schema: "/repo/app/db/schema.ts" },
      "/repo",
    );
    expect(text.split("\n")).toEqual([
      "::error file=app/dpdp.config.ts,title=dpdp-kit%3A data.users.fields.x::100%25 wrong,%0Areally",
      "::warning file=app/db/schema.ts,title=dpdp-kit%3A schema.users.gender::Looks personal",
    ]);
    const { code, out } = await audit(["--config", "config.ts", "--format", "yaml"], fixtures);
    expect(code).toBe(1);
    expect(out).toContain('Unknown --format "yaml"');
  });
});

