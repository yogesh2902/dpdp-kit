// The Postgres stores and data access, so the same tests run against each of them on PGlite.
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { drizzleData, drizzleSchema, drizzleStore } from "../src/drizzle.js";
import { postgresData, postgresStore, type SqlQuery } from "../src/postgres.js";
import { type PrismaLike, prismaData, prismaStore } from "../src/prisma.js";

/** node-postgres style: `query(text, params)` resolving with `{ rows }`. */
const pgliteQuery =
  (client: PGlite): SqlQuery =>
  async (text, params) =>
    (await client.query<Record<string, unknown>>(text, [...params])).rows;

/**
 * A stand-in for PrismaClient: `$queryRawUnsafe(text, ...values)`, with unique violations wrapped
 * the way Prisma does (P2010, the database's code in `meta`).
 */
export const fakePrisma = (client: PGlite): PrismaLike => ({
  async $queryRawUnsafe(text, ...values) {
    try {
      return (await client.query(text, values)).rows;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      throw Object.assign(new Error(`Raw query failed. Code: \`${e.code}\`. Message: \`${e.message}\``), {
        code: "P2010",
        meta: { code: e.code, message: e.message },
      });
    }
  },
});

export const backends = [
  {
    name: "drizzle",
    store: (client: PGlite) => drizzleStore(drizzle(client)),
    data: (client: PGlite, schema: Record<string, unknown>) => drizzleData(drizzle(client), { schema }),
  },
  {
    name: "plain SQL",
    store: (client: PGlite) => postgresStore(pgliteQuery(client)),
    data: (client: PGlite, schema: Record<string, unknown>) => postgresData(pgliteQuery(client), { schema: drizzleSchema(schema) }),
  },
  {
    name: "prisma",
    store: (client: PGlite) => prismaStore(fakePrisma(client)),
    data: (client: PGlite, schema: Record<string, unknown>) => prismaData(fakePrisma(client), { schema: drizzleSchema(schema) }),
  },
];
