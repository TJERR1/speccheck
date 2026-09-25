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
