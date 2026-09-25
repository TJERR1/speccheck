import { splitClauses } from "./splitter.js";
import { callModelJson } from "./llm.js";
import { PROMPTS, ACTIVE_PROMPT, SUPPRESSED_TAGS, TAGS, buildUserMessage } from "./prompts.js";

export const MAX_CLAUSES = 60;

/**
 * Split text into clauses and check them all in one model call, so the model
 * sees the whole list and can spot Conflicting pairs.
 */
export async function checkRequirements(text, apiKey, options = {}) {
  const clauses = splitClauses(text);
  if (clauses.length > MAX_CLAUSES) {
    throw new UserError(`That's ${clauses.length} clauses. Paste at most ${MAX_CLAUSES} at a time.`);
  }
  return checkClauses(clauses, apiKey, options);
}

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
