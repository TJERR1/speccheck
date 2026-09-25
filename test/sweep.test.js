import { test } from "node:test";
import assert from "node:assert/strict";
import { pickThreshold } from "../eval/sweep.js";

const TARGET = { recall: 0.8, precision: 0.7 };

// 4 clauses with the Vague flaw (ids 1–4) and 6 valid ones (ids 5–10).
const items = new Map(
  Array.from({ length: 10 }, (_, i) => [i + 1, { id: i + 1, tags: i < 4 ? ["Vague"] : [], also_ok: [] }]),
);
const rows = (score) => [...items.keys()].map((id) => ({ id, jev: { Vague: score(id) } }));

test("clean separation picks the highest threshold that keeps full recall", () => {
  const best = pickThreshold(rows((id) => (id <= 4 ? 0.9 : 0.1)), items, "Vague", TARGET);
  assert.equal(best.t, 0.9);
  assert.equal(best.precision, 1);
  assert.equal(best.recall, 1);
  assert.equal(best.meetsTarget, true);
});

test("a threshold that flags nothing does not count as 100% precision", () => {
  // Jev can't tell flawed from valid: flagging anything gives 40% precision.
  const best = pickThreshold(rows(() => 0.1), items, "Vague", TARGET);
  assert.equal(best, null);
});

test("a tag whose best recall is under the target is marked as not meeting it", () => {
  const best = pickThreshold(rows((id) => (id === 1 ? 0.9 : 0.1)), items, "Vague", TARGET);
  assert.equal(best.t, 0.9);
  assert.equal(best.recall, 0.25);
  assert.equal(best.meetsTarget, false);
});

test("also_ok tags are not false positives", () => {
  const withAlsoOk = new Map(items);
  withAlsoOk.set(5, { id: 5, tags: [], also_ok: ["Vague"] });
  const best = pickThreshold(rows((id) => (id <= 5 ? 0.9 : 0.1)), withAlsoOk, "Vague", TARGET);
  assert.equal(best.precision, 1);
});
