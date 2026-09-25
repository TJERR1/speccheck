// Compare the candidate prompts on the labelled dataset, or run the hybrid checker.
//
//   npm run eval                     # all prompts, 3 runs each
//   npm run eval -- --runs 1 --prompts strict --model deepseek-v4-flash
//   npm run eval -- --mode hybrid --runs 3          # Jev + LLM (src/hybrid.js)
//   npm run eval -- --sweep eval/results/<file>.json   # tune Jev thresholds offline
//
// Each run checks all 40 clauses as one document, the same way the app does.
// Scores are clause-level (flagged vs clean) and per tag. Tags listed in an
// item's "also_ok" are defensible and not counted as false positives.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkClauses } from "../src/checker.js";
import { checkClausesHybrid, JEV_QUESTIONS, THRESHOLDS, JEV_TUNED_MODEL } from "../src/hybrid.js";
import { pickThreshold } from "./sweep.js";
import { listModels, JEV_BASE_URL } from "../src/jev.js";
import { PROMPTS, TAGS } from "../src/prompts.js";
import { LLM_MODEL } from "../src/llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const runs = Number(args.runs ?? 3);
const mode = args.mode ?? "llm";
const promptNames = args.prompts ? args.prompts.split(",") : Object.keys(PROMPTS);
const model = args.model ?? LLM_MODEL;
const jevModel = args["jev-model"] ?? JEV_TUNED_MODEL;
const TARGET = { recall: 0.8, precision: 0.7 };

const { items } = JSON.parse(fs.readFileSync(path.join(here, "dataset.json"), "utf8"));
const clauses = items.map((it) => ({ id: it.id, label: "", text: it.text }));

if (args.sweep) {
  sweep(JSON.parse(fs.readFileSync(args.sweep, "utf8")));
} else if (mode === "hybrid") {
  await runHybrid();
} else {
  await runPrompts();
}

async function runPrompts() {
  const apiKey = readKey("OPENCODE_API_KEY");
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
  const outFile = writeResults(`${model}`, { model, runs, summaries });
  printReport(summaries);
  console.log(`\nFull results: ${path.relative(process.cwd(), outFile)}`);
}

async function runHybrid() {
  const keys = { opencode: readKey("OPENCODE_API_KEY"), jev: readKey("JEV_AI_API_KEY") };
  const baseUrl = process.env.JEV_AI_BASE_URL || readEnvFile("JEV_AI_BASE_URL") || JEV_BASE_URL;
  const jevModels = await listModels(keys.jev, { baseUrl });
  console.log(`Jev models on this key: ${jevModels.join(", ")} · using ${jevModel}`);

  const runResults = [];
  const probabilities = [];
  for (let r = 1; r <= runs; r++) {
    process.stdout.write(`hybrid run ${r}/${runs}… `);
    const timings = {};
    const started = Date.now();
    try {
      const results = await checkClausesHybrid(clauses, keys, {
        withProbabilities: true,
        timings,
        jevOptions: { baseUrl, model: jevModel },
        llmOptions: { model, timeoutMs: 300_000 },
      });
      const seconds = (Date.now() - started) / 1000;
      console.log(`${seconds.toFixed(1)}s (jev ${timings.jev}s, conflict ${timings.conflict}s, rewrites ${timings.rewrites}s)`);
      runResults.push({ seconds, timings, results });
      probabilities.push(results.map((r) => ({ id: r.id, jev: r.jev, conflicting: r.flags.some((f) => f.tag === "Conflicting") })));
    } catch (err) {
      console.log(`failed: ${err.message.slice(0, 120)}`);
    }
  }
  const summaries = runResults.length
    ? [{ name: "hybrid", ...summarise(runResults), timings: meanTimings(runResults) }]
    : [];
  const outFile = writeResults(`hybrid-${model}`, { mode: "hybrid", model, jevModel, jevModels, thresholds: THRESHOLDS, runs, summaries, probabilities });
  printReport(summaries);
  if (summaries[0]) {
    const t = summaries[0].timings;
    console.log(`\nAverage step times: jev ${t.jev.toFixed(1)}s · conflict ${t.conflict.toFixed(1)}s · rewrites ${t.rewrites.toFixed(1)}s`);
  }
  console.log(`\nFull results: ${path.relative(process.cwd(), outFile)}`);
}

/** For each Jev tag, pick a threshold (see eval/sweep.js). All runs in the file are pooled. */
function sweep(file) {
  if (!Array.isArray(file.probabilities) || file.probabilities.length === 0) {
    console.error("That file has no Jev probabilities. Run `npm run eval -- --mode hybrid` first.");
    process.exit(1);
  }
  const itemsById = new Map(items.map((it) => [it.id, it]));
  const rows = file.probabilities.flat();
  const chosen = {};
  const fallback = [];

  console.log(`Sweeping ${rows.length} clause results from ${file.probabilities.length} run(s)\n`);
  console.log("tag              threshold  precision  recall");
  for (const { tag } of JEV_QUESTIONS) {
    const best = pickThreshold(rows, itemsById, tag, TARGET);
    // A tag Jev can't handle is left out (null) rather than shipped with a weak threshold.
    chosen[tag] = best?.meetsTarget ? best.t : null;
    if (!best?.meetsTarget) fallback.push(tag);
    const pct = (x) => `${Math.round(x * 100)}%`;
    console.log(`${tag.padEnd(16)} ${best ? String(best.t).padEnd(10) : "none      "} ${best ? pct(best.precision).padEnd(10) : "-         "} ${best ? pct(best.recall) : "-"}`);
  }

  // Clause-level score with the chosen thresholds plus the recorded conflict flags, per run.
  const perRun = file.probabilities.map((run) =>
    score(
      run.map((row) => ({
        id: row.id,
        flags: [
          ...JEV_QUESTIONS.filter(({ tag }) => chosen[tag] !== null && row.jev[tag] >= chosen[tag]).map(({ tag }) => ({ tag })),
          ...(row.conflicting ? [{ tag: "Conflicting" }] : []),
        ],
      })),
    ),
  );
  const mean = (f) => perRun.reduce((s, r) => s + f(r), 0) / perRun.length;
  console.log(`\nWith these thresholds: clause recall ${Math.round(mean((r) => r.recall) * 100)}%, precision ${Math.round(mean((r) => r.precision) * 100)}% (target: recall ≥ 80%, precision ≥ 70%)`);
  if (fallback.length) {
    console.log(
      `\nNo threshold reaches ${TARGET.recall * 100}% recall at ${TARGET.precision * 100}% precision for: ${fallback.join(", ")}.` +
        ` Per the spec these tags go back to the LLM; the scores above leave them out.`,
    );
  }
  console.log(`\nTHRESHOLDS = ${JSON.stringify(chosen)}`);
}

function meanTimings(runResults) {
  const mean = (k) => runResults.reduce((s, r) => s + r.timings[k], 0) / runResults.length;
  return { jev: mean("jev"), conflict: mean("conflict"), rewrites: mean("rewrites") };
}

function writeResults(name, data) {
  const outDir = path.join(here, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.join(outDir, `${stamp}-${name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
  return outFile;
}

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
  console.log(`\nModel: ${model}${mode === "hybrid" ? ` + ${jevModel}` : ""} · runs: ${runs} · target: recall ≥ 80%, precision ≥ 70%\n`);
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

function readKey(name) {
  const value = process.env[name] || readEnvFile(name);
  if (!value) {
    console.error(`Set ${name} in .env first.`);
    process.exit(1);
  }
  return value;
}

function readEnvFile(name) {
  const envFile = path.join(here, "..", ".env");
  const match = fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}
