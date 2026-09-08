// Bindings that exist only under test, declared so the suite typechecks with
// the same strictness as src/. TEST_MIGRATIONS is injected by vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
