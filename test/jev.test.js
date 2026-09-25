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
