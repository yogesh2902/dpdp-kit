import { describe, expect, it } from "vitest";
import { audit, type DpdpConfig, defineConfig, hasErrors } from "../src/index.js";
import { config } from "./fixtures/config.js";

const codes = (c: DpdpConfig<string>) => audit(c).map((i) => `${i.level}:${i.code}:${i.path}`);

describe("audit", () => {
  it("passes a clean config", () => {
    expect(audit(config)).toEqual([]);
  });

  it("catches a misspelt purpose (the type checker catches it too)", () => {
    const bad = defineConfig({
      fiduciary: { name: "X", grievanceUrl: "/g" },
      purposes: { account: { basis: "legitimate-use", retain: "while-active" } },
      // @ts-expect-error "acount" is not a declared purpose
      data: { users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: ["acount"] } } } },
      logs: { minimumRetention: "1y" },
    });
    expect(codes(bad)).toContain("error:unknown-purpose:data.users.fields.phone.purposes");
    expect(hasErrors(audit(bad))).toBe(true);
  });

  it("flags fields and processors without purposes, bad durations, and unused purposes", () => {
    const bad = {
      fiduciary: { name: "X" },
      purposes: {
        account: { basis: "legitimate-use", retain: "while-active" },
        promo: { basis: "consent", retain: "forever" },
        spare: { basis: "consent", retain: { afterWithdrawal: "soon" } },
      },
      data: {
        users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: [] } } },
        orders: { table: "orders", subject: "", fields: {}, legalHold: { reason: "tax", keep: "8 years", then: "delete" } },
      },
      processors: { sms: { purposes: ["account", "nope"] } },
      logs: { minimumRetention: "90d" },
    } as unknown as DpdpConfig<string>;

    expect(codes(bad).sort()).toEqual(
      [
        "error:field-without-purpose:data.users.fields.phone.purposes",
        "error:invalid-duration:data.orders.legalHold.keep",
        "error:invalid-duration:purposes.spare.retain.afterWithdrawal",
        "error:invalid-retention:purposes.promo.retain",
        "error:logs-retention-too-short:logs.minimumRetention",
        "error:missing-subject-column:data.orders.subject",
        "error:unknown-purpose:processors.sms.purposes",
        "warning:grievance-missing:fiduciary.grievanceUrl",
        "warning:table-without-fields:data.orders.fields",
        "warning:unused-purpose:purposes.promo",
        "warning:unused-purpose:purposes.spare",
      ].sort(),
    );
  });

  it("rejects afterWithdrawal on a legitimate use and warns when log retention is missing", () => {
    const bad = {
      fiduciary: { name: "X", grievanceUrl: "/g" },
      purposes: { account: { basis: "legitimate-use", retain: { afterWithdrawal: "0d" } } },
      data: { users: { table: "users", subject: "id", fields: { phone: { category: "contact", purposes: ["account"] } } } },
    } as unknown as DpdpConfig<string>;
    expect(codes(bad)).toEqual([
      "error:invalid-retention:purposes.account.retain",
      "warning:logs-retention-missing:logs.minimumRetention",
    ]);
  });
});
