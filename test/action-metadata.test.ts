// The GitHub Action is listed on the Marketplace, which refuses a release whose action.yml breaks
// its rules. Catch that here rather than on the release page.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const yml = readFileSync(resolve(import.meta.dirname, "../action.yml"), "utf8");
const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(yml)?.[1]?.trim() ?? "";

describe("action.yml meets the GitHub Marketplace rules", () => {
  it("has a name, and a description under 125 characters", () => {
    expect(field("name")).toBe("DPDP Kit Audit");
    const description = field("description");
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThan(125);
  });

  it("has branding", () => {
    expect(yml).toMatch(/^branding:\n\s+icon: \S+\n\s+color: \S+/m);
  });
});
