# Hybrid Jev + LLM checker: design

Date: 2026-09-25 · Status: proposed · Stage: proof of concept

## Goal

Make a SpecCheck check faster without breaking the accuracy targets.

Today one LLM call (`deepseek-v4-flash` via OpenCode Go) returns flags, explanations and rewrites for every clause in one long reply. A 40-clause check takes 52–260s in the eval (156s average for `strict`), which is longer than the app's 60s model timeout.

The hybrid gives tag decisions to Jev, TypeSafe's System One model (70–500ms per call). The LLM then only writes text for the clauses that need it, in small parallel calls.

## Success criteria

On the 40-clause eval (`eval/dataset.json`), checked the same way as today:

1. **Faster:** the average time per run is lower than `strict`'s 156s.
2. **Clause recall ≥ 80%** and **clause precision ≥ 70%**. These are the existing eval targets. Matching today's 95% / 100% is not required.

If both hold, the app ships in hybrid mode.

## Constraints

- Jev integration follows `JEV_INTEGRATION.md`. The base URL is `https://api.typesafe.ai/v1` (configurable via `JEV_AI_BASE_URL`), the key is `JEV_AI_API_KEY`, and the retry and error rules are in its section 6.
- The key is read server-side only, and it never appears in logs, errors or test fixtures.
- Sending clause text to TypeSafe as well as OpenCode is acceptable at this stage. The README's privacy note is updated to name both.
- No new dependencies. Plain ES modules using `fetch`, runnable in both the Worker and Node, like `src/llm.js`.
- The `/api/check` request and response shapes, and everything in `public/`, stay unchanged.

## Architecture

```
POST /api/check
  └─ checker.checkRequirements(text, keys)      CHECK_MODE = "hybrid" | "llm"
       ├─ "llm":    existing single-call path (unchanged)
       └─ "hybrid": hybrid.checkClausesHybrid(clauses, keys)
            Step 1 (in parallel)
            │   ├─ Jev: one decide() per clause, 4 noul questions      → probabilities
            │   └─ LLM: one conflict call over the whole list          → conflict pairs
            Step 2 flags = { tag : p(tag) ≥ THRESHOLDS[tag] } ∪ conflicts
            Step 3 LLM: one rewrite call per flagged clause (at most 8 at once)
                        → explanation per tag + rewrite
            → [{ id, label, text, flags: [{tag, explanation}], rewrite }]
```

Expected wall time is the slower of the Jev and conflict calls, plus the slowest wave of rewrite calls. Clean clauses never reach the LLM after step 1.

## Components

### `src/jev.js` (new)

Built as `JEV_INTEGRATION.md` §3–§6 describes:

- `JEV_BASE_URL` (default `https://api.typesafe.ai/v1`), `JEV_MODEL = "jev-latest"`.
- `decide(body, apiKey, { baseUrl, model, timeoutMs, sleep })` sends `POST {base}/systemone` and returns `{ model, answers, usage }`. Before sending, it checks the documented limits: nonempty `state`, 1–64 questions, valid question IDs, and a body of at most 256,000 bytes.
- `listModels(apiKey, opts)` sends `GET {base}/models` and returns the model names. It's only used by the eval to record which model ran, and there's no browser route for it.
- `JevError` has `status`, `code` and a safe `message`. It parses both error body shapes (`{statusCode, message}` and `{detail: {error_type, message}}`). Retry rules:
  - A 429 retries once after `Retry-After` (capped at 30s). If there is no `Retry-After` header, or the retry also fails, it throws.
  - 401, 402, 403 and 422 throw immediately.
  - 502, 503, 504, a timeout or a network error throw after exactly one attempt, because the call may already have run and been billed.
- Timeout is `AbortSignal.timeout`, default 15s.

### `src/hybrid.js` (new)

- `JEV_QUESTIONS` holds the four `noul` questions. The IDs are `vague`, `untestable`, `vendor_locking` and `compound`. Each question's `instructions` restate the tag definition from the `strict` prompt in `src/prompts.js`, including its "is NOT" exclusions (for example, naming an open standard is not vendor-locking).
- `THRESHOLDS` sets one threshold per tag. Each starts at 0.5 and is set from the eval (see Eval).
- `checkClausesHybrid(clauses, { opencodeKey, jevKey }, options)` runs the three steps above. The Jev `state` for each clause is the clause text only. It returns the existing clause result shape.
- With `options.withProbabilities`, each result also gets `jev: {tag: p}`. The eval uses this; the app does not.
- A rewrite concurrency limit of 8 is a small local helper (a pool of promises), not a dependency.

### `src/prompts.js` (extended)

- `CONFLICT_PROMPT` gets all numbered clauses and replies `{"conflicts": [{"a": 6, "b": 31, "explanation": "..."}]}`. It uses the `strict` definition of Conflicting. Both clauses in a pair get the flag, and each flag's explanation names the other clause, as today.
- `REWRITE_PROMPT` gets one clause, its assigned tags, and, for a Conflicting flag, the text of the other clause. It replies `{"flags": [{"tag", "explanation"}], "rewrite": "..."}` and keeps today's `OUTPUT_FORMAT` rules for explanations, rewrites, square-bracket placeholders and Compound splits. The model may write explanations only for the tags it was given; any other tags it returns are dropped.

### `src/checker.js` and `src/index.js` (changed)

- `CHECK_MODE = "hybrid"` in `checker.js`. `checkRequirements(text, keys, options)` sends clauses to `checkClauses` (llm) or `checkClausesHybrid` (hybrid). Existing callers pass the OpenCode key as `keys.opencode`.
- `index.js` passes `{ opencode: env.OPENCODE_API_KEY, jev: env.JEV_AI_API_KEY }`. A `JevError` is logged by status and code only, and the user gets today's 502 message ("The checker is unavailable right now…").
- `.env.example` gets `JEV_AI_API_KEY=`, and `wrangler.toml`'s comment names both secrets.

## Error handling

- If any Jev call fails in hybrid mode, the whole check fails. There is no silent fallback to the LLM path, so eval timings and accuracy reflect the hybrid alone.
- A failed conflict call or rewrite call fails the check, as a failed LLM call does today.
- Clause text never reaches logs or error messages.

## Eval

- `npm run eval -- --mode hybrid [--runs 3]` runs the hybrid on the same 40 clauses. Jev is pinned to `jev-1.13.0`, and the LLM is `deepseek-v4-flash` at temperature 0.
- Each run records the total time and the time for each step (Jev, conflict, rewrites), and saves every Jev probability to `eval/results/`.
- **Threshold tuning is offline:** a `--sweep` over the saved probabilities finds, for each tag, the threshold that keeps recall highest while precision stays ≥ 70%. The chosen values go into `THRESHOLDS`, and one confirming live run is done with them.
- `eval/RESULTS.md` gets a hybrid section: time vs `strict`, recall and precision, per-tag results, the chosen thresholds, and limitations.
- **Fallback rule:** if a tag can't reach 80% recall at any threshold with precision ≥ 70%, it goes back to the LLM. That tag is added to the conflict call, which becomes the "LLM-judged tags" call, and the change is documented in `RESULTS.md`.

## Testing

`node:test`, with a mocked `globalThis.fetch` and no live calls.

- `test/jev.test.js`: the seven cases in `JEV_INTEGRATION.md` §7.
- `test/hybrid.test.js`:
  - thresholding (a probability of exactly the threshold flags; just below doesn't);
  - a conflict pair flags both clauses, and each explanation names the other;
  - rewrite calls are made only for flagged clauses;
  - no more than 8 rewrite calls run at once;
  - the output shape matches `checkClauses`;
  - a failed Jev call rejects the whole check.
- Existing `test/splitter.test.js` stays green.
- Manual: the live check in `JEV_INTEGRATION.md` §8, then one real check in `npm run dev`.

## Out of scope

- Model selection in the UI and a `GET /api/models` route.
- Streaming partial results to the browser.
- Using Jev for Conflicting (pairwise questions). This can be revisited after the eval.
- Laya models (not available on this key).
