# Hybrid Jev + LLM Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a SpecCheck check faster. Jev (TypeSafe's System One model) decides four of the five tags per clause, and the LLM only finds conflicts and writes explanations and rewrites for flagged clauses, in parallel.

**Architecture:** A new `src/jev.js` client (following `JEV_INTEGRATION.md`) and a new `src/hybrid.js` pipeline:
1. Jev calls (one per clause) run in parallel with one LLM conflict call.
2. Thresholds turn Jev's probabilities into tags.
3. One LLM rewrite call runs per flagged clause, at most 8 at a time.

`src/checker.js` picks the pipeline via `CHECK_MODE`. The eval gains `--mode hybrid` and an offline `--sweep` that tunes thresholds.

**Tech Stack:** Cloudflare Worker, plain ES modules, `fetch` only, `node:test`, Node 22. No dependencies are added.

**Spec:** `docs/superpowers/specs/2026-09-25-jev-hybrid-checker-design.md`. Read it together with `JEV_INTEGRATION.md`.

## Global Constraints

- Jev base URL `https://api.typesafe.ai/v1`, configurable. Both the Worker (`env.JEV_AI_BASE_URL`) and the eval read the `JEV_AI_BASE_URL` override when it's set.
- Jev key: `env.JEV_AI_API_KEY` (starts with `apikey_`). Server-side only. It never appears in logs, error messages or test fixtures.
- The OpenCode key `OPENCODE_API_KEY` (starts with `oc_sk_`) is for the LLM only; Jev rejects it.
- App Jev model: `jev-latest`. Eval Jev model: pinned `jev-1.13.0`.
- Jev request limits: `state` nonempty; 1–64 questions; question IDs `^[A-Za-z0-9._-]{1,64}$`; body ≤ 256,000 bytes; 1,000 requests per minute.
- Retries:
  - 429: retry once after `Retry-After`, capped at 30s. With no `Retry-After` header, throw without retrying.
  - 401, 402, 403, 409 and 422: throw, no retry.
  - 502, 503, 504, a timeout or a network error: exactly one attempt, then throw.
- Rewrite concurrency: 8. Initial thresholds: 0.5 per tag.
- The `/api/check` request and response shapes, and everything in `public/`, are unchanged.
- No new dependencies. No live network calls in `npm test`.
- `PROMPTS.strict` and `PROMPTS.baseline` must stay byte-identical, because the eval history depends on them. Their SHA-256 hashes:
  - `strict`: `2489936422b52d5dd2bcafb9bae3dc84869ef67888e7414b50906d1b49b46dc4`
  - `baseline`: `e0e7fd60a618681f2e51f30077f31a6901c78b4bbaa5ca5de75f7a3943b75f02`
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A single clause** (nothing for it to conflict with) should make no conflict call and still get Jev tags and a rewrite. The test is in Task 3.
2. **The conflict call returns bad pairs** (unknown ids, a clause paired with itself, duplicate pairs). These should be ignored, not crash the check or flag the wrong clause. The test is in Task 3.
3. **A Jev answer is missing a question**, or its `noul` isn't a number. That tag should count as probability 0 (not flagged), and the check should carry on. The test is in Task 3.
4. **A rewrite reply is incomplete** (it omits an explanation, adds a tag it wasn't given, or returns no rewrite). The clause should keep exactly its assigned tags, with a fallback explanation and `rewrite: null`. The test is in Task 3.
5. **A Jev failure during a real check** (for example 402, out of balance) should give the user the friendly 502 message. The log should record the status and code only, never the key or the clause text. The test is in Task 4.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/jev.js` | create | Jev HTTP client: `decide`, `listModels`, `JevError`, limit checks, retry rules |
| `test/jev.test.js` | create | Mocked-fetch tests for the client |
| `src/prompts.js` | modify | Extract shared tag definitions and rules; add `CONFLICT_PROMPT`, `REWRITE_PROMPT`, `buildRewriteMessage` |
| `test/prompts.test.js` | create | Pins the `strict`/`baseline` hashes; checks the new prompt builders |
| `src/hybrid.js` | create | `JEV_QUESTIONS`, `THRESHOLDS`, `checkClausesHybrid` pipeline |
| `test/hybrid.test.js` | create | Pipeline tests with mocked Jev and LLM endpoints |
| `src/checker.js` | modify | `CHECK_MODE`, `checkRequirements(text, keys, options)` dispatch |
| `src/index.js` | modify | Pass both keys; log `JevError` safely |
| `test/index.test.js` | create | Worker-level tests for dispatch and error handling |
| `.env.example`, `wrangler.toml`, `README.md` | modify | Document the second key and provider |
| `eval/run.js` | modify | `--mode hybrid`, per-step timing, saved probabilities, `--sweep` |
| `eval/RESULTS.md` | modify | Hybrid results section (Task 6, from real runs) |

---

### Task 1: Jev client

**Files:**
- Create: `src/jev.js`
- Test: `test/jev.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `JEV_BASE_URL: string`, `JEV_MODEL: string`.
  - `class JevError extends Error { status: number; code: string }`. Codes: `unauthorized`, `payment_required`, `conflict`, `invalid_request`, `rate_limited`, `upstream`, `timeout`, `network`, `http_<status>`.
  - `decide(body: {state, questions, model?}, apiKey: string, opts?: {baseUrl?, model?, timeoutMs?, sleep?}) → Promise<{model: string, answers: Record<string, JevAnswer>, usage: {input_tokens, output_tokens}}>`.
  - `listModels(apiKey: string, opts?: {baseUrl?, timeoutMs?, sleep?}) → Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

Create `test/jev.test.js`:

```js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decide, listModels, JevError, JEV_BASE_URL } from "../src/jev.js";

const KEY = "apikey_test_SECRET_123";
const NOUL_BODY = {
  state: "My payment failed. Please help.",
  questions: { urgent: { type: "noul", instructions: "Does this message need urgent support?" } },
};

const realFetch = globalThis.fetch;
let calls;

function mockFetch(...responses) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r;
  };
}

const json = (status, body, headers = {}) =>
  () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const timeoutError = () => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
const noSleep = async () => {};

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test("decide sends a noul question and returns answers and usage", async () => {
  mockFetch(json(200, { model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.68 } }, usage: { input_tokens: 280, output_tokens: 20 } }));
  const result = await decide(NOUL_BODY, KEY);

  assert.equal(result.answers.urgent.noul, 0.68);
  assert.deepEqual(result.usage, { input_tokens: 280, output_tokens: 20 });
  assert.equal(result.model, "jev-1.13.0");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${JEV_BASE_URL}/systemone`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "jev-latest", ...NOUL_BODY });
});

test("decide uses the model and base URL options", async () => {
  mockFetch(json(200, { model: "jev-1.13.0", answers: {}, usage: {} }));
  await decide(NOUL_BODY, KEY, { baseUrl: "https://example.test/v1", model: "jev-1.13.0" });
  assert.equal(calls[0].url, "https://example.test/v1/systemone");
  assert.equal(JSON.parse(calls[0].init.body).model, "jev-1.13.0");
});

test("a choice answer keeps choice, probabilities and confidence", async () => {
  const answer = { type: "choice", choice: "contradicted", probabilities: { supported: 0.01, contradicted: 0.98, not_addressed: 0.01 }, confidence: 0.98 };
  mockFetch(json(200, { model: "jev-1.13.0", answers: { claim: answer }, usage: { input_tokens: 1, output_tokens: 1 } }));
  const result = await decide({ state: "x", questions: { claim: { type: "choice", instructions: "?", criteria: { supported: null, contradicted: null, not_addressed: null } } } }, KEY);
  assert.deepEqual(result.answers.claim, answer);
});

for (const [status, code] of [[401, "unauthorized"], [402, "payment_required"], [403, "unauthorized"], [422, "invalid_request"]]) {
  test(`${status} throws JevError(${code}) after one call`, async () => {
    mockFetch(json(status, { detail: { error_type: "x", message: "nope" } }));
    await assert.rejects(decide(NOUL_BODY, KEY, { sleep: noSleep }), (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test("both error body shapes are parsed into the message", async () => {
  mockFetch(json(422, { statusCode: 422, message: "questions is empty" }));
  await assert.rejects(decide(NOUL_BODY, KEY), /questions is empty/);
  mockFetch(json(422, { detail: { error_type: "invalid_state", message: "state is empty" } }));
  await assert.rejects(decide(NOUL_BODY, KEY), /state is empty/);
});

test("429 with Retry-After waits, then retries once", async () => {
  const waits = [];
  mockFetch(json(429, { message: "slow down" }, { "retry-after": "1" }), json(200, { model: "m", answers: { urgent: { type: "noul", noul: 0.1 } }, usage: {} }));
  const result = await decide(NOUL_BODY, KEY, { sleep: async (ms) => waits.push(ms) });
  assert.equal(result.answers.urgent.noul, 0.1);
  assert.deepEqual(waits, [1000]);
  assert.equal(calls.length, 2);
});

test("a second 429 throws rate_limited", async () => {
  mockFetch(json(429, {}, { "retry-after": "1" }), json(429, {}, { "retry-after": "1" }));
  await assert.rejects(decide(NOUL_BODY, KEY, { sleep: noSleep }), (err) => err.code === "rate_limited");
  assert.equal(calls.length, 2);
});

test("429 without Retry-After throws without retrying", async () => {
  mockFetch(json(429, {}));
  await assert.rejects(decide(NOUL_BODY, KEY, { sleep: noSleep }), (err) => err.code === "rate_limited");
  assert.equal(calls.length, 1);
});

test("Retry-After is capped at 30 seconds", async () => {
  const waits = [];
  mockFetch(json(429, {}, { "retry-after": "600" }), json(200, { model: "m", answers: {}, usage: {} }));
  await decide(NOUL_BODY, KEY, { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [30_000]);
});

for (const status of [502, 503, 504]) {
  test(`${status} throws upstream after exactly one call`, async () => {
    mockFetch(json(status, {}));
    await assert.rejects(decide(NOUL_BODY, KEY, { sleep: noSleep }), (err) => err.status === status && err.code === "upstream");
    assert.equal(calls.length, 1);
  });
}

test("a timeout throws JevError(504, timeout) after exactly one call", async () => {
  mockFetch(timeoutError());
  await assert.rejects(decide(NOUL_BODY, KEY), (err) => err instanceof JevError && err.status === 504 && err.code === "timeout");
  assert.equal(calls.length, 1);
});

test("a network error throws JevError(network) after exactly one call", async () => {
  mockFetch(new TypeError("fetch failed"));
  await assert.rejects(decide(NOUL_BODY, KEY), (err) => err.code === "network");
  assert.equal(calls.length, 1);
});

test("errors never contain the key, even if the upstream body echoes it", async () => {
  for (const status of [401, 402, 422, 429, 502]) {
    mockFetch(json(status, { message: `bad key ${KEY}` }));
    const err = await decide(NOUL_BODY, KEY, { sleep: noSleep }).catch((e) => e);
    assert.ok(err instanceof JevError);
    assert.ok(!err.message.includes(KEY), `message for ${status} leaks the key`);
    assert.ok(!JSON.stringify(err).includes(KEY), `serialised error for ${status} leaks the key`);
    assert.ok(!String(err.stack).includes(KEY), `stack for ${status} leaks the key`);
  }
});

test("invalid requests are rejected before any fetch", async () => {
  mockFetch(json(200, {}));
  const bad = [
    { state: "", questions: NOUL_BODY.questions },
    { state: [], questions: NOUL_BODY.questions },
    { state: "x", questions: {} },
    { state: "x", questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: "noul", instructions: "?" }])) },
    { state: "x", questions: { "bad id!": { type: "noul", instructions: "?" } } },
    { state: "x".repeat(256_001), questions: NOUL_BODY.questions },
  ];
  for (const body of bad) {
    await assert.rejects(decide(body, KEY), (err) => err instanceof JevError && err.code === "invalid_request");
  }
  assert.equal(calls.length, 0);
});

test("listModels returns the model names", async () => {
  mockFetch(json(200, { models: [{ name: "jev-latest", description: "", release_date: "" }, { name: "jev-preview", description: "", release_date: "" }] }));
  assert.deepEqual(await listModels(KEY), ["jev-latest", "jev-preview"]);
  assert.equal(calls[0].url, `${JEV_BASE_URL}/models`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/jev.test.js`
Expected: FAIL with `Cannot find module '.../src/jev.js'`.

- [ ] **Step 3: Implement the client**

Create `src/jev.js`:

```js
// Client for Jev, TypeSafe's System One decision model. See JEV_INTEGRATION.md.
// Uses only fetch, so it runs in both the Worker and Node (for the eval).

export const JEV_BASE_URL = "https://api.typesafe.ai/v1";
export const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 256_000;
const MAX_QUESTIONS = 64;
const QUESTION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_RETRY_WAIT_MS = 30_000;

/**
 * @typedef {{ type: "noul", instructions: string, criteria?: object }
 *   | { type: "choice", instructions: string, criteria: Record<string, string | null> }
 *   | { type: "score", instructions: string, criteria: string[] }} JevQuestion
 * @typedef {{ model?: string, state: string | object | Array<unknown>, questions: Record<string, JevQuestion> }} JevRequest
 * @typedef {{ type: "noul", noul: number }
 *   | { type: "choice", choice: string, probabilities: Record<string, number>, confidence: number }
 *   | { type: "score", score: number, [key: string]: unknown }} JevAnswer
 * @typedef {{ model: string, answers: Record<string, JevAnswer>, usage: { input_tokens: number, output_tokens: number } }} JevResponse
 */

export class JevError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Ask Jev a set of questions about one state.
 * @param {JevRequest} body
 * @returns {Promise<JevResponse>}
 */
export async function decide(body, apiKey, { baseUrl = JEV_BASE_URL, model = JEV_MODEL, timeoutMs = JEV_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  const payload = { model: body.model ?? model, state: body.state, questions: body.questions };
  const text = JSON.stringify(payload);
  validate(payload, text);
  const data = await request(
    `${baseUrl}/systemone`,
    { method: "POST", headers: { "content-type": "application/json" }, body: text },
    apiKey,
    { timeoutMs, sleep },
  );
  return { model: data.model, answers: data.answers ?? {}, usage: data.usage };
}

/** List the model names this key can use. Free to call. */
export async function listModels(apiKey, { baseUrl = JEV_BASE_URL, timeoutMs = JEV_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  const data = await request(`${baseUrl}/models`, { method: "GET", headers: {} }, apiKey, { timeoutMs, sleep });
  return (Array.isArray(data.models) ? data.models : []).map((m) => m.name);
}

async function request(url, init, apiKey, { timeoutMs, sleep }) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // No retry: the call may have run and been billed.
      if (err?.name === "TimeoutError") throw new JevError(504, "timeout", "Jev did not answer in time.");
      throw new JevError(0, "network", "Could not reach Jev.");
    }
    if (res.ok) return res.json();

    // Only a 429 is known not to have run, so it is the only retry.
    const wait = res.status === 429 && attempt === 1 ? retryAfterMs(res.headers.get("retry-after")) : null;
    if (wait !== null) {
      await sleep(wait);
      continue;
    }
    throw await toError(res, apiKey);
  }
}

async function toError(res, apiKey) {
  let detail = "";
  try {
    const body = await res.json();
    detail = String(body?.detail?.message ?? body?.message ?? "");
  } catch {
    // Non-JSON error body: keep the status only.
  }
  const code = errorCode(res.status);
  const safe = detail.split(apiKey).join("[key]").slice(0, 200);
  return new JevError(res.status, code, `Jev returned ${res.status} (${code})${safe ? `: ${safe}` : ""}`);
}

function errorCode(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 402) return "payment_required";
  if (status === 409) return "conflict";
  if (status === 422) return "invalid_request";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return `http_${status}`;
}

function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

function validate({ state, questions }, text) {
  const emptyState =
    state == null ||
    (typeof state === "string" && state.trim() === "") ||
    (Array.isArray(state) && state.length === 0) ||
    (typeof state === "object" && !Array.isArray(state) && Object.keys(state).length === 0);
  if (emptyState) throw new JevError(422, "invalid_request", "Jev request state is empty.");

  const ids = questions && typeof questions === "object" ? Object.keys(questions) : [];
  if (ids.length < 1 || ids.length > MAX_QUESTIONS) {
    throw new JevError(422, "invalid_request", `Jev requests need 1–${MAX_QUESTIONS} questions.`);
  }
  if (!ids.every((id) => QUESTION_ID.test(id))) {
    throw new JevError(422, "invalid_request", "Jev question IDs must be 1–64 letters, digits, '.', '-' or '_'.");
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new JevError(422, "invalid_request", `Jev request body is over ${MAX_BODY_BYTES} bytes.`);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --test test/jev.test.js`
Expected: all tests PASS.

Then run: `npm test`
Expected: all tests PASS, including the 7 splitter tests.

- [ ] **Step 5: Commit**

```bash
git add src/jev.js test/jev.test.js
git commit -m "Add Jev client with limit checks and retry rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Conflict and rewrite prompts

**Files:**
- Modify: `src/prompts.js` (the whole file is shown below)
- Test: `test/prompts.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (existing exports unchanged: `TAGS`, `PROMPTS`, `ACTIVE_PROMPT`, `SUPPRESSED_TAGS`, `buildUserMessage`):
  - `CONFLICT_PROMPT: string`. The reply shape is `{"conflicts": [{"a": number, "b": number, "explanation": string}]}`.
  - `REWRITE_PROMPT: string`. The reply shape is `{"flags": [{"tag", "explanation"}], "rewrite": string}`.
  - `buildRewriteMessage(clause: {id, text}, tags: string[], conflicting: Array<{id, text}>) → string`.
  - `TAG_DEFINITIONS: Record<tag, string>`: the definition text for each of the five tags. It is reused by `src/hybrid.js` for the Jev questions.

- [ ] **Step 1: Write the failing tests**

Create `test/prompts.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PROMPTS, CONFLICT_PROMPT, REWRITE_PROMPT, TAG_DEFINITIONS, TAGS, buildRewriteMessage } from "../src/prompts.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("the shipped prompts are byte-identical to the evaluated ones", () => {
  assert.equal(sha(PROMPTS.strict), "2489936422b52d5dd2bcafb9bae3dc84869ef67888e7414b50906d1b49b46dc4");
  assert.equal(sha(PROMPTS.baseline), "e0e7fd60a618681f2e51f30077f31a6901c78b4bbaa5ca5de75f7a3943b75f02");
});

test("every tag has a definition", () => {
  assert.deepEqual(Object.keys(TAG_DEFINITIONS), TAGS);
  for (const tag of TAGS) assert.ok(TAG_DEFINITIONS[tag].length > 20, tag);
});

test("the conflict prompt asks for id pairs as JSON", () => {
  assert.match(CONFLICT_PROMPT, /"conflicts"/);
  assert.match(CONFLICT_PROMPT, /"a"/);
  assert.match(CONFLICT_PROMPT, /"b"/);
});

test("the rewrite prompt asks for flags and a rewrite as JSON", () => {
  assert.match(REWRITE_PROMPT, /"flags"/);
  assert.match(REWRITE_PROMPT, /"rewrite"/);
  assert.match(REWRITE_PROMPT, /\[square brackets\]/);
});

test("buildRewriteMessage lists the clause, its tags and any conflicting clauses", () => {
  const msg = buildRewriteMessage({ id: 6, text: "Retain audit logs for 24 months." }, ["Conflicting", "Vague"], [{ id: 31, text: "Purge logs after 12 months." }]);
  assert.equal(
    msg,
    "Clause: Retain audit logs for 24 months.\nFlagged tags: Conflicting, Vague\nIt conflicts with:\n- clause 31: Purge logs after 12 months.",
  );
});

test("buildRewriteMessage leaves out the conflict section when there is none", () => {
  const msg = buildRewriteMessage({ id: 1, text: "The system shall be fast." }, ["Untestable"], []);
  assert.equal(msg, "Clause: The system shall be fast.\nFlagged tags: Untestable");
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/prompts.test.js`
Expected: FAIL, because `CONFLICT_PROMPT`, `REWRITE_PROMPT`, `TAG_DEFINITIONS` and `buildRewriteMessage` are not exported. The hash test passes already.

- [ ] **Step 3: Extract the shared text and add the prompts**

Replace `src/prompts.js` with the version below. The `strict` and `baseline` strings are built from the extracted pieces. The hash test proves their text is unchanged.

```js
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
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `npm test`
Expected: all tests PASS. If the hash test fails, the extraction changed a character of `strict` or `baseline`. Diff `PROMPTS.strict` against `git show HEAD:src/prompts.js` and fix it before moving on.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.js test/prompts.test.js
git commit -m "Add conflict and rewrite prompts for the hybrid checker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Hybrid pipeline

**Files:**
- Create: `src/hybrid.js`
- Test: `test/hybrid.test.js`

**Interfaces:**
- Consumes:
  - `decide(body, apiKey, opts)` and `JevError` from `src/jev.js` (Task 1).
  - `CONFLICT_PROMPT`, `REWRITE_PROMPT`, `TAG_DEFINITIONS`, `buildUserMessage` and `buildRewriteMessage` from `src/prompts.js` (Task 2).
  - `callModelJson(messages, apiKey, {model, timeoutMs})` from `src/llm.js` (existing).
- Produces:
  - `JEV_QUESTIONS: Array<{tag: string, id: string, instructions: string}>`, covering Vague, Untestable, Vendor-locking and Compound.
  - `THRESHOLDS: Record<tag, number>`.
  - `REWRITE_CONCURRENCY = 8`.
  - `checkClausesHybrid(clauses, keys: {opencode, jev}, options?) → Promise<Array<{id, label, text, flags: [{tag, explanation}], rewrite: string|null, jev?: Record<tag, number>}>>`.
  - Its options are `{thresholds, concurrency, withProbabilities, timings, jevOptions, llmOptions}`. `timings` is an object that gets filled with the seconds each step took: `jev`, `conflict`, `rewrites`.

- [ ] **Step 1: Write the failing tests**

Create `test/hybrid.test.js`:

```js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkClausesHybrid, JEV_QUESTIONS, THRESHOLDS } from "../src/hybrid.js";
import { CONFLICT_PROMPT, REWRITE_PROMPT } from "../src/prompts.js";
import { JevError } from "../src/jev.js";

const KEYS = { opencode: "oc_sk_test", jev: "apikey_test" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const clause = (id, text) => ({ id, label: `${id}.`, text });
const llmReply = (obj) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
const jevReply = (answers) => new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 4 } }), { status: 200 });
const noul = (probs) => Object.fromEntries(JEV_QUESTIONS.map((q) => [q.id, { type: "noul", noul: probs[q.tag] ?? 0 }]));

/**
 * Route mocked fetch calls by endpoint.
 * jev(text) → {tag: p}; conflicts → pairs; rewrite(userMessage) → reply object.
 */
function mockServices({ jev = () => ({}), conflicts = [], rewrite = () => ({ flags: [], rewrite: "Rewritten." }), onRewrite } = {}) {
  const log = { jev: [], conflict: 0, rewrite: [] };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/systemone")) {
      log.jev.push(body);
      return jevReply(noul(jev(body.state)));
    }
    const system = body.messages[0].content;
    if (system === CONFLICT_PROMPT) {
      log.conflict++;
      return llmReply({ conflicts });
    }
    if (system === REWRITE_PROMPT) {
      log.rewrite.push(body.messages[1].content);
      if (onRewrite) await onRewrite();
      return llmReply(rewrite(body.messages[1].content));
    }
    throw new Error(`unexpected call to ${url}`);
  };
  return log;
}

test("asks Jev the four non-conflict tags for every clause", async () => {
  const log = mockServices();
  await checkClausesHybrid([clause(1, "A."), clause(2, "B.")], KEYS);
  assert.equal(log.jev.length, 2);
  assert.deepEqual(log.jev.map((b) => b.state), ["A.", "B."]);
  assert.deepEqual(JEV_QUESTIONS.map((q) => q.tag), ["Vague", "Untestable", "Vendor-locking", "Compound"]);
  for (const b of log.jev) {
    assert.deepEqual(Object.keys(b.questions), JEV_QUESTIONS.map((q) => q.id));
    assert.ok(Object.values(b.questions).every((q) => q.type === "noul" && q.instructions.length > 20));
  }
});

test("a probability at the threshold flags; just below does not", async () => {
  const t = THRESHOLDS.Vague;
  mockServices({ jev: (text) => ({ Vague: text === "at" ? t : t - 0.001 }) });
  const [at, below] = await checkClausesHybrid([clause(1, "at"), clause(2, "below")], KEYS);
  assert.deepEqual(at.flags.map((f) => f.tag), ["Vague"]);
  assert.deepEqual(below.flags, []);
  assert.equal(below.rewrite, null);
});

test("custom thresholds override the defaults", async () => {
  mockServices({ jev: () => ({ Compound: 0.3 }) });
  const [r] = await checkClausesHybrid([clause(1, "x")], KEYS, { thresholds: { ...THRESHOLDS, Compound: 0.25 } });
  assert.deepEqual(r.flags.map((f) => f.tag), ["Compound"]);
});

test("rewrite calls are made only for flagged clauses, and explanations come from the rewrite reply", async () => {
  const log = mockServices({
    jev: (text) => (text === "bad" ? { Untestable: 0.9 } : {}),
    rewrite: () => ({ flags: [{ tag: "Untestable", explanation: "'fast' has no target." }], rewrite: "Respond within [X] seconds." }),
  });
  const results = await checkClausesHybrid([clause(1, "good"), clause(2, "bad"), clause(3, "good")], KEYS);
  assert.equal(log.rewrite.length, 1);
  assert.match(log.rewrite[0], /^Clause: bad\nFlagged tags: Untestable$/);
  assert.deepEqual(results[1].flags, [{ tag: "Untestable", explanation: "'fast' has no target." }]);
  assert.equal(results[1].rewrite, "Respond within [X] seconds.");
  assert.deepEqual(results[0], { ...clause(1, "good"), flags: [], rewrite: null });
});

test("a conflict pair flags both clauses, each naming the other", async () => {
  const log = mockServices({ conflicts: [{ a: 1, b: 3, explanation: "24 months vs 12 months." }] });
  const results = await checkClausesHybrid([clause(1, "keep 24"), clause(2, "fine"), clause(3, "purge 12")], KEYS);
  assert.equal(log.conflict, 1);
  assert.deepEqual(results[0].flags, [{ tag: "Conflicting", explanation: "Conflicts with clause 3: 24 months vs 12 months." }]);
  assert.deepEqual(results[2].flags, [{ tag: "Conflicting", explanation: "Conflicts with clause 1: 24 months vs 12 months." }]);
  assert.deepEqual(results[1].flags, []);
  assert.equal(log.rewrite.length, 2);
  assert.match(log.rewrite.find((m) => m.startsWith("Clause: keep 24")), /It conflicts with:\n- clause 3: purge 12/);
});

test("Conflicting comes after Jev tags, in TAGS order", async () => {
  mockServices({ jev: () => ({ Compound: 0.9, Vague: 0.9 }), conflicts: [{ a: 1, b: 2, explanation: "x." }] });
  const [r] = await checkClausesHybrid([clause(1, "a"), clause(2, "b")], KEYS);
  assert.deepEqual(r.flags.map((f) => f.tag), ["Vague", "Conflicting", "Compound"]);
});

test("bad conflict pairs are ignored", async () => {
  mockServices({
    conflicts: [
      { a: 1, b: 99, explanation: "unknown id." },
      { a: 2, b: 2, explanation: "self pair." },
      { a: "x", b: 1, explanation: "not a number." },
      { a: 1, b: 2, explanation: "real." },
      { a: 2, b: 1, explanation: "duplicate." },
    ],
  });
  const results = await checkClausesHybrid([clause(1, "a"), clause(2, "b"), clause(3, "c")], KEYS);
  assert.deepEqual(results[0].flags, [{ tag: "Conflicting", explanation: "Conflicts with clause 2: real." }]);
  assert.deepEqual(results[1].flags, [{ tag: "Conflicting", explanation: "Conflicts with clause 1: real." }]);
  assert.deepEqual(results[2].flags, []);
});

test("a single clause makes no conflict call", async () => {
  const log = mockServices({ jev: () => ({ Vague: 0.9 }) });
  const [r] = await checkClausesHybrid([clause(1, "robust system")], KEYS);
  assert.equal(log.conflict, 0);
  assert.deepEqual(r.flags.map((f) => f.tag), ["Vague"]);
  assert.equal(r.rewrite, "Rewritten.");
});

test("a missing or non-numeric Jev answer counts as probability 0", async () => {
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/systemone")) return jevReply({ vague: { type: "noul", noul: "high" } });
    return llmReply({ conflicts: [] });
  };
  const results = await checkClausesHybrid([clause(1, "a"), clause(2, "b")], KEYS, { withProbabilities: true });
  assert.deepEqual(results[0].flags, []);
  assert.deepEqual(results[0].jev, { Vague: 0, Untestable: 0, "Vendor-locking": 0, Compound: 0 });
});

test("an incomplete rewrite reply keeps the assigned tags with a fallback explanation", async () => {
  mockServices({
    jev: () => ({ Vague: 0.9, Compound: 0.9 }),
    rewrite: () => ({ flags: [{ tag: "Compound", explanation: "Two requirements." }, { tag: "Untestable", explanation: "not assigned" }], rewrite: "  " }),
  });
  const [r] = await checkClausesHybrid([clause(1, "a")], KEYS);
  assert.deepEqual(r.flags, [
    { tag: "Vague", explanation: "This clause was flagged as vague." },
    { tag: "Compound", explanation: "Two requirements." },
  ]);
  assert.equal(r.rewrite, null);
});

test("no more than 8 rewrite calls run at once", async () => {
  let inFlight = 0;
  let peak = 0;
  mockServices({
    jev: () => ({ Vague: 0.9 }),
    onRewrite: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    },
  });
  const clauses = Array.from({ length: 20 }, (_, i) => clause(i + 1, `c${i}`));
  const results = await checkClausesHybrid(clauses, KEYS);
  assert.equal(results.length, 20);
  assert.ok(results.every((r) => r.rewrite === "Rewritten."));
  assert.ok(peak <= 8, `peak ${peak}`);
  assert.ok(peak > 1, "rewrites should run in parallel");
});

test("output keeps clause order and the checkClauses shape", async () => {
  mockServices({ jev: (t) => (t === "b" ? { Vague: 0.9 } : {}) });
  const results = await checkClausesHybrid([clause(1, "a"), clause(2, "b")], KEYS);
  assert.deepEqual(results.map((r) => r.id), [1, 2]);
  for (const r of results) assert.deepEqual(Object.keys(r).sort(), ["flags", "id", "label", "rewrite", "text"]);
});

test("withProbabilities adds each clause's Jev probabilities", async () => {
  mockServices({ jev: () => ({ Vague: 0.2, Compound: 0.7 }) });
  const [r] = await checkClausesHybrid([clause(1, "a")], KEYS, { withProbabilities: true });
  assert.deepEqual(r.jev, { Vague: 0.2, Untestable: 0, "Vendor-locking": 0, Compound: 0.7 });
});

test("timings records each step in seconds", async () => {
  mockServices({ jev: () => ({ Vague: 0.9 }) });
  const timings = {};
  await checkClausesHybrid([clause(1, "a"), clause(2, "b")], KEYS, { timings });
  for (const step of ["jev", "conflict", "rewrites"]) assert.equal(typeof timings[step], "number", step);
});

test("a failed Jev call rejects the whole check", async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith("/systemone")) return new Response(JSON.stringify({ message: "no balance" }), { status: 402 });
    return llmReply({ conflicts: [] });
  };
  await assert.rejects(checkClausesHybrid([clause(1, "a"), clause(2, "b")], KEYS), (err) => err instanceof JevError && err.code === "payment_required");
});

test("no clauses means no calls", async () => {
  const log = mockServices();
  assert.deepEqual(await checkClausesHybrid([], KEYS), []);
  assert.equal(log.jev.length + log.conflict + log.rewrite.length, 0);
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/hybrid.test.js`
Expected: FAIL with `Cannot find module '.../src/hybrid.js'`.

- [ ] **Step 3: Implement the pipeline**

Create `src/hybrid.js`:

```js
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

// Minimum Jev probability for each tag to be flagged. Set from `npm run eval -- --sweep`; see eval/RESULTS.md.
export const THRESHOLDS = { Vague: 0.5, Untestable: 0.5, "Vendor-locking": 0.5, Compound: 0.5 };

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
          ? clashes.map((c) => `Conflicts with clause ${c.other}: ${c.explanation}`).join(" ")
          : reply?.explanations.get(tag) || `This clause was flagged as ${tag.toLowerCase()}.`,
    }));
    const result = { ...clause, flags, rewrite: flags.length > 0 ? reply?.rewrite ?? null : null };
    return withProbabilities ? { ...result, jev: probabilities[i] } : result;
  });
}

async function jevProbabilities(text, apiKey, options) {
  const { answers } = await decide({ state: text, questions: JEV_REQUEST_QUESTIONS }, apiKey, options);
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
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hybrid.js test/hybrid.test.js
git commit -m "Add hybrid Jev + LLM checking pipeline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the hybrid into the Worker

**Files:**
- Modify: `src/checker.js`: `checkRequirements` (lines 7–17) and its imports.
- Modify: `src/index.js`: `handleCheck` (lines 34–46) and imports.
- Modify: `.env.example`, `wrangler.toml` (the secrets comment), `README.md` (privacy note and architecture).
- Test: `test/index.test.js`

**Interfaces:**
- Consumes: `checkClausesHybrid` (Task 3), `JevError` (Task 1), and the existing `checkClauses`.
- Produces:
  - `CHECK_MODE: "hybrid" | "llm"`.
  - `checkRequirements(text: string, keys: {opencode: string, jev: string}, options?: {mode?, ...}) → Promise<clause results>`. The second argument changes from a bare key to a keys object; `src/index.js` is the only caller.

- [ ] **Step 1: Write the failing tests**

Create `test/index.test.js`:

```js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { checkRequirements } from "../src/checker.js";
import { PROMPTS } from "../src/prompts.js";

const ENV = { OPENCODE_API_KEY: "oc_sk_test_SECRET", JEV_AI_API_KEY: "apikey_test_SECRET" };
const realFetch = globalThis.fetch;
const realError = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

const llmReply = (obj) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
const post = (text) => new Request("http://localhost/api/check", { method: "POST", body: JSON.stringify({ text }) });
const TEXT = "1. The system shall be robust.\n2. The system shall export CSV files.";

test("the Worker checks in hybrid mode with both keys", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    if (url.endsWith("/systemone")) {
      const robust = JSON.parse(init.body).state.includes("robust");
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { vague: { type: "noul", noul: robust ? 0.9 : 0.1 } }, usage: {} }), { status: 200 });
    }
    const system = JSON.parse(init.body).messages[0].content;
    if (system.includes('"conflicts"')) return llmReply({ conflicts: [] });
    return llmReply({ flags: [{ tag: "Vague", explanation: "'robust' is undefined." }], rewrite: "The system shall [measurable target]." });
  };

  const res = await worker.fetch(post(TEXT), ENV);
  assert.equal(res.status, 200);
  const { clauses } = await res.json();
  assert.deepEqual(clauses.map((c) => c.flags.map((f) => f.tag)), [["Vague"], []]);
  assert.ok(seen.filter((s) => s.url.endsWith("/systemone")).every((s) => s.auth === `Bearer ${ENV.JEV_AI_API_KEY}`));
  assert.ok(seen.filter((s) => !s.url.endsWith("/systemone")).every((s) => s.auth === `Bearer ${ENV.OPENCODE_API_KEY}`));
});

test("llm mode still makes the single strict-prompt call", async () => {
  const systems = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(!url.endsWith("/systemone"), "llm mode must not call Jev");
    systems.push(JSON.parse(init.body).messages[0].content);
    return llmReply({ results: [{ id: 1, flags: [], rewrite: null }, { id: 2, flags: [], rewrite: null }] });
  };
  const results = await checkRequirements(TEXT, { opencode: ENV.OPENCODE_API_KEY, jev: ENV.JEV_AI_API_KEY }, { mode: "llm" });
  assert.equal(results.length, 2);
  assert.deepEqual(systems, [PROMPTS.strict]);
});

test("a Jev failure gives the friendly 502 and logs no key or clause text", async () => {
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  globalThis.fetch = async (url) => {
    if (url.endsWith("/systemone")) return new Response(JSON.stringify({ message: `balance empty for ${ENV.JEV_AI_API_KEY}` }), { status: 402 });
    return llmReply({ conflicts: [] });
  };

  const res = await worker.fetch(post(TEXT), ENV);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "The checker is unavailable right now. Try again in a moment." });
  const all = logged.join("\n");
  assert.match(all, /JevError 402 payment_required/);
  for (const secret of [ENV.JEV_AI_API_KEY, ENV.OPENCODE_API_KEY, "robust", "CSV"]) assert.ok(!all.includes(secret), `log leaks ${secret}`);
});

test("a Jev timeout gives the took-too-long message", async () => {
  console.error = () => {};
  globalThis.fetch = async (url) => {
    if (url.endsWith("/systemone")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return llmReply({ conflicts: [] });
  };
  const res = await worker.fetch(post(TEXT), ENV);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "The check took too long. Try a shorter section." });
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test test/index.test.js`
Expected: FAIL. The Worker still calls the LLM only, with `env.OPENCODE_API_KEY` passed as a string.

- [ ] **Step 3: Add the mode switch to `src/checker.js`**

Replace the imports and `checkRequirements` (lines 1–17) with:

```js
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
```

Leave the bodies of `checkClauses`, `normaliseFlags` and `UserError` as they are. Add this comment directly above `export async function checkClauses`, since its old description moved off `checkRequirements`:

```js
/** Check all clauses in one model call, so the model sees the whole list and can spot Conflicting pairs. */
```

- [ ] **Step 4: Update `handleCheck` in `src/index.js`**

Add `import { JevError } from "./jev.js";` after the checker import. Replace the `try`/`catch` in `handleCheck` with:

```js
  try {
    const clauses = await checkRequirements(
      text,
      { opencode: env.OPENCODE_API_KEY, jev: env.JEV_AI_API_KEY },
      env.JEV_AI_BASE_URL ? { jevOptions: { baseUrl: env.JEV_AI_BASE_URL } } : {},
    );
    return json({ clauses });
  } catch (err) {
    if (err instanceof UserError) return json({ error: err.message }, 400);
    // Log the failure type only, never the pasted text or a key.
    if (err instanceof JevError) console.error("check failed: JevError", err.status, err.code);
    else console.error("check failed:", err.name, err.message.slice(0, 200));
    const timedOut = err.name === "TimeoutError" || err.code === "timeout";
    return json(
      { error: timedOut ? "The check took too long. Try a shorter section." : "The checker is unavailable right now. Try again in a moment." },
      502,
    );
  }
```

- [ ] **Step 5: Run the tests to check they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Document the second key and provider**

Change `.env.example` to:

```
OPENCODE_API_KEY=
JEV_AI_API_KEY=
```

In `wrangler.toml`, replace the two secret comment lines with:

```toml
# OPENCODE_API_KEY (LLM) and JEV_AI_API_KEY (Jev) are set with
# `wrangler secret put` for deploys and read from `.env` for local
# development. Never put them in this file.
```

In `README.md`, make these edits:
- **Privacy note (line 15):** replace "Pasted text is sent to the LLM provider for checking." with "Pasted text is sent to two model providers for checking: OpenCode Go (the LLM) and TypeSafe (Jev)."
- **Architecture section:** replace step 2 with the following, and renumber the later steps:
  > 2. `src/checker.js` checks the clauses in one of two ways, set by `CHECK_MODE`:
  >    - **`hybrid`** (the default, `src/hybrid.js`) runs one Jev call per clause (`src/jev.js`) in parallel with one LLM call over the whole list. Jev decides Vague, Untestable, Vendor-locking and Compound, and the LLM call finds Conflicting pairs. Then one small LLM call per flagged clause writes the explanations and the rewrite.
  >    - **`llm`** sends all the clauses in one model call.
- **Mermaid diagram:** add `participant Jev as Jev (TypeSafe)` and the line `Worker->>Jev: one decision call per clause`.
- **Setup:** say `.env` needs both keys, and add `npx wrangler secret put JEV_AI_API_KEY` next to the OpenCode `secret put` line.

- [ ] **Step 7: Commit**

```bash
git add src/checker.js src/index.js test/index.test.js .env.example wrangler.toml README.md
git commit -m "Check in hybrid mode by default, with both keys" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Eval hybrid mode and threshold sweep

**Files:**
- Modify: `eval/run.js`. The whole file is shown below: the existing llm-mode behaviour and output are unchanged, plus `--mode hybrid` and `--sweep`.

**Interfaces:**
- Consumes:
  - `checkClausesHybrid`, `JEV_QUESTIONS` and `THRESHOLDS` (Task 3).
  - `listModels` and `JEV_BASE_URL` (Task 1).
  - The existing `checkClauses`, `PROMPTS`, `TAGS` and `LLM_MODEL`.
- Produces:
  - A CLI:
    - `npm run eval -- --mode hybrid --runs N [--model M] [--jev-model jev-1.13.0]`.
    - `npm run eval -- --sweep eval/results/<file>.json`.
  - Hybrid result files in `eval/results/<stamp>-hybrid-<model>.json` with the shape `{ mode: "hybrid", model, jevModel, jevModels, thresholds, runs, summaries, probabilities: [[{id, jev, conflicting}]] }`. There is one inner array per run.

This task has no unit test: `eval/run.js` is a script that makes live calls. It is verified by a dry run on a two-clause mock in Step 2 and by the live runs in Task 6.

- [ ] **Step 1: Replace `eval/run.js`**

```js
// Compare the candidate prompts on the labelled dataset, or run the hybrid checker.
//
//   npm run eval                     # all prompts, 3 runs each
//   npm run eval -- --runs 1 --prompts strict --model deepseek-v4-flash
//   npm run eval -- --mode hybrid --runs 3          # Jev + LLM (src/hybrid.js)
//   npm run eval -- --sweep eval/results/<file>.json   # tune Jev thresholds offline
//
// Each run checks all 40 clauses as one document, the same way the app does.
// Scores are clause-level (flagged vs clean) and per tag. Tags listed in an
// item's "also_ok" are defensible and not counted as false positives.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkClauses } from "../src/checker.js";
import { checkClausesHybrid, JEV_QUESTIONS, THRESHOLDS } from "../src/hybrid.js";
import { listModels, JEV_BASE_URL } from "../src/jev.js";
import { PROMPTS, TAGS } from "../src/prompts.js";
import { LLM_MODEL } from "../src/llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const runs = Number(args.runs ?? 3);
const mode = args.mode ?? "llm";
const promptNames = args.prompts ? args.prompts.split(",") : Object.keys(PROMPTS);
const model = args.model ?? LLM_MODEL;
const jevModel = args["jev-model"] ?? "jev-1.13.0";
const TARGET = { recall: 0.8, precision: 0.7 };

const { items } = JSON.parse(fs.readFileSync(path.join(here, "dataset.json"), "utf8"));
const clauses = items.map((it) => ({ id: it.id, label: "", text: it.text }));

if (args.sweep) {
  sweep(JSON.parse(fs.readFileSync(args.sweep, "utf8")));
} else if (mode === "hybrid") {
  await runHybrid();
} else {
  await runPrompts();
}

async function runPrompts() {
  const apiKey = readKey("OPENCODE_API_KEY");
  const summaries = [];
  for (const name of promptNames) {
    const runResults = [];
    for (let r = 1; r <= runs; r++) {
      process.stdout.write(`${name} run ${r}/${runs}… `);
      const started = Date.now();
      try {
        const results = await checkClauses(clauses, apiKey, { prompt: name, model, timeoutMs: 300_000, suppressedTags: [] });
        const seconds = (Date.now() - started) / 1000;
        console.log(`${seconds.toFixed(1)}s`);
        runResults.push({ seconds, results });
      } catch (err) {
        console.log(`failed: ${err.message.slice(0, 120)}`);
      }
    }
    if (runResults.length) summaries.push({ name, ...summarise(runResults) });
  }
  const outFile = writeResults(`${model}`, { model, runs, summaries });
  printReport(summaries);
  console.log(`\nFull results: ${path.relative(process.cwd(), outFile)}`);
}

async function runHybrid() {
  const keys = { opencode: readKey("OPENCODE_API_KEY"), jev: readKey("JEV_AI_API_KEY") };
  const baseUrl = process.env.JEV_AI_BASE_URL || readEnvFile("JEV_AI_BASE_URL") || JEV_BASE_URL;
  const jevModels = await listModels(keys.jev, { baseUrl });
  console.log(`Jev models on this key: ${jevModels.join(", ")} · using ${jevModel}`);

  const runResults = [];
  const probabilities = [];
  for (let r = 1; r <= runs; r++) {
    process.stdout.write(`hybrid run ${r}/${runs}… `);
    const timings = {};
    const started = Date.now();
    try {
      const results = await checkClausesHybrid(clauses, keys, {
        withProbabilities: true,
        timings,
        jevOptions: { baseUrl, model: jevModel },
        llmOptions: { model, timeoutMs: 300_000 },
      });
      const seconds = (Date.now() - started) / 1000;
      console.log(`${seconds.toFixed(1)}s (jev ${timings.jev}s, conflict ${timings.conflict}s, rewrites ${timings.rewrites}s)`);
      runResults.push({ seconds, timings, results });
      probabilities.push(results.map((r) => ({ id: r.id, jev: r.jev, conflicting: r.flags.some((f) => f.tag === "Conflicting") })));
    } catch (err) {
      console.log(`failed: ${err.message.slice(0, 120)}`);
    }
  }
  const summaries = runResults.length
    ? [{ name: "hybrid", ...summarise(runResults), timings: meanTimings(runResults) }]
    : [];
  const outFile = writeResults(`hybrid-${model}`, { mode: "hybrid", model, jevModel, jevModels, thresholds: THRESHOLDS, runs, summaries, probabilities });
  printReport(summaries);
  if (summaries[0]) {
    const t = summaries[0].timings;
    console.log(`\nAverage step times: jev ${t.jev.toFixed(1)}s · conflict ${t.conflict.toFixed(1)}s · rewrites ${t.rewrites.toFixed(1)}s`);
  }
  console.log(`\nFull results: ${path.relative(process.cwd(), outFile)}`);
}

/**
 * For each Jev tag, pick the threshold with the highest recall whose precision is at least the target.
 * Ties go to the higher threshold, which flags less. All runs in the file are pooled.
 */
function sweep(file) {
  if (!Array.isArray(file.probabilities) || file.probabilities.length === 0) {
    console.error("That file has no Jev probabilities. Run `npm run eval -- --mode hybrid` first.");
    process.exit(1);
  }
  const itemsById = new Map(items.map((it) => [it.id, it]));
  const rows = file.probabilities.flat();
  const candidates = Array.from({ length: 19 }, (_, i) => Math.round((0.05 + i * 0.05) * 100) / 100);
  const chosen = {};

  console.log(`Sweeping ${rows.length} clause results from ${file.probabilities.length} run(s)\n`);
  console.log("tag              threshold  precision  recall");
  for (const { tag } of JEV_QUESTIONS) {
    let best = null;
    for (const t of candidates) {
      let tp = 0, fp = 0, fn = 0;
      for (const row of rows) {
        const item = itemsById.get(row.id);
        const want = item.tags.includes(tag);
        const got = row.jev[tag] >= t;
        const allowed = want || (item.also_ok ?? []).includes(tag);
        if (want && got) tp++;
        else if (want && !got) fn++;
        else if (!allowed && got) fp++;
      }
      const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
      const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
      if (precision >= TARGET.precision && (!best || recall >= best.recall)) best = { t, precision, recall };
    }
    chosen[tag] = best?.t ?? null;
    const pct = (x) => `${Math.round(x * 100)}%`;
    console.log(`${tag.padEnd(16)} ${best ? String(best.t).padEnd(10) : "none      "} ${best ? pct(best.precision).padEnd(10) : "-         "} ${best ? pct(best.recall) : "-"}`);
  }

  // Clause-level score with the chosen thresholds plus the recorded conflict flags, per run.
  const perRun = file.probabilities.map((run) =>
    score(
      run.map((row) => ({
        id: row.id,
        flags: [
          ...JEV_QUESTIONS.filter(({ tag }) => chosen[tag] !== null && row.jev[tag] >= chosen[tag]).map(({ tag }) => ({ tag })),
          ...(row.conflicting ? [{ tag: "Conflicting" }] : []),
        ],
      })),
    ),
  );
  const mean = (f) => perRun.reduce((s, r) => s + f(r), 0) / perRun.length;
  console.log(`\nWith these thresholds: clause recall ${Math.round(mean((r) => r.recall) * 100)}%, precision ${Math.round(mean((r) => r.precision) * 100)}% (target: recall ≥ 80%, precision ≥ 70%)`);
  const failing = JEV_QUESTIONS.filter(({ tag }) => chosen[tag] === null).map((q) => q.tag);
  if (failing.length) console.log(`No threshold reaches ${TARGET.precision * 100}% precision for: ${failing.join(", ")}`);
  console.log(`\nTHRESHOLDS = ${JSON.stringify(chosen)}`);
}

function meanTimings(runResults) {
  const mean = (k) => runResults.reduce((s, r) => s + r.timings[k], 0) / runResults.length;
  return { jev: mean("jev"), conflict: mean("conflict"), rewrites: mean("rewrites") };
}

function writeResults(name, data) {
  const outDir = path.join(here, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.join(outDir, `${stamp}-${name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
  return outFile;
}

function summarise(runResults) {
  const perRun = runResults.map(({ seconds, results }) => ({ seconds, ...score(results) }));
  const mean = (f) => perRun.reduce((s, r) => s + f(r), 0) / perRun.length;
  const tags = Object.fromEntries(
    TAGS.map((t) => [
      t,
      {
        precision: mean((r) => r.tags[t].precision),
        recall: mean((r) => r.tags[t].recall),
        fp: mean((r) => r.tags[t].fp),
      },
    ]),
  );
  return {
    runs: perRun.length,
    seconds: mean((r) => r.seconds),
    precision: mean((r) => r.precision),
    recall: mean((r) => r.recall),
    falseAlarms: mean((r) => r.falseAlarms),
    tags,
    perRun: perRun.map(({ seconds, precision, recall, errors }) => ({ seconds, precision, recall, errors })),
  };
}

function score(results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  let tp = 0, fp = 0, fn = 0;
  const tags = Object.fromEntries(TAGS.map((t) => [t, { tp: 0, fp: 0, fn: 0 }]));
  const errors = [];

  for (const item of items) {
    const predicted = (byId.get(item.id)?.flags ?? []).map((f) => f.tag);
    const allowed = new Set([...item.tags, ...(item.also_ok ?? [])]);
    const isBad = item.tags.length > 0;
    // A valid clause flagged only with defensible tags is not a false alarm.
    const flagged = predicted.some((t) => (isBad ? true : !allowed.has(t)));

    if (isBad && flagged) tp++;
    if (isBad && !flagged) { fn++; errors.push({ id: item.id, kind: "missed", expected: item.tags }); }
    if (!isBad && flagged) {
      fp++;
      errors.push({ id: item.id, kind: "false alarm", predicted, explanation: byId.get(item.id)?.flags.map((f) => f.explanation) });
    }

    for (const t of TAGS) {
      const want = item.tags.includes(t);
      const got = predicted.includes(t);
      if (want && got) tags[t].tp++;
      else if (want && !got) tags[t].fn++;
      else if (!want && got && !allowed.has(t)) tags[t].fp++;
    }
  }

  const ratio = (a, b) => (b === 0 ? 1 : a / b);
  for (const t of TAGS) {
    const c = tags[t];
    c.precision = ratio(c.tp, c.tp + c.fp);
    c.recall = ratio(c.tp, c.tp + c.fn);
  }
  return { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), falseAlarms: fp, tags, errors };
}

function printReport(summaries) {
  const pct = (x) => `${Math.round(x * 100)}%`.padStart(5);
  console.log(`\nModel: ${model}${mode === "hybrid" ? ` + ${jevModel}` : ""} · runs: ${runs} · target: recall ≥ 80%, precision ≥ 70%\n`);
  console.log("prompt     recall  precision  false alarms  avg time");
  for (const s of summaries) {
    console.log(`${s.name.padEnd(10)} ${pct(s.recall)}   ${pct(s.precision)}      ${s.falseAlarms.toFixed(1).padStart(4)}        ${s.seconds.toFixed(1)}s`);
  }
  for (const s of summaries) {
    console.log(`\n${s.name} — per tag (precision / recall / avg false positives)`);
    for (const t of TAGS) {
      const c = s.tags[t];
      console.log(`  ${t.padEnd(15)} ${pct(c.precision)} / ${pct(c.recall)} / ${c.fp.toFixed(1)}`);
    }
    const errs = s.perRun.flatMap((r) => r.errors);
    if (errs.length) {
      console.log("  errors across runs:");
      for (const e of errs) console.log(`    #${e.id} ${e.kind}: ${e.kind === "missed" ? e.expected.join(",") : e.predicted.join(",") + " — " + (e.explanation ?? []).join(" / ")}`);
    }
  }
}

function readKey(name) {
  const value = process.env[name] || readEnvFile(name);
  if (!value) {
    console.error(`Set ${name} in .env first.`);
    process.exit(1);
  }
  return value;
}

function readEnvFile(name) {
  const envFile = path.join(here, "..", ".env");
  const match = fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}
```

- [ ] **Step 2: Dry-run the sweep on a hand-made file (no network)**

Write a scratch file where every flawed clause scores 0.9 on its expected tags and everything else scores 0.1. The sweep should then pick a threshold for every tag with 100% precision and recall.

```bash
node -e '
const fs=require("fs");const d=JSON.parse(fs.readFileSync("eval/dataset.json","utf8"));
const tags=["Vague","Untestable","Vendor-locking","Compound"];
const run=d.items.map(it=>({id:it.id,jev:Object.fromEntries(tags.map(t=>[t,it.tags.includes(t)?0.9:0.1])),conflicting:it.tags.includes("Conflicting")}));
fs.writeFileSync(process.env.TMP+"/sweep-fixture.json",JSON.stringify({probabilities:[run]}));'
npm run eval -- --sweep "$TMP/sweep-fixture.json"
```

Expected: every tag gets a threshold between 0.15 and 0.9 at 100% precision and 100% recall. The output ends with `clause recall 100%, precision 100%` and a `THRESHOLDS = {...}` line.

- [ ] **Step 3: Check the llm-mode path still starts**

Run: `npm test`, then `node --check eval/run.js`.
Expected: all tests PASS, and `node --check` prints nothing (exit 0). The llm-mode code in `runPrompts` is the old top-level code moved into a function, so it gets its live check in Task 6 only if a comparison run is wanted.

- [ ] **Step 4: Commit**

```bash
git add eval/run.js
git commit -m "Add hybrid mode and offline threshold sweep to the eval" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live runs, thresholds and results write-up

This task needs real keys and costs money (small amounts), so a human has to be involved. An agent must not copy `.env` or run commands that expose keys unless the human does it or explicitly approves.

**Files:**
- Modify: `src/hybrid.js` (the `THRESHOLDS` values only).
- Modify: `eval/RESULTS.md` (add a hybrid section).
- New result files in `eval/results/`.

- [ ] **Step 1: Give the worktree its keys (human)**

Ask the human to run this from the worktree root:

```
! cp ../../../.env .env
```

Then have them confirm `.env` has both `OPENCODE_API_KEY=` and `JEV_AI_API_KEY=` lines with values. Only check this with `grep -c '^JEV_AI_API_KEY=.\+' .env`, which prints a count and never the key.

- [ ] **Step 2: Live Jev check (JEV_INTEGRATION.md §8)**

Ask the human to run the §8 command with `!`.
Expected: `answers.urgent.noul` is between 0 and 1, and the model list includes `jev-1.13.0` or `jev-latest`. If `jev-1.13.0` isn't accepted, rerun the later steps with `--jev-model jev-latest` and record that in `RESULTS.md`.

- [ ] **Step 3: One hybrid run at the starting thresholds**

Run: `npm run eval -- --mode hybrid --runs 1`
Expected: it completes, and prints the total time plus the jev, conflict and rewrite step times, and the results file path. The first run's accuracy doesn't matter; what matters is that it records probabilities.

- [ ] **Step 4: Sweep and set the thresholds**

Run: `npm run eval -- --sweep eval/results/<file from step 3>.json`

Copy the printed `THRESHOLDS` values into `THRESHOLDS` in `src/hybrid.js`.

**Stop and report to the human, without changing anything, if either of these happens:**
- the sweep prints "No threshold reaches 70% precision" for any tag;
- a tag's recall at its chosen threshold is below 80%.

The spec's fallback rule (moving that tag back to the LLM) changes the design, so the human decides whether to apply it.

Run: `npm test`
Expected: PASS. The threshold test reads `THRESHOLDS`, so it still holds.

- [ ] **Step 5: Confirm with three runs at the tuned thresholds**

Run: `npm run eval -- --mode hybrid --runs 3`

Success, per the spec: the average time is below 156s, clause recall is ≥ 80% and clause precision is ≥ 70%. Record the actual numbers either way.

- [ ] **Step 6: Write up the results**

Add a `## Hybrid (Jev + LLM)` section to `eval/RESULTS.md`, above `## Limitations and failed attempts`, with:
- a table comparing `strict` (from the existing results: 95% recall, 100% precision, 156s) with `hybrid` (real numbers from step 5): recall, precision, false alarms, average time, and step times;
- a per-tag precision and recall table for `hybrid`;
- the chosen thresholds and the name of the sweep file;
- the misses and false alarms the eval printed, with clause numbers;
- whether the success criteria were met, and the decision on `CHECK_MODE`;
- limitations: the thresholds were tuned and confirmed on the same 40 clauses (so they may be overfitted), the Jev model version used, and the fact that there's one rewrite call per flagged clause.

If the criteria were **not** met, set `CHECK_MODE = "llm"` in `src/checker.js`, say so in the write-up, and tell the human.

- [ ] **Step 7: Manual check in the app**

Run `npm run dev`, open http://localhost:8788/app, paste 5–8 clauses from `eval/dataset.json` (including #6 and #31), and click **Check Requirements**. Check that flags, explanations and rewrites appear, and that both #6 and #31 show Conflicting.

- [ ] **Step 8: Commit**

`.env` is gitignored, but check it isn't staged anyway:

```bash
git status --short
git add src/hybrid.js eval/RESULTS.md eval/results/
git commit -m "Tune Jev thresholds and record hybrid eval results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
