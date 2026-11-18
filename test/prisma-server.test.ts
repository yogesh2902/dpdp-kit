// Runs real Prisma (7, with @prisma/adapter-pg) against a real Postgres server, when DPDP_PG_URL is
// set. Creates its own databases, in IST, so it can run beside postgres-server.test.ts.
//   - `prisma db push` creates dpdp-kit's tables from PRISMA_MODELS;
//   - `prisma migrate diff` finds no difference between PRISMA_MODELS and DPDP_DDL;
//   - the store and data access then run through the generated PrismaClient.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DPDP_DDL } from "../src/drizzle.js";
import { createDpdp, defineConfig } from "../src/index.js";
import { PRISMA_MODELS, type PrismaLike, prismaData, prismaSchema, prismaStore } from "../src/prisma.js";

const url = process.env.DPDP_PG_URL;
const DAY = 24 * 60 * 60 * 1000;

const APP_MODELS = `
enum Tier {
  BASIC
  GOLD

  @@map("member_tier")
}

model Member {
  id       Int     @id @default(autoincrement())
  uid      String  @unique @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email    String  @unique @map("email_address") @db.VarChar(120)
  nickname String
  tier     Tier    @default(GOLD)
  city     String?
  joinedAt DateTime @default(now()) @map("joined_at") @db.Timestamptz(6)

  @@map("members")
}
`;

const config = defineConfig({
  fiduciary: { name: "Acme", grievanceUrl: "/g" },
  purposes: {
    account: { basis: "legitimate-use", retain: "while-active" },
    promo: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },
  data: {
    members: {
      table: "Member", // model and field names, as in the Prisma schema
      subject: "id",
      fields: {
        email: { category: "contact", purposes: ["promo"], erase: { value: ({ subjectId }) => `erased-${subjectId}@invalid` } },
        nickname: { category: "identity", purposes: ["promo"], erase: "redact" },
        tier: { category: "behavioural", purposes: ["promo"], erase: { value: "BASIC" } },
        city: { category: "contact", purposes: ["account"] },
        joinedAt: { category: "behavioural", purposes: ["account"] },
      },
    },
  },
  minimumRetention: "1y",
});

/** The same server, another database. */
const withDatabase = (base: string, name: string) => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
};

describe.skipIf(!url)("real Prisma on a real Postgres server", () => {
  const root = resolve(import.meta.dirname, "../node_modules/.cache/dpdp-prisma-test");
  const prismaUrl = url ? withDatabase(url, "dpdp_prisma") : "";
  const ddlUrl = url ? withDatabase(url, "dpdp_prisma_ddl") : "";
  const schemaText = `generator client {\n  provider = "prisma-client"\n  output   = "./generated"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n${PRISMA_MODELS}\n${APP_MODELS}`;
  const prismaCli = (args: string[], databaseUrl: string) =>
    execFileSync(process.execPath, [resolve(import.meta.dirname, "../node_modules/prisma/build/index.js"), ...args], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
    });

  let prisma: PrismaLike & { $disconnect(): Promise<void>; $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T> };
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  let dpdp: ReturnType<typeof createDpdp>;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    for (const db of ["dpdp_prisma", "dpdp_prisma_ddl"]) {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${db}`);
      // Indian servers often run in IST; drivers that mishandle the offset fail here, not in production.
      await admin.query(`ALTER DATABASE ${db} SET timezone TO 'Asia/Kolkata'`);
    }
    await admin.end();

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "schema.prisma"), schemaText);
    writeFileSync(
      join(root, "prisma.config.ts"),
      `import { defineConfig, env } from "prisma/config";\nexport default defineConfig({ schema: "schema.prisma", datasource: { url: env("DATABASE_URL") } });\n`,
    );
    prismaCli(["db", "push"], prismaUrl);
    prismaCli(["generate"], prismaUrl);

    const { PrismaClient } = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: prismaUrl }) });
    const schema = prismaSchema(schemaText);
    dpdp = createDpdp({ config, store: prismaStore(prisma), data: prismaData(prisma, { schema }), now: () => new Date(t) });

    await prisma.$queryRawUnsafe(
      `INSERT INTO members (email_address, nickname, city, joined_at) SELECT 'm' || i || '@example.com', 'nick' || i, 'Pune', '2026-01-01T00:00:00Z' FROM generate_series(1, 12) i`,
    );
  }, 180_000);
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("PRISMA_MODELS and DPDP_DDL create the same tables", async () => {
    const ddl = new pg.Client({ connectionString: ddlUrl });
    await ddl.connect();
    await ddl.query(DPDP_DDL);
    await ddl.query("CREATE TYPE member_tier AS ENUM ('BASIC', 'GOLD')");
    await ddl.query(`CREATE TABLE members (id serial PRIMARY KEY, uid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      email_address varchar(120) NOT NULL, nickname text NOT NULL, tier member_tier NOT NULL DEFAULT 'GOLD', city text,
      joined_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await ddl.end();
    const diff = prismaCli(["migrate", "diff", "--from-config-datasource", "--to-schema", "schema.prisma", "--script"], ddlUrl);
    const dpdpChanges = diff.split("\n").filter((l) => /dpdp_/.test(l));
    expect(dpdpChanges).toEqual([]);
  });

  it("keeps one unbroken chain when one person's consent is written from many connections at once", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? dpdp.consent.withdraw("1", ["promo"]) : dpdp.consent.grant("1", ["promo"]))));
    expect((await dpdp.consent.history("1")).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await dpdp.consent.verify("1")).toEqual({ ok: true, events: 6 });
  });

  it("shows a person's data, found by an integer id through model and field names", async () => {
    const summary = await dpdp.rights.summary("2");
    // joinedAt is exact: on this IST server Prisma's adapter alone would show it 5.5 hours off.
    expect(summary.data).toMatchObject([
      { key: "members", rows: [{ email: "m2@example.com", nickname: "nick2", tier: "GOLD", city: "Pune", joinedAt: "2026-01-01T00:00:00.000Z" }] },
    ]);
  });

  it("erases into NOT NULL, UNIQUE and enum columns, each task once across racing runners", async () => {
    for (const id of ["1", "2", "3"]) {
      await dpdp.consent.grant(id, ["promo"]);
      await dpdp.consent.withdraw(id, ["promo"]);
    }
    t += 366 * DAY;
    const reports = await Promise.all([dpdp.retention.run(), dpdp.retention.run(), dpdp.retention.run()]);
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    // 3 tasks here, and 3 from the withdrawals in the chain test above: each run exactly once.
    const done = reports.flatMap((r) => r.done).map((task) => task.id);
    expect(done).toHaveLength(6);
    expect(new Set(done).size).toBe(6);
    const rows = await prisma.$queryRawUnsafe(`SELECT id, email_address, nickname, tier::text AS tier, city FROM members WHERE id <= 4 ORDER BY id`);
    expect(rows).toEqual([
      { id: 1, email_address: "erased-1@invalid", nickname: "[erased]", tier: "BASIC", city: "Pune" },
      { id: 2, email_address: "erased-2@invalid", nickname: "[erased]", tier: "BASIC", city: "Pune" },
      { id: 3, email_address: "erased-3@invalid", nickname: "[erased]", tier: "BASIC", city: "Pune" },
      { id: 4, email_address: "m4@example.com", nickname: "nick4", tier: "GOLD", city: "Pune" },
    ]);
  });

  it("deletes an account's rows", async () => {
    await dpdp.erasure.deleteAccount("5");
    t += 366 * DAY;
    expect((await dpdp.retention.run()).failed).toEqual([]);
    expect(await prisma.$queryRawUnsafe(`SELECT id FROM members WHERE id = 5`)).toEqual([]);
  });

  it("writes consent inside a Prisma transaction, and rolls it back with the app's own writes", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const inTx = createDpdp({ config, store: prismaStore(tx) });
        await inTx.consent.grant("6", ["promo"]);
        await tx.$queryRawUnsafe(`UPDATE members SET city = 'Delhi' WHERE id = 6`);
        throw new Error("checkout failed");
      }),
    ).rejects.toThrow("checkout failed");
    expect(await dpdp.consent.history("6")).toEqual([]);
    expect(await prisma.$queryRawUnsafe(`SELECT city FROM members WHERE id = 6`)).toEqual([{ city: "Pune" }]);
  });

  it("keeps the access log, records breaches, and runs daily()", async () => {
    for (const id of ["7", "8", "9"]) await dpdp.access.log({ actor: "support:ravi", subjectId: id, purpose: "account", fields: ["members.city"] });
    const breach = await dpdp.breach.open({ description: "support:ravi's account was taken over.", fields: ["members.city"] });
    expect(await dpdp.breach.addAffectedFromAccessLog(breach.id, { actor: "support:ravi" })).toBe(3);
    expect(await dpdp.breach.markNotified(breach.id, ["7", "8"], { channel: "email" })).toBe(2);
    expect((await dpdp.breach.status(breach.id)).people).toEqual({ total: 3, sent: 2, pending: 1 });

    const report = await dpdp.daily();
    expect(report.errors).toEqual([]);
    expect(report.breaches!.map((b) => b.id)).toEqual([breach.id]);
    t += 400 * DAY;
    expect((await dpdp.access.prune()).deleted).toBe(3);
  });
});
