# Redacted fixtures

Every value in this directory is invented. The account numbers, merchant names,
balances, references, and timestamps do not correspond to any real account or
any real transaction. They reproduce the *shape* of the two banks' alert emails
so the parsers can be tested without a real email ever entering the repository.

Real emails, if you need them locally, go in `samples/real/`, which is
gitignored and must never be committed.

## What each fixture exercises

| File | Shape | Why it exists |
|---|---|---|
| `nimb-debit.eml` | `text/plain` | The baseline NIMB prose parse: two timestamps, comma-blob detail line. |
| `nimb-credit-multipart.eml` | `multipart/alternative` | Proves the MIME layer picks the text part, and that CREDIT parses. |
| `nimb-no-reference.eml` | `text/plain` | No detail line, so no reference: forces the hash `event_id` fallback. |
| `nabil-debit.eml` | `text/html` | The baseline Nabil table parse. |
| `nabil-credit.eml` | `text/html` | Wrapper `<span>`s, a `<tbody>`, an HTML entity, and a merchant containing a comma. |

The NIMB account and the Nabil account each carry a balance chain that adds
up across their fixtures, so the same files can seed the Phase 3 ledger tests.
