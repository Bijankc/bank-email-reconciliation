# Cloudflare setup runbook

Nothing in this file has been run. There is no Cloudflare account attached to
this project yet, and the build is verified entirely under local emulation. This
is the ordered list of what to run **once an account exists**, with real
arguments, so it can be executed top to bottom without working anything out.

Keep this file current as bindings change. Every step says what it produces and
what proves it worked.

---

## Read this before the first deploy

**Any change to how `occurred_at`, `event_id`, `account_id` or the paisa amounts
are derived must land before the first deploy, or carry a migration that
rewrites every stored row.**

These are derived values, not values the bank supplies, and nothing in the
stored data records which version of a rule produced it. Change a rule
afterwards and the store holds two incompatible generations of the same column
with no way to tell them apart:

- `occurred_at` is what the balance chain sorts on. Rows on two time bases can
  order wrongly against each other.
- `event_id` is the dedup key. If it changes, a re-forwarded email no longer
  matches its stored row, inserts a second one, and the movement is counted
  twice — silently, with no error and no failing test.
- `account_id` is the Durable Object's name. If it changes, the ledger splits in
  two and each half reconciles against a fraction of the history.

This is not hypothetical. Converting `occurred_at` from bank local time to UTC
did exactly this during the build, and because `occurred_at` feeds the
hash-derived `event_id`, it changed the identity of every event that had no bank
reference as well. It was free only because nothing had been deployed yet.

A migration here means rewriting the column in **both** the Durable Object
SQLite tables and the D1 projection, and re-deriving anything downstream of it.
`docs/DECISIONS.md` 7.3 has the full table of derived values and what each one
costs.

---

## Step 0 — What works with no account at all

Nothing below is needed to run, test, or demo the project locally.

```bash
npm install
npm run db:local         # applies migrations/0001_init.sql to the local D1
npx wrangler dev         # local emulation; no account, no login
```

**Before any demo or screenshot run, start from clean state:**

```bash
rm -rf .wrangler
npm run db:local
npm run dev
```

Local emulation state persists between runs and can hold rows written by an
earlier version of the parsers - including `occurred_at` values on the old time
base, in the column the chain sorts on. `docs/DEMO.md` is the full walkthrough.

`wrangler dev` emulates D1, R2, Queues, and Durable Objects on disk under
`.wrangler/`. The simulator path (`POST /webhook`) exercises the same queue,
Durable Object, and projection as a real bank email would.

---

## Step 1 — Create the account and log in

1. Sign up at <https://dash.cloudflare.com/sign-up>. The Workers **free** plan
   is sufficient for everything except the domain in Step 7.
2. Authenticate the CLI:

   ```bash
   npx wrangler login
   ```

   Opens a browser for OAuth consent. Proves it worked:

   ```bash
   npx wrangler whoami
   # expect: your email and account id, not "You are not authenticated"
   ```

---

## Step 2 — (only if you have more than one account) pin the account id

`wrangler whoami` prints an Account ID. If it lists more than one account,
export the one you want so no command has to guess:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account id from whoami>    # bash
$env:CLOUDFLARE_ACCOUNT_ID = "<account id from whoami>"  # PowerShell
```

Do not put the account id in `wrangler.jsonc`. It is account-scoped and this
repository is public.

---

## Step 3 — Create the D1 database → replaces the one placeholder

```bash
npx wrangler d1 create bank-recon
```

The output ends with a block containing `database_id = "..."`.

**Placeholder to replace:** in `wrangler.jsonc`, under `d1_databases`, change

```jsonc
"database_id": "REPLACE_WITH_D1_DATABASE_ID"
```

to the uuid that command printed. That is the only account-scoped id in the
config; after this step the only remaining mention of `PLACEHOLDER` should be
the note in the header block.

Then create the schema remotely:

```bash
npx wrangler d1 execute bank-recon --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute bank-recon --remote --file=./migrations/0002_gap_bounds.sql
```

Proves it worked:

```bash
npx wrangler d1 execute bank-recon --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
# expect rows: accounts, gaps, transactions (plus sqlite_* internals)
```

---

## Step 4 — Create the R2 audit bucket (PRIVATE)

```bash
npx wrangler r2 bucket create bank-recon-audit
```

**This bucket must stay private.** It holds raw bank emails verbatim: real
names, account numbers, balances, merchants.

- Do **not** run `wrangler r2 bucket dev-url enable bank-recon-audit`.
- Do **not** attach a custom domain to it in the dashboard.
- Verify in the dashboard under **R2 → bank-recon-audit → Settings → Public
  access** that both *r2.dev subdomain* and *Custom domains* read as disabled.

Proves it is private: with public access off there is no public URL to fetch at
all. If an `r2.dev` URL exists for this bucket, public access is on — turn it
off.

Only if a README demo asset exceeds 5MB, create the separate public bucket:

```bash
npx wrangler r2 bucket create bank-recon-assets
npx wrangler r2 bucket dev-url enable bank-recon-assets   # public; assets only
```

Never put demo assets in `bank-recon-audit`, and never enable public access on
it.

---

## Step 5 — Create the queues

Order matters: the dead-letter queue must exist before the consumer that names
it is deployed.

```bash
npx wrangler queues create txn-events-dlq
npx wrangler queues create txn-events

# The Worker consumes both queues: txn-events for real work, txn-events-dlq so
# a poisoned event is recorded rather than accumulating unread. Both consumer
# blocks are already in wrangler.jsonc; no extra `queues consumer add` is needed
# because they are declared in config.
```

Proves it worked:

```bash
npx wrangler queues list
# expect both txn-events and txn-events-dlq
```

---

## Step 6 — Set the simulator secret and deploy

```bash
npx wrangler secret put SIMULATOR_TOKEN
# paste a long random value when prompted; it is never echoed and never stored in git
```

Generate one with:

```bash
node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

**There are two secrets, and they must be different values.** They guard
different things and a leak of one should not imply the other:

```bash
npx wrangler secret put SIMULATOR_TOKEN   # POST /webhook, force-window
npx wrangler secret put OPERATOR_TOKEN    # accepting a gap, permanently
```

`SIMULATOR_TOKEN` admits an event to the pipeline. `OPERATOR_TOKEN` records a
human accepting a real discrepancy on the record. Generate each one with the
command above rather than choosing them; both fail closed if unset, so a
deployment missing one rejects every request to its routes rather than waving
them through.

The simulator is additionally fenced: `SIMULATOR_SCOPE` in `wrangler.jsonc` is
`demo-accounts-only`, so even a correct `SIMULATOR_TOKEN` can only write to
`DEMO-` account ids. Leave it that way on a deployment that sees real email.

Then:

```bash
npx wrangler deploy
```

Proves it worked (replace the host with the deployed workers.dev host):

```bash
curl -s https://bank-email-reconciliation.<subdomain>.workers.dev/health
# expect ok:true with d1, r2, durable_object and queue_producer all "ok";
# simulator_token AND operator_token both "configured"; and
# simulator_scope "demo-accounts-only"
```

Then prove the async path end to end, which is what Phase 2 built (this is
deferred rows D5, D16 and D17):

```bash
HOST=https://bank-email-reconciliation.<subdomain>.workers.dev
TOKEN=<the value you generated above>

curl -s -X POST "$HOST/webhook"   -H "authorization: Bearer $TOKEN"   -H "content-type: application/json"   -d '{"account_id":"NABIL:220XXXXXX881904","bank":"NABIL","direction":"DEBIT",
       "amount_paisa":200000,"reported_balance_paisa":806055,
       "occurred_at":"2026-03-12T16:45:00Z","reference":"55123909QqRs"}'
# expect HTTP 202 and {"accepted":true,"event_id":"NABIL:55123909QqRs",...}
```

With `npx wrangler tail` running in another terminal you should see, within a
few seconds, `queue.received` and then `audit.written` carrying the key
`raw/NABIL:220XXXXXX881904/NABIL:55123909QqRs.json`. Fetch the object to
confirm the audit store really has it:

```bash
npx wrangler r2 object get bank-recon-audit   "raw/NABIL:220XXXXXX881904/NABIL:55123909QqRs.json" --remote --file=./audit-check.json
```

Re-POST the identical body once more: the second pass must log `audit.exists`
rather than `audit.written`. That is write-once holding on real R2.

A `503` with either token `"unset"` means that secret did not land — the routes
it guards fail closed by design rather than accepting unauthenticated writes.
`simulator_scope` reading anything other than `demo-accounts-only` means the
fence is off and the simulator can write to real account ids.

---

## Step 6b - The dashboard is part of the Worker

There is **no separate Pages project to create.** `public/` is configured as the
Worker's static assets in `wrangler.jsonc`, so `wrangler deploy` ships the
dashboard and the API together on one origin. After Step 6:

```bash
curl -sI https://bank-email-reconciliation.<subdomain>.workers.dev/ | head -3
# expect 200 and content-type: text/html
```

Then open that URL in a browser. This is deferred rows D24 and D25.

The dashboard reads are unauthenticated by design. **Step 7 puts Cloudflare
Access in front of them and must be completed before Step 8**, which is what
starts real bank email arriving.

---

## Step 7 — Cloudflare Access (REQUIRED, and it must come before Step 8)

**Ordering constraint, stated here because getting it wrong is not recoverable:
do this before Step 8.** Step 8 is what causes real bank email to start
arriving. From the moment the first forward lands, the deployed Worker holds
real balances, real merchants and a real masked account number, and the read API
is unauthenticated by design — the dashboard polls it and a static page cannot
hold a secret. `workers.dev` hostnames are enumerated and scanned continuously,
so an unprotected window is not theoretical. Access first, then email.

Access is free tier and needs no code change.

### 7.1 — Two applications, in this order

Access evaluates the **most specific path first**, so the bypass has to be its
own application rather than a policy on the main one.

**Application A — the webhook bypass.** Dashboard → *Zero Trust* → *Access* →
*Applications* → *Add an application* → **Self-hosted**.

| Field | Value |
|---|---|
| Application name | `bank-recon webhook` |
| Session duration | No duration, expires immediately |
| Subdomain / domain / path | `bank-email-reconciliation` / `<subdomain>.workers.dev` / `webhook` |

Add one policy: Action **Bypass**, Include **Everyone**.

This is deliberate, not a hole. `POST /webhook` is the simulator ingress and it
is called by JavaScript in the page, not by a browser navigation — a login
policy on it returns an Access HTML redirect where the simulator expects JSON,
and every scenario breaks. It carries its own protection: a constant-time bearer
check against `SIMULATOR_TOKEN` that fails closed if the secret is unset
(`src/auth.ts`), and the deployed `SIMULATOR_SCOPE` restricts it to `DEMO-`
account ids, so even a leaked token cannot put a fabricated movement into a real
account's balance chain. Treat that token as the credential guarding this path,
and generate it with the command in Step 6 rather than choosing one.

Note what the bypass does **not** cover: `POST /api/accounts/:id/gaps/:gapId/accept`
sits behind Access like everything else, and takes `OPERATOR_TOKEN` rather than
the simulator's secret.

**Application B — everything else.** *Add an application* → **Self-hosted**.

| Field | Value |
|---|---|
| Application name | `bank-recon dashboard` |
| Session duration | 24 hours |
| Subdomain / domain / path | `bank-email-reconciliation` / `<subdomain>.workers.dev` / *(leave path empty)* |

Add one policy: Action **Allow**, Include → **Emails** → your own address.

Under *Authentication*, enable **One-time PIN**. No identity provider is needed.

> **Why one-time PIN and not a service token.** A service token authenticates a
> `curl` carrying two headers; it cannot log a browser in. This dashboard has to
> open on a phone, and typing a code from an email is the only method that works
> there without configuring an IdP. Service tokens are the right answer for
> machine callers, which here is `/webhook` — and that path is bypassed instead,
> because it already has a bearer secret and adding a second credential would
> mean the page needs both.

### 7.2 — What Application B now covers

Every route in `src/index.ts` except the bypassed one. Worth checking against the
source rather than trusting this list:

| Route | Covered by Access |
|---|---|
| `GET /` and the static assets (`/app.js`, `/simulator.js`, `/styles.css`) | Yes |
| `GET /health` | Yes |
| `GET /api/accounts` | Yes |
| `GET /api/accounts/:id` (and `?authoritative=true`) | Yes |
| `GET /api/accounts/:id/audit` | Yes |
| `POST /api/accounts/:id/force-window` | Yes (and `SIMULATOR_TOKEN` + the `DEMO-` fence) |
| `POST /api/accounts/:id/gaps/:gapId/accept` | Yes (and `OPERATOR_TOKEN` underneath) |
| `POST /webhook` | **No — bypassed by Application A** (bearer + `DEMO-` fence) |

The two `POST /api/...` routes are called from the dashboard by a logged-in
browser, so the Access session cookie rides along and they keep working. They
also still require the bearer token underneath.

### 7.3 — Prove it before moving on

Logged out, from a terminal with no Access cookie:

```bash
HOST=https://bank-email-reconciliation.<subdomain>.workers.dev

curl -si "$HOST/api/accounts" | head -5
# EXPECT: HTTP/2 302 and a `location:` header pointing at
#   https://<your-team>.cloudflareaccess.com/cdn-cgi/access/login/...
# FAIL:   HTTP/2 200 and a JSON body containing "accounts". If you see account
#         data here, Access is not covering the route. Do not continue to Step 8.

curl -si "$HOST/" | head -5
# EXPECT: the same 302 to the Access login.
```

Then confirm the bypass did not break the simulator:

```bash
curl -s -o /dev/null -w "%{http_code}
" -X POST "$HOST/webhook"   -H "authorization: Bearer $TOKEN"   -H "content-type: application/json"   -d '{"account_id":"NIMB:DEMO-ACCESS","bank":"NIMB","direction":"DEBIT",
       "amount_paisa":50000,"reported_balance_paisa":950000,
       "occurred_at":"2026-04-01T09:00:00Z","reference":"accesscheck01"}'
# EXPECT: 202. The event is queued.
# FAIL:   302 — Application A is missing, or its path does not match /webhook.
#         The simulator panel will be broken in the browser too.

curl -s -o /dev/null -w "%{http_code}
" -X POST "$HOST/webhook"   -H "content-type: application/json" -d '{}'
# EXPECT: 401. The bypass removes the Access login, not the bearer check.
```

Finally, open `$HOST/` in a browser: you should get a one-time-PIN prompt,
receive a code by email, and land on the dashboard.

Only when all four of those behave as described, continue to Step 8.

---

## Step 8 — Domain and Email Routing (LAST; costs money)

This is the only paid dependency in the project (~$10/yr) and the only step that
cannot be done without it. Everything above is free tier.

1. **Buy or transfer a domain.** Cloudflare Registrar (dashboard → *Domain
   Registration*) is simplest because the nameservers are already correct. Any
   registrar works if you then point the nameservers at Cloudflare.
2. **Add the zone**: dashboard → *Add a site* → enter the domain → Free plan →
   follow the nameserver instructions. Wait for the zone to read **Active**.
3. **Enable Email Routing**: dashboard → the zone → *Email* → *Email Routing* →
   *Get started*. Cloudflare adds the required MX, SPF, and DKIM records for
   you. Wait for the status to read **Enabled**.
4. **Verify a destination address** (needed only if you also forward to a real
   mailbox): *Destination addresses* → add your personal address → click the
   link in the confirmation email Cloudflare sends.
5. **Route an address to this Worker**: *Email Routing* → *Routes* → *Create
   address* → e.g. `alerts@yourdomain.tld` → Action: **Send to a Worker** →
   select `bank-email-reconciliation`.
6. **Forward the bank alerts**: in Gmail, *Settings → Forwarding and POP/IMAP →
   Add a forwarding address* → `alerts@yourdomain.tld`. Gmail sends a
   confirmation code to that address; because the address routes to the Worker
   and not to a mailbox, temporarily add a second route sending it to your
   verified personal destination so you can read the code, confirm, then switch
   the route back to the Worker. Finally add a Gmail filter matching only the
   bank senders (`donot_reply@nimb.com.np`, `txn-alert@nabilbank.com`) and
   forward those, not the whole inbox.

Proves it worked:

```bash
npx wrangler tail
# then trigger or wait for a bank alert; expect an {"at":"email.received", ...}
# log line carrying the bank's sender address
```

### When Email Routing becomes blocking

It blocks **only** the real-email ingress path. It does not block any phase of
the build:

| Capability | Needs Email Routing? |
|---|---|
| Parsers, ledger, gap lifecycle, alarm, projection, dashboard, simulator | No |
| Unit tests, including the `email()` handler | No — synthetic `ForwardableEmailMessage` over a redacted fixture |
| Local end-to-end demo | No — `POST /webhook` drives the same queue, DO, and projection |
| Ingesting a genuine bank email | Yes |

---

## Free-tier limits to re-check before submitting

These are named in the README's cost section and should be re-read at
<https://developers.cloudflare.com/workers/platform/limits/> rather than trusted
from memory, since they move:

- Workers: requests/day and CPU ms per invocation on the free plan
- D1: rows read/day, rows written/day, storage
- Durable Objects: requests, duration, and SQLite storage on the free plan
- R2: Class A / Class B operations per month, storage
- Queues: operations/day
- Email Routing: inbound is free and unlimited; the domain is not
