import { defineConfig } from "vitest/config";

// The Postgres suites start a PGlite database per backend (the store contract suite alone starts
// 21); on a busy 2-core runner a test's first database can take longer than the default 5 seconds.
// React Native components are tested in jsdom through react-native-web.
export default defineConfig({
  resolve: { alias: { "react-native": "react-native-web" } },
  test: { hookTimeout: 60_000, testTimeout: 20_000 },
});
