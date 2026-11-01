import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/proxy/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    env: { MODE: "demo", PENSTOCK_LOG: "silent" },
  },
});
