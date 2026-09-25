// Hybrid checker: Jev decides the per-clause tags, the LLM finds conflicts and
// writes explanations and rewrites for flagged clauses only. See
// docs/superpowers/specs/2026-09-25-jev-hybrid-checker-design.md.

import { decide } from "./jev.js";
import { callModelJson } from "./llm.js";
import { TAGS, TAG_DEFINITIONS, CONFLICT_PROMPT, REWRITE_PROMPT, buildUserMessage, buildRewriteMessage } from "./prompts.js";

const question = (tag) =>
  `Answer about this requirement clause from a tender or statement of work. Is it ${tag}? A clause is ${tag} when it ${TAG_DEFINITIONS[tag]} ` +
  `Answer yes only if the defect would realistically cause a vendor clarification question, a review comment, or an acceptance-testing dispute.`;

// One noul (yes/no) question per tag that Jev decides. Conflicting needs the whole list, so the LLM keeps it.
export const JEV_QUESTIONS = [
  { tag: "Vague", id: "vague", instructions: question("Vague") },
  { tag: "Untestable", id: "untestable", instructions: question("Untestable") },
  { tag: "Vendor-locking", id: "vendor_locking", instructions: question("Vendor-locking") },
  { tag: "Compound", id: "compound", instructions: question("Compound") },
];

// Minimum Jev probability for each tag to be flagged: the middle of the gap between flawed and other
// clauses in the eval (`npm run eval -- --sweep`), rounded to 0.05. See eval/RESULTS.md.
export const THRESHOLDS = { Vague: 0.8, Untestable: 0.65, "Vendor-locking": 0.35, Compound: 0.75 };

// The Jev model THRESHOLDS were tuned on. Pinned so jev-latest moving can't shift the calibration; bump both together.
export const JEV_TUNED_MODEL = "jev-1.13.0";

export const REWRITE_CONCURRENCY = 8;

const JEV_REQUEST_QUESTIONS = Object.fromEntries(JEV_QUESTIONS.map((q) => [q.id, { type: "noul", instructions: q.instructions }]));

/**
 * Check clauses with Jev + LLM. Returns the same shape as checkClauses.
 * @param {{id: number, label: string, text: string}[]} clauses
 * @param {{opencode: string, jev: string}} keys
 */
export async function checkClausesHybrid(
  clauses,
  keys,
  { thresholds = THRESHOLDS, concurrency = REWRITE_CONCURRENCY, withProbabilities = false, timings = {}, jevOptions = {}, llmOptions = {} } = {},
) {
  if (clauses.length === 0) return [];

  const [probabilities, conflicts] = await Promise.all([
    timed(timings, "jev", () => Promise.all(clauses.map((c) => jevProbabilities(c.text, keys.jev, jevOptions)))),
    timed(timings, "conflict", () => findConflicts(clauses, keys.opencode, llmOptions)),
  ]);

  const byId = new Map(clauses.map((c) => [c.id, c]));
  const assigned = clauses.map((clause, i) => {
    const jevTags = JEV_QUESTIONS.map((q) => q.tag).filter((tag) => probabilities[i][tag] >= (thresholds[tag] ?? Infinity));
    const clashes = conflicts.get(clause.id) ?? [];
    const tags = TAGS.filter((t) => jevTags.includes(t) || (t === "Conflicting" && clashes.length > 0));
    return { clause, tags, clashes };
  });

  const written = await timed(timings, "rewrites", () =>
    mapPool(assigned, concurrency, ({ clause, tags, clashes }) =>
      tags.length === 0 ? null : writeRewrite(clause, tags, clashes.map((c) => byId.get(c.other)), keys.opencode, llmOptions),
    ),
  );

  return assigned.map(({ clause, tags, clashes }, i) => {
    const reply = written[i];
    const flags = tags.map((tag) => ({
      tag,
      explanation:
        tag === "Conflicting"
          ? clashes.map((c) => `Conflicts with clause ${displayName(byId.get(c.other))}: ${c.explanation}`).join(" ")
          : reply?.explanations.get(tag) || `This clause was flagged as ${tag.toLowerCase()}.`,
    }));
    const result = { ...clause, flags, rewrite: flags.length > 0 ? reply?.rewrite ?? null : null };
    return withProbabilities ? { ...result, jev: probabilities[i] } : result;
  });
}

// How the user numbered the clause ("6." → "6", "REQ-031:" → "REQ-031"); ids are only positions in the paste.
// Bullets ("-", "*") and unlabelled clauses fall back to the position.
function displayName(clause) {
  const label = clause.label.replace(/[.:]+$/, "");
  return /[A-Za-z0-9]/.test(label) ? label : String(clause.id);
}

async function jevProbabilities(text, apiKey, options) {
  const { answers } = await decide({ state: text, questions: JEV_REQUEST_QUESTIONS }, apiKey, { model: JEV_TUNED_MODEL, ...options });
  return Object.fromEntries(
    JEV_QUESTIONS.map((q) => {
      const p = answers[q.id]?.noul;
      return [q.tag, typeof p === "number" && Number.isFinite(p) ? p : 0];
    }),
  );
}

/** Returns Map<clauseId, {other, explanation}[]>, with both sides of every valid pair. */
async function findConflicts(clauses, apiKey, options) {
  const out = new Map();
  if (clauses.length < 2) return out;

  const reply = await callModelJson(
    [
      { role: "system", content: CONFLICT_PROMPT },
      { role: "user", content: buildUserMessage(clauses) },
    ],
    apiKey,
    options,
  );

  const ids = new Set(clauses.map((c) => c.id));
  const seen = new Set();
  for (const pair of Array.isArray(reply.conflicts) ? reply.conflicts : []) {
    const a = Number(pair?.a);
    const b = Number(pair?.b);
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (!ids.has(a) || !ids.has(b) || a === b || seen.has(key)) continue;
    seen.add(key);
    const explanation = String(pair.explanation ?? "").trim() || "The two clauses cannot both be met.";
    for (const [self, other] of [[a, b], [b, a]]) {
      if (!out.has(self)) out.set(self, []);
      out.get(self).push({ other, explanation });
    }
  }
  return out;
}

async function writeRewrite(clause, tags, conflicting, apiKey, options) {
  const reply = await callModelJson(
    [
      { role: "system", content: REWRITE_PROMPT },
      { role: "user", content: buildRewriteMessage(clause, tags, conflicting) },
    ],
    apiKey,
    options,
  );
  const explanations = new Map();
  for (const f of Array.isArray(reply.flags) ? reply.flags : []) {
    const tag = TAGS.find((t) => t.toLowerCase() === String(f?.tag ?? "").trim().toLowerCase());
    const text = String(f?.explanation ?? "").trim();
    if (tag && text && !explanations.has(tag)) explanations.set(tag, text);
  }
  const rewrite = typeof reply.rewrite === "string" && reply.rewrite.trim() ? reply.rewrite.trim() : null;
  return { explanations, rewrite };
}

/** Like Promise.all(items.map(fn)), but with at most `limit` calls running at once. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function timed(timings, step, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings[step] = (Date.now() - started) / 1000;
  }
}
