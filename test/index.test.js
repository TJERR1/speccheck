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

test("an LLM failure logs its status but no clause text", async () => {
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/systemone")) return new Response(JSON.stringify({ answers: {}, usage: {} }), { status: 200 });
    const echoed = JSON.parse(init.body).messages[1].content;
    return new Response(`upstream error while processing: ${echoed}`, { status: 500 });
  };

  const res = await worker.fetch(post(TEXT), ENV);
  assert.equal(res.status, 502);
  const all = logged.join("\n");
  assert.match(all, /500/);
  for (const secret of [ENV.OPENCODE_API_KEY, "robust", "CSV"]) assert.ok(!all.includes(secret), `log leaks ${secret}`);
});

test("a malformed LLM reply logs no clause text", async () => {
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  globalThis.fetch = async (url) => {
    if (url.endsWith("/systemone")) return new Response(JSON.stringify({ answers: {}, usage: {} }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"conflicts": robust system }' } }] }), { status: 200 });
  };

  const res = await worker.fetch(post(TEXT), ENV);
  assert.equal(res.status, 502);
  assert.ok(!logged.join("\n").includes("robust"), "log leaks clause text");
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
