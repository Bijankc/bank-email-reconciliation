-- D1 read model (AP). The authoritative ledger lives in the Durable Object;
-- everything here is a projection written behind a version guard.
--
-- All money columns are INTEGER paisa (rupees * 100). No REAL columns: float
-- arithmetic on money is a defect, and these balances carry two decimals.

-- Deliberately no DROP TABLE. This same file is applied with --remote against
-- the real database, where a re-run must fail loudly rather than silently
-- destroy the projection. To reset the LOCAL database, delete .wrangler/ and
-- re-run `npm run db:local`.

CREATE TABLE accounts (
  account_id             TEXT PRIMARY KEY,
  bank                   TEXT NOT NULL CHECK (bank IN ('NIMB','NABIL')),
  account_label          TEXT,                 -- masked a/c string, for display
  current_balance_paisa  INTEGER,              -- latest reported balance by occurred_at
  last_event_at          TEXT,
  reconciliation_status  TEXT NOT NULL DEFAULT 'NEW'
                           CHECK (reconciliation_status IN
                             ('NEW','RECONCILED','PENDING_REVIEW','GAP_CONFIRMED')),
  open_gap_count         INTEGER NOT NULL DEFAULT 0,
  -- The projection guard: the consumer writes only where the DO's returned
  -- version is strictly greater than this. A stale write matches zero rows.
  projection_version     INTEGER NOT NULL DEFAULT 0 CHECK (projection_version >= 0),
  created_at             TEXT NOT NULL
);
CREATE INDEX idx_accounts_status ON accounts (reconciliation_status);

-- Timeline for the dashboard. Raw bytes are not here; they live in R2.
CREATE TABLE transactions (
  event_id               TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL,
  occurred_at            TEXT,
  direction              TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paisa           INTEGER NOT NULL,
  reported_balance_paisa INTEGER NOT NULL,
  merchant               TEXT,
  reference              TEXT,
  outcome                TEXT NOT NULL CHECK (outcome IN ('applied','duplicate')),
  delivery_count         INTEGER NOT NULL DEFAULT 1,
  raw_r2_key             TEXT,
  received_at            TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);
CREATE INDEX idx_transactions_account ON transactions (account_id, occurred_at);

CREATE TABLE gaps (
  gap_id        TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  delta_paisa   INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('PENDING_GAP','CONFIRMED_GAP','ACCEPTED_GAP')),
  detected_at   TEXT NOT NULL,
  confirmed_at  TEXT,
  accepted_at   TEXT,
  accept_reason TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);
CREATE INDEX idx_gaps_account ON gaps (account_id, status);
