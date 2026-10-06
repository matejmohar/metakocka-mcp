import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Runs against the real Metakocka API; see vitest.live.config.ts and `npm run test:live`.
    exclude: ["test/live/**"],
    environment: "node",
  },
});
