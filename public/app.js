// SpecCheck front end. All state lives in memory for this page only;
// nothing is written to localStorage or anywhere else.

import { readDocx, paragraphEdits, buildTrackedDocx, DocxError } from "./docx.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const $ = (sel) => document.querySelector(sel);
const input = $("#spec-input");
const checkBtn = $("#check-btn");
const statusEl = $("#status");
const resultsEl = $("#results");
const bodyEl = $("#results-body");
const summaryEl = $("#summary");

let clauses = [];
let timer = null;
// The uploaded Word document, if any: { name, doc, texts }. Never leaves the page.
let upload = null;

checkBtn.addEventListener("click", runCheck);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runCheck();
});
$("#copy-all-btn").addEventListener("click", () => copy(cleanedText(), "Cleaned spec copied"));
$("#download-btn").addEventListener("click", downloadCleaned);
$("#docx-btn").addEventListener("click", downloadTrackedDocx);

const fileInput = $("#file-input");
$("#upload-btn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => fileInput.files[0] && loadFile(fileInput.files[0]));
$("#file-clear").addEventListener("click", clearFile);
input.addEventListener("dragover", (e) => {
  if (![...e.dataTransfer.items].some((i) => i.kind === "file")) return;
  e.preventDefault();
  input.classList.add("is-dragover");
});
input.addEventListener("dragleave", () => input.classList.remove("is-dragover"));
input.addEventListener("drop", (e) => {
  input.classList.remove("is-dragover");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  e.preventDefault();
  loadFile(file);
});

async function loadFile(file) {
  fileInput.value = "";
  if (!/\.docx$/i.test(file.name)) {
    setStatus("Only .docx files are supported. In Word, use File › Save As › Word Document (.docx).", "error");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setStatus("That file is over 10 MB. Upload just the requirements section.", "error");
    return;
  }
  try {
    const doc = await readDocx(file);
    const texts = doc.paragraphs.map((p) => p.text);
    if (texts.every((t) => t.trim() === "")) throw new DocxError("That document has no text to check.");
    upload = { name: file.name, doc, texts };
  } catch (err) {
    setStatus(err instanceof DocxError ? err.message : "Couldn't open that file. Check it opens in Word and try again.", "error");
    return;
  }
  $("#file-name").textContent = upload.name;
  const count = upload.texts.filter((t) => t.trim() !== "").length;
  $("#file-meta").textContent = `· ${count} paragraph${count === 1 ? "" : "s"}`;
  $("#file-chip").hidden = false;
  input.hidden = true;
  resultsEl.hidden = true;
  setStatus("");
}

function clearFile() {
  upload = null;
  $("#file-chip").hidden = true;
  input.hidden = false;
  resultsEl.hidden = true;
  setStatus("");
  input.focus();
}

async function runCheck() {
  const text = input.value;
  if (!upload && text.trim() === "") {
    setStatus("Paste some requirements first.", "error");
    input.focus();
    return;
  }

  setBusy(true);
  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(upload ? { paragraphs: upload.texts } : { text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");

    clauses = data.clauses.map((c) => ({ ...c, final: c.text, state: "original" }));
    if (clauses.length === 0) {
      setStatus(
        upload ? "No requirements found in that document." : "No requirements found. Put each requirement on its own line.",
        "error",
      );
      resultsEl.hidden = true;
      return;
    }
    render();
    setExportMode();
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
  save(new Blob([cleanedText() + "\n"], { type: "text/plain" }), "cleaned-requirements.txt");
}

function setExportMode() {
  const docx = Boolean(upload);
  $("#docx-btn").hidden = !docx;
  $("#copy-all-btn").classList.toggle("btn-primary", !docx);
  $("#export-hint").textContent = docx
    ? "Your document comes back unchanged except for your accepted rewrites and edits, each as a tracked change you can accept or reject in Word."
    : "Cleaned spec uses your accepted rewrites and edits, and the original wording everywhere else.";
  $("#export-note").textContent = "";
}

async function downloadTrackedDocx() {
  const note = $("#export-note");
  const { edits, unmapped } = paragraphEdits(upload.texts, clauses);
  if (edits.length === 0 && unmapped.length === 0) {
    toast("Accept or edit a rewrite first. Nothing has changed yet.");
    return;
  }
  try {
    const { blob, skipped } = await buildTrackedDocx(upload.doc, edits);
    save(blob, upload.name.replace(/\.docx$/i, "") + " (SpecCheck).docx");
    const missed = new Set([...skipped, ...unmapped]);
    const refs = clauses.filter((c) => missed.has(c.block) && c.final !== c.text).map((c) => c.label || `#${c.id}`);
    note.dataset.kind = refs.length ? "error" : "";
    note.textContent = refs.length
      ? `${refs.length} change${refs.length === 1 ? " isn't" : "s aren't"} in the document because the paragraph has links, fields or existing tracked changes. Make ${refs.length === 1 ? "it" : "them"} by hand in Word: ${refs.join(", ")}.`
      : "";
    const tracked = clauses.filter((c) => c.final !== c.text).length - refs.length;
    toast(`Downloaded with ${tracked} rewrite${tracked === 1 ? "" : "s"} as tracked changes`);
  } catch (err) {
    console.error(err);
    toast("Couldn't build the Word document. Try Download .txt instead.");
  }
}

function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
