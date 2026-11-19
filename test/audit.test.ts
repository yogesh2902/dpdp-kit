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
      minimumRetention: "1y",
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
      minimumRetention: "90d",
    } as unknown as DpdpConfig<string>;

    expect(codes(bad).sort()).toEqual(
      [
        "error:field-without-purpose:data.users.fields.phone.purposes",
        "warning:processor-countries-missing:processors.sms.countries",
        "error:invalid-duration:data.orders.legalHold.keep",
        "error:invalid-duration:purposes.spare.retain.afterWithdrawal",
        "error:invalid-retention:purposes.promo.retain",
        "error:minimum-retention-too-short:minimumRetention",
        "error:missing-subject-column:data.orders.subject",
        "error:unknown-purpose:processors.sms.purposes",
        "warning:grievance-missing:fiduciary.grievanceUrl",
        "warning:contact-missing:fiduciary.dpo",
        "warning:table-without-fields:data.orders.fields",
        "warning:unused-purpose:purposes.promo",
        "warning:unused-purpose:purposes.spare",
        "warning:processor-contract-missing:processors.sms.contract",
        "warning:security-measure-missing:security.accessControl",
        "warning:security-measure-missing:security.backups",
        "warning:security-measure-missing:security.measures",
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
      "warning:contact-missing:fiduciary.dpo",
      "error:invalid-retention:purposes.account.retain",
      "warning:minimum-retention-missing:minimumRetention",
      "warning:security-measure-missing:security.accessControl",
      "warning:security-measure-missing:security.backups",
      "warning:security-measure-missing:security.measures",
    ]);
  });
});

describe("audit: Rule 6 security safeguards", () => {
  const base = {
    fiduciary: { name: "X", grievanceUrl: "/g", dpo: "dpo@x.example" },
    purposes: { kyc: { basis: "legitimate-use", retain: "while-active" } },
    minimumRetention: "1y",
    security: { accessControl: "SSO", backups: "Daily", measures: "Training" },
  } as const;
  const fields = (f: Record<string, unknown>) =>
    ({ ...base, data: { users: { table: "users", subject: "id", fields: f } } }) as unknown as DpdpConfig<string>;

  it("warns about high-risk identifiers stored without protection", () => {
    const c = fields({
      aadhaar_number: { category: "identity", purposes: ["kyc"] },
      pan: { category: "identity", purposes: ["kyc"], protect: "encrypted" },
      bankAccountNumber: { category: "financial", purposes: ["kyc"] },
      bloodGroup: { category: "health", purposes: ["kyc"] },
      company_pan: { category: "identity", purposes: ["kyc"] }, // a business identifier: only a weak guess
      phone: { category: "contact", purposes: ["kyc"] },
    });
    expect(codes(c)).toEqual([
      "warning:unprotected-high-risk-field:data.users.fields.aadhaar_number.protect",
      "warning:unprotected-high-risk-field:data.users.fields.bankAccountNumber.protect",
      "warning:unprotected-high-risk-field:data.users.fields.bloodGroup.protect",
    ]);
  });

  it("warns about processors without a security provision in the contract", () => {
    const c = {
      ...fields({ phone: { category: "contact", purposes: ["kyc"] } }),
      processors: { sms: { purposes: ["kyc"], countries: ["IN"] }, kyc: { purposes: ["kyc"], contract: "MSA clause 9", countries: ["IN"] } },
    } as unknown as DpdpConfig<string>;
    expect(codes(c)).toEqual(["warning:processor-contract-missing:processors.sms.contract"]);
  });

  it("requires a year of access logs", () => {
    const short = { ...fields({ phone: { category: "contact", purposes: ["kyc"] } }), security: { ...base.security, accessLogRetention: "180d" } };
    expect(codes(short as unknown as DpdpConfig<string>)).toEqual(["error:access-log-retention-too-short:security.accessLogRetention"]);
    const bad = { ...short, security: { ...base.security, accessLogRetention: "a while" } };
    expect(codes(bad as unknown as DpdpConfig<string>)).toEqual(["error:invalid-duration:security.accessLogRetention"]);
  });
});

describe("audit: erase settings", () => {
  it("accepts null, redact and { value }, and rejects anything else", () => {
    const withErase = (erase: unknown) =>
      ({
        fiduciary: { name: "X", grievanceUrl: "/g", dpo: "dpo@x.example" },
        purposes: { a: { basis: "legitimate-use", retain: "while-active" } },
        data: { users: { table: "users", subject: "id", fields: { email: { category: "contact", purposes: ["a"], erase } } } },
        minimumRetention: "1y",
        security: { accessControl: "x", backups: "x", measures: "x" },
      }) as unknown as DpdpConfig<string>;
    for (const ok of ["null", "redact", { value: "" }, { value: 0 }, { value: null }, { value: () => "x" }]) expect(codes(withErase(ok))).toEqual([]);
    for (const bad of ["blank", { with: "x" }, { value: { nested: 1 } }]) {
      expect(codes(withErase(bad))).toEqual(["error:invalid-erase:data.users.fields.email.erase"]);
    }
  });
});
