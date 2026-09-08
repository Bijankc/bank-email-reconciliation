// The dashboard. Vanilla JS on purpose: no build step, no bundler, no CDN, so
// what is deployed is what is in this file.
//
// It polls rather than subscribing. That is not laziness - the D1 read model is
// eventually consistent, and a page that refreshes on a timer makes the lag
// something you can watch instead of something described in a README.

const POLL_MS = 4000;

const el = (id) => document.getElementById(id);
const accountsView = el("accounts-view");
const detailView = el("detail-view");
const simulatorView = el("simulator-view");

let pollTimer = null;
let currentAccount = null;

/**
 * Paisa to rupees for display only.
 *
 * Every value crossing the API is an integer count of paisa, and the only
 * division by 100 in the whole system is this one, at the last possible moment.
 * The formatter is what turns 892500 into 8,925.00; nothing downstream of here
 * does arithmetic.
 */
function rupees(paisa) {
  if (paisa === null || paisa === undefined) return "—";
  const negative = paisa < 0;
  const absolute = Math.abs(paisa);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-IN")}.${fraction}`;
}

function signedRupees(paisa) {
  if (paisa === null || paisa === undefined) return "—";
  return `${paisa > 0 ? "+" : ""}${rupees(paisa)}`;
}

function shortTime(iso) {
  if (!iso) return "—";
  // The bank's own wall clock, shown as the bank printed it. See DECISIONS 1.1.
  return iso.replace("T", " ").replace("Z", "");
}

function pill(status) {
  const span = document.createElement("span");
  span.className = `pill ${status}`;
  span.textContent = status.replace(/_/g, " ").toLowerCase();
  return span;
}

// Shared with simulator.js, which is loaded first and therefore cannot define
// it itself. Two files, one helper, no bundler.
function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// account list
// ---------------------------------------------------------------------------

async function renderAccounts() {
  const { body } = await api("/api/accounts");
  const tbody = el("accounts-body");
  tbody.replaceChildren();

  if (!body.accounts || body.accounts.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty";
    const cell = text("td", "No accounts yet. Forward a bank alert, or post one to /webhook.");
    cell.colSpan = 6;
    row.append(cell);
    tbody.append(row);
    return;
  }

  for (const account of body.accounts) {
    const row = document.createElement("tr");
    row.className = "clickable";
    row.addEventListener("click", () => showAccount(account.account_id));

    row.append(text("td", account.account_label || account.account_id, "mono"));
    row.append(text("td", account.bank));
    row.append(text("td", rupees(account.current_balance_paisa), "num"));

    const status = document.createElement("td");
    status.append(pill(account.reconciliation_status));
    // The flag the brief asks for: a confirmed gap is the one state that wants
    // a human, so it is the one that gets an unmissable marker.
    if (account.reconciliation_status === "GAP_CONFIRMED") {
      status.append(document.createTextNode(" \u{1F6A9}"));
    }
    row.append(status);

    row.append(text("td", String(account.open_gap_count), "num"));
    row.append(text("td", String(account.projection_version), "num"));
    tbody.append(row);
  }
}

// ---------------------------------------------------------------------------
// account detail
// ---------------------------------------------------------------------------

function summaryCards(view) {
  const cards = el("summary-cards");
  cards.replaceChildren();

  const entries = [
    ["Balance", rupees(view.current_balance_paisa)],
    ["Transactions", String(view.event_count)],
    ["Open gaps", String(view.open_gap_count)],
    ["Version", String(view.version)],
  ];

  for (const [label, value] of entries) {
    const card = document.createElement("div");
    card.className = "card";
    card.append(text("div", label, "label"));
    card.append(text("div", value, "value"));
    cards.append(card);
  }

  const statusCard = document.createElement("div");
  statusCard.className = "card";
  statusCard.append(text("div", "Status", "label"));
  const holder = document.createElement("div");
  holder.className = "value";
  holder.append(pill(view.reconciliation_status));
  statusCard.append(holder);
  cards.append(statusCard);
}

function renderGaps(view, accountId) {
  const container = el("gaps");
  container.replaceChildren();

  if (!view.gaps || view.gaps.length === 0) {
    container.append(text("p", "No gaps. Every adjacency chains.", "hint"));
    return;
  }

  for (const gap of view.gaps) {
    const box = document.createElement("div");
    box.className = `gap ${gap.status}`;

    const head = document.createElement("div");
    head.className = "gap-head";
    head.append(pill(gap.status));
    // The exact size of the unaccounted movement. Known precisely even though
    // its cause is not.
    head.append(text("span", `${signedRupees(gap.delta_paisa)} unaccounted`, "delta"));
    box.append(head);

    box.append(
      text(
        "div",
        `between ${gap.after_event_id || "the start"} and ${gap.before_event_id}`,
        "between",
      ),
    );
    box.append(text("div", `detected ${shortTime(gap.detected_at)}`, "note"));

    if (gap.status === "PENDING_GAP") {
      box.append(
        text(
          "div",
          "Still inside the resolution window. A late email may yet fill it, so nothing is decided until the window closes.",
          "note",
        ),
      );
    }

    if (gap.fillable_at) {
      // Spec 6.4: a confirmed gap is never closed automatically. The operator
      // is told, and decides.
      box.append(
        text(
          "div",
          "A later email now fills this adjacency. It was already confirmed, so it has not been reopened automatically.",
          "fillable",
        ),
      );
    }

    if (gap.status === "ACCEPTED_GAP") {
      box.append(
        text(
          "div",
          `Accepted ${shortTime(gap.accepted_at)}: ${gap.accept_reason || "no reason recorded"}`,
          "note",
        ),
      );
    }

    if (gap.status === "CONFIRMED_GAP") {
      box.append(reanchorControl(accountId, gap));
    }

    container.append(box);
  }
}

/**
 * The re-anchor control (spec 6.5). Only offered on a CONFIRMED_GAP: accepting
 * a gap that is still pending would throw away the one mechanism that
 * distinguishes a late email from a lost one, and the ledger refuses it anyway.
 */
function reanchorControl(accountId, gap) {
  const form = document.createElement("form");
  form.className = "reanchor";

  form.append(
    text(
      "div",
      "The window closed and no email arrived. Accepting records this delta as a discontinuity you have taken responsibility for, and lets the account reconcile forward.",
      "note",
    ),
  );

  const reason = document.createElement("input");
  reason.type = "text";
  reason.required = true;
  reason.placeholder = "Reason (recorded permanently)";

  const token = document.createElement("input");
  token.type = "password";
  token.required = true;
  token.placeholder = "Operator token";
  // Kept for the session only, and never written into the page. A static
  // dashboard cannot hold a secret, so the operator supplies it per session
  // instead of it being shipped to every visitor.
  token.value = sessionStorage.getItem("operator-token") || "";

  const row = document.createElement("div");
  row.className = "row";
  row.append(reason, token);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Accept and re-anchor";

  const note = text("div", "", "note");

  form.append(row, submit, note);

  form.addEventListener("submit", async (fired) => {
    fired.preventDefault();
    submit.disabled = true;
    note.className = "note";
    note.textContent = "Accepting…";

    sessionStorage.setItem("operator-token", token.value);

    const { status, body } = await api(
      `/api/accounts/${encodeURIComponent(accountId)}/gaps/${encodeURIComponent(gap.gap_id)}/accept`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token.value}`,
        },
        body: JSON.stringify({ reason: reason.value }),
      },
    );

    if (status !== 200) {
      note.className = "note error";
      note.textContent = body.error || `Failed with ${status}`;
      submit.disabled = false;
      return;
    }

    note.textContent = "Accepted.";
    await showAccount(accountId);
  });

  return form;
}

function renderTimeline(view) {
  const tbody = el("timeline-body");
  tbody.replaceChildren();

  if (!view.timeline || view.timeline.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty";
    const cell = text("td", "No transactions yet.");
    cell.colSpan = 6;
    row.append(cell);
    tbody.append(row);
    return;
  }

  for (const entry of view.timeline) {
    const row = document.createElement("tr");
    row.append(text("td", shortTime(entry.occurred_at), "mono"));
    row.append(text("td", entry.direction.toLowerCase()));
    row.append(
      text(
        "td",
        `${entry.direction === "CREDIT" ? "+" : "−"}${rupees(entry.amount_paisa)}`,
        "num",
      ),
    );
    row.append(text("td", rupees(entry.reported_balance_paisa), "num"));

    const merchant = entry.merchant || "—";
    const deliveries = entry.deliveries ?? entry.delivery_count ?? 1;
    row.append(
      // The duplicate demo, visible: one row, more than one delivery.
      text("td", deliveries > 1 ? `${merchant} (${deliveries} deliveries)` : merchant),
    );

    const mark = document.createElement("td");
    if (entry.chains === null) {
      mark.append(pill("anchor"));
    } else if (entry.chains) {
      mark.append(pill("ok"));
    } else {
      mark.append(pill("broken"));
      mark.append(
        text("div", `expected ${rupees(entry.expected_balance_paisa)}`, "note"),
      );
      mark.append(text("div", `off by ${signedRupees(entry.delta_paisa)}`, "note"));
    }
    row.append(mark);

    tbody.append(row);
  }
}

async function renderAudit(accountId) {
  const container = el("audit");
  container.replaceChildren();

  const { body } = await api(`/api/accounts/${encodeURIComponent(accountId)}/audit`);
  if (!body.objects || body.objects.length === 0) {
    container.append(text("div", "Nothing archived for this account.", "audit-row"));
    return;
  }

  for (const object of body.objects) {
    const row = document.createElement("div");
    row.className = "audit-row";
    row.append(text("span", object.key));
    row.append(text("span", `${object.size} bytes · ${object.source_channel}`));
    container.append(row);
  }
}

async function showAccount(accountId) {
  currentAccount = accountId;
  accountsView.hidden = true;
  simulatorView.hidden = true;
  detailView.hidden = false;

  const authoritative = el("authoritative-toggle").checked;
  const query = authoritative ? "?authoritative=true" : "";
  const { status, body } = await api(
    `/api/accounts/${encodeURIComponent(accountId)}${query}`,
  );

  if (status === 404) {
    el("detail-title").textContent = accountId;
    el("detail-sub").textContent = "No such account.";
    return;
  }

  // The two shapes differ: the projected read wraps the summary in `account`,
  // the authoritative read is the ledger state itself. Flattening here keeps
  // the render functions from having to know which one they were given.
  const view = authoritative
    ? body
    : {
        ...body.account,
        version: body.account.projection_version,
        timeline: body.timeline,
        gaps: body.gaps,
        event_count: body.timeline.length,
      };

  el("detail-title").textContent = view.account_label || accountId;
  el("detail-sub").textContent = `${view.bank} · ${accountId}`;
  el("source-note").textContent = authoritative
    ? "Durable Object. Serialized, always current."
    : "D1 projection. May lag by a few seconds.";

  summaryCards(view);
  renderGaps(view, accountId);
  renderTimeline(view);
  await renderAudit(accountId);
}

function showList() {
  currentAccount = null;
  detailView.hidden = true;
  accountsView.hidden = false;
  simulatorView.hidden = false;
  renderAccounts();
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

async function tick() {
  try {
    if (currentAccount === null) {
      await renderAccounts();
    } else {
      await showAccount(currentAccount);
    }
    el("poll-state").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    el("poll-state").textContent = "offline";
  }
}

el("back-link").addEventListener("click", (fired) => {
  fired.preventDefault();
  showList();
});

el("authoritative-toggle").addEventListener("change", () => {
  if (currentAccount !== null) showAccount(currentAccount);
});

// The simulator posts events and then leans on the same poll everything else
// uses, so what a scenario demonstrates includes the delay before the read
// model catches up.
buildSimulator(el("simulator"), () => {
  window.setTimeout(tick, 250);
});

showList();
pollTimer = setInterval(tick, POLL_MS);
