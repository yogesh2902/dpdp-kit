import { copyFileSync, mkdirSync } from "node:fs";
import { defineConfig } from "tsup";

// Type declarations come from `tsc -p tsconfig.build.json` (tsup's dts step needs the
// TypeScript JS API, which TypeScript 7 doesn't ship).
const shared = { format: ["esm" as const], target: "node20", external: ["drizzle-orm", "jiti", "react", "react/jsx-runtime", "react-dom", "react-native", "node:sqlite"] };

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      drizzle: "src/drizzle.ts",
      express: "src/express.ts",
      hono: "src/hono.ts",
      next: "src/next.ts",
      client: "src/client.ts",
      fastify: "src/fastify.ts",
      nestjs: "src/nestjs.ts",
      protect: "src/protect.ts",
      schedule: "src/schedule.ts",
      postgres: "src/postgres.ts",
      sqlite: "src/sqlite.ts",
      prisma: "src/prisma.ts",
      mongodb: "src/mongodb.ts",
      cli: "src/cli.ts",
    },
    clean: false,
  },
  {
    // React code runs in the browser: marked "use client" for the Next.js App Router, which
    // esbuild would otherwise drop, and built on its own so it shares no chunk with server code.
    ...shared,
    entry: { react: "src/react/index.ts" },
    target: "es2020",
    banner: { js: '"use client";' },
    clean: false,
    // The optional stylesheet, served as dpdp-kit/react/styles.css.
    async onSuccess() {
      mkdirSync("dist", { recursive: true });
      copyFileSync("src/react/styles.css", "dist/react.css");
    },
  },
  {
    // React Native: the same hooks, built on their own for Metro.
    ...shared,
    entry: { "react-native": "src/react-native/index.tsx" },
    target: "es2020",
    clean: false,
  },
]);
