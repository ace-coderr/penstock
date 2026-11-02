import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/proxy/test/**/*.test.ts", "apps/console/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // Suites start a seeded proxy in beforeAll; a cold first run (fresh install, many workers) can
    // take longer than the 10s default.
    hookTimeout: 60000,
    env: { MODE: "demo", PENSTOCK_LOG: "silent" },
  },
});
