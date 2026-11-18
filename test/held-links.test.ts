// A table under a legal hold (invoices kept for GST) must survive account deletion. A foreign key
// to the users table can break that, and `audit --schema` says how.
import { PGlite } from "@electric-sql/pglite";
import { foreignKey, pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DPDP_DDL, drizzleSchema } from "../src/drizzle.js";
import { createDpdp, defineConfig } from "../src/index.js";
import { postgresData, postgresStore } from "../src/postgres.js";
import { prismaSchema } from "../src/prisma.js";
import { checkSchema } from "../src/schema-check.js";

const config = defineConfig({
  fiduciary: { name: "Chai & Co", grievanceUrl: "/g", dpo: "privacy@chai.example" },
  purposes: { account: { basis: "legitimate-use", retain: "while-active" } },
  data: {
    users: { table: "User", subject: "id", fields: { name: { category: "identity", purposes: ["account"] } } },
    orders: {
      table: "Order",
      subject: "userId",
      fields: { address: { category: "contact", purposes: ["account"] } },
      legalHold: { reason: "GST invoices", keep: "8y", then: "anonymise" },
    },
  },
  minimumRetention: "1y",
});

const prisma = (relation: string) => `
  model User {
    id     String  @id
    name   String?
    orders Order[]
    @@map("users")
  }
  model Order {
    id      String  @id
    address String?
    ${relation}
    @@map("orders")
  }`;

const issues = (text: string) => checkSchema(config, prismaSchema(text)).map((i) => `${i.level}:${i.code}:${i.path}`);

describe("audit --schema: foreign keys from a held table", () => {
  it("reads Prisma relations, with Prisma's defaults", () => {
    const required = prismaSchema(prisma(`userId String @map("user_id")\n user User @relation(fields: [userId], references: [id])`));
    expect(required.tables[1]!.references).toEqual([{ columns: ["user_id"], table: "users", onDelete: "restrict" }]);
    const optional = prismaSchema(prisma(`userId String? @map("user_id")\n user User? @relation(fields: [userId], references: [id])`));
    expect(optional.tables[1]!.references).toEqual([{ columns: ["user_id"], table: "users", onDelete: "set null" }]);
    expect(required.tables[0]!.references).toBeUndefined(); // the other side holds no key
  });

  it("is an error when deleting the account deletes the held rows (Cascade)", () => {
    expect(issues(prisma(`userId String @map("user_id")\n user User @relation(fields: [userId], references: [id], onDelete: Cascade)`))).toEqual([
      "error:held-rows-cascade:schema.orders.user_id",
    ]);
  });

  it("is an error when deleting the account clears whose rows they are (SetNull)", () => {
    expect(issues(prisma(`userId String? @map("user_id")\n user User? @relation(fields: [userId], references: [id])`))).toEqual([
      "error:held-link-lost:schema.orders.user_id",
    ]);
  });

  it("warns when the held rows block deleting the account (Restrict, NoAction)", () => {
    expect(issues(prisma(`userId String @map("user_id")\n user User @relation(fields: [userId], references: [id])`))).toEqual([
      "warning:held-rows-block-delete:schema.orders.user_id",
    ]);
    expect(issues(prisma(`userId String @map("user_id")\n user User @relation(fields: [userId], references: [id], onDelete: NoAction)`))).toEqual([
      "warning:held-rows-block-delete:schema.orders.user_id",
    ]);
  });

  it("passes with a plain column, and ignores links that don't involve a held table", () => {
    expect(issues(prisma(`userId String @map("user_id")`))).toEqual([]);
    const { legalHold: _, ...orders } = config.data!.orders!;
    const noHold = { ...config, data: { ...config.data, orders } };
    const cascade = prismaSchema(prisma(`userId String @map("user_id")\n user User @relation(fields: [userId], references: [id], onDelete: Cascade)`));
    expect(checkSchema(noHold, cascade)).toEqual([]);
  });

  it("reads Drizzle foreign keys the same way", () => {
    const users = pgTable("users", { id: text("id").primaryKey(), name: text("name") });
    const cascade = pgTable("orders", { id: text("id").primaryKey(), userId: text("user_id").references(() => users.id, { onDelete: "cascade" }), address: text("address") });
    const restrict = pgTable(
      "orders",
      { id: text("id").primaryKey(), userId: text("user_id").notNull(), address: text("address") },
      (t) => [foreignKey({ columns: [t.userId], foreignColumns: [users.id] })],
    );
    const drizzleConfig = { ...config, data: { users: { ...config.data!.users!, table: "users" }, orders: { ...config.data!.orders!, table: "orders" } } } as typeof config;
    expect(drizzleSchema({ users, orders: cascade }).tables[1]!.references).toEqual([{ columns: ["user_id"], table: "users", onDelete: "cascade" }]);
    expect(checkSchema(drizzleConfig, drizzleSchema({ users, orders: cascade })).map((i) => i.code)).toEqual(["held-rows-cascade"]);
    expect(checkSchema(drizzleConfig, drizzleSchema({ users, orders: restrict })).map((i) => i.code)).toEqual(["held-rows-block-delete"]);
  });
});

describe("what the check prevents, on Postgres", () => {
  const client = new PGlite();
  const query = async (text: string, params: readonly unknown[]) => (await client.query<Record<string, unknown>>(text, [...params])).rows;
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  const pgConfig = { ...config, data: { users: { ...config.data!.users!, table: "users" }, orders: { ...config.data!.orders!, table: "orders", subject: "user_id" } } } as typeof config;
  const dpdp = createDpdp({ config: pgConfig, store: postgresStore(query), data: postgresData(query), now: () => new Date(t) });
  const rows = async (sql: string) => (await client.query(sql)).rows;

  beforeAll(async () => {
    await client.exec(DPDP_DDL);
    await client.exec(`
      CREATE TABLE users (id text PRIMARY KEY, name text);
      CREATE TABLE orders (id text PRIMARY KEY, user_id text REFERENCES users ON DELETE CASCADE, address text);
      INSERT INTO users VALUES ('asha', 'Asha'), ('ravi', 'Ravi');
      INSERT INTO orders VALUES ('o1', 'asha', '12 FC Road'), ('o2', 'ravi', '7 MG Road');
      ALTER TABLE orders DROP CONSTRAINT orders_user_id_fkey;
      ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users ON DELETE RESTRICT;`);
  });
  afterAll(async () => {
    await client.close();
  });

  it("RESTRICT: deleting the account fails, as the warning says", async () => {
    await dpdp.erasure.deleteAccount("asha");
    t += 366 * 24 * 60 * 60 * 1000;
    const report = await dpdp.retention.run();
    expect(report.failed.map((x) => x.kind)).toEqual(["delete-rows"]);
    expect(report.failed[0]!.lastError).toMatch(/foreign key/i);
    expect(await rows("SELECT id FROM users ORDER BY id")).toEqual([{ id: "asha" }, { id: "ravi" }]);
  });

  it("CASCADE: deleting the account deletes the held invoice, as the error says", async () => {
    await client.exec(`ALTER TABLE orders DROP CONSTRAINT orders_user_id_fkey;
      ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users ON DELETE CASCADE;`);
    await dpdp.erasure.deleteAccount("ravi");
    t += 366 * 24 * 60 * 60 * 1000;
    await dpdp.retention.run();
    expect(await rows("SELECT id FROM orders WHERE user_id = 'ravi'")).toEqual([]); // gone, despite the 8-year hold
  });
});
