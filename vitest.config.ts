import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/proxy/test/**/*.test.ts", "apps/console/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // Suites start a seeded proxy in beforeAll; a cold first run (fresh install, many workers) can
    // take longer than the 10s default.
    hookTimeout: 60000,
    // Tests that build a buyer without a journal get an in-memory one; the real default is ~/.penstock/buyer-journal.
    env: { MODE: "demo", PENSTOCK_LOG: "silent", PENSTOCK_JOURNAL_DIR: "memory" },
  },
});
