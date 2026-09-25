import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readDocx, paragraphEdits, buildTrackedDocx, diffSegments, scanParagraphs } from "../public/docx.js";
import { splitParagraphs } from "../src/splitter.js";

// Saved by Word: typed and automatic numbering, a bold word, a hyperlink and a table.
const fixture = () => readDocx(fs.readFileSync(new URL("./fixtures/sample.docx", import.meta.url)));

// Paragraph text with tracked changes accepted (w:delText is ignored) or rejected.
const accepted = (xml) => scanParagraphs(xml).map((p) => p.text);
const rejected = (xml) =>
  accepted(xml.replace(/<w:ins\b[^>]*>[\s\S]*?<\/w:ins>/g, "").replace(/<(\/?)w:delText\b/g, "<$1w:t"));

function redline(changes) {
  const edit = (doc) => {
    const texts = doc.paragraphs.map((p) => p.text);
    const clauses = splitParagraphs(texts).map((c) => ({ ...c, final: changes[c.id] ?? c.text }));
    return paragraphEdits(texts, clauses);
  };
  return fixture().then(async (doc) => {
    const { edits, unmapped } = edit(doc);
    const { blob, skipped } = await buildTrackedDocx(doc, edits, { date: new Date("2026-09-25T00:00:00Z") });
    const out = await readDocx(blob);
    return { doc, out, edits, unmapped, skipped };
  });
}

test("reads paragraphs from a Word document, including table cells", async () => {
  const doc = await fixture();
  const texts = doc.paragraphs.map((p) => p.text);
  assert.equal(texts[1], "1.\tThe system shall be user-friendly.");
  assert.equal(texts[2], "2.\tThe system shall be fast and easy to use.");
  assert.ok(texts.includes("The system shall retain logs & audit trails for a reasonable period."));
});

test("splits paragraphs into clauses that remember their paragraph", () => {
  const clauses = splitParagraphs(["Heading", "1.\tThe system shall log in users.", "", "The vendor shall train. The vendor shall supply spares."]);
  assert.deepEqual(clauses, [
    { id: 1, label: "1.", text: "The system shall log in users.", block: 1 },
    { id: 2, label: "", text: "The vendor shall train.", block: 3 },
    { id: 3, label: "", text: "The vendor shall supply spares.", block: 3 },
  ]);
});

test("writes rewrites as tracked changes: accept gives the new text, reject gives the original", async () => {
  const { doc, out, skipped } = await redline({
    1: "The system shall let a new user complete checkout in under 3 minutes.",
    2: "The system shall respond within 2 seconds.",
    4: "The vendor shall supply spares for 5 years.",
    7: "The system shall retain logs & audit trails for 12 months.",
  });
  assert.deepEqual(skipped, []);

  const after = accepted(out.xml);
  assert.equal(after[1], "1.\tThe system shall let a new user complete checkout in under 3 minutes.");
  assert.equal(after[2], "2.\tThe system shall respond within 2 seconds.");
  assert.equal(after[3], "The vendor shall provide training. The vendor shall supply spares for 5 years.");
  assert.ok(after.includes("The system shall retain logs & audit trails for 12 months."));
  assert.deepEqual(rejected(out.xml), doc.paragraphs.map((p) => p.text));

  assert.match(out.xml, /<w:ins w:id="\d+" w:author="SpecCheck" w:date="2026-09-25T00:00:00Z">/);
  assert.match(out.xml, /<w:del w:id="\d+" w:author="SpecCheck"/);
  // The other parts of the package are copied unchanged.
  assert.deepEqual(out.entries.map((e) => e.name), doc.entries.map((e) => e.name));
});

test("keeps the formatting of deleted text", async () => {
  const { out } = await redline({ 2: "The system shall respond within 2 seconds." });
  const del = out.xml.match(/<w:del [^>]*>([\s\S]*?)<\/w:del>/)[1];
  assert.match(del, /<w:b\/>[\s\S]*fast/);
});

test("leaves paragraphs with hyperlinks untouched and reports them", async () => {
  const { doc, out, skipped } = await redline({ 6: "The system shall comply with the policy." });
  assert.equal(skipped.length, 1);
  assert.equal(doc.paragraphs[skipped[0]].text, "The system shall comply with the policy at example.com.");
  assert.equal(out.xml, doc.xml);
});

test("diffs by word and keeps the original whitespace", () => {
  const old = "1.\tThe vendor shall supply spares.";
  const show = (segs) =>
    segs.map((s) => (s.type === "eq" ? old.slice(s.from, s.to) : `[-${old.slice(s.from, s.to)}+${s.ins}]`)).join("");
  assert.equal(show(diffSegments(old, "1. The vendor shall supply spares for 5 years.")), "1.\tThe vendor shall supply spares[-+ for 5 years].");
  assert.equal(show(diffSegments(old, "1. The vendor shall be fast.")), "1.\tThe vendor shall [-supply spares+be fast].");
  assert.equal(show(diffSegments(old, old)), old);
});
