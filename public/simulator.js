// The simulator panel (spec 10.4).
//
// Every button here builds a normalized event and POSTs it to /webhook, the
// same authenticated ingress a third party would use. Nothing fires an internal
// function or writes to a store directly: the demo drives the real pipeline -
// validation, queue, audit, ledger, projection - and watches what comes out.
//
// The scenarios exist to make five claims checkable in a few seconds rather
// than believable on the strength of a README paragraph.

const SIM_TOKEN_KEY = "simulator-token";
const SIM_ACCOUNT_KEY = "simulator-account";
const SIM_HELD_KEY = "simulator-held-event";
const POISON_REFERENCE = "POISON-DLQ-DEMO";

/** A per-session demo account, so a demo always starts from a clean ledger. */
function demoAccount() {
  let id = sessionStorage.getItem(SIM_ACCOUNT_KEY);
  if (id === null) {
    id = newDemoAccount();
  }
  return id;
}

function newDemoAccount() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  // The DEMO- prefix is load-bearing on a deployment, not cosmetic: the Worker
  // is configured to refuse simulator events for any other account id. The
  // same prefix is DEMO_ACCOUNT_PREFIX in src/validate.ts.
  const id = `NIMB:DEMO-${suffix}`;
  sessionStorage.setItem(SIM_ACCOUNT_KEY, id);
  sessionStorage.removeItem(SIM_HELD_KEY);
  return id;
}

function reference(tag) {
  // Invented, and unique per click so a repeated scenario is a new transaction
  // rather than an accidental duplicate.
  return `${tag}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The next event on the demo account, chained onto whatever the ledger already
 * holds. The balance is read back from the authoritative endpoint rather than
 * remembered in the page, so the simulator cannot drift from the ledger and
 * quietly manufacture a gap it did not mean to.
 */
async function nextEvent(options) {
  const accountId = demoAccount();
  const response = await fetch(
    `/api/accounts/${encodeURIComponent(accountId)}?authoritative=true`,
  );

  let balance = 1000000; // 10,000.00 opening balance for a fresh demo account
  let minute = 0;
  if (response.status === 200) {
    const state = await response.json();
    balance = state.current_balance_paisa;
    minute = state.event_count * 7;
  }

  const direction = options.direction || "DEBIT";
  const amount = options.amount_paisa;
  const movement = direction === "CREDIT" ? amount : -amount;
  const occurredAt = new Date(
    Date.UTC(2026, 3, 1, 9, 0, 0) + (minute + (options.minuteOffset || 0)) * 60000,
  )
    .toISOString()
    .slice(0, 19);

  return {
    account_id: accountId,
    bank: "NIMB",
    direction,
    amount_paisa: amount,
    // The balance the bank would report after this movement. A scenario that
    // wants a gap simply omits an event, it never fakes a balance.
    reported_balance_paisa: balance + movement,
    occurred_at: `${occurredAt}Z`,
    merchant: options.merchant,
    reference: options.reference || reference("SIM"),
  };
}

async function post(event, token) {
  const response = await fetch("/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(event),
  });
  const body = await response.json();

  if (response.status === 401) {
    throw new Error(
      "Rejected. /webhook takes SIMULATOR_TOKEN, which is a different secret from OPERATOR_TOKEN.",
    );
  }
  if (response.status === 422 && Array.isArray(body.errors)) {
    // Most likely the deployment fence: this Worker only accepts simulator
    // events for DEMO- accounts, and the panel is posting something else.
    throw new Error(body.errors.map((e) => `${e.field}: ${e.message}`).join("; "));
  }

  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    id: "normal",
    label: "Normal transaction",
    detail: "One debit that chains cleanly onto the last balance.",
    async run(token, say) {
      const event = await nextEvent({ amount_paisa: 45000, merchant: "invented grocer" });
      const result = await post(event, token);
      say(`Queued ${result.body.event_id}. It should appear and chain.`);
    },
  },
  {
    id: "duplicate",
    label: "Send the same email twice",
    detail:
      "The identical payload, twice. The derived event_id is the same both times, so the balance and the transaction count must not move; only the delivery counter does.",
    async run(token, say) {
      const event = await nextEvent({ amount_paisa: 21000, merchant: "invented pharmacy" });
      await post(event, token);
      await post(event, token);
      say("Posted twice. Expect one row on the timeline, showing 2 deliveries.");
    },
  },
  {
    id: "out-of-order",
    label: "Send two out of order",
    detail:
      "Two transactions posted with the later one first. Arrival order is wrong; the ledger sorts on when the bank stamped them, so both still chain.",
    async run(token, say) {
      const first = await nextEvent({
        amount_paisa: 15000,
        merchant: "invented bookshop",
        minuteOffset: 0,
      });
      const second = {
        ...first,
        reference: reference("SIM"),
        amount_paisa: 30000,
        merchant: "invented hardware",
        occurred_at: first.occurred_at.replace(/T(\d{2}):(\d{2})/, (all, h, m) =>
          `T${h}:${String(Number(m) + 3).padStart(2, "0")}`,
        ),
        reported_balance_paisa: first.reported_balance_paisa - 30000,
      };

      // The later transaction is delivered first.
      await post(second, token);
      await post(first, token);
      say("Posted later-then-earlier. Expect both rows in time order, both chained.");
    },
  },
  {
    id: "skip",
    label: "Skip a transaction",
    detail:
      "Posts transaction N and N+2, holding N+1 back. The chain fails by exactly the held amount and a PENDING_GAP opens.",
    async run(token, say) {
      const held = await nextEvent({
        amount_paisa: 60000,
        merchant: "invented electricity bill",
        minuteOffset: 0,
      });
      const after = {
        ...held,
        reference: reference("SIM"),
        amount_paisa: 12000,
        merchant: "invented tea",
        occurred_at: held.occurred_at.replace(/T(\d{2}):(\d{2})/, (all, h, m) =>
          `T${h}:${String(Number(m) + 4).padStart(2, "0")}`,
        ),
        reported_balance_paisa: held.reported_balance_paisa - 12000,
      };

      sessionStorage.setItem(SIM_HELD_KEY, JSON.stringify(held));
      await post(after, token);
      say("Posted N+2 only. Expect a PENDING_GAP of -600.00, the exact held amount.");
    },
  },
  {
    id: "fill",
    label: "Send the skipped one late",
    detail:
      "Delivers the held transaction. It slots into its own place in time and both new adjacencies chain, so the gap closes.",
    async run(token, say) {
      const held = sessionStorage.getItem(SIM_HELD_KEY);
      if (held === null) {
        say("Nothing held. Run 'Skip a transaction' first.", true);
        return;
      }
      await post(JSON.parse(held), token);
      sessionStorage.removeItem(SIM_HELD_KEY);
      say("Posted the missing transaction. Expect the gap to close and the account to reconcile.");
    },
  },
  {
    id: "force",
    label: "Force the window",
    detail:
      "Runs the promotion the 48-hour alarm would run. Any PENDING_GAP becomes a CONFIRMED_GAP, which is the state that offers the re-anchor control.",
    async run(token, say) {
      const response = await fetch(
        `/api/accounts/${encodeURIComponent(demoAccount())}/force-window`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      );
      const body = await response.json();
      if (response.status !== 200) {
        say(
          response.status === 401
            ? "Rejected. Force-window takes SIMULATOR_TOKEN."
            : body.error || `Failed with ${response.status}`,
          true,
        );
        return;
      }
      say(
        `Window closed. Status is now ${body.reconciliation_status}. Scroll to the gap to re-anchor it.`,
      );
    },
  },
  {
    id: "poison",
    label: "Send a poison event",
    detail:
      "An event the consumer is built to fail on. It exhausts its retries and lands in the dead-letter queue without ever reaching a ledger, and the pipeline keeps running behind it.",
    async run(token, say) {
      const event = await nextEvent({
        amount_paisa: 9900,
        merchant: "invented poison",
        reference: POISON_REFERENCE,
      });
      const result = await post(event, token);
      say(
        `Accepted with ${result.status} and queued. It will retry, fail every time, and reach the DLQ. Nothing on this account changes.`,
      );
    },
  },
];

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

function buildSimulator(container, onChanged) {
  container.replaceChildren();

  const head = document.createElement("div");
  head.className = "sim-head";

  const account = document.createElement("code");
  account.textContent = demoAccount();

  const reroll = document.createElement("button");
  reroll.type = "button";
  reroll.className = "ghost";
  reroll.textContent = "New demo account";
  reroll.addEventListener("click", () => {
    newDemoAccount();
    buildSimulator(container, onChanged);
    onChanged();
  });

  head.append(account, reroll);
  container.append(head);

  const token = document.createElement("input");
  token.type = "password";
  // SIMULATOR_TOKEN, not the operator's. Stored under its own key so the two
  // never overwrite each other between the panel and the re-anchor form.
  token.placeholder = "SIMULATOR_TOKEN";
  token.className = "sim-token";
  token.value = sessionStorage.getItem(SIM_TOKEN_KEY) || "";
  token.addEventListener("change", () =>
    sessionStorage.setItem(SIM_TOKEN_KEY, token.value),
  );
  container.append(token);

  container.append(
    text(
      "p",
      "These buttons use SIMULATOR_TOKEN. Accepting a gap uses OPERATOR_TOKEN, a different secret, entered on the gap itself.",
      "token-hint",
    ),
  );

  const note = document.createElement("p");
  note.className = "note";
  container.append(note);

  const say = (message, isError) => {
    note.className = isError ? "note error" : "note";
    note.textContent = message;
  };

  const list = document.createElement("div");
  list.className = "sim-list";

  for (const scenario of SCENARIOS) {
    const card = document.createElement("div");
    card.className = "sim-card";

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = scenario.label;
    button.addEventListener("click", async () => {
      if (token.value === "") {
        say("Enter SIMULATOR_TOKEN first.", true);
        return;
      }
      sessionStorage.setItem(SIM_TOKEN_KEY, token.value);
      button.disabled = true;
      say(`Running: ${scenario.label}…`);
      try {
        await scenario.run(token.value, say);
        onChanged();
      } catch (error) {
        say(String(error), true);
      } finally {
        button.disabled = false;
      }
    });

    card.append(button, text("p", scenario.detail, "note"));
    list.append(card);
  }

  container.append(list);
}

window.buildSimulator = buildSimulator;
window.simulatorAccount = demoAccount;
