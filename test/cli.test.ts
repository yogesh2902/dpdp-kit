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
        logs: { minimumRetention: "1y" },
      };`,
    );
    const { code, out } = await audit([], dir);
    expect(code).toBe(1);
    expect(out).toContain("data.users.fields.phone.purposes");
    expect(out).toContain('Unknown purpose "acount"');
    // the misspelling also leaves "account" unused, and there is no grievance URL
    expect(out).toMatch(/1 error\(s\), 2 warning\(s\)/);
  });

  it("fails on warnings with --strict, and when no config exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dpdp-kit-"));
    writeFileSync(
      join(dir, "dpdp.config.mjs"),
      `export const config = {
        fiduciary: { name: "X" },
        purposes: { account: { basis: "legitimate-use", retain: "while-active" } },
        data: { users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: ["account"] } } } },
        logs: { minimumRetention: "1y" },
      };`,
    );
    expect((await audit([], dir)).code).toBe(0);
    expect((await audit(["--strict"], dir)).code).toBe(1);
    expect((await audit([], tmpdir())).code).toBe(1);
  });
});
