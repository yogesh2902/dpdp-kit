import { defineConfig } from "vitest/config";

// The Postgres suites start a PGlite database per backend; on a 2-core CI runner a dozen
// starting at once can take longer than the default 10 seconds.
export default defineConfig({ test: { hookTimeout: 60_000 } });
