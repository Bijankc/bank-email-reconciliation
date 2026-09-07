# Cloudflare setup runbook

Nothing in this file has been run. There is no Cloudflare account attached to
this project yet, and the build is verified entirely under local emulation. This
is the ordered list of what to run **once an account exists**, with real
arguments, so it can be executed top to bottom without working anything out.

Keep this file current as bindings change. Every step says what it produces and
what proves it worked.

---

## Step 0 — What works with no account at all

Nothing below is needed to run, test, or demo the project locally.

```bash
npm install
npm run db:local         # applies migrations/0001_init.sql to the local D1
npx wrangler dev         # local emulation; no account, no login
```

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

Then:

```bash
npx wrangler deploy
```

Proves it worked (replace the host with the deployed workers.dev host):

```bash
curl -s https://bank-email-reconciliation.<subdomain>.workers.dev/health
# expect ok:true with d1, r2, durable_object and queue_producer all "ok",
# and simulator_token "configured"
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

A `503` with `simulator_token: "unset"` means the secret did not land —
`/webhook` fails closed by design rather than accepting unauthenticated writes.

---

## Step 7 — Domain and Email Routing (LAST; costs money)

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
