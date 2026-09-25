// Splits pasted requirement text into discrete, checkable clauses.
//
// A new clause starts at a blank line, a bullet, or a numbered label
// ("1.", "3.2.1", "a)", "(iv)", "REQ-012:"). Lines without a marker are
// treated as wrapped continuations of the previous clause. A block that
// holds several sentences each carrying its own "shall/must/will/should"
// is further split into one clause per sentence.

const MARKER = /^\s*(?:[-*•▪◦–]\s+|\(?[0-9]+(?:\.[0-9]+)*[.)]?\s+|\(?[a-z][.)]\s+|\([ivx]+\)\s+|[A-Z]{2,}[-_ ]?[0-9]+(?:\.[0-9]+)*\s*[:.)-]?\s+)/i;
const MODAL = /\b(shall|must|will|should|is required to|are required to)\b/i;
const MIN_CLAUSE_LENGTH = 8;

export function splitClauses(text) {
  const blocks = [];
  let current = null;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      current = null;
      continue;
    }
    const marker = line.match(MARKER);
    if (marker || current === null) {
      current = { label: marker ? marker[0].trim() : "", text: line.slice(marker ? marker[0].length : 0) };
      blocks.push(current);
    } else {
      current.text += " " + line;
    }
  }

  const clauses = [];
  for (const block of blocks) {
    const parts = splitSentences(block.text);
    parts.forEach((part, i) => {
      const label = parts.length > 1 && block.label ? `${block.label} (${i + 1})` : block.label;
      clauses.push({ label, text: part });
    });
  }

  return clauses
    .map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() }))
    .filter((c) => c.text.length >= MIN_CLAUSE_LENGTH && !isHeading(c.text))
    .map((c, i) => ({ id: i + 1, ...c }));
}

// Split a block into sentences only when more than one sentence is itself a requirement.
function splitSentences(text) {
  const sentences = text.split(/(?<=[.;!?])\s+(?=[A-Z(])/).filter((s) => s.trim() !== "");
  const requirementCount = sentences.filter((s) => MODAL.test(s)).length;
  if (requirementCount < 2) return [text];

  // Attach any non-requirement sentence (e.g. a note) to the requirement before it.
  const merged = [];
  for (const s of sentences) {
    if (MODAL.test(s) || merged.length === 0) merged.push(s);
    else merged[merged.length - 1] += " " + s;
  }
  return merged;
}

// Short lines with no modal verb and no final punctuation are section headings.
function isHeading(text) {
  return !MODAL.test(text) && !/[.;:!?]$/.test(text) && text.split(" ").length <= 8;
}
