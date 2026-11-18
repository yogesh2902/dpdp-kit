import { describe, expect, it } from "vitest";
import { drizzleSchema } from "../src/drizzle.js";
import { audit, checkSchema, type DpdpConfig, guessPersonal, type Schema } from "../src/index.js";
import { config } from "./fixtures/config.js";
import * as cleanSchema from "./fixtures/schema.js";
import * as driftedSchema from "./fixtures/schema-drift.js";

const codes = (issues: ReturnType<typeof checkSchema>) => issues.map((i) => `${i.level}:${i.code}:${i.path}`);

describe("guessPersonal", () => {
  it.each([
    ["phone", "strong", "contact"],
    ["phoneNumber", "strong", "contact"],
    ["mobile_no", "strong", "contact"],
    ["shipping_address", "strong", "contact"],
    ["ipAddress", "strong", "device"],
    ["aadhaar_number", "strong", "identity"],
    ["panNumber", "strong", "identity"],
    ["date_of_birth", "strong", "identity"],
    ["firstName", "strong", "identity"],
    ["upiId", "strong", "financial"],
    ["latitude", "strong", "location"],
    ["name", "weak", "identity"],
    ["gender", "weak", "identity"],
    ["companyPan", "weak", "identity"],
    ["merchant_email", "weak", "contact"],
  ])("%s → %s %s", (column, confidence, category) => {
    expect(guessPersonal(column)).toMatchObject({ confidence, category });
  });

  it.each(["id", "user_id", "created_at", "email_verified_at", "phone_confirmed", "address_type", "email_opt_in", "pancake", "span", "page", "category", "total", "is_active"])(
    "%s → not personal",
    (column) => {
      expect(guessPersonal(column)).toBeUndefined();
    },
  );
});

describe("checkSchema with Drizzle", () => {
  it("reads tables, database names and property names, and skips nothing it shouldn't", () => {
    const schema = drizzleSchema(cleanSchema);
    expect(schema.tables.map((t) => t.name).sort()).toEqual(
      ["analytics_events", "dpdp_consent_events", "orders", "products", "users"].sort(),
    );
    expect(schema.tables.find((t) => t.name === "orders")?.columns).toContainEqual(expect.objectContaining({ name: "user_id", key: "userId", type: "string" }));
  });

  it("passes when the data map matches the schema", () => {
    expect(checkSchema(config, drizzleSchema(cleanSchema))).toEqual([]);
  });

  it("reports drift in both directions", () => {
    expect(codes(checkSchema(config, drizzleSchema(driftedSchema))).sort()).toEqual(
      [
        // the data map points at things that are gone
        "error:unknown-column:data.users.fields.interests",
        "error:unknown-table:data.events.table",
        // personal-looking columns nobody mapped
        "error:unmapped-personal-column:schema.users.aadhaar_number",
        "warning:unmapped-personal-column:schema.users.gender",
        "error:unmapped-personal-column:schema.leads.email",
        "warning:unmapped-personal-column:schema.leads.company_name",
      ].sort(),
    );
  });

  it("explains how to fix an unmapped column", () => {
    const issue = checkSchema(config, drizzleSchema(driftedSchema)).find((i) => i.path === "schema.users.aadhaar_number");
    expect(issue?.message).toContain('matched "aadhaar"');
    expect(issue?.message).toContain('"users.aadhaar_number" to `notPersonal`');
  });
});

describe("checkSchema rules", () => {
  const schema: Schema = {
    tables: [
      { name: "people", columns: [{ name: "id" }, { name: "mobile_no", key: "mobileNo" }, { name: "city" }] },
      { name: "branches", columns: [{ name: "id" }, { name: "name" }, { name: "phone" }] },
    ],
  };
  const base = {
    fiduciary: { name: "X", grievanceUrl: "/g" },
    purposes: { account: { basis: "legitimate-use", retain: "while-active" } },
    minimumRetention: "1y",
  } as const;

  it("matches data map fields by property name or database name", () => {
    const byKey: DpdpConfig<string> = {
      ...base,
      data: { people: { table: "people", subject: "id", fields: { mobileNo: { category: "contact", purposes: ["account"] } } } },
      notPersonal: ["people.city", "branches.*"],
    };
    expect(checkSchema(byKey, schema)).toEqual([]);
  });

  it("ignores whole tables with table.*, and warns about notPersonal entries that match nothing", () => {
    const cfg: DpdpConfig<string> = {
      ...base,
      data: {},
      notPersonal: ["people.*", "branches.*", "branches.fax", "gone.*"],
    };
    expect(codes(checkSchema(cfg, schema))).toEqual([
      "warning:stale-not-personal:notPersonal",
      "warning:stale-not-personal:notPersonal",
    ]);
  });

  it("checks the subject column exists", () => {
    const cfg: DpdpConfig<string> = {
      ...base,
      data: { people: { table: "people", subject: "person_id", fields: { mobile_no: { category: "contact", purposes: ["account"] } } } },
      notPersonal: ["people.city", "branches.*"],
    };
    expect(codes(checkSchema(cfg, schema))).toEqual(["error:unknown-column:data.people.subject"]);
  });

  it("audit rejects a malformed notPersonal entry", () => {
    const cfg = { ...config, notPersonal: ["products"] };
    expect(audit(cfg).map((i) => i.code)).toEqual(["invalid-not-personal"]);
  });
});

describe("checkSchema: erase settings against the columns", () => {
  it("catches erasures the column can't take, before they fail a year later", async () => {
    const { pgTable, text, integer, boolean } = await import("drizzle-orm/pg-core");
    const members = pgTable("members", {
      id: text("id").primaryKey(),
      email: text("email").notNull(),
      nickname: text("nickname").notNull(),
      points: integer("points").notNull(),
      score: integer("score").notNull(),
      vip: boolean("vip"),
      bio: text("bio"),
      handle: text("handle").notNull(),
    });
    const c = {
      fiduciary: { name: "X", grievanceUrl: "/g" },
      purposes: { a: { basis: "legitimate-use", retain: "while-active" } },
      data: {
        members: {
          table: "members",
          subject: "id",
          fields: {
            email: { category: "contact", purposes: ["a"] }, // NOT NULL, erased to NULL
            nickname: { category: "identity", purposes: ["a"], erase: "redact" }, // fine
            points: { category: "behavioural", purposes: ["a"], erase: "redact" }, // text into an integer
            score: { category: "behavioural", purposes: ["a"], erase: { value: 0 } }, // fine
            vip: { category: "behavioural", purposes: ["a"], erase: { value: "no" } }, // text into a boolean
            bio: { category: "identity", purposes: ["a"] }, // nullable: fine
            handle: { category: "identity", purposes: ["a"], erase: { value: ({ subjectId }: { subjectId: string }) => `x-${subjectId}` } }, // checked at run time
          },
        },
      },
      minimumRetention: "1y",
    } as unknown as DpdpConfig<string>;
    expect(codes(checkSchema(c, drizzleSchema({ members })))).toEqual([
      "error:erase-not-null:data.members.fields.email.erase",
      "error:erase-type-mismatch:data.members.fields.points.erase",
      "error:erase-type-mismatch:data.members.fields.vip.erase",
    ]);
  });
});
