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

---

## Phase 1 — parsers and normalization

### 1.1 Bank wall-clock time is preserved verbatim and stamped `Z`, not shifted to true UTC

**Decision.** `12Mar26 09:14:22` becomes `2026-03-12T09:14:22Z`. The digits the
bank printed are kept exactly; the `Z` is a formatting convention, not a claim
that the reading was taken in UTC.

**Rejected.** Converting from Nepal time (UTC+05:45) to real UTC, which would
make the same stamp `2026-03-12T03:29:22Z`.

**Reason.** Neither bank states a zone, so any conversion is an assumption about
data the email does not carry. The assumption happens to be safe for *ordering* —
both banks stamp the same local zone, so applying the same offset to both cannot
change their relative order, and ordering is the only thing the balance chain
depends on. That leaves the choice to be made on display: the owner reads these
alerts in a Nepali inbox, and a dashboard that echoes the time printed in the
email is easier to trust than one that silently subtracts 5h45m. The spec's own
example in §5.1 does the same thing — `2026-08-28 14:20` in the raw Nabil table
becomes `2026-08-28T14:20:00Z`, with no offset applied.

The cost is that `occurred_at` is not a true instant, so it must not be compared
against `Date.now()` or against the email's `Date:` header without adding the
offset back. Nothing in the engine does that: the chain compares events only
against each other. `DEFERRED.md` D14 records the check that confirms both banks
stamp NPT. Should this need to change, it is one function — `toIso` in
`src/parse/time.ts` — and the fixtures move with it.

### 1.2 Nabil is read with HTMLRewriter, and its columns are found by header text

**Decision.** The Nabil table is parsed by streaming it through `HTMLRewriter`,
collecting `tr`/`td`/`th`, and locating each column by matching its header cell
against a pattern. A missing required header is a hard parse failure.

**Rejected.** A regex over `<td>(.*?)</td>`, and reading the cells positionally
once matched.

**Reason.** Two different failure modes, both silent. Bank alert HTML comes out
of a mail template: cell text is wrapped in `<span>`/`<font>`, attributes carry
inline styles, and tags are frequently unclosed. A regex over that markup
degrades into wrong captures rather than no captures. Positional reads fail worse
still — a bank that inserts a "Channel" column shifts every index by one, and the
parser then reads the *amount* out of the balance column and reconciles a
perfectly consistent-looking chain against the wrong numbers. Matching on header
text turns both into a loud `ParseError` instead. There is a test that reorders
and inserts a column specifically to hold this property.

One HTMLRewriter detail worth recording, because it cost a failing test: a `text`
handler registered on `td` already fires for text inside nested elements.
Registering a second handler on `td *` to "also catch wrapped text" double-counts
it, and `<td><span>Credit</span></td>` arrives as `"CreditCredit"`.

### 1.3 A message that will not parse is a returned outcome, not a thrown exception

**Decision.** `parseBankEmail` returns `{ ok: false, bank, field, message }`
rather than throwing. `ParseError` exists but is caught at the module boundary.

**Rejected.** Letting the parse error propagate out of `email()`.

**Reason.** By the time `email()` runs, Cloudflare has already accepted the
message from the sender; there is no one left to bounce it to. Throwing would
lose the message and, from Phase 2, would put an unparseable email on the retry
path — where it fails identically on every attempt and does nothing but fill the
dead-letter queue. The two cases have to be distinguishable: a transient D1 or R2
failure *should* throw so the queue retries, and a malformed body should be
recorded and acked. Making the parse result a value rather than an exception is
what lets Phase 2 tell them apart.

### 1.4 Hash-derived event ids are bank-namespaced, and the hashed fields are separated

**Decision.** The fallback id is `{bank}:{sha256hex}`, and the fields are joined
with a NUL byte before hashing rather than concatenated.

**Rejected.** A bare hex digest as the spec's §5.4 sketch implies, and plain
concatenation of the field values.

**Reason.** Namespacing keeps one invariant true of every id in the system —
every `event_id` starts with its bank — which matters because these ids are also
R2 key components and D1 primary keys spanning both banks. `event_id_method`,
not the shape of the string, is what records which derivation was used.

The separator is the more substantive half. Concatenating `bank + account_id +
occurred_at + direction + amount_paisa` makes the field boundaries invisible to
the hash, so two different field splits can produce the same input string and
therefore the same id — a dedup collision that silently swallows a real
transaction. A separator that cannot occur in bank data removes the ambiguity for
nothing.

### 1.5 The bank token in ids is uppercase

**Decision.** `NIMB:88213047qLmT`, `NABIL:220XXXXXX881904`.

**Rejected.** The lowercase `nabil:` shown in the spec's §5.1 example.

**Reason.** That example is internally inconsistent: it writes `"event_id":
"nabil:55697463K9aD"` alongside `"bank": "NABIL"`. One casing has to win, and the
`bank` field is the one with an enumerated type that D1 has a CHECK constraint
on. Deriving the id prefix from that field directly means the two can never drift.

### 1.6 A missing reference degrades the id; a missing balance fails the parse

**Decision.** `reference` and `merchant` are optional — absent, the event still
normalizes and falls back to the hash id. `reported_balance_paisa` is required,
and a message without an Available Balance line is a parse failure.

**Rejected.** Treating all extracted fields alike, either all optional or all
required.

**Reason.** They are not alike. The reference is an idempotency convenience: lose
it and dedup degrades from exact to heuristic, which §5.4 already accepts. The
merchant is display only. The reported balance is the entire product — it is the
independent assertion the recorded movements are checked against, and an event
without one contributes nothing to a chain while creating a hole in it. Better to
reject the message loudly than to insert a transaction that can never reconcile.

## Phase 2 — ingress, queue and audit

### 2.1 Both ingress paths converge on one enqueue function, and neither touches storage

**Decision.** `email()` and `POST /webhook` do their own kind of parsing and
then call the same `enqueueEvent`. Neither writes to R2, D1 or the ledger.

**Rejected.** Letting each handler build its own queue message, and writing the
audit object at ingress where the raw bytes already are.

**Reason.** Two handlers building their own messages is how the two paths drift:
a field added for the simulator quietly never reaches the email path, and the
divergence shows up three phases later as a reconciliation that works for one
source and not the other. Keeping the construction in one place makes the two
paths structurally identical downstream of ingress.

Writing the audit object at ingress is the more tempting mistake. It looks like
a saved round trip, but it puts a storage write on the path that Email Routing
is waiting on: an R2 slowdown becomes a delivery stall, and there is nothing
useful to do about a failure there because the message has already been
accepted from the sender. On the consumer side the same failure is just a
retry. Ingress stays fast and dumb (spec 9); durability is the queue's job.

### 2.2 The simulator ingress is treated as an untrusted boundary, not a test hook

**Decision.** `/webhook` validates every field of the incoming event, collects
every failure rather than stopping at the first, and answers `422` with the
list. `400` is reserved for a body that is not JSON at all.

**Rejected.** Trusting the body because the endpoint is behind a bearer token,
and validating only the fields the next phase happens to read.

**Reason.** This is the only place a caller can hand the engine a transaction
the parsers did not build, so every invariant the rest of the system assumes has
to be asserted here or it is not an invariant. The parsers cannot emit a float
amount; an HTTP client can, and `amount_paisa: 2200.5` accepted at the boundary
becomes a ledger that fails to reconcile by half a paisa with no visible cause.
An `account_id` whose prefix disagrees with `bank` is worse: it addresses a
different Durable Object, so the same real account ends up with two ledgers each
reconciling against half its transactions.

Authentication answers who is calling, not whether what they sent is coherent.

Collecting all errors rather than the first is for the Phase 6 simulator panel,
which posts hand-edited JSON. One round trip per mistake is a poor way to find
three of them.

### 2.3 Provenance is decided by the endpoint, never read from the body

**Decision.** `source_channel` is overwritten with `"simulator"` on every event
that arrives at `/webhook`, whatever the body claims. Likewise `event_id_method`
is derived from the id rather than trusted.

**Rejected.** Passing both through as sent.

**Reason.** The audit trail exists to answer where a transaction came from. A
simulator event able to label itself `"email"` makes that question unanswerable
by exactly the payload that most needs auditing, and the field costs nothing to
set correctly at the one point that actually knows the answer. The same argument
applies to `event_id_method`: it is the flag the README uses to admit that a
hash-derived id is the weaker key, so it has to reflect the id that was really
used. It reads as `"reference"` only when the id genuinely is `{bank}:{reference}`.

### 2.4 Write-once means skip an existing object, not overwrite it with the same bytes

**Decision.** `writeAudit` checks for the key and returns early if it is there.
Only a first write puts.

**Rejected.** The spec's phrasing in 7.3 - every retry rewrites the same key
with the same bytes, so write-once and at-least-once coexist.

**Reason.** That reasoning holds for a queue retry, which really does resend
identical bytes. It does not hold for the case this system is built around. A
re-forwarded email produces the same derived `event_id` and a different byte
stream: a new `Message-ID`, extra `Received` headers, sometimes a different
transfer encoding. Overwriting would let the second copy replace the first in a
store whose entire value is holding the thing that actually arrived. The
skip-if-present version keeps the original and is equally idempotent.

The cost is a check-then-write race if two deliveries of one event are in flight
at once. The worst outcome there is a duplicate write of bytes for a single
`event_id`, which changes nothing. Losing the original artifact does.

### 2.5 Audit keys keep the colon and escape only what would change the path

**Decision.** `raw/{account_id}/{event_id}.eml` with `%` and `/` percent-escaped
in each component and everything else left alone, so a key reads
`raw/NIMB:099XX4417/NIMB:88213047qLmT.eml`.

**Rejected.** `encodeURIComponent` on each component, and no escaping at all.

**Reason.** A slash inside a bank reference would silently push the object a
directory deeper, out from under the account prefix that Phase 5 lists by;
escaping it removes the hazard. Percent is escaped first so the mapping stays
reversible. Beyond those two characters, encoding buys nothing and costs the
thing that makes an audit bucket useful under pressure, which is being able to
find one transaction by reading the key.

### 2.6 The failure taxonomy: what retries, what acks, and what throws

**Decision.** Three distinct behaviours, chosen per failure rather than per
layer.

- A body that does not parse as a bank email is logged and dropped at ingress.
  It never reaches the queue.
- A queue message with no `event_id` or `account_id` is acked.
- An R2 failure in the consumer calls `retry()`.
- A queue send failure at ingress is allowed to throw out of the handler.

**Rejected.** Retrying everything and letting `max_retries` sort it out.

**Reason.** Retry is only useful when the next attempt could differ. A newsletter
that slipped through the forwarding rule parses identically five times and then
occupies the dead-letter queue, which is meant to hold real poison. Email Routing
has already accepted the message by the time `email()` runs, so there is nobody
to bounce it to either; recording it is the whole available response.

A storage failure is the opposite: the input is fine and the next attempt very
likely succeeds, so it must not be acked. Acking there loses a real debit
silently, which is the one outcome this project exists to prevent.

The enqueue throw is the interesting one. There is no retry available at ingress
and no caller to tell, so failing the invocation is the only signal left - it
marks the delivery as failed rather than reporting success over a transaction
that went nowhere.

### 2.7 The raw payload travels inside the queue message, with a truncation guard

**Decision.** `QueuedTxnMessage` carries the raw bytes. A payload over 96 KB is
cut to fit, flagged with `raw_truncated`, logged as a warning, and marked in the
R2 object metadata.

**Rejected.** Silently sending oversized messages, and dropping the transaction
when the payload is too large.

**Reason.** Queue messages are capped at 128 KB and the cap here sits under it,
because hitting the real limit surfaces as an opaque send failure at ingress
rather than as anything readable. Bank alerts are a few kilobytes, so the guard
should never fire; the point is that if it ever does, it says so.

Dropping the transaction would be the wrong trade. Everything the ledger needs
is in `event`, not in `raw`, so a truncated artifact still reconciles correctly
and only the evidence is incomplete. What must not happen is an audit store that
holds partial evidence while claiming to be verbatim, which is why the flag
follows the object rather than living only in a log line.

### 2.8 A simulator event archives the validated event, not the request body

**Decision.** The `.json` audit artifact is the normalized `TxnEvent`, serialized
after validation.

**Rejected.** Archiving the raw request body as received.

**Reason.** For an email the raw payload is the source of truth and the parse is
the derived thing, so the bytes are what deserve keeping. For a simulator event
the relationship is inverted: the body is a hand-written approximation of an
event, and the validated result is what actually entered the system. Archiving
the body would store unvalidated extras and omit every field that validation
filled in, leaving the audit trail describing something the ledger never saw.
