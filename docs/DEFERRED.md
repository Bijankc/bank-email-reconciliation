# Deferred verification

Everything in this project is built and verified under local emulation. There is
no Cloudflare account attached, so the rows below have **not** been checked and
must not be described as working. Each row states the exact check and the result
that proves it.

**No row here is ever marked verified from a local run.** A row is verified when
it has been executed against a real account, and only then.

| # | What must be checked | How to check it | Result that proves it | Status |
|---|---|---|---|---|
| D1 | `wrangler dev` local emulation is not proof that the config deploys | `npx wrangler deploy` after Steps 3–6 of `CLOUDFLARE_SETUP.md` | Deploy succeeds and prints a `*.workers.dev` route | Not verified |
| D2 | The real `database_id` binds and the remote D1 has the schema | `npx wrangler d1 execute bank-recon --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"` | Rows `accounts`, `gaps`, `transactions` | Not verified |
| D3 | All bindings resolve in the deployed Worker, not just locally | `curl -s https://<host>/health` | `ok:true`; `d1`, `r2`, `durable_object`, `queue_producer` all `"ok"` | Not verified |
| D4 | The DO migration tag `v1` applies against real Durable Object infrastructure with a SQLite-backed class | First `wrangler deploy` output | Reports the `v1` migration applied for `AccountLedger` with no "cannot convert" error | Not verified |
| D5 | Queue producer → real consumer delivery works remotely | `POST /webhook` against the deployed host, then `npx wrangler tail` | A `queue.received` log line appears with the same `event_id` | Not verified |
| D6 | The dead-letter queue actually receives poison events after `max_retries` | Send the poison-hook event (Phase 6), then `npx wrangler queues consumer add txn-events-dlq` or inspect the DLQ in the dashboard | The event lands in `txn-events-dlq` after 5 delivery attempts, and the main queue is not blocked | Not verified |
| D7 | `SIMULATOR_TOKEN` set via `wrangler secret put` is readable in production and fails closed when unset | `curl -s https://<host>/health`, then `curl -X POST https://<host>/webhook` with no auth header | `simulator_token: "configured"`; the unauthenticated POST returns `401` | Not verified |
| D8 | **The R2 audit bucket is not publicly reachable** | Dashboard → R2 → `bank-recon-audit` → Settings → Public access; confirm no `r2.dev` URL and no custom domain. If an `r2.dev` URL exists, `curl` it | No public URL exists at all; if one does, it must return 401/403 and public access must then be disabled | Not verified |
| D9 | DO Alarms fire on real infrastructure at the scheduled wall-clock time (local emulation fast-forwards) | Open a `PENDING_GAP`, wait out the real window, then `GET /api/accounts/:id?authoritative=true` | The gap reads `CONFIRMED_GAP` with `confirmed_at` set, without any external scheduler | Not verified |
| D10 | Email Routing delivers a real bank email to `email()` | Step 7 of `CLOUDFLARE_SETUP.md`, then `npx wrangler tail` | An `email.received` log line with the bank's sender address | Not verified |
| D11 | The two parsers survive a **real** bank email, not just the redacted fixtures | After D10, compare the parsed event against the email actually received | Amount, balance, direction, and timestamp match what the email states | Not verified |
| D12 | Free-tier limits quoted in the README are current | Re-read <https://developers.cloudflare.com/workers/platform/limits/> before submitting | The README's numbers match the published limits on the day of submission | Not verified |
| D13 | README image URLs resolve from the published repository | Phase 6: open the rendered README on GitHub and follow every image | Every image renders; no broken-image icon | Not verified |
| D14 | The bank timestamps really are Nepal local time, and `occurred_at` therefore orders correctly against the email's own `Date` header | After D10, compare the `12Mar26 09:14:22` style stamp in the body against the `Date:` header of the same real email | The body stamp equals the `Date` header converted to UTC+05:45, confirming both banks stamp NPT (see DECISIONS 1.1) | Not verified |
