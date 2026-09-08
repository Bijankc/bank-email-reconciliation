# Running the demo, and capturing the screenshots

Everything below runs under local emulation. No Cloudflare account is needed and
nothing here touches a deployment.

The simulator generates its own demo account with fabricated merchants and
balances, so nothing on screen needs blurring or cropping — the underlying data
is invented, which is the standard `docs/images/README.md` requires.

## 0. Start from clean state

```powershell
Remove-Item -Recurse -Force .wrangler -ErrorAction SilentlyContinue
npm run db:local
npm run dev
```

POSIX: `rm -rf .wrangler && npm run db:local && npm run dev`

**The `rm -rf .wrangler` is not optional.** Local emulation state persists across
runs, and it holds rows written by earlier versions of the parsers. Bank
timestamps were converted from Nepal local time to UTC during the build, so
state from before that change carries `occurred_at` on a different time base —
in the column the balance chain sorts on. A ledger holding both will order
events wrongly and show gaps that are an artefact of the mixed state rather than
of anything the scenarios did. See `DECISIONS.md` 7.3.

Then open <http://127.0.0.1:8787> and paste the two secrets from `.dev.vars`
when each is asked for. They are different values and they are not
interchangeable:

| Field | Secret | Guards |
|---|---|---|
| Simulator panel | `SIMULATOR_TOKEN` | `POST /webhook`, force-window |
| Re-anchor form, on a confirmed gap | `OPERATOR_TOKEN` | accepting a gap |

## 1. The walkthrough

Each step says what to click and what should happen. A mismatch is worth
reporting with the browser console open.

| # | Click | Expect |
|---|---|---|
| 1 | — | Account list, empty. Header shows `updated <time>`, ticking every ~4s. If it says `offline`, `app.js` failed to load. |
| 2 | **Normal transaction** | Note reads "Queued …". Within ~5s a row appears: `DEMO-XXXXXX`, `NIMB`, balance `9,955.00`, status `new`, 0 gaps. |
| 3 | **Normal transaction** again | Balance drops again; status becomes `reconciled`. |
| 4 | **Send the same email twice** | Balance moves **once**. Click into the account: one new row, merchant reads `invented pharmacy (2 deliveries)`. |
| 5 | Back → **Send two out of order** | Two new rows in ascending time order, both marked `ok`. They were delivered later-first. |
| 6 | Back → **Skip a transaction** | Status → `pending review`, open gaps `1`. |
| 7 | Click into the account | Gap card reads `-600.00 unaccounted`, pill `pending gap`. The timeline row below is marked `broken`, with `expected …` and `off by -600.00`. **Capture `gap-detail.png`.** |
| 8 | Back to the list | Row shows `pending review`, 1 open gap. |
| 9 | **Force the window** | Note reports `GAP_CONFIRMED`. The list row shows `gap confirmed` 🚩. **Capture `accounts.png`.** |
| 10 | Click in, scroll to the gap | Pill is now `confirmed gap` with a red left border, and the re-anchor form is visible: a reason field and an `OPERATOR_TOKEN` field. **Capture `reanchor.png`** before submitting. |
| 11 | Enter a reason and the operator token, submit | Note reads "Accepted." Status → `reconciled`, open gaps `0`. The gap card stays, as `accepted gap`, with the reason. The timeline row is **still** marked `broken` — correct: the discontinuity was accepted, not erased. |
| 12 | **Send a poison event** | Accepted with 202; the account does not change. In the terminal, roughly 40s later: six `queue.failed` lines followed by one red `dlq.received`. |
| 13 | Any account → tick **Read the ledger directly** | The source note changes to "Durable Object. Serialized, always current." Values match. Immediately after a scenario the two can differ for one poll cycle; that is the replication lag, and it is the point. |
| 14 | Any timeline row | The time reads like the alert email would, e.g. `2026-04-01 09:00:00`. Stored values are UTC; the page renders them in `Asia/Kathmandu`. |

To see a gap **fill** rather than be accepted, use a fresh demo account (**New
demo account**), run step 6, then **Send the skipped one late** without forcing
the window: the gap disappears and the account returns to `reconciled`.

## 2. Wrong-secret behaviour

Worth confirming once, since the two tokens are new:

- Paste `SIMULATOR_TOKEN` into the re-anchor form. It should say the route takes
  `OPERATOR_TOKEN`, not fail with a bare 401.
- Paste `OPERATOR_TOKEN` into the simulator panel. The scenario should report
  that `/webhook` takes `SIMULATOR_TOKEN`.

## 3. What this proves

- The dashboard renders and works in a real browser — deferred row **D25**.
- The simulator scenarios compose valid events and drive the pipeline — **D27**.
- The three screenshots exist against invented data — **D26**.

None of these can be marked verified from reading this file. They are verified
by running it.
