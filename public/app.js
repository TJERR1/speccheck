// SpecCheck front end. All state lives in memory for this page only;
// nothing is written to localStorage or anywhere else.

const $ = (sel) => document.querySelector(sel);
const input = $("#spec-input");
const checkBtn = $("#check-btn");
const statusEl = $("#status");
const resultsEl = $("#results");
const bodyEl = $("#results-body");
const summaryEl = $("#summary");

let clauses = [];
let timer = null;

checkBtn.addEventListener("click", runCheck);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runCheck();
});
$("#copy-all-btn").addEventListener("click", () => copy(cleanedText(), "Cleaned spec copied"));
$("#download-btn").addEventListener("click", downloadCleaned);

async function runCheck() {
  const text = input.value;
  if (text.trim() === "") {
    setStatus("Paste some requirements first.", "error");
    input.focus();
    return;
  }

  setBusy(true);
  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");

    clauses = data.clauses.map((c) => ({ ...c, final: c.text, state: "original" }));
    if (clauses.length === 0) {
      setStatus("No requirements found. Put each requirement on its own line.", "error");
      resultsEl.hidden = true;
      return;
    }
    render();
    setStatus("");
    resultsEl.hidden = false;
    resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(err.message === "Failed to fetch" ? "Can't reach the server. Check your connection." : err.message, "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  checkBtn.disabled = busy;
  clearInterval(timer);
  if (!busy) return;
  const started = Date.now();
  const tick = () => setStatus(`Checking… ${Math.floor((Date.now() - started) / 1000)}s`, "busy");
  tick();
  timer = setInterval(tick, 1000);
}

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function render() {
  bodyEl.replaceChildren();
  const flagged = clauses.filter((c) => c.flags.length > 0).length;
  summaryEl.innerHTML = `${clauses.length} clauses · <span class="count-flagged">${flagged} flagged</span> · <span class="count-clean">${clauses.length - flagged} clean</span>`;

  for (const clause of clauses) {
    const row = $("#row-template").content.firstElementChild.cloneNode(true);
    const detail = $("#detail-template").content.firstElementChild.cloneNode(true);
    const isFlagged = clause.flags.length > 0;

    row.classList.add(isFlagged ? "is-flagged" : "is-clean");
    row.querySelector(".col-num").textContent = clause.label || clause.id;

    const issues = row.querySelector(".col-issues");
    if (isFlagged) {
      for (const f of clause.flags) issues.append(tagEl(f.tag));
    } else {
      issues.innerHTML = '<span class="clean-mark">✓ Clean</span>';
    }

    const toggle = row.querySelector(".row-toggle");
    const toggleDetail = () => {
      const open = detail.hidden;
      detail.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      row.classList.toggle("is-open", open);
    };
    toggle.addEventListener("click", toggleDetail);

    buildDetail(clause, row, detail);
    updateRow(clause, row, detail);
    bodyEl.append(row, detail);
  }
}

function buildDetail(clause, row, detail) {
  const list = detail.querySelector(".explanations");
  for (const f of clause.flags) {
    const li = document.createElement("li");
    li.append(tagEl(f.tag), document.createTextNode(" " + f.explanation));
    list.append(li);
  }

  const rewriteBlock = detail.querySelector(".rewrite-block");
  const editBlock = detail.querySelector(".edit-block");
  const editInput = detail.querySelector(".edit-input");

  if (clause.rewrite) {
    detail.querySelector(".rewrite-text").textContent = clause.rewrite;
  } else {
    detail.querySelector(".rewrite-text").textContent = clause.flags.length ? "No rewrite suggested." : "No issues found.";
    detail.querySelector(".accept-btn").hidden = true;
    detail.querySelector(".copy-btn").hidden = true;
    detail.querySelector(".detail-label").hidden = !clause.flags.length;
  }

  detail.querySelector(".accept-btn").addEventListener("click", () => {
    clause.final = clause.rewrite;
    clause.state = "accepted";
    updateRow(clause, row, detail);
  });
  detail.querySelector(".copy-btn").addEventListener("click", () => copy(clause.rewrite, "Rewrite copied"));
  detail.querySelector(".edit-btn").addEventListener("click", () => {
    editInput.value = clause.final;
    rewriteBlock.hidden = true;
    editBlock.hidden = false;
    editInput.focus();
  });
  detail.querySelector(".cancel-btn").addEventListener("click", () => {
    editBlock.hidden = true;
    rewriteBlock.hidden = false;
  });
  detail.querySelector(".save-btn").addEventListener("click", () => {
    const value = editInput.value.trim();
    if (value && value !== clause.text) {
      clause.final = value;
      clause.state = "edited";
    } else {
      clause.final = clause.text;
      clause.state = "original";
    }
    editBlock.hidden = true;
    rewriteBlock.hidden = false;
    updateRow(clause, row, detail);
  });
  detail.querySelector(".revert-btn").addEventListener("click", () => {
    clause.final = clause.text;
    clause.state = "original";
    updateRow(clause, row, detail);
  });
}

// Reflect the clause's accepted/edited state in its row.
function updateRow(clause, row, detail) {
  const changed = clause.state !== "original";
  row.querySelector(".clause-text").textContent = clause.final;
  row.classList.toggle("is-resolved", changed);
  const state = row.querySelector(".row-state");
  state.textContent = clause.state === "accepted" ? "Rewrite accepted" : clause.state === "edited" ? "Edited" : "";
  state.hidden = !changed;
  if (changed) {
    const orig = document.createElement("span");
    orig.className = "original-text";
    orig.textContent = `Original: ${clause.text}`;
    state.append(orig);
  }
  detail.querySelector(".accept-btn").disabled = clause.state === "accepted";
  detail.querySelector(".accept-btn").textContent = clause.state === "accepted" ? "Accepted" : "Accept rewrite";
  detail.querySelector(".revert-btn").hidden = !changed;
}

function tagEl(tag) {
  const span = document.createElement("span");
  span.className = `tag tag-${tag.toLowerCase()}`;
  span.textContent = tag;
  return span;
}

function cleanedText() {
  return clauses
    .map((c) => {
      const [first, ...rest] = c.final.split("\n");
      const prefix = c.label ? `${c.label} ` : "";
      return [prefix + first, ...rest.map((line) => (prefix ? " ".repeat(prefix.length) : "") + line)].join("\n");
    })
    .join("\n");
}

function downloadCleaned() {
  const url = URL.createObjectURL(new Blob([cleanedText() + "\n"], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "cleaned-requirements.txt" });
  a.click();
  URL.revokeObjectURL(url);
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("Couldn't copy. Select the text and copy it manually.");
  }
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2000);
}
