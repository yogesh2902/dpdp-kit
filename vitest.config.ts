import { defineConfig } from "vitest/config";

// The Postgres suites start a PGlite database per backend; on a 2-core CI runner a dozen
// starting at once can take longer than the default 10 seconds.
// React Native components are tested in jsdom through react-native-web.
export default defineConfig({
  resolve: { alias: { "react-native": "react-native-web" } },
  test: { hookTimeout: 60_000 },
});
