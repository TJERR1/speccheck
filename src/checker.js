import { splitClauses } from "./splitter.js";
import { callModelJson } from "./llm.js";
import { checkClausesHybrid } from "./hybrid.js";
import { PROMPTS, ACTIVE_PROMPT, SUPPRESSED_TAGS, TAGS, buildUserMessage } from "./prompts.js";

export const MAX_CLAUSES = 60;

// "hybrid": Jev decides tags, the LLM writes rewrites (src/hybrid.js).
// "llm": one model call does everything (checkClauses below).
export const CHECK_MODE = "hybrid";

/**
 * Split text into clauses and check them.
 * @param {{opencode: string, jev: string}} keys
 */
export async function checkRequirements(text, keys, { mode = CHECK_MODE, ...options } = {}) {
  const clauses = splitClauses(text);
  if (clauses.length > MAX_CLAUSES) {
    throw new UserError(`That's ${clauses.length} clauses. Paste at most ${MAX_CLAUSES} at a time.`);
  }
  return mode === "hybrid" ? checkClausesHybrid(clauses, keys, options) : checkClauses(clauses, keys.opencode, options);
}

/** Check all clauses in one model call, so the model sees the whole list and can spot Conflicting pairs. */
export async function checkClauses(clauses, apiKey, { prompt = ACTIVE_PROMPT, model, timeoutMs, suppressedTags = SUPPRESSED_TAGS } = {}) {
  if (clauses.length === 0) return [];

  const reply = await callModelJson(
    [
      { role: "system", content: PROMPTS[prompt] },
      { role: "user", content: buildUserMessage(clauses) },
    ],
    apiKey,
    { model, timeoutMs },
  );

  const byId = new Map((Array.isArray(reply.results) ? reply.results : []).map((r) => [Number(r.id), r]));

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
