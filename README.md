# Bank Email Reconciliation Engine

> **Status: runs under local emulation, and has never been deployed.** Everything
> here is built and verified with `wrangler dev` and `vitest`. No Cloudflare
> resources exist, nothing has run on real infrastructure, and no bank email has
> ever reached it — the parsers have only seen invented fixtures.
> [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md) is the runbook for what
> deploying it would take; [`docs/DEFERRED.md`](docs/DEFERRED.md) lists every
> claim a deployment would have to prove.

**Your inbox shows every transaction you were told about. The running balance is the only thing that knows about the ones you weren't.**

Two Nepali banks, NIMB and Nabil, send a transaction alert on every debit and credit. Each of those emails asserts two things at once: the **movement** — this debit, this credit — and the **available balance that resulted**. Read one at a time, they are notifications. Read as a sequence, they are a checkable claim.

This engine ingests those emails through a Cloudflare Email Worker, normalizes two formats that look nothing alike into one event shape, and maintains a per-account ledger that does the one job no individual email can do: it checks that the balances **chain**. If the email for transaction N says the balance is now X, and the next transaction in time says the balance is now Y, then Y must equal X plus that transaction's movement.

When it does, that stretch of history is reconciled. When it does not, something moved money and sent no email — a fee, a standing instruction, a transaction alerted only by SMS, or an email that got lost between the bank and the inbox. The engine flags the gap and states its exact size, even though it cannot know its cause.

That is the whole idea. Everything below is about doing it honestly.

---

## 1. The problem

Personal bank reconciliation, done against the only source that exists: the bank itself.

You cannot check your bank's arithmetic against your bank. What you *can* do is check the bank's two assertions against each other. Each alert email carries a movement and a resulting balance, and those two facts, chained across a sequence of emails, have to be consistent. A discrepancy between them is not a claim that the bank is wrong — it is proof that **a transaction occurred that produced no email**, and the balances tell you exactly how large it was.

This is reconciliation in the ordinary accounting sense: cross-check a stream of recorded movements against an independently stated balance and resolve the difference. Section 15 is precise about what that does and does not entitle the engine to claim.

## 2. What it does

Forward your bank alerts to an address on a domain you own. Cloudflare Email Routing hands each one to a Worker, which parses it, normalizes it, and puts it on a queue. A consumer archives the raw message to R2, then hands the event to a Durable Object that holds that account's ledger. The dashboard reads a D1 projection of that ledger.

The interesting behaviour, all of it demonstrable from the simulator panel in a few seconds:

| Scenario | What should happen |
|---|---|
| The same email arrives twice | One transaction. Balance unchanged, count unchanged, delivery counter goes to 2. |
| Two emails arrive out of order | Both reconcile. The ledger sorts on when the bank stamped them, not on arrival. |
| A transaction is skipped | A `PENDING_GAP` opens, sized at exactly the missing amount. |
| The skipped email arrives late | It slots into its place in time, both new adjacencies chain, the gap closes. |
| The window elapses with no email | A Durable Object alarm promotes it to `CONFIRMED_GAP`. 🚩 |
| An operator accepts the gap | Re-anchor: the delta is recorded as an accepted discontinuity with a reason, and the account reconciles forward. |
| A poison event arrives | It exhausts its retries, lands in the dead-letter queue, and the pipeline behind it keeps running. |

Each of those is a test in `test/ledger.test.ts` and `test/consumer.test.ts` as well as a button.

### A gap opening

![An account detail view. The summary reads: balance 8,830.00, 2 transactions, 1 open gap, status "pending review". A gap card states "-600.00 unaccounted" between two named event ids. Below, the timeline shows two debits; the second is marked "broken", with "expected 9,430.00" and "off by -600.00".](docs/images/gap-detail.png)

Two debits arrived. The bank said the balance was 9,550.00 after the first and 8,830.00 after the second, but the second debit was only 120.00 — so the balances disagree with the movements by exactly 600.00. **That difference is a transaction that happened and sent no email**, and the engine states its size precisely while saying nothing about its cause. The gap is `PENDING_GAP` because at this moment a late email could still explain it.

Note what is *not* flagged: the first row reads `anchor`, because reconciliation is a property of adjacencies and the first event has nothing before it to chain from.

### Re-anchoring past a gap that will never fill

![The same view after the resolution window has closed. The status card reads "gap confirmed", the gap card is now "confirmed gap" with a red edge, and it has expanded to show a re-anchor form: an explanatory paragraph, a line reading "Authorised by OPERATOR_TOKEN — not the simulator secret", a reason field, a token field, and an "Accept and re-anchor" button.](docs/images/reanchor.png)

The window elapsed with no filling email, so a Durable Object alarm promoted the gap to `CONFIRMED_GAP` — no cron worker, no external scheduler. Only now does the re-anchor control appear: accepting a gap while it is still pending would discard the one mechanism that distinguishes a late email from a lost one.

The reason field is required and enforced server-side, because the accepted delta is kept permanently and a record that cannot say *why* answers nothing. Accepting marks the discontinuity as one a human took responsibility for; it does not erase it, and the timeline row stays marked broken afterwards.

Both screenshots are taken against simulator-generated data — `DEMO-` accounts, invented merchants, fabricated balances and references. Nothing in them is blurred or cropped, because none of it is real.

## 3. Architecture

```
Bank ──email──▶ Gmail ──auto-forward──▶ Cloudflare Email Routing ──▶ Email Worker
                                                                        │  email() handler
                                                                        │  1. parse MIME (postal-mime)
                                                                        │  2. branch: NIMB (regex) | Nabil (HTMLRewriter)
                                                                        │  3. normalize → TxnEvent
                                                                        ▼
Simulator ──POST /webhook──▶ Worker ──validate──▶  Queue  (both ingress paths converge here)
                                                     │
                                                     ▼
                                   Queue Consumer (Worker)
                                     1. write raw payload → R2 (audit)
                                     2. call Account DO with event
                                                     │
                                                     ▼
                              Durable Object (account_id)  ◀── CP ledger
                                - dedup by derived event_id
                                - insert into ordered log (by occurred_at)
                                - recompute adjacencies, open/close/accept gaps
                                - set alarm for any PENDING_GAP
                                - return projected account state
                                                     │
                                     3. write projection → D1 (read model)

Dashboard ──GET /api/accounts──▶ Worker ──▶ D1  (eventually consistent reads, AP)
```

This is **CQRS-lite**. The Durable Object is the authoritative write model; D1 is a read model derived from it. Naming that split is what makes the consistency story in the next section coherent rather than a collection of preferences.

## 4. The three consistency zones

It would be wrong to call this "an AP system". CAP describes what a *replicated datastore* does during a partition, and the ledger here is single-writer — there is nothing to partition. The honest framing is three zones, each with a behaviour chosen for it:

**1. Ingestion — asynchronous and disorder-tolerant.** Emails arrive whenever the bank and Gmail decide. They arrive out of order relative to when the transactions happened, and sometimes more than once: a forwarding retry, a bank re-send, a queue redelivery. The response is not to relax about correctness but to stop depending on arrival order at all. Identity comes from a key derived from the content, and time order is reconstructed inside the ledger. Two deliveries of one transaction converge; so do two transactions delivered backwards.

**2. The reconciliation ledger — CP.** The balance chain only means anything against a consistent view of one account's history. Inserting an event means recomputing the adjacencies around it and possibly opening or closing a gap: a read-modify-write over the account's state. Two of those running concurrently on one account could each miss that the other's event filled a gap, or leave the open-gap count wrong — a textbook lost update, on the one number the whole product is about. One Durable Object per account makes writes single-threaded per account, so that interleaving is structurally impossible rather than defended against.

**3. Dashboard reads — genuinely AP.** An account view that is two seconds stale is fine, so reads come from the D1 projection and are allowed to lag. The dashboard has a toggle that reads the Durable Object directly, so you can put the two answers side by side and watch the lag close.

In one sentence: **asynchronous, disorder-tolerant ingestion → a CP reconciliation ledger → eventually-consistent reads.**

## 5. The reconciliation model

This is the part that is actually mine, so it gets the most words.

### The chain

For one account, sort the applied events by `occurred_at`. For each adjacent pair `(prev, cur)`:

```
signed_movement(cur) = +amount_paisa if CREDIT, -amount_paisa if DEBIT
expected             = prev.reported_balance_paisa + signed_movement(cur)
chains  ⟺  cur.reported_balance_paisa == expected
```

The load-bearing idea: **reconciliation is a property of adjacencies, not of events.** No transaction is ever "unreconciled" on its own. What is reconciled or not is the *relationship* between two consecutive transactions.

That is why there is no pending buffer anywhere in this system. An email that arrives late is not held in a pen waiting for its predecessor — it is recorded immediately at its position in time, and the two adjacencies it creates are recomputed. A held-event queue would need drain logic, retry logic, and a rule for when to give up; the sorted-log recompute needs none of those and cannot get stuck.

### Gaps

A failing adjacency means an unaccounted movement of size `delta = cur.reported_balance_paisa - expected` happened between the two. **Its size is known exactly even though its cause is not**, and being clear about that division is the difference between a useful tool and a guess. The engine will tell you 600 rupees left the account with no email. It will not tell you why, because it cannot.

### The two-stage lifecycle

At the moment a mismatch is detected there are two possible explanations and no way to distinguish them: an email that will never come, or an email that is merely late. Anything that claims to tell them apart instantly is bluffing.

So gaps have a lifecycle, and time is what resolves it:

| Status | Meaning | Enters when | Leaves when |
|---|---|---|---|
| `PENDING_GAP` | Mismatch detected, still inside the resolution window | An adjacency fails | A filling email arrives (closed) or the window elapses (`CONFIRMED_GAP`) |
| `CONFIRMED_GAP` | Window elapsed with no filling email; treat as real | The alarm fires | An operator accepts it |
| `ACCEPTED_GAP` | Operator re-anchored past it | Manual re-anchor | Terminal |
| *(closed)* | A late email filled it and both new adjacencies chain | A filling email arrives while pending | — |

The window is 48 hours and it is enforced by a **Durable Object alarm**, not a cron worker and not an external scheduler. When a gap opens, the object schedules itself; when the alarm fires it promotes whatever is due and reschedules for the next deadline. Time-based state transition with nothing outside the object responsible for remembering.

A closed gap is deleted rather than moved to a fourth status. A gap that filled is not a gap, and leaving the row behind would mean every reader of `open_gap_count` has to remember to exclude it — one that forgets reports an account as permanently broken.

A **confirmed** gap is never closed automatically, even if a late email would fill it. By the time a gap is confirmed the system has told a human that a transaction is missing, and they may have acted on it. Silently reversing that — and silently reversing it again if a further event reopens the adjacency — would make the confirmed state meaningless. Instead the gap is flagged as *now fillable* and the operator decides.

### Re-anchor

A permanently lost email leaves an adjacency that will never chain. Re-anchor is the escape hatch: an operator accepts a `CONFIRMED_GAP`, recording the delta as an accepted discontinuity **with a required reason**, and the account can read `RECONCILED` again.

Worth being precise, because the obvious justification for this feature is slightly wrong. It is tempting to say a lost email "poisons all subsequent reconciliation". In this model it does not — each adjacency is checked against the *previous reported balance*, not against a running total computed from movements, so a break stays local to the one adjacency it belongs to. What re-anchor actually fixes is the account's **status**: without it, one lost email means an account that is red forever, and a status that can never be green is a status nobody reads.

The accepted gap row is kept permanently. The reason is required and enforced server-side, because the entire value of that record is being able to come back in six months and ask why the chain has a hole in it. "Accepted by operator" answers nothing and is indistinguishable from a mis-click.

### Same-minute ordering

Nabil stamps its alerts to the minute, so two transactions in the same minute tie on `occurred_at` and the log alone cannot say which came first. The tiebreak is not cosmetic: order two perfectly consistent transactions the wrong way round and the chain reports a gap that never existed, which is the fastest possible way for a reconciliation tool to stop being believed.

So the balances are used to recover the order. Starting from the balance the chain has already reached, repeatedly take whichever tied event chains from it. When no arrangement chains — a genuine gap inside the tie — the remainder falls back to a deterministic order and the mismatch is reported normally. The residual risk is a real gap being hidden if the tied events happen to chain in some other order, which requires the missing transaction to be exactly compensated by a reordering; that is a much smaller risk than routinely inventing gaps.

## 6. Why a Durable Object for the ledger

Applying an event is a read-modify-write over an account's whole state: read the log, insert, re-evaluate adjacencies, open or close gaps, bump a version. Two of those interleaving on one account can lose an update — each recomputes from a view that does not include the other's event, and the loser's gap changes are overwritten. The result is a wrong open-gap count or a gap that stays open after the email that filled it arrived.

A Durable Object gives one single-threaded execution context per `account_id`. Not a lock, not a transaction retry loop: the interleaving cannot be constructed. Combined with the SQLite storage API, the whole apply is a sequence of statements inside one object with no other writer.

**Why not just D1?** It was the alternative, and it is the honest comparison. D1 has transactions, and a `BEGIN ... COMMIT` around the recompute would be correct too. The reasons it lost:

- The recompute reads and writes a variable number of rows across two tables. Expressing "insert, then reconcile the gap set against every adjacency" as one safely-retryable D1 transaction is more moving parts than doing it in a context where concurrency is impossible.
- D1 is the read model. Making it also the write model collapses the CQRS split and removes the thing that makes the projected-versus-authoritative demonstration possible.
- The alarm has to live somewhere. With a Durable Object it is a property of the object that owns the state; with D1 it needs a scheduled Worker that scans for due gaps, which is a second moving part doing what the platform already offers.

**And the honest caveat:** at personal-spending volume, two emails for one account arriving concurrently is rare. This is structural correctness under concurrency I will mostly not encounter, not a fix for contention I measured. The argument for it is that the failure it prevents is silent and lands on the balance, and that the cost of choosing it is close to zero. That is a defensible reason to pick it. "It was faster" would not be.

## 7. Why a Queue

Both ingress paths — the `email()` handler and `POST /webhook` — validate and enqueue, then return. Nothing else.

That is not an optimisation, it is a constraint. A slow `email()` handler stalls Email Routing delivery, and by the time it runs, Cloudflare has already accepted the message from the sender: there is nobody left to bounce it to. Ingress has to be fast and has to not fail. Everything that can fail — R2, the ledger, D1 — happens on the other side of the queue where a retry is available.

Delivery is **at-least-once**, so every step in the consumer is written to be repeated. The R2 key is derived from the event and written once. The ledger dedups on a primary key. The projection is guarded by a monotonic version.

**Idempotency with no server-issued id.** Emails carry no identifier under my control, and the same transaction can arrive twice as two byte-different messages — a Gmail re-forward has a new `Message-ID` and extra `Received` headers. So the key is derived from the content: `event_id = "{bank}:{reference}"` using the bank's own transaction reference, falling back to `sha256` over the stable fields when no reference can be extracted. The event records which derivation was used, because the hash-derived key is genuinely weaker: two identical-looking transactions in the same second would collide under it. That weakness is recorded on every row rather than hidden.

The failure taxonomy in the consumer is deliberate, and it is per-failure rather than per-layer:

- A body that will not parse as a bank email is logged and **dropped at ingress**. It never reaches the queue. It would fail identically five times and then occupy the dead-letter queue, which is meant to hold real poison.
- A queue message with no `event_id` is **acked**. Nothing to reconcile, no attempt will differ.
- An R2 or D1 failure **retries**. The input is fine and the next attempt will probably work; acking here would silently lose a real debit, which is the one outcome this project exists to prevent.
- A queue send failure at ingress is allowed to **throw**, because there is no retry available there and failing the invocation is the only signal left.

## 8. Why D1 for reads and R2 for audit

**D1** holds a projection: accounts, transactions, gaps. It exists so dashboard reads do not serialize through one Durable Object per account, and it is allowed to lag. What it is not allowed to do is go backwards. The Durable Object returns a monotonic version with every state, and the projection write is a conditional upsert — `ON CONFLICT DO UPDATE ... WHERE excluded.projection_version > accounts.projection_version` — so a delivery that lost a race matches zero rows and disappears. The comparison is part of the write, not a check before it, because check-then-write is exactly the race it is supposed to prevent.

**R2** holds the raw payload of every event, verbatim, at `raw/{account_id}/{event_id}.eml` (or `.json` for simulator events), written *before* anything reconciles. Audit-first ordering means a later failure retries against evidence that is already durable; the reverse order can reconcile a transaction whose raw form was never kept. It is also why a poisoned event that never reaches a ledger is still investigable afterwards.

Write-once is enforced by skipping an existing key rather than overwriting it with identical bytes. A queue retry does resend identical bytes — but a re-forwarded email does not, and in a store whose entire value is holding the thing that actually arrived, the first copy has to win.

The two raw formats are the clearest illustration of "different data, different shape" in the project: one is a paragraph of prose and the other is an HTML table, they share no field names, no date format and no structure, and by the time they leave the parsers nothing downstream can tell them apart.

## 9. The two parsers

**NIMB — plain-text prose.**

```
Your a/c 017XX0791 has been Debited by NPR 2,200.00 on 28Aug26 14:38:20.
The transaction detail is 15668799tZvW,beer,155892674,2222050005866663,12687.
Available Balance on 28Aug26 14:40:03 is NPR 2,538.46
```

Regex over the sentence. Two timestamps appear and only one is right: the transaction time, not the balance-read time two minutes later. The reference and merchant come from a positional comma-blob, and that parse is **the most brittle thing in this project** — first token is the reference, second is the closest thing to a memo, and nothing in the format guarantees either. When it goes wrong the reference is lost, which degrades the `event_id` to the hash derivation rather than corrupting anything; that is the only reason it is acceptable.

**Nabil — an HTML table.**

| Transaction Date | Transaction Type | Transaction Amount | Available Balance | Remarks |
|---|---|---|---|---|
| 2026-08-28 14:20 | Debit | 2,000.00 | 3,018.36 | MPAY FPQR,55697463K9aD,SAMAJ DENTAL PVT. LTD. |

Parsed by streaming through `HTMLRewriter`, with **columns located by matching their header text** rather than by position. Bank alert HTML comes out of a mail template: cell text is wrapped in `<span>`s, tags are frequently unclosed, and a regex over that markup degrades into wrong captures rather than no captures. Reading positionally fails worse — a bank that inserts one column shifts every index, and the parser then reads the amount out of the balance column and reconciles a plausible-looking chain against the wrong numbers. Matching on header text turns both failures into a loud error. There is a test that reorders and inserts a column specifically to hold that property.

One `HTMLRewriter` detail worth recording because it cost a failing test: a `text` handler on `td` already fires for text inside nested elements. Registering a second handler on `td *` to "also catch wrapped text" double-counts it, and `<td><span>Credit</span></td>` arrives as `"CreditCredit"`.

**Money is integer paisa everywhere.** `parseFloat("7310.55") * 100` is `731054.9999999999`, and that is the whole argument. Amounts are parsed by stripping commas, splitting on the decimal point and computing `rupees * 100 + paisa`. No float touches a money value at any layer — not in the parsers, not in the Durable Object, not in D1, not in an API response. The only division by 100 in the system is in the browser at render time.

**Timestamps** are normalized to `YYYY-MM-DDTHH:MM:SSZ` from two unrelated formats (`28Aug26 14:38:20` and `2026-08-28 14:20`, the latter with no seconds). Neither bank states a timezone. Both are taken to stamp Nepal Standard Time and are converted to true UTC, so `28Aug26 14:38:20` is stored as `2026-08-28T08:53:20Z`.

The reason is one time base across the schema. `applied_at`, `detected_at`, `promote_at` and `received_at` all come from `Date.toISOString()` and are genuinely UTC. An `occurred_at` sitting beside them in the same format with the same `Z` suffix, but carrying local time, would make every comparison across those columns wrong by 5h45m — silently, and only once something started comparing them. A freshness check, or a measure of how late a forwarded email arrived, would each read correctly and be wrong. Converting removes the category rather than documenting the trap.

The dashboard renders these back in `Asia/Kathmandu`, so the digits on screen match the digits in the alert email. Storage is UTC; exactly one place in the system applies a timezone. See [`docs/DECISIONS.md`](docs/DECISIONS.md) 1.1 and 7.1.

## 10. Reliability primitives

| Primitive | Where |
|---|---|
| **Idempotency** | Derived `event_id`, deduped by the `events` primary key in the Durable Object. A re-forwarded email increments a delivery counter and moves nothing else. |
| **At-least-once handling** | Every consumer step is repeatable; transient failures throw so the queue retries with backoff. |
| **Dead-letter queue** | Poison events land in `txn-events-dlq` after exhausting retries, with their own consumer that records and acks. The pipeline behind them keeps running. |
| **Timeouts / fast path** | Both ingress handlers parse-or-validate and enqueue. Reconciliation is asynchronous. |
| **Ordering vs arrival** | Correctness is reconstructed by sorting on `occurred_at` inside the ledger, so out-of-order delivery converges. Asserted in `test/ledger.test.ts`. |
| **Time-based transitions** | A Durable Object alarm promotes `PENDING_GAP → CONFIRMED_GAP` with no external scheduler. |
| **Schema evolution** | The normalized event carries `schema_version` and is additive-only. |

## 11. Compute choices

Serverless throughout, and for the ordinary reason: this workload is a handful of emails a day with no steady traffic to justify anything running continuously.

**Email Workers** are the piece that makes the project possible. Inbound email as a programmable endpoint means there is no IMAP poller, no always-on mailbox process, no credentials for a mail account sitting in a secret store — a message arrives and a function runs.

**A Durable Object for the one stateful part.** Workers are stateless by design and that is right for parsing and routing. Exactly one thing here needs to be stateful and serialized — the per-account ledger — and it gets an object. The boundary between the stateless and stateful parts of the system is the boundary between "transform this message" and "decide what this message means for an account".

**DO Alarms for time.** The 48-hour window needs something to notice that it elapsed. The alternatives are a cron-triggered Worker scanning for due gaps, or a scheduled job somewhere off-platform. The alarm makes elapsed time a property of the object that owns the state, and it is also the one state transition with no queue message behind it — which is why the alarm projects to D1 itself.

**The dashboard is served by this same Worker** as static assets rather than by a separate Pages project. One deploy, one origin, no CORS layer to configure or explain. The brief specified Pages; Workers static assets is where Cloudflare has moved this capability, and following the brief exactly would have meant building on the older of the two paths to match a sentence.

## 12. What I deliberately didn't use

**A held-event buffer.** The obvious design for out-of-order arrival is to hold an event whose predecessor has not arrived and drain the buffer later. Recomputing adjacencies over a sorted log is simpler and strictly more correct: there is no buffer to leak, no drain to get stuck, no rule needed for when to give up on a predecessor that will never come.

**KV for the ledger.** Eventually-consistent storage is the wrong shape for a balance chain. A read-modify-write over eventually-consistent state is how you get a lost update on the number the product is about.

**A JSON blob for the account state.** The previous project of this shape stored history as one JSON value read and rewritten whole. That is fine for an entity that goes terminal after a handful of events. An account ledger never terminates, so the blob grows without bound and every event rewrites all of it. The Durable Object's SQLite API gives indexed tables instead.

**A real bank API.** None is available for these banks at a personal level. Email is the interface that exists.

**Cross-source matching.** Reconciling against a statement export or an SMS feed would make this independent-source reconciliation. It is not in scope, and section 15 says so plainly rather than letting the word "reconciliation" imply it.

## 13. Schema evolution

The normalized event carries a `schema_version` and evolves additively: new fields may be added, existing ones are not repurposed or removed. Consumers ignore fields they do not know, and the ingress boundary refuses an event whose version it does not recognise — a higher version means the producer changed something this code cannot see, and guessing is worse than refusing.

This is the same discipline as versioned structured-message exchange in EDI, where EDIFACT and X12 messages carry a version so that a partner running an older implementation can still read what it understands. The parallel is in the versioning discipline only; nothing here implements an EDI standard.

## 14. Running it

### Locally

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars   # then set both tokens to any values
npm run db:local                        # applies both migrations to the local D1
npm run dev                             # wrangler dev, all bindings emulated locally
```

On POSIX shells, `cp .dev.vars.example .dev.vars`. The runbook is PowerShell-first; see its "Shell conventions" section for the four other differences that matter.

Open <http://127.0.0.1:8787>. The simulator panel drives everything. It asks for `SIMULATOR_TOKEN`; accepting a gap asks for `OPERATOR_TOKEN`, which is a separate secret — both are in `.dev.vars`.

Start from `rm -rf .wrangler` before a demo run: emulation state persists between runs and can hold rows from an earlier version of the parsers. [`docs/DEMO.md`](docs/DEMO.md) is the step-by-step walkthrough, including what each scenario should produce.

```bash
npm test                           # 162 tests, vitest on @cloudflare/vitest-pool-workers
npm run typecheck                  # tsc --noEmit
```

To drive the real `email()` handler locally, without a domain or an account, post a raw message to Miniflare's email trigger:

```bash
curl -X POST "http://127.0.0.1:8787/cdn-cgi/handler/email?from=donot_reply@nimb.com.np&to=alerts@example.invalid" \
  -H "Content-Type: message/rfc822" \
  --data-binary @samples/redacted/nimb-debit.eml
```

Every fixture in `samples/redacted/` is invented — the account numbers, merchants, balances and references are all fabricated.

### Deploying, and configuring Email Routing

**This has never been deployed.** It was built and verified entirely under local emulation, and everything that can only be checked against a real Cloudflare account is listed in [`docs/DEFERRED.md`](docs/DEFERRED.md) with the exact command and the result that would prove it. **Not one of those rows has been run**, because no Cloudflare resource exists to run them against. Two rows in that file are marked verified — that the dashboard renders in a browser and that the simulator scenarios drive the pipeline — and both are explicitly scoped to local emulation, which is a different claim from working on deployed infrastructure.

[`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md) is the ordered runbook: every `wrangler` command with real arguments, every dashboard action, and every placeholder id in `wrangler.jsonc` with what replaces it. Email Routing is deliberately last, because it is the only step that costs money.

**Cloudflare Access is required before the first email forward.** Not optional, and not something to add afterwards. The read API is unauthenticated by design, so a deployed instance with real bank email flowing in publishes real balances, merchants and masked account numbers to anyone who finds the URL — and `workers.dev` hostnames get scanned. The runbook configures Access as a step that precedes Email Routing, with a bypass for `POST /webhook` so the simulator keeps working on its own bearer token. Free tier, no code change.

### Cost

**One paid dependency: a domain, roughly $10/year**, needed because Email Routing requires a zone on Cloudflare. Inbound Email Routing itself is free and unlimited on the Workers free plan.

Everything else is free tier: Workers requests, D1 rows read and written, Durable Object requests, R2 operations and storage, and Queues operations. At personal-spending volume — a few emails a day — the usage is nowhere near any of those limits. Cloudflare Images is deliberately not used; it is a paid product, and adding it would contradict this section.

Free-tier limits change. Check <https://developers.cloudflare.com/workers/platform/limits/> rather than trusting numbers written here; this is deferred check D12.

## 15. Honest limitations

**Single origin.** This is the most important one. Every fact in the system comes from the bank. The engine reconciles two things the bank asserts in the same email — the movement, and the balance that resulted — so a mismatch reveals a *third* movement the bank never emailed. That is genuine reconciliation and it is standard bank-rec logic, but it is **not independent-source reconciliation**. Nothing here would catch the bank being wrong about its own balance. Cross-checking against a statement export or an SMS feed would be independent; neither is in scope.

**Late versus missing is undecidable at detection.** The two-stage lifecycle is the honest response to that, not a solution to it. The 48-hour window is a judgement call, not a truth, and a gap confirmed after 48 hours can still be filled by an email that took three days.

**Chain integrity assumes every email carries a balance and none is permanently lost.** An email without a balance line is rejected outright rather than stored, because an event that cannot be chained contributes nothing and creates a hole. Re-anchor mitigates a permanently lost email but cannot recover what it contained — the delta is known, its cause never will be.

**The parsers are format-specific and will break on rewording.** A versioned event schema protects everything downstream of the parse; it does nothing for the parse itself. The NIMB positional comma-blob will break first.

**The Nepal timezone assumption is now load-bearing.** `occurred_at` is stored as a true UTC instant on the assumption that both banks stamp UTC+05:45. Neither states a zone, so this is inferred rather than known. If it is wrong, `occurred_at` is not mislabelled — it is a genuinely wrong instant, off by up to 5h45m, and anything derived from it inherits the error. Sort order within one account survives regardless, since a single ledger only ever holds one bank's timestamps and a constant offset cannot reorder them, so reconciliation itself is unaffected either way. Confirming it needs a real email, whose `Date:` header can be compared against the stamp in its body; that is deferred check D14 and it is open.

**One paid dependency** — the domain, above.

**Privacy, and the access control this needs before it sees a real inbox.** Real bank emails carry your name, your balances, and your merchants. Everything committed to this repository is invented: no real account number, merchant, balance or reference appears in any fixture, test or screenshot.

A deployment pointed at a real inbox is a different matter. The read API is unauthenticated by design — the dashboard polls it and a static page cannot hold a secret — so **Cloudflare Access in front of the Worker route is a prerequisite for the first email forward, not later hardening.** `workers.dev` hostnames are enumerated and scanned; there is no window in which an unprotected deployment is merely theoretical. The setup runbook configures Access *before* Email Routing for that reason.

Be precise about what that buys. Access protects the read surface: the dashboard and the `/api` endpoints. It does not protect R2 — if the audit bucket were ever given public access it would serve raw bank emails to anyone, independently of Access — which is why `bank-recon-audit` has no public custom domain and no `r2.dev` access, and why `wrangler.jsonc` carries a comment saying so. It also does not protect `/webhook`, which is deliberately excluded from the Access policy so the simulator can still reach it, and remains protected only by its bearer token.

**It has not been deployed, and the dashboard has not been opened in a browser.** Every claim in this README is backed by a passing test or a `wrangler dev` session captured in a pull request, and the ones that are not are in `docs/DEFERRED.md` rather than being implied here.

---

## Repository map

| Path | |
|---|---|
| `src/parse/` | MIME extraction, the two bank parsers, paisa, timestamps, `event_id` derivation |
| `src/validate.ts` | The `/webhook` trust boundary |
| `src/chain.ts` | The balance chain — one implementation, shared by the ledger and the read API |
| `src/account-ledger.ts` | The Durable Object: dedup, ordered log, gaps, alarm, re-anchor |
| `src/consumer.ts` | Queue consumer, the failure taxonomy, the poison hook and DLQ |
| `src/projection.ts` | The version-guarded write to D1 |
| `src/api.ts` | Dashboard reads, the authoritative toggle, re-anchor |
| `public/` | The dashboard and simulator: three files, no build step |
| `docs/DECISIONS.md` | Every non-obvious call, written when it was made |
| `docs/DEFERRED.md` | Everything unverifiable without a Cloudflare account |
| `docs/CLOUDFLARE_SETUP.md` | The deployment runbook |
| `docs/DEMO.md` | The local walkthrough, and what each simulator scenario should show |
