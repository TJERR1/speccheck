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
