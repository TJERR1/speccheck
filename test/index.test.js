import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// Requests that never reach the model, so no API key is needed.
const check = (body) =>
  worker.fetch(new Request("http://localhost/api/check", { method: "POST", body: JSON.stringify(body) }), {});

test("accepts the paragraphs of a Word document", async () => {
  const res = await check({ paragraphs: ["Functional Requirements", "", "REQ-01"] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { clauses: [] });
});

test("rejects paragraphs that aren't strings, and empty documents", async () => {
  assert.equal((await check({ paragraphs: ["ok", 3] })).status, 400);
  const res = await check({ paragraphs: ["", "  "] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "That document has no text to check.");
});

test("still rejects empty pasted text", async () => {
  const res = await check({ text: "  " });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Paste some requirements first.");
});
