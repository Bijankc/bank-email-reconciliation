# Decisions

Appended to at the time a non-obvious call is made. Each entry: the decision,
the alternative rejected, and the reason.

---

## Phase 0 — scaffold

### 0.1 Integer paisa everywhere, no floats at any layer

**Decision.** Money is stored, transported, and compared as integer paisa
(rupees × 100). Every money column in D1 and in the Durable Object is `INTEGER`.
The normalized event carries `amount_paisa` and `reported_balance_paisa`.

**Rejected.** Floating-point rupees (`2538.46`), and the whole-rupee integers
used in the earlier COD project.

**Reason.** These balances carry two decimal places, so whole rupees cannot
represent them at all. Floats are worse than imprecise here: the entire product
is an equality test between a computed balance and a bank-reported balance, and
`0.1 + 0.2 !== 0.3` turns a reconciled account into a phantom gap of a fraction
of a paisa. An equality-based reconciliation engine cannot be built on a type
that does not have exact equality.

### 0.2 The Durable Object uses the SQLite SQL API, not the KV blob API

**Decision.** `AccountLedger` stores `events`, `gaps`, and `meta` as SQLite
tables via `ctx.storage.sql`, with an index on `occurred_at`.

**Rejected.** Storing the event log, dedup set, and gap list as JSON blobs read
and rewritten whole on each event — the approach the COD project used.

**Reason.** That works for an entity that goes terminal after a handful of
events. An account ledger never terminates: it accumulates transactions for as
long as the account exists. Rewriting the whole history on every insert is
O(n) per event and eventually exceeds the per-value size limit. Tables also give
dedup for free as a `PRIMARY KEY` constraint, and let the chain be walked with
an ordered query instead of sorting the whole log in memory.

### 0.3 Dedup is a primary-key constraint, not a lookup

**Decision.** `events.event_id` is the `PRIMARY KEY`; a re-delivered email is
caught by the insert failing, which then increments `deliveries`.

**Rejected.** Reading a `processed` set and branching before inserting.

**Reason.** Check-then-act is two steps that can interleave. Inside a single
Durable Object they cannot, so both are correct here — but the constraint states
the invariant in the schema rather than relying on a code path continuing to be
correct. The database enforces it even if the calling logic is later changed.

### 0.4 `event_id` records which method derived it

**Decision.** The normalized event carries `event_id_method: "reference" |
"hash"` alongside the id.

**Rejected.** Deriving the id and discarding how.

**Reason.** The two derivations are not equally strong. A bank reference is
genuinely unique; the fallback hash of `(bank, account, occurred_at, direction,
amount)` cannot distinguish two identical transactions in the same second, so it
would silently swallow a real second transaction as a duplicate. That weakness
is worth being able to see and report on, so it is recorded per event rather
than inferred later.

### 0.5 `/webhook` fails closed when its secret is unset

**Decision.** If `SIMULATOR_TOKEN` is not configured, `/webhook` returns `503`
and accepts nothing. The token comparison hashes both sides to 32 bytes and uses
`crypto.subtle.timingSafeEqual`.

**Rejected.** Treating an unset secret as "auth not required in development",
and comparing the tokens with `===`.

**Reason.** An unset secret meaning "open" is how a public deployment ends up
with an unauthenticated write endpoint that injects events into a ledger. Fail
closed makes a misconfiguration loud instead of dangerous. Hashing before the
constant-time compare avoids leaking the token's length as well as its content,
which a raw `timingSafeEqual` on the bytes would (it requires equal lengths).

### 0.6 `/health` exercises the bindings rather than reporting config

**Decision.** `/health` performs a real read against D1, R2, and the Durable
Object, and reports per-binding status.

**Rejected.** Returning `200 OK` from a static handler.

**Reason.** The failure this project is most exposed to is a binding that is
declared but not actually reachable — a placeholder `database_id`, a bucket that
was never created, a DO migration that did not apply. A health check that does
not touch the bindings would report healthy in exactly that case. This one turns
a Phase 4 mystery into a Phase 0 error message, and it doubles as the proof
required by the deferred checks D3 and D4.

### 0.7 The build brief is not committed

**Decision.** `bank-email-reconciliation-engine-spec.md` is in `.gitignore`.

**Rejected.** Committing it, or committing a stripped version, without asking.

**Reason.** The repository is public and the brief contains non-technical
strategy language that does not belong in a submitted repository. A stripped
technical version at `docs/design.md` would be useful, but that is the owner's
call to make, not a default to assume.

### 0.8 Local emulation only; account-scoped ids stay literal placeholders

**Decision.** No Cloudflare account is used. `database_id` is the literal string
`REPLACE_WITH_D1_DATABASE_ID`, marked with a `PLACEHOLDER` comment.

**Rejected.** A plausible-looking all-zeros uuid, which was the first thing
written here.

**Reason.** A well-formed uuid is indistinguishable at a glance from a real one,
so it can be deployed by accident and fail with a confusing binding error. A
string that is obviously not a uuid cannot be mistaken for a configured value.
Wrangler parses the config and runs `wrangler dev` locally with it unchanged,
because local emulation never reads that field — so the placeholder costs
nothing until the moment it must be replaced, which is documented in
`docs/CLOUDFLARE_SETUP.md`.

### 0.9 `compatibility_date` is 2026-08-22, not the 2026-09-01 in the spec sketch

**Decision.** `wrangler.jsonc` pins `compatibility_date: "2026-08-22"`.

**Rejected.** The `2026-09-01` in the spec's config sketch; and keeping that date
while overriding it to an older one for tests only.

**Reason.** The `workerd` build bundled with `@cloudflare/vitest-pool-workers`
supports dates up to `2026-08-22`, while the one wrangler ships is newer. With
`2026-09-01` the test runner refuses to start every worker with
`This Worker requires compatibility date "2026-09-01", but the newest date
supported by this server binary is "2026-08-22"` and the run hangs with no test
output.

Overriding the date for tests only would have kept the sketch's number, but then
the suite would be exercising a different runtime contract than the deployed
Worker — the one thing a compatibility date exists to prevent. Pinning both to a
date the whole toolchain supports keeps tests and production identical, which
matters more than matching a number in a sketch. Raise it once the pool's
`workerd` catches up; nothing in the project depends on behaviour introduced
between those two dates.
