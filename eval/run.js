// Compare the candidate prompts on the labelled dataset.
//
//   npm run eval                     # all prompts, 3 runs each
//   npm run eval -- --runs 1 --prompts strict --model deepseek-v4-flash
//
// Each run checks all 40 clauses as one document, the same way the app does.
// Scores are clause-level (flagged vs clean) and per tag. Tags listed in an
// item's "also_ok" are defensible and not counted as false positives.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkClauses } from "../src/checker.js";
import { PROMPTS, TAGS } from "../src/prompts.js";
import { LLM_MODEL } from "../src/llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const runs = Number(args.runs ?? 3);
const promptNames = args.prompts ? args.prompts.split(",") : Object.keys(PROMPTS);
const model = args.model ?? LLM_MODEL;

const apiKey = readApiKey();
const { items } = JSON.parse(fs.readFileSync(path.join(here, "dataset.json"), "utf8"));
const clauses = items.map((it) => ({ id: it.id, label: "", text: it.text }));

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

const outDir = path.join(here, "results");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = path.join(outDir, `${stamp}-${model}.json`);
fs.writeFileSync(outFile, JSON.stringify({ model, runs, summaries }, null, 2));

printReport(summaries);
console.log(`\nFull results: ${path.relative(process.cwd(), outFile)}`);

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
  console.log(`\nModel: ${model} · runs per prompt: ${runs} · target: recall ≥ 80%, precision ≥ 70%\n`);
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

function readApiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  const envFile = path.join(here, "..", ".env");
  const match = fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").match(/^OPENCODE_API_KEY=(.*)$/m);
  if (!match || !match[1].trim()) {
    console.error("Set OPENCODE_API_KEY in .env first.");
    process.exit(1);
  }
  return match[1].trim();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}
