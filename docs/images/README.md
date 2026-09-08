# Demo images

Empty on purpose: no image is linked from the README, so nothing there is
broken. Tracked as **D26** in `../DEFERRED.md`.

## What to capture

Run `npm run dev`, open <http://127.0.0.1:8787>, enter the token from
`.dev.vars` in the simulator panel, and click through the scenarios in order.
Every value on screen is then invented — the simulator generates its own demo
account (`NIMB:DEMO-XXXXXX`) with fabricated merchants and balances, so nothing
needs blurring or cropping and no real data is ever on screen.

| File | View | How to reach it |
|---|---|---|
| `accounts.png` | The account list with a flagged account | Run **Skip a transaction**, then **Force the window**. The demo account shows `gap confirmed` with the flag. |
| `gap-detail.png` | An account detail with an open gap | Click into that account. The timeline shows the failing adjacency with its expected balance and the exact delta, and the gap card sits above it. |
| `reanchor.png` | The re-anchor control | Same view, scrolled to the `CONFIRMED_GAP` card with the reason field visible. Do not submit before capturing. |

Optionally, `duplicate.gif` — run **Send the same email twice** and record the
timeline showing one row reaching "2 deliveries" while the balance does not move.

## Rules these have to follow

- Committed to this directory and referenced from the README by relative path.
- Any single asset over 5MB goes in the separate public R2 bucket
  `bank-recon-assets`, never in `bank-recon-audit`, which holds raw bank email
  and stays private.
- No Cloudflare Images. It is a paid product and would contradict the README's
  cost section.
- Seeded fixture data only. The underlying values must be fake rather than
  hidden.

## After adding them

Link them from README section 2, replacing the note that says they are missing,
then check every image URL resolves in GitHub's rendered view and mark D26.
