import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["app/**/*.{js,ts,tsx}", "components/**/*.{js,ts,tsx}", "lib/**/*.{js,ts,tsx}", "scripts/**/*.{js,mjs,ts}"],
      exclude: ["**/*.test.*", "**/*.spec.*"],
      reporter: ["text", "json"],
      reportsDirectory: process.env.FGA_TEST_COVERAGE ?? join(tmpdir(), "fga-lens-coverage-" + process.pid),
    },
  },
});
