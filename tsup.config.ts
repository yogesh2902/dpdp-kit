import { defineConfig } from "tsup";

// Type declarations come from `tsc -p tsconfig.build.json` (tsup's dts step needs the
// TypeScript JS API, which TypeScript 7 doesn't ship).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    drizzle: "src/drizzle.ts",
    express: "src/express.ts",
    hono: "src/hono.ts",
    fastify: "src/fastify.ts",
    nestjs: "src/nestjs.ts",
    protect: "src/protect.ts",
    schedule: "src/schedule.ts",
    postgres: "src/postgres.ts",
    prisma: "src/prisma.ts",
    mongodb: "src/mongodb.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  clean: true,
  target: "node20",
  external: ["drizzle-orm", "jiti"],
});
