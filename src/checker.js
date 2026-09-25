import { splitClauses, splitParagraphs } from "./splitter.js";
import { callModelJson } from "./llm.js";
import { checkClausesHybrid } from "./hybrid.js";
import { PROMPTS, ACTIVE_PROMPT, SUPPRESSED_TAGS, TAGS, buildUserMessage, buildBatchMessage } from "./prompts.js";

export const MAX_CLAUSES = 60;
// Longer lists are reviewed in parallel slices of this size. One call over 45
// clauses took ~144 s; slices of 8 took 31-63 s and found the same conflicts.
export const BATCH_SIZE = 8;

// "hybrid": Jev decides tags, the LLM writes rewrites (src/hybrid.js).
// "llm": model calls do everything, in parallel slices (checkClauses below).
export const CHECK_MODE = "hybrid";

/**
 * Split text into clauses and check them.
 * @param {{opencode: string, jev: string}} keys
 */
export async function checkRequirements(text, keys, options = {}) {
  const clauses = splitClauses(text);
  if (clauses.length > MAX_CLAUSES) {
    throw new UserError(`That's ${clauses.length} clauses. Paste at most ${MAX_CLAUSES} at a time.`);
  }
  return checkWithMode(clauses, keys, options);
}

/** Same as checkRequirements, for the paragraphs of an uploaded Word document. */
export async function checkParagraphs(paragraphs, keys, options = {}) {
  const clauses = splitParagraphs(paragraphs);
  if (clauses.length > MAX_CLAUSES) {
    throw new UserError(
      `That document has ${clauses.length} clauses. Upload at most ${MAX_CLAUSES} at a time, e.g. just the requirements section.`,
    );
  }
  return checkWithMode(clauses, keys, options);
}

function checkWithMode(clauses, keys, { mode = CHECK_MODE, ...options }) {
  return mode === "hybrid" ? checkClausesHybrid(clauses, keys, options) : checkClauses(clauses, keys.opencode, options);
}

/**
 * Check clauses with the LLM alone. Every model call sees the whole list, so it can
 * spot Conflicting pairs even when the review is split into slices.
 */
export async function checkClauses(
  clauses,
  apiKey,
  { prompt = ACTIVE_PROMPT, model, timeoutMs, suppressedTags = SUPPRESSED_TAGS, batchSize = BATCH_SIZE } = {},
) {
  if (clauses.length === 0) return [];

  const batches = [];
  for (let i = 0; i < clauses.length; i += batchSize) batches.push(clauses.slice(i, i + batchSize));

  const replies = await Promise.all(
    batches.map((batch) =>
      callModelJson(
        [
          { role: "system", content: PROMPTS[prompt] },
          { role: "user", content: batches.length === 1 ? buildUserMessage(clauses) : buildBatchMessage(clauses, batch) },
        ],
        apiKey,
        { model, timeoutMs },
      ),
    ),
  );

  // Keep only the ids each slice was asked about, in case a reply strays.
  const byId = new Map();
  replies.forEach((reply, i) => {
    const wanted = new Set(batches[i].map((c) => c.id));
    for (const r of Array.isArray(reply.results) ? reply.results : []) {
      if (wanted.has(Number(r.id))) byId.set(Number(r.id), r);
    }
  });

  return clauses.map((clause) => {
    const result = byId.get(clause.id) ?? {};
    const flags = normaliseFlags(result.flags).filter((f) => !suppressedTags.includes(f.tag));
    const rewrite = flags.length > 0 && typeof result.rewrite === "string" && result.rewrite.trim() ? result.rewrite.trim() : null;
    return { ...clause, flags, rewrite };
  });
}

function normaliseFlags(flags) {
  if (!Array.isArray(flags)) return [];
  const seen = new Set();
  const out = [];
  for (const f of flags) {
    const tag = TAGS.find((t) => t.toLowerCase() === String(f?.tag ?? "").trim().toLowerCase());
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, explanation: String(f.explanation ?? "").trim() });
  }
  return out;
}

export class UserError extends Error {}
