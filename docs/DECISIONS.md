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

## Phase 3 — the ledger Durable Object

### 3.1 Same-minute transactions are ordered by the balances, not by an arbitrary key

**Decision.** Events that tie on `occurred_at` are arranged by walking the
balance chain: starting from the balance already reached, repeatedly take
whichever tied event chains from it. When no arrangement chains, the remainder
keeps `event_id` order, which is deterministic, and the mismatch is reported
normally.

**Rejected.** Sorting ties by `event_id`, by arrival order, or by
`reported_balance_paisa`.

**Reason.** Nabil stamps its alerts to the minute, so two transactions in the
same minute are genuinely indistinguishable in the log. The arbitrary tiebreaks
are not neutral: order two consistent transactions the wrong way round and the
chain reports a gap that never existed, which is the fastest way for a
reconciliation tool to stop being believed. Sorting by balance looks principled
and is not - for two debits the balance descends, for two credits it ascends, so
no fixed direction is correct.

The balances are the only evidence in the data about which order actually
happened, so they are what gets used. The cost is a theoretical false negative:
a real gap inside a tie group could be hidden if the tied events happen to chain
in some other order, which requires the missing transaction to be exactly
compensated by a reordering. That is a much smaller risk than routinely
inventing gaps, and it is bounded to events sharing a timestamp.

This was raised with the owner as an open question at the Phase 2 checkpoint and
implemented as proposed.

### 3.2 A filled gap is deleted, not moved to a fourth status

**Decision.** When a `PENDING_GAP` stops failing - either the adjacency now
chains or a late event landed between its two bounding events - the row is
removed.

**Rejected.** A `CLOSED_GAP` status alongside the three in the spec.

**Reason.** The lifecycle table in spec 6.3 shows *(closed)* as leaving the
lifecycle, not as a fourth state, and the schema CHECK constraint lists exactly
three. A closed gap is not a gap: keeping the row would mean every consumer of
`open_gap_count` and `reconciliation_status` has to remember to exclude it, and
one that forgets reports a permanently unreconciled account. What happened is
still recoverable from the event log and the R2 artifacts, which is where the
history belongs.

### 3.3 A gap is keyed by its bounding pair, and the key is hashed

**Decision.** `gap_id` is the first 16 hex characters of
`sha256(after_event_id + " " + before_event_id)`.

**Rejected.** Concatenating the two event ids, and allocating a random id.

**Reason.** Deriving from the pair is what makes gap detection idempotent: the
full recompute that runs on every insert re-detects the same gap and finds the
same row, instead of opening a second one and doubling the open count. A random
id would lose that.

Hashing rather than concatenating is because `gap_id` travels in a URL path
segment (spec 8, the accept endpoint), and the ids it is built from contain a
bank reference that nothing guarantees is path-safe. The cost is an opaque id;
`after_event_id` and `before_event_id` are columns, so no information is lost.

### 3.4 The whole chain is recomputed on every insert

**Decision.** Each applied event triggers a full walk of the account's event log
and a full reconciliation of the gaps table against it.

**Rejected.** Patching only the two adjacencies the new event creates.

**Reason.** The targeted version has to get four things right at once - close the
old gap, open up to two new ones, leave confirmed and accepted gaps alone, and
handle the event landing at either end of the log - and a miss leaves a stale
gap row that no later insert will ever revisit. The full walk cannot leave one
behind, because the gaps table is reconciled against the complete set of failing
adjacencies every time.

The cost is linear in account history per event. For a personal account that is
thousands of rows against an operation measured in microseconds, and the
Durable Object is single-threaded per account anyway, so this is throughput on
one account rather than a system-wide ceiling. If it ever mattered, the same
function narrowed to a window is a local change: nothing outside it knows how
the gaps table is maintained.

### 3.5 A duplicate bumps the version even though the balance does not move

**Decision.** A redelivered event increments `deliveries` and the monotonic
`version`, while leaving balance, event count and reconciliation status
untouched.

**Rejected.** Treating a duplicate as a no-op that skips the version bump.

**Reason.** `version` is the projection guard: D1 only accepts a write whose
version exceeds the stored one. The delivery counter is state the dashboard
displays, and it is the visible half of the duplicate demo, so a duplicate that
did not move the version would update the ledger and then be silently dropped by
its own guard. "Nothing moves" is about the money, not about the record of what
arrived.

### 3.6 A redelivery that disagrees about the money keeps the first copy and says so

**Decision.** When an event arrives with a known `event_id` but a different
amount, direction, or balance, the stored row wins and the conflict is logged.

**Rejected.** Overwriting with the newer values, and rejecting the message.

**Reason.** Two things can produce this: a bank reusing a reference, or a
hash-derived id colliding - and spec 5.4 already admits the hash id is the weaker
key. Overwriting means a redelivery can rewrite settled history, which is worse
than being wrong in one direction consistently. Rejecting turns it into a queue
retry that fails identically forever. Keeping the first delivery and making the
disagreement loud leaves a human able to find it.

### 3.7 A confirmed gap that later looks fillable is flagged, not closed

**Decision.** When a late email arrives that would have closed a gap already
promoted to `CONFIRMED_GAP`, the gap keeps its status and gets `fillable_at` set.

**Rejected.** Auto-closing it, which spec 6.4 explicitly leaves as a choice.

**Reason.** Confirmation is the point at which the system has told an operator
that a transaction is missing, and they may have acted on it. Silently reversing
that - and silently reversing it again if another event reopens the same
adjacency - makes the confirmed state meaningless. Recording that it now looks
fillable gives the operator the same information without the tool changing
history behind them. The flag clears itself if a further event makes the
adjacency fail again, so it always reflects the current chain.

### 3.8 Re-anchor clears the account, and the adjacency model makes that enough

**Decision.** `acceptGap` moves a `CONFIRMED_GAP` to `ACCEPTED_GAP` with a
reason. Accepted gaps are excluded from `open_gap_count` and from the
reconciliation status, and the row is kept forever.

**Rejected.** Deleting the gap, and adjusting later balances to absorb the delta.

**Reason.** Spec 6.5 describes re-anchor as rescuing a chain that a lost email
would otherwise poison forever. Worth noting precisely: because reconciliation
is checked per adjacency against the previous *reported* balance rather than
against a running computed total, a single break never propagates - only that
one adjacency fails. So re-anchoring is not repairing arithmetic. What it does
is let an account whose only fault is one permanently missing email read
`RECONCILED` again, which is what makes the status trustworthy rather than
permanently red.

Keeping the row is the whole point: the delta is a recorded accepted
discontinuity with a reason attached, not an erasure.

Accepting is refused while a gap is still `PENDING_GAP`, because that would
discard the one mechanism that distinguishes a late email from a lost one, and
it is idempotent once accepted, because a retried operator action must not fail.

### 3.9 The demo forces the window through the same transition the alarm uses

**Decision.** `forceWindow()` promotes every open `PENDING_GAP` exactly as the
alarm would, and the alarm handler promotes only gaps whose `promote_at` has
passed.

**Rejected.** Shortening `GAP_WINDOW_MS` for demos, and letting the demo write
`CONFIRMED_GAP` rows directly.

**Reason.** The simulator panel has to show the two-stage lifecycle inside a demo
rather than across two days (spec 10), so some fast-forward is required. Making
it a separate write path would mean the demo proves nothing about the real
transition. Routing it through the same promotion keeps the demonstrated
behaviour and the production behaviour the same code. Shortening the window
instead would make the deployed system wrong in order to make a demo convenient.

## Phase 4 — projection to D1 and the read surface

### 4.1 The balance chain is one implementation, shared by both stores

**Decision.** Ordering and adjacency evaluation live in `src/chain.ts`. The
Durable Object runs it over its own SQLite rows; the read API runs it over the
projected D1 rows.

**Rejected.** Leaving the logic in the DO and either duplicating it in the API,
or projecting a precomputed `chain_position` and `chains` flag into D1.

**Reason.** The projected view and the authoritative view are shown side by side
on purpose, so a difference between them is a claim: this is replication lag.
Two copies of the ordering rule would eventually make that claim false - the two
views would differ because the code disagreed, not because the queue was behind,
and the one feature built to teach eventual consistency would be teaching a bug.

Projecting the marks instead of recomputing them was the alternative, and it is
worse here for a specific reason: the tie ordering from DECISIONS 3.1 depends on
the running balance, so a late event can change the position of events that were
already written. Keeping positions correct would mean rewriting a span of
transaction rows on every insert. Recomputing on read costs nothing at these
sizes and cannot go stale.

### 4.2 The version guard is a conditional upsert, run before anything else

**Decision.** The accounts row is written with
`ON CONFLICT DO UPDATE ... WHERE excluded.projection_version > accounts.projection_version`,
alone, and its `meta.changes` decides whether the gap replacement runs at all.

**Rejected.** Reading the stored version and then writing (check-then-act), and
putting the whole projection in one `db.batch()`.

**Reason.** Check-then-act is a race: two deliveries for one account can both
read version 4 and both decide they are newer. Making the comparison part of the
write means the database resolves it, and the loser matches zero rows.

The batch was the tidier-looking option, and it does not work: D1 has no way to
make later statements in a batch conditional on an earlier one, so the gap
replacement would run even when the account write was rejected - which is
exactly the stale write the guard exists to stop, arriving through the side
door. Two round trips is the price of the guard actually guarding.

Strictly greater, not greater-or-equal, so a redelivery of the message that
wrote the current version is also discarded.

### 4.3 Gaps are replaced per account; transactions are upserted per event

**Decision.** Projecting an account deletes its gap rows and reinserts the set
the ledger returned, in one batch. Transaction rows are written one at a time by
the consumer and never deleted.

**Rejected.** Merging gaps by id, and projecting the whole timeline each time.

**Reason.** The two tables have opposite lifecycles. A gap can vanish - it fills,
and the ledger simply stops returning it - and no event carries that news, so a
merge would leave a filled gap on the dashboard forever. The ledger returns the
complete set, which makes replace both correct and simple. Doing it in one batch
means a dashboard poll never lands in the window where the old rows are gone and
the new ones are not yet there.

A transaction is a one-shot fact that never disappears, and its row carries
three columns only the consumer knows: which R2 object holds the raw bytes, when
the delivery arrived, and whether it was the first. The alarm re-projects an
account without any of that, so if transactions were part of the account
projection the alarm would blank them.

### 4.4 The alarm projects itself

**Decision.** After promoting gaps, `alarm()` calls `projectAccount` directly.

**Rejected.** Leaving the projection to the next queue message for that account.

**Reason.** Every other state change in this system arrives on a queue message,
and the consumer projects it immediately afterwards. The alarm is the one
transition with no message behind it. Without this call the dashboard would keep
showing `PENDING_REVIEW` until the account happened to receive another
transaction - which, for the exact case the two-stage lifecycle exists to handle
(an account whose emails have stopped arriving), could be never. The state
transition would be real and invisible.

### 4.5 A superseded projection still writes its transaction row

**Decision.** When the account write loses the version guard, the transaction
row for that event is written anyway.

**Rejected.** Skipping the whole projection when the guard rejects.

**Reason.** The guard protects versioned summary state - balance, status, gap
count - where an older value overwriting a newer one is corruption. A
transaction row is not that: it is a fact about one event, it is written once,
and no other delivery will ever write it. Skipping it would drop a transaction
from the timeline permanently to protect a column it does not touch. The foreign
key still holds, because a rejected guard means some newer write already created
the account row.

### 4.6 The read surface is unauthenticated, and that is a deployment risk worth naming

**Decision.** `GET /api/accounts`, the account detail, and the audit listing take
no auth, matching spec 8, where only the write endpoints are marked bearer-auth.
The audit endpoint returns keys and metadata but never an object body.

**Rejected.** Requiring the bearer token on reads.

**Reason.** The dashboard is a static page that polls these endpoints, and giving
it the token means shipping the token to every visitor, which is not
authentication. So the choice is really between open reads and putting an
identity layer in front of the whole thing.

That makes this worth stating plainly rather than burying: **deployed as
specified, with real bank emails flowing in, these endpoints publish real
balances, merchants and masked account numbers to anyone with the URL.** The
fixture-data demo is unaffected. The fix costs no code - Cloudflare Access in
front of the Pages project and the Worker route, free tier, which is the same
answer this stack would give for any internal dashboard. It is recorded in
DEFERRED as D22 rather than silently accepted, and the audit endpoint withholds
bodies so that at least the raw emails are not served to an unauthenticated
caller.

### 4.7 An empty ledger is a 404, not an empty account

**Decision.** The authoritative read returns 404 when the Durable Object has no
events.

**Rejected.** Returning an empty account object.

**Reason.** A Durable Object exists as soon as it is named, so
`?authoritative=true` on a nonsense account id would otherwise answer 200 with a
plausible-looking empty ledger, and the projected and authoritative paths would
disagree about whether an account exists. Treating "no events" as "no account"
makes the two paths agree.

## Phase 5 — the dashboard

### 5.1 The dashboard is served by this Worker, not by a separate Pages project

**Decision.** `public/` is configured as the Worker's static assets. One deploy
serves the page and the API from the same origin; a request matching a file is
served at the edge without invoking the Worker, and everything else falls
through to `fetch()`.

**Rejected.** A separate Cloudflare Pages project calling the Worker
cross-origin, which is what spec 2 and spec 10 describe.

**Reason.** Two projects means two deploys, a second URL, and a CORS layer -
preflight handling in the Worker, an allowlist that has to name the Pages
domain, and a class of failure where the dashboard is up and every request it
makes fails. All of that is configuration in service of a separation that buys
nothing here: the page and the API ship together and version together.

Same-origin also removes the awkward part of the re-anchor control. A
cross-origin write needs its credentials handled explicitly; a same-origin POST
does not.

The wider context is that Workers static assets is where Cloudflare has moved
this capability - Pages remains for existing projects, and new work of this
shape targets Workers. Following the brief exactly would mean building on the
older of the two paths in order to match a sentence.

### 5.2 The page polls, and says when it last updated

**Decision.** A four-second timer re-fetches whatever is on screen, and the
header shows the time of the last successful update.

**Rejected.** Fetching once on load, and pushing updates over a WebSocket.

**Reason.** The D1 read model is eventually consistent and the brief asks for
that to be visible (spec 10). A page that loads once hides the lag behind a
manual refresh; a WebSocket hides it in the other direction, by making the read
model look instantaneous. A visible timer makes the lag something you can watch:
post an event, and the balance changes a moment later, exactly as the
architecture says it will.

The timestamp in the header exists so a stalled page cannot be mistaken for a
quiet account.

### 5.3 The operator token is typed per session, never shipped with the page

**Decision.** The re-anchor form asks for the token, keeps it in
`sessionStorage`, and sends it as a bearer header. The static assets contain no
secret.

**Rejected.** Embedding a token in the JavaScript, and dropping auth on the
accept endpoint because the dashboard is "internal".

**Reason.** Anything shipped to the browser is public, so a token in `app.js`
would not be authentication - it would be a password printed on the door. The
alternative of leaving the write unauthenticated is worse: accepting a gap is
the one operation that records a human taking responsibility for a discrepancy,
and it must not be something a stranger with the URL can do.

Asking for the token per session is the honest middle. It is not a real identity
system, and the real answer for a deployment is an identity layer in front of
the whole thing - which is the same fix DEFERRED D22 names for the read
endpoints.

### 5.4 Accepting a gap requires a reason, enforced server-side

**Decision.** The endpoint returns 422 when `reason` is missing or blank. The
form marks it required too, but the server is what enforces it.

**Rejected.** An optional reason with a default like "accepted by operator".

**Reason.** The accepted delta stays in the ledger permanently, and the point of
keeping it is that someone can come back later and ask why the chain has a hole
in it. A row that answers "accepted by operator" answers nothing; it is
indistinguishable from a gap accepted by a mis-click. The reason is the entire
value of the record, so it is not optional.

### 5.5 The re-anchor control appears only on a confirmed gap

**Decision.** The accept form is rendered for `CONFIRMED_GAP` and for nothing
else. A pending gap shows an explanation of the window instead.

**Rejected.** Showing the control on every gap and letting the server refuse.

**Reason.** The server does refuse - the ledger returns an error and the endpoint
answers 409 - but an offered control that fails when used teaches the operator
that the interface lies. Not offering it says the thing the two-stage lifecycle
exists to say: this discrepancy might still be a late email, and there is
nothing to decide yet.

### 5.6 Force-window is an API endpoint from this phase, not a Phase 6 addition

**Decision.** `POST /api/accounts/:id/force-window` ships here, bearer
authenticated, running exactly the promotion the alarm runs. The button that
calls it belongs to the simulator panel in the next phase.

**Rejected.** Waiting for the simulator phase, and shortening the window in
development builds.

**Reason.** The re-anchor control is part of this phase and cannot be exercised
without it: accepting requires a `CONFIRMED_GAP`, and the only other route to
one is waiting 48 hours. Building a control that cannot be demonstrated in the
phase that builds it is not finishing it.

Shortening the window under a development flag was the alternative and is worse:
it makes the deployed system behave differently from the tested one, and the
difference is in the exact mechanism the two-stage lifecycle rests on.

### 5.7 Money is formatted in the browser, and only there

**Decision.** The API returns integer paisa everywhere. `app.js` divides by 100
once, at render time.

**Rejected.** Returning pre-formatted strings, or a `rupees` float alongside the
paisa.

**Reason.** A float on the wire is a float someone downstream will do arithmetic
with, and the unit pin exists precisely to stop that. Formatting strings on the
server would keep the API safe but make it useless for anything that is not this
page.

The cost is a small formatter duplicated in JavaScript that already exists in
TypeScript. Sharing it would mean a build step for three lines that do a
division and a `padStart`, and the version in `app.js` is display-only: nothing
downstream of it does arithmetic, which is the property that matters.

## Phase 6 — simulator, dead-letter queue, README

### 6.1 The poison hook is a reference value, and it throws between the audit write and the ledger

**Decision.** An event whose `reference` is exactly `POISON-DLQ-DEMO` throws in
the consumer, after the R2 write and before the Durable Object call.

**Rejected.** A dedicated `source_channel`, throwing at the very top of the
consumer, and a poison flag on the queue message.

**Reason.** The position is the substance of this decision. Throwing before the
audit write would leave a failed event with no artifact, which contradicts the
audit-first ordering the rest of the system is built on and makes the poisoned
event uninvestigable after it dies. Throwing after the ledger call would prove
nothing about the retry path, because the event would already have been applied.
Between the two is the only place that demonstrates what it claims: retries
exhaust, the dead-letter queue receives it, no account is touched, and the raw
payload is still there to look at.

A reference rather than a `source_channel` because `source_channel` is part of
the audit record and should describe where an event genuinely came from. A
reference is data the bank supplies, and no bank issues this one.

### 6.2 The dead-letter queue has a consumer, and it always acks

**Decision.** `txn-events-dlq` is consumed by the same Worker, on a branch keyed
off `batch.queue`. It logs at error level and acks every message.

**Rejected.** Leaving the DLQ unconsumed, and retrying there.

**Reason.** A dead-letter queue nobody reads is a queue where events go to be
forgotten quietly, which is most of the way back to dropping them. A consumer
that records the account and event id turns "something failed five times" into a
line someone can act on.

Acking rather than retrying is not a shortcut: a message arrives here precisely
because it already failed every attempt on the main queue, so the same failure
would repeat. Retrying would build a loop whose only output is noise.

It also makes deferred row D6 partly checkable locally - the promotion to the
DLQ can now be observed under `wrangler dev` rather than only reasoned about.

### 6.3 Every simulator button posts to /webhook

**Decision.** The panel builds a normalized event in the browser and POSTs it to
the authenticated ingress, exactly as an external producer would.

**Rejected.** A server-side `/demo/scenario/:name` endpoint that fires events
internally, which would be less code.

**Reason.** Spec 5.5 asks for a real external event source rather than internal
fake-firing, and the distinction is what makes the demo evidence rather than
theatre. A scenario that calls an internal function proves the ledger works. A
scenario that posts over HTTP proves validation, the queue, the audit write, the
ledger, the projection and the read path all work, in the order they run in
production, including the delay before the dashboard catches up.

### 6.4 The simulator reads the ledger before composing its next event

**Decision.** Each scenario fetches the demo account's authoritative state,
takes the current balance from it, and computes the next reported balance from
that.

**Rejected.** Tracking the running balance in page state.

**Reason.** A balance remembered in the page can drift from the ledger - a
refresh, a second tab, a scenario that partly failed - and every drift shows up
as a gap the demo did not mean to create. Since a manufactured gap is exactly
what one scenario is *supposed* to demonstrate, a drifting simulator would make
the honest scenario indistinguishable from a bug. Reading the balance back means
a gap appears only when a scenario deliberately withholds an event.

### 6.5 Each demo session gets its own account

**Decision.** The panel generates `NIMB:DEMO-XXXXXX` per browser session and
offers a button to roll a new one.

**Rejected.** A single fixed demo account, and a reset endpoint that wipes a
ledger.

**Reason.** Scenarios are only legible from a clean starting point: "a gap of
exactly the missing amount" is hard to see on an account carrying four previous
demonstrations. A fixed account would need resetting, and a reset endpoint means
a way to destroy ledger history - a destructive operation added for the
convenience of a demo, on the one store in the system that is supposed to be
authoritative. Rolling a new account id costs nothing and exercises account
self-creation from the first event.

### 6.6 The README ships without images rather than with broken ones

**Decision.** No image is linked from the README. `docs/images/README.md`
records exactly which three views to capture, how to reach each one, and the
rules the captures have to follow.

**Rejected.** Linking images that do not exist yet, and describing screenshots
that were never taken as though they had been.

**Reason.** Capturing them needs a browser driven by hand, which was not
available. The two ways to paper over that are both worse than the gap: linking
missing files puts broken-image icons in the graded deliverable, and writing the
demo section as if the images were there would be a claim about work that was
not done. The README says the demo is described rather than shown and points at
the deferred row, which is the same standard every other unverified thing in
this project is held to.

### 6.7 The README corrects the brief where the brief overstates

**Decision.** Section 5 says plainly that a lost email does *not* poison every
later balance check, and that re-anchor repairs the account's status rather than
its arithmetic.

**Rejected.** Repeating the stronger claim from the brief, which would have read
better.

**Reason.** In the adjacency model the brief itself specifies, each check
compares against the previous *reported* balance rather than a running total
computed from movements, so a break cannot propagate past the adjacency it
belongs to. Re-anchor is still worth building - without it an account with one
permanently lost email is red forever, and a status that can never be green is a
status nobody reads - but that is a different and smaller claim than the one the
brief makes.

A README that overstates its own mechanism is exactly the kind of thing that
falls apart under one good question, and the weaker claim is both true and
sufficient.
