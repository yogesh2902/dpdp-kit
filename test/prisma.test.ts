import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DPDP_DDL } from "../src/drizzle.js";
import { createDpdp, defineConfig, SeqConflictError } from "../src/index.js";
import { castType, isUniqueViolation } from "../src/postgres.js";
import { PRISMA_MODELS, prismaData, prismaSchema, prismaStore } from "../src/prisma.js";
import { checkSchema } from "../src/schema-check.js";
import { config } from "./fixtures/config.js";
import { fakePrisma } from "./pg-backends.js";

const fixture = readFileSync(resolve(import.meta.dirname, "fixtures/schema.prisma"), "utf8");

describe("prismaSchema", () => {
  it("reads models into tables and columns, with database names and model and field names as keys", () => {
    const schema = prismaSchema(fixture);
    expect(schema.tables.map((t) => [t.name, t.key])).toEqual([
      ["users", "User"],
      ["orders", "Order"],
      ["analytics_events", "AnalyticsEvent"],
      ["products", "Product"],
    ]);
    expect(schema.tables[0]!.columns).toEqual([
      { name: "id", notNull: true, type: "string", sqlType: "text" },
      { name: "phone", notNull: false, type: "string", sqlType: "text" },
      { name: "name", notNull: false, type: "string", sqlType: "text" },
      { name: "interests", notNull: false, type: "string", sqlType: "text" },
      { name: "email_verified_at", key: "emailVerifiedAt", notNull: false, type: "other", sqlType: "timestamp(3)" },
      { name: "created_at", key: "createdAt", notNull: true, type: "other", sqlType: "timestamp(3)" },
    ]); // the orders relation isn't a column
    expect(schema.tables[1]!.columns.map((c) => c.name)).toEqual(["id", "user_id", "address", "total"]);
    expect(schema.tables[3]!.columns[2]).toEqual({ name: "kind", notNull: true, type: "other", sqlType: '"product_kind"' });
  });

  it("matches the data map, so audit --schema passes", () => {
    expect(checkSchema(config, prismaSchema(fixture))).toEqual([]);
  });

  it("lets the data map use model and field names", () => {
    const byModel = {
      ...config,
      data: { users: { table: "User", subject: "id", fields: { phone: { category: "contact", purposes: ["account"] } } } },
      notPersonal: ["User.name", "User.interests", "Order.*", "AnalyticsEvent.*", "Product.*"],
    } as typeof config;
    expect(checkSchema(byModel, prismaSchema(fixture))).toEqual([]);
  });

  it("finds drift: a new personal column, a renamed field", () => {
    const drifted = fixture.replace("  interests       String?", "  interestTags    String?\n  aadhaarNumber   String? @map(\"aadhaar_number\")");
    const codes = checkSchema(config, prismaSchema(drifted)).map((i) => `${i.code}:${i.path}`);
    expect(codes).toContain("unknown-column:data.users.fields.interests");
    expect(codes).toContain("unmapped-personal-column:schema.users.aadhaar_number");
  });

  it("reads native types, lists, Unsupported, comments, and NOT NULL for erase checks", () => {
    const schema = prismaSchema(`
      model Member {
        id      Int      @id @default(autoincrement()) /// the key
        uid     String   @unique @db.Uuid
        email   String   @db.VarChar(255) @map("e_mail") // "not // a comment" is fine too
        tags    String[]
        note    String?  @map(name: "note_text")
        spot    Unsupported("point")?
        balance Decimal  @db.Decimal(10, 2)
        @@map(name: "members")
        @@index([email])
      }
      view MemberStats {
        memberId Int @unique @map("member_id")
      }
      type Address { street String }
    `);
    expect(schema.tables[0]).toEqual({
      name: "members",
      key: "Member",
      columns: [
        { name: "id", notNull: true, type: "number", sqlType: "integer" },
        { name: "uid", notNull: true, type: "string", sqlType: "uuid" },
        { name: "e_mail", key: "email", notNull: true, type: "string", sqlType: "varchar(255)" },
        { name: "tags", notNull: false, type: "other", sqlType: "text[]" },
        { name: "note_text", key: "note", notNull: false, type: "string", sqlType: "text" },
        { name: "spot", notNull: false, type: "other", sqlType: "point" },
        { name: "balance", notNull: true, type: "number", sqlType: "numeric(10, 2)" },
      ],
    });
    expect(schema.tables[1]).toEqual({ name: "MemberStats", columns: [{ name: "member_id", key: "memberId", notNull: true, type: "number", sqlType: "integer" }] });

    const cfg = defineConfig({
      fiduciary: { name: "Acme", grievanceUrl: "/g", dpo: "privacy@acme.example" },
      purposes: { news: { basis: "consent", retain: { afterWithdrawal: "0d" } } },
      data: { members: { table: "Member", subject: "id", fields: { email: { category: "contact", purposes: ["news"] }, note: { category: "other", purposes: ["news"] } } } },
      notPersonal: ["members.*"],
      minimumRetention: "1y",
    });
    expect(checkSchema(cfg, schema).map((i) => i.code)).toEqual(["erase-not-null"]); // email is NOT NULL, note isn't
  });

  it("PRISMA_MODELS describe dpdp-kit's tables", () => {
    const tables = prismaSchema(PRISMA_MODELS).tables;
    expect(tables.map((t) => t.name)).toEqual([
      "dpdp_consent_events",
      "dpdp_requests",
      "dpdp_erasure_tasks",
      "dpdp_access_log",
      "dpdp_breaches",
      "dpdp_breach_notices",
    ]);
    // Same columns as DPDP_DDL, in the same order.
    for (const table of tables) {
      const ddl = new RegExp(`CREATE TABLE IF NOT EXISTS ${table.name} \\(([^;]*)\\);`).exec(DPDP_DDL)![1]!;
      const ddlColumns = ddl
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[0]!)
        .filter((c) => c && c !== "PRIMARY");
      expect(table.columns.map((c) => c.name), table.name).toEqual(ddlColumns);
    }
  });
});

describe("Prisma store and data access (PGlite)", () => {
  const client = new PGlite();
  const prisma = fakePrisma(client);
  const schema = prismaSchema(`
    model Customer {
      id        Int     @id
      mobileNo  String? @map("mobile_no")
      points    Int     @default(0)
      @@map("customers")
    }
  `);
  const cfg = defineConfig({
    fiduciary: { name: "Acme", grievanceUrl: "/g" },
    purposes: { account: { basis: "legitimate-use", retain: "while-active" }, promo: { basis: "consent", retain: { afterWithdrawal: "0d" } } },
    data: {
      customers: {
        table: "Customer", // the model name; the table is "customers"
        subject: "id",
        fields: { mobileNo: { category: "contact", purposes: ["account"] }, points: { category: "behavioural", purposes: ["promo"], erase: { value: 0 } } },
      },
    },
    minimumRetention: "1y",
  });
  let t = Date.parse("2026-11-18T10:00:00.000Z");
  const store = prismaStore(prisma);
  const dpdp = createDpdp({ config: cfg, store, data: prismaData(prisma, { schema }), now: () => new Date(t) });

  beforeAll(async () => {
    await client.exec(DPDP_DDL);
    await client.exec(`CREATE TABLE customers (id integer PRIMARY KEY, mobile_no text, points integer NOT NULL DEFAULT 0);
      INSERT INTO customers VALUES (7, '98xxxxxx07', 40), (8, '98xxxxxx08', 10);`);
  });
  afterAll(async () => {
    await client.close();
  });

  it("finds a person's rows by an integer id, using model and field names", async () => {
    const summary = await dpdp.rights.summary("7");
    expect(summary.data).toMatchObject([{ key: "customers", rows: [{ mobileNo: "98xxxxxx07", points: 40 }] }]);
  });

  it("erases with the field's replacement, and deletes rows", async () => {
    await dpdp.consent.grant("7", ["promo"]);
    await dpdp.consent.withdraw("7", ["promo"]);
    t += 366 * 24 * 60 * 60 * 1000;
    expect((await dpdp.retention.run()).failed).toEqual([]);
    expect((await client.query("SELECT id, points FROM customers ORDER BY id")).rows).toEqual([
      { id: 7, points: 0 },
      { id: 8, points: 10 },
    ]);
    await dpdp.erasure.deleteAccount("8");
    t += 366 * 24 * 60 * 60 * 1000;
    await dpdp.retention.run();
    expect((await client.query("SELECT id FROM customers ORDER BY id")).rows).toEqual([{ id: 7 }]);
  });

  it("turns Prisma's wrapped unique violation into SeqConflictError", async () => {
    const [first] = await dpdp.consent.history("7");
    await expect(store.insert(first!)).rejects.toBeInstanceOf(SeqConflictError);
  });
});

describe("SQL helpers", () => {
  it("recognises unique violations from pg, PGlite and Prisma", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "P2010", meta: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(new Error("x", { cause: { code: "23505" } }))).toBe(true);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint "dpdp_consent_events_pkey"'))).toBe(true);
    expect(isUniqueViolation({ code: "23502" })).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("casts to a column's type without length limits or serials", () => {
    expect(castType("varchar(3)")).toBe("varchar");
    expect(castType("char(2)")).toBe("bpchar");
    expect(castType("numeric(10, 2)")).toBe("numeric");
    expect(castType("serial")).toBe("integer");
    expect(castType("bigserial")).toBe("bigint");
    expect(castType("varchar(20)[]")).toBe("varchar[]");
    expect(castType('"product_kind"')).toBe('"product_kind"');
    expect(castType("timestamp(3)")).toBe("timestamp");
  });
});
