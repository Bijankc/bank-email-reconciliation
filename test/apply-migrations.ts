import { applyD1Migrations, env } from "cloudflare:test";

// Runs once before the suite: builds the read-model schema in the test D1 from
// migrations/0001_init.sql, the same file the real database is created from.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
