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

```powershell
Remove-Item -Recurse -Force .wrangler -ErrorAction SilentlyContinue
npm run db:local
npm run dev
```

POSIX: `rm -rf .wrangler && npm run db:local && npm run dev`

Local emulation state persists between runs and can hold rows written by an
earlier version of the parsers - including `occurred_at` values on the old time
base, in the column the chain sorts on. `docs/DEMO.md` is the full walkthrough.

`wrangler dev` emulates D1, R2, Queues, and Durable Objects on disk under
`.wrangler/`. The simulator path (`POST /webhook`) exercises the same queue,
Durable Object, and projection as a real bank email would.

---

## What changed after this runbook was first written

Audited 2026-09-08 against the code as it stands. Steps 1 and 2 are unaffected —
they touch no project config. The rest, so nothing is a surprise mid-deploy:

| Step | What changed | Already updated below? |
|---|---|---|
| 3 — D1 | A second migration exists, `0002_gap_bounds.sql`. Both must be applied, in order | Yes |
| 5 — Queues | `txn-events-dlq` now has its own consumer, declared in `wrangler.jsonc`. No extra `queues consumer add` is needed | Yes |
| 6 — Secrets | **There are now two secrets**, `SIMULATOR_TOKEN` and `OPERATOR_TOKEN`, and they must differ. A deployment with only one set half-works and fails at the moment someone accepts a gap | Yes |
| 6 — Health | `/health` now reports `operator_token` and `simulator_scope` alongside the original checks | Yes |
| 6 — Smoke test | The example POST must use a `DEMO-` account id. `SIMULATOR_SCOPE` is `demo-accounts-only` on a deployment, so a real account id returns 422 by design | Yes |
| 7 — Access | This step did not exist. It is required, and it must precede Step 8 | Yes |
| 8 — Email Routing | No longer buys the domain; Step 1 does | Yes |

Nothing in the runbook still assumes a single shared token or an unfenced
simulator.

---

## Shell conventions — read once, saves five failures

**Commands here are written for Windows PowerShell 5.1**, which is what this
project is developed on. Where a POSIX form is meaningfully different it is
given underneath. Four differences will bite otherwise, and the first two fail
in ways that do not obviously point at the shell:

**1. `curl` is not curl.** In PowerShell, `curl` is an alias for
`Invoke-WebRequest`, so `curl -s -X POST ...` fails with:

```
Missing an argument for parameter 'SessionVariable'.
```

because `-s` is being read as a prefix of `-SessionVariable`. Real curl ships
with Windows at `C:\Windows\system32\curl.exe`. **Always write `curl.exe`**, and
every command below does.

**2. `$HOST` is reserved.** PowerShell defines `$HOST` as the console host
object and it is read-only:

```
Cannot overwrite variable Host because it is read-only or constant.
```

So the deployed hostname is held in `$WorkerHost` throughout this file, never
`$HOST`.

**3. `&&` does not exist in PowerShell 5.1.** Use `;` to sequence
unconditionally, or `if ($?) { ... }` to run only on success.

**5. PowerShell mangles inline JSON on its way to a native command.** Passing a
JSON string straight to `curl.exe -d` looks right and is not — PowerShell 5.1
rewrites the embedded double quotes before curl ever runs, and the Worker
answers:

```
{ "error": "body must be valid JSON" }   HTTP 400
```

Write the body to a file and let curl read it with `-d "@file"`. Every POST in
this runbook is written that way and each has been run:

```powershell
$body = '{"account_id":"NIMB:DEMO-X","bank":"NIMB"}'
$body | Out-File -Encoding ascii -NoNewline "$env:TEMP\body.json"
curl.exe -s -X POST "$WorkerHost/webhook" -H "content-type: application/json" -d "@$env:TEMP\body.json"
```

`Invoke-RestMethod -Body $body` also handles the quoting correctly and is more
idiomatic, but it throws on any 4xx instead of printing the status code, and
these checks are mostly about *which* status came back. Hence curl.

**4. Unix file and text commands are not present.** The ones this runbook needs:

| POSIX | PowerShell |
|---|---|
| `rm -rf .wrangler` | `Remove-Item -Recurse -Force .wrangler` |
| `export FOO=bar` | `$env:FOO = "bar"` |
| `... \| head -5` | `... \| Select-Object -First 5` |
| `cp a b` | `Copy-Item a b` |

Line continuation is a backtick `` ` `` in PowerShell, not a backslash. The
commands below are written on single lines to avoid the issue entirely.

---

## Step 1 — Account, and the domain onto it

This is the step that costs money: a domain is roughly $10/year and is the only
paid dependency in the project. Everything after it is free tier.

The domain is bought here rather than at the end, through **Cloudflare
Registrar**, because a domain registered with Cloudflare is on Cloudflare
nameservers from the moment it exists. Email Routing requires that — the
documentation is explicit that you must be using Cloudflare DNS — and buying
elsewhere means a nameserver change and a propagation wait before Step 8 can
start.

### 1.1 — The account

1. Sign up at <https://dash.cloudflare.com/sign-up>. The Workers **free** plan
   covers everything in this project except the domain.
2. Verify the email address Cloudflare sends you. Registrar will not sell you a
   domain until the account email is verified.
3. Authenticate the CLI:

   ```powershell
   npx wrangler login
   ```

   Opens a browser for OAuth consent.

**Checkable:**

```powershell
npx wrangler whoami
```

Prints your email and an Account ID. If it prints `You are not authenticated`,
the login did not complete — re-run it and finish the browser consent.

### 1.2 — Buy the domain through Cloudflare Registrar

1. Dashboard → **Domain Registration** → **Register Domains**.
2. Search for the name you want.
3. **Check the TLD is offered by Cloudflare Registrar before settling on a
   name.** Registrar does not sell every TLD, and this is the one decision here
   that is genuinely annoying to reverse — see 1.3.
4. Add to cart, enter registrant contact details and a payment method, and
   complete the purchase.
5. Leave **auto-renew on**. It is on by default.

Cloudflare Registrar includes WHOIS redaction at no cost and it is on by
default, so your name and address are not published. Nothing to configure.

The zone is created automatically and, because the domain was registered here,
it is already on Cloudflare nameservers. There is no "add a site" step, no
nameserver change at another registrar, and no propagation wait.

### 1.3 — What to get right now, because it is painful later

**The TLD must be one Cloudflare Registrar sells.** If you buy elsewhere you
have to point that registrar's nameservers at Cloudflare and wait for
propagation, and a newly registered domain cannot be *transferred* to Cloudflare
for 60 days under ICANN rules. That does not block anything — an external
domain on Cloudflare nameservers works fine — but it turns a five-minute step
into a wait, which is precisely what buying here avoids.

**The zone must be a full setup, not a CNAME/partial setup.** Email Routing
needs to manage the domain's MX records and cannot on a partial zone. A
Registrar purchase is always full setup, so this is only a hazard if you buy
elsewhere and configure the zone as partial.

**Do not buy a domain that already has mail on it.** Enabling Email Routing adds
MX, SPF and DKIM records at the zone apex. On a fresh domain there is nothing to
collide with. On a domain already serving a mailbox, enabling routing will
interfere with that mail. A brand-new name has no such history.

**Keep the domain name out of this repository.** It is public. The domain will
appear in your Access configuration, your Email Routing rule and your own
commands, and none of those are files here. Do not paste it into the README,
`wrangler.jsonc`, or this runbook — every example below uses a placeholder for
that reason.

**Auto-renew matters more than usual here.** If the domain lapses, Email Routing
stops and forwarded bank alerts bounce silently. The engine would not report an
error; it would simply stop receiving anything, which looks identical to an
account with no transactions.

### 1.4 — What "Step 1 is done" looks like

Four things, each of which you can check rather than assume:

1. Dashboard → **Websites** lists your domain, status **Active**.
   Not "Pending Nameserver Update" — a Registrar purchase should go straight to
   Active, usually within a minute or two.
2. Dashboard → **Domain Registration** → your domain shows **Auto-renew: On**
   and an expiry roughly a year out.
3. The zone answers DNS as a Cloudflare zone:

   ```powershell
   nslookup -type=NS yourdomain.tld 1.1.1.1
   ```

   Returns two `*.ns.cloudflare.com` nameservers. If it returns anything else,
   or `NXDOMAIN`, the zone is not live yet — wait and re-check before going on.

4. The CLI is authenticated against the account that owns it:

   ```powershell
   npx wrangler whoami
   ```

   Prints an email and Account ID with no error.

**Do not enable Email Routing yet.** It is Step 8, and Step 7 (Cloudflare
Access) has to be in place first — the read API is unauthenticated by design,
and Step 8 is what causes real balances to start arriving. That ordering is the
one thing in this runbook that cannot be safely rearranged.

### 1.5 — What has *not* happened yet

Nothing remote exists beyond the account and the domain. No D1 database, no R2
bucket, no queues, no secrets, no Worker. `wrangler.jsonc` still carries the
literal `REPLACE_WITH_D1_DATABASE_ID` placeholder, and `npm run dev` still runs
entirely locally. Step 3 onwards is where remote resources start being created.

---

## Step 2 — (only if you have more than one account) pin the account id

`wrangler whoami` prints an Account ID. If it lists more than one account,
export the one you want so no command has to guess:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "<account id from whoami>"
```

POSIX: `export CLOUDFLARE_ACCOUNT_ID=<account id from whoami>`

This lasts for the current shell session only. Re-set it in each new terminal,
or the commands that create resources may prompt you to pick an account.

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

## Step 6 — Set both secrets and deploy

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

```powershell
$WorkerHost = "https://bank-email-reconciliation.<subdomain>.workers.dev"
curl.exe -s "$WorkerHost/health"
# expect ok:true with d1, r2, durable_object and queue_producer all "ok";
# simulator_token AND operator_token both "configured"; and
# simulator_scope "demo-accounts-only"
```

Then prove the async path end to end (deferred rows D5, D16 and D17). Set the
host and token once; `$WorkerHost`, not `$HOST`, because `$HOST` is read-only in
PowerShell:

```powershell
$WorkerHost = "https://bank-email-reconciliation.<subdomain>.workers.dev"
$SimToken   = "<the SIMULATOR_TOKEN you generated above>"

$body = '{"account_id":"NIMB:DEMO-SMOKE1","bank":"NIMB","direction":"DEBIT","amount_paisa":200000,"reported_balance_paisa":806055,"occurred_at":"2026-03-12T16:45:00Z","reference":"55123909QqRs"}'
$body | Out-File -Encoding ascii -NoNewline "$env:TEMP\body.json"

curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$WorkerHost/webhook" -H "authorization: Bearer $SimToken" -H "content-type: application/json" -d "@$env:TEMP\body.json"
```

Expect `202` and a body carrying `"accepted":true` and
`"event_id":"NIMB:55123909QqRs"`.

Note the account id is `NIMB:DEMO-SMOKE1`, not a real one. The deployed
`SIMULATOR_SCOPE` restricts `/webhook` to `DEMO-` accounts, so a real account id
here returns `422` naming `account_id` — that is the fence working, not a
failure.

POSIX form of the same call:

```bash
WORKER_HOST=https://bank-email-reconciliation.<subdomain>.workers.dev
SIM_TOKEN=<the SIMULATOR_TOKEN you generated above>
curl -s -w '\nHTTP %{http_code}\n' -X POST "$WORKER_HOST/webhook" -H "authorization: Bearer $SIM_TOKEN" -H "content-type: application/json" -d '{"account_id":"NIMB:DEMO-SMOKE1","bank":"NIMB","direction":"DEBIT","amount_paisa":200000,"reported_balance_paisa":806055,"occurred_at":"2026-03-12T16:45:00Z","reference":"55123909QqRs"}'
```

With `npx wrangler tail` running in another terminal you should see, within a
few seconds, `queue.received` and then `audit.written` carrying the key
`raw/NIMB:DEMO-SMOKE1/NIMB:55123909QqRs.json`. Fetch the object to confirm the
audit store really has it:

```powershell
npx wrangler r2 object get bank-recon-audit "raw/NIMB:DEMO-SMOKE1/NIMB:55123909QqRs.json" --remote --file=./audit-check.json
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

```powershell
curl.exe -sI "$WorkerHost/" | Select-Object -First 3
# expect 200 and content-type: text/html
```

POSIX: `curl -sI "$WORKER_HOST/" | head -3`

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

```powershell
$WorkerHost = "https://bank-email-reconciliation.<subdomain>.workers.dev"

curl.exe -si "$WorkerHost/api/accounts" | Select-Object -First 5
```

EXPECT: `HTTP/2 302` and a `location:` header pointing at
`https://<your-team>.cloudflareaccess.com/cdn-cgi/access/login/...`

FAIL: `HTTP/2 200` and a JSON body containing `"accounts"`. If account data
comes back here, Access is not covering the route. **Do not continue to Step 8.**

```powershell
curl.exe -si "$WorkerHost/" | Select-Object -First 5
```

EXPECT: the same 302 to the Access login.

Then confirm the bypass did not break the simulator:

```powershell
$SimToken = "<your SIMULATOR_TOKEN>"
$body = '{"account_id":"NIMB:DEMO-ACCESS","bank":"NIMB","direction":"DEBIT","amount_paisa":50000,"reported_balance_paisa":950000,"occurred_at":"2026-04-01T09:00:00Z","reference":"accesscheck01"}'
$body | Out-File -Encoding ascii -NoNewline "$env:TEMP\body.json"

curl.exe -s -o NUL -w "%{http_code}`n" -X POST "$WorkerHost/webhook" -H "authorization: Bearer $SimToken" -H "content-type: application/json" -d "@$env:TEMP\body.json"
```

EXPECT: `202`. The event is queued.

FAIL: `302` — Application A is missing, or its path does not match `/webhook`.
The simulator panel will be broken in the browser too.

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST "$WorkerHost/webhook" -H "content-type: application/json" -d "{}"
```

(`{}` has no inner quotes, so it survives PowerShell's argument handling and
needs no file.)

EXPECT: `401`. The bypass removes the Access login, not the bearer check.

Finally, open `$WorkerHost` in a browser: you should get a one-time-PIN prompt,
receive a code by email, and land on the dashboard.

Only when all four of those behave as described, continue to Step 8.

---

## Step 8 — Email Routing (LAST; this is what makes the data real)

The domain was bought and the zone created in Step 1, so this step is only about
turning routing on and pointing an address at the Worker.

**Do not start this step until Step 7 is verified.** From the first forwarded
alert, this Worker holds real balances, real merchants and a real masked account
number, and the read API is unauthenticated by design. Access has to be in front
of it first.

1. *(Done in Step 1.)* The domain is registered with Cloudflare Registrar and
   the zone is Active on Cloudflare nameservers. If you bought elsewhere,
   confirm the zone reads **Active** before continuing — Email Routing requires
   the domain to be using Cloudflare DNS.
2. **Enable Email Routing**: dashboard → the zone → *Email* → *Email Routing* →
   *Get started*. Cloudflare adds the required MX, SPF, and DKIM records for
   you. Wait for the status to read **Enabled**.
3. **Verify a destination address** (needed only if you also forward to a real
   mailbox): *Destination addresses* → add your personal address → click the
   link in the confirmation email Cloudflare sends.
4. **Route an address to this Worker**: *Email Routing* → *Routes* → *Create
   address* → e.g. `alerts@yourdomain.tld` → Action: **Send to a Worker** →
   select `bank-email-reconciliation`.
5. **Forward the bank alerts**: in Gmail, *Settings → Forwarding and POP/IMAP →
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
