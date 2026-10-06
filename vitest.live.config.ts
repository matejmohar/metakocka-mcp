import { defineConfig } from "vitest/config";

/** `npm run test:live`: read-only checks against a real Metakocka company (credentials from .env or the environment). */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One company handles one request at a time; run files one after another.
    fileParallelism: false,
  },
});
