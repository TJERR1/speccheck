// Two candidate system prompts, compared by `npm run eval`.
// ACTIVE_PROMPT is the one the app ships; see eval/RESULTS.md for why.
// CONFLICT_PROMPT and REWRITE_PROMPT are used by the hybrid checker (src/hybrid.js).

export const TAGS = ["Vague", "Untestable", "Vendor-locking", "Conflicting", "Compound"];

export const TAG_DEFINITIONS = {
  Vague: `uses subjective or undefined terms with no agreed meaning ("user-friendly", "robust", "adequate", "as appropriate", "etc.", "state-of-the-art", "industry standard" with no standard named).`,
  Untestable: `there is no objective pass/fail check at acceptance: no metric, threshold, condition, or method (e.g. "fast response", "highly available", "shall not fail"). A clause with a concrete number, a named standard, or a clear yes/no outcome is testable.`,
  "Vendor-locking": `names a brand, product, model or proprietary technology without "or equivalent" and performance criteria, or describes a spec only one supplier can meet. Naming an open standard (e.g. IPv6, ISO 27001, PDF/A) is NOT vendor-locking.`,
  Conflicting: `directly contradicts another clause in the same list (different values for the same parameter, or requirements that cannot both be true). Only flag when both clauses are present; flag both of them.`,
  Compound: `packs two or more independently testable requirements into one clause, so one could pass while another fails (e.g. "shall back up nightly and restore within 4 hours"). A single requirement with a list of values it must support is NOT compound.`,
};

const DEFINITIONS_LIST = TAGS.map((t) => `- ${t}: ${TAG_DEFINITIONS[t]}`).join("\n");

const EXPLANATION_RULE = `"explanation" is one plain-English sentence naming the exact words at fault, e.g. "'fast response' has no measurable target."`;
const REWRITE_RULE = `"rewrite" is one improved clause that keeps the author's intent and does not change what is being bought. Use [square brackets] for any value the author must supply, e.g. "within [X] seconds". If a Compound clause is split, put each requirement on its own line.`;

const OUTPUT_FORMAT = `Reply with JSON only, in this shape:
{"results": [{"id": 1, "flags": [{"tag": "Vague", "explanation": "..."}], "rewrite": "..."}]}
- Include every clause id exactly once, in order.
- "flags" is [] for a clause with no defect, and "rewrite" is then null.
- "tag" is one of: ${TAGS.join(", ")}.
- ${EXPLANATION_RULE}
- For a Conflicting flag, name the other clause id in the explanation, e.g. "Conflicts with clause 7: ...".
- ${REWRITE_RULE}`;

const BASELINE = `You review requirement clauses from tender specifications and statements of work.
For each numbered clause, flag any drafting defects using these tags: ${TAGS.join(", ")}.
Suggest a rewrite for each flagged clause.

${OUTPUT_FORMAT}`;

const REVIEWER = `You are a senior procurement reviewer`;

const STRICT = `${REVIEWER} checking draft requirement clauses from a tender specification or statement of work, before the draft goes to review.

Flag a clause only when the defect would realistically cause a vendor clarification question, a review comment, or an acceptance-testing dispute. Do not nitpick style, grammar, or word choice. A clause that a competent vendor could price and a tester could verify is clean, even if it could be worded more elegantly. When in doubt, do not flag.

Defect tags:
${DEFINITIONS_LIST}

A clause may have more than one tag. Most well-drafted clauses have none.

${OUTPUT_FORMAT}`;

export const PROMPTS = { baseline: BASELINE, strict: STRICT };
export const ACTIVE_PROMPT = "strict";

// Tags hidden from users because the eval showed too many false alarms.
export const SUPPRESSED_TAGS = [];

export function buildUserMessage(clauses) {
  const lines = clauses.map((c) => `${c.id}. ${c.text}`).join("\n");
  return `Clauses to review:\n${lines}`;
}

// One slice of a long document. The model sees every clause, so it can still
// spot Conflicting pairs, but only reviews and returns the clauses in `batch`.
export function buildBatchMessage(allClauses, batch) {
  const lines = allClauses.map((c) => `${c.id}. ${c.text}`).join("\n");
  const ids = batch.map((c) => c.id);
  return `All clauses in the document, for context (e.g. to spot Conflicting pairs):\n${lines}\n\nReview ONLY clauses ${ids[0]}-${ids.at(-1)}. Return results for exactly those ids.`;
}

export const CONFLICT_PROMPT = `${REVIEWER} checking draft requirement clauses from a tender specification or statement of work, before the draft goes to review.

Find pairs of clauses that are Conflicting: a clause ${TAG_DEFINITIONS.Conflicting}
Do not report clauses that only overlap, repeat each other, or add detail. Most lists have no conflicts.

Reply with JSON only, in this shape:
{"conflicts": [{"a": 6, "b": 31, "explanation": "..."}]}
- "a" and "b" are the ids of the two clauses, with "a" smaller than "b".
- "explanation" is one plain-English sentence naming the contradicting values, e.g. "Audit logs are kept for 24 months in one clause and purged after 12 months in the other." Do not mention clause numbers.
- "conflicts" is [] when there are none.`;

export const REWRITE_PROMPT = `${REVIEWER}. You are given one requirement clause from a tender specification or statement of work, and the drafting defects it has already been flagged with. Do not question the flags.

Defect tags:
${DEFINITIONS_LIST}

Reply with JSON only, in this shape:
{"flags": [{"tag": "Vague", "explanation": "..."}], "rewrite": "..."}
- Include exactly one entry per flagged tag, and no other tags.
- ${EXPLANATION_RULE}
- ${REWRITE_RULE}
- If the clause conflicts with another clause, the rewrite must remove the contradiction. Use [square brackets] for the value the author must choose.`;

export function buildRewriteMessage(clause, tags, conflicting) {
  const lines = [`Clause: ${clause.text}`, `Flagged tags: ${tags.join(", ")}`];
  if (conflicting.length > 0) {
    lines.push("It conflicts with:", ...conflicting.map((c) => `- clause ${c.id}: ${c.text}`));
  }
  return lines.join("\n");
}
