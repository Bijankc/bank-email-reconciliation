import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// Tests run against the same migration file the real database is built from, so
// a schema change cannot pass the suite while breaking the deployed schema.
const migrations = await readD1Migrations(path.join(here, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Never real secrets. The two write paths are exercised against these,
          // and they differ so a test cannot pass by using the wrong one.
          SIMULATOR_TOKEN: "test-token-not-a-real-secret",
          OPERATOR_TOKEN: "test-operator-token-not-a-real-secret",
          // The suite posts to ordinary account ids, so it opts out of the
          // DEMO- fence exactly as local development does.
          SIMULATOR_SCOPE: "any-account",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
