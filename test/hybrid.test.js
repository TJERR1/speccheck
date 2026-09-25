import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkClausesHybrid, JEV_QUESTIONS, THRESHOLDS, JEV_TUNED_MODEL } from "../src/hybrid.js";
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

test("calls Jev with the model the thresholds were tuned on", async () => {
  const log = mockServices();
  await checkClausesHybrid([clause(1, "A.")], KEYS);
  assert.equal(JEV_TUNED_MODEL, "jev-1.13.0");
  assert.equal(log.jev[0].model, JEV_TUNED_MODEL);
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
