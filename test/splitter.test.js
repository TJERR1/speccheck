import { test } from "node:test";
import assert from "node:assert/strict";
import { splitClauses } from "../src/splitter.js";

const texts = (input) => splitClauses(input).map((c) => c.text);

test("splits numbered lines and strips the numbers into labels", () => {
  const clauses = splitClauses("1. The system shall log in users.\n2. The system shall log out users.");
  assert.deepEqual(clauses, [
    { id: 1, label: "1.", text: "The system shall log in users." },
    { id: 2, label: "2.", text: "The system shall log out users." },
  ]);
});

test("handles bullets, dotted numbering and requirement ids", () => {
  const input = [
    "- The vendor shall provide training.",
    "3.2.1 The system shall export CSV files.",
    "REQ-012: The system shall encrypt data at rest.",
    "(a) The vendor shall supply spares.",
  ].join("\n");
  assert.deepEqual(texts(input), [
    "The vendor shall provide training.",
    "The system shall export CSV files.",
    "The system shall encrypt data at rest.",
    "The vendor shall supply spares.",
  ]);
});

test("joins wrapped lines into one clause", () => {
  const input = "1. The system shall retain audit logs\nfor a minimum of 12 months.\n2. The vendor shall provide support.";
  assert.deepEqual(texts(input), [
    "The system shall retain audit logs for a minimum of 12 months.",
    "The vendor shall provide support.",
  ]);
});

test("blank lines separate unnumbered paragraphs", () => {
  assert.deepEqual(texts("The system shall be fast.\n\nThe system shall be secure."), [
    "The system shall be fast.",
    "The system shall be secure.",
  ]);
});

test("splits a paragraph holding several shall-sentences", () => {
  const input = "The system shall be fast. The system shall be secure. Note: see Annex A.";
  assert.deepEqual(texts(input), ["The system shall be fast.", "The system shall be secure. Note: see Annex A."]);
});

test("keeps a single sentence with two shalls together, so Compound can be flagged", () => {
  assert.deepEqual(texts("The system shall back up nightly and shall restore within 4 hours."), [
    "The system shall back up nightly and shall restore within 4 hours.",
  ]);
});

test("drops headings and empty input", () => {
  assert.deepEqual(texts("Functional Requirements\n1. The system shall print reports."), [
    "The system shall print reports.",
  ]);
  assert.deepEqual(splitClauses("   \n\n"), []);
});
