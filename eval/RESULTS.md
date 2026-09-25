# Eval results: which prompt ships

**Decision: ship the `strict` prompt** (`ACTIVE_PROMPT = "strict"` in `src/prompts.js`). No tags are suppressed.

**Update, 2026-09-25: the app now checks in hybrid mode** (`CHECK_MODE = "hybrid"` in `src/checker.js`). Jev decides four of the tags and the LLM writes the text. It met both success criteria against the single-call `strict` it replaced. Against #4's batched `strict` it is about even on speed and more accurate; see [Hybrid (Jev + LLM)](#hybrid-jev--llm). `strict` is still the prompt for `CHECK_MODE = "llm"`.

## Setup

- Dataset: `eval/dataset.json`, 40 clauses, 20 valid and 20 flawed (4 per tag). All 40 are checked as one document, the same way the app checks them.
- Model: `deepseek-v4-flash` (the shipped model), temperature 0. One extra `strict` run on `kimi-k3`.
- Target: clause-level recall ≥ 80% and precision ≥ 70%.
- Raw output: `eval/results/*.json`.

## Results (deepseek-v4-flash)

| Prompt | Runs completed | Clause recall | Clause precision | False alarms on 20 valid clauses | Avg time |
|---|---|---|---|---|---|
| `strict` | 3 / 3 | 95% | 100% | 0 | 156s |
| `baseline` | 3 / 4 (1 timed out at 300s) | 95% | 100% | 0 | 100s |

Per tag, which is where the two prompts differ:

| Tag | `strict` precision / recall | `baseline` precision / recall |
|---|---|---|
| Vague | 100% / 100% | 100% / 100% |
| Untestable | 100% / 100% | 100% / 63–100% (usually tagged Vague instead) |
| Vendor-locking | 100% / 75% | 100% / 100% |
| Conflicting | 100% / 100% | 88–100% / 75% |
| Compound | 100% / 100% | 100% / 100% |

Every run missed exactly one flawed clause:

- `strict` missed **#29** every time: "deployed only in the vendor's own proprietary data centre in Tuas" (Vendor-locking).
- `baseline` missed **#6** every time: "retain audit logs for 24 months", which conflicts with #31, "purge after 12 months". It flagged #31 but not #6, so a user would see only half of the conflict.

`kimi-k3` with `strict` (1 run, 259s): 100% recall, 100% precision, no misses.

## Why `strict`

1. **Both prompts pass the target and tie at clause level.** Neither raised a single false alarm on the 20 valid clauses, so the riskiest assumption (flags are nitpicks) was not borne out on this set.
2. **`strict` labels the flaw correctly.** `baseline` often calls an untestable clause "Vague", and it never flagged both sides of the audit-log conflict. The tag decides which rewrite the user gets, so a wrong tag leads to a weaker fix.
3. **`strict` completed every run.** `baseline` timed out once. Timing varied from 52s to 209s for the same input, though, so we don't claim either prompt is faster.

## Hybrid (Jev + LLM)

`npm run eval -- --mode hybrid` runs the same 40 clauses as one document.
- **Jev:** `jev-1.13.0` (`JEV_TUNED_MODEL`), one call per clause with four yes/no questions.
- **LLM:** `deepseek-v4-flash`, one conflict call over the whole list, then one rewrite call per flagged clause (at most 8 at once).
- **Timeout:** 300 s per LLM call. The app's is 60 s; see Latency in the app below.

Success criteria (spec): the average time is below `strict`'s 156 s, clause recall is ≥ 80% and clause precision is ≥ 70%. **All three are met.**

| | `strict` (llm mode) | `hybrid` |
|---|---|---|
| Runs | 3 | 3 |
| Clause recall | 95% | **100%** |
| Clause precision | 100% | **100%** |
| False alarms on 20 valid clauses | 0 | **0** |
| Avg time | 156 s | **78.6 s** (51.2, 132.8, 51.7) |
| Avg step times | – | Jev 0.9 s · conflict 45.3 s · rewrites 33.2 s |

Per tag (`hybrid`, 3 runs):

| Tag | Precision / recall |
|---|---|
| Vague | 100% / 100% |
| Untestable | 100% / 100% |
| Vendor-locking | 100% / 100% (it catches #29, which `strict` missed every time) |
| Conflicting | 82% / 100% |
| Compound | 100% / 100% |

- **Misses:** none. Both halves of the #6 / #31 audit-log conflict and the #35 / #38 downtime conflict were flagged in every run.
- **Conflicting's extra flags:**
  - Clause 5 was flagged in every run. Its 99.9% availability allows scheduled maintenance, which #35 forbids, and the dataset lists it in `also_ok`.
  - The other extras were one-off pairings of clauses that were already flawed for another reason: #25 with #29 in run 2, and #8 in run 3. None of them landed on a valid clause.

**Thresholds** (`THRESHOLDS` in `src/hybrid.js`): Vague 0.80, Untestable 0.65, Vendor-locking 0.35, Compound 0.75.
- **Where they come from:** the first run, at 0.5 for every tag, saved Jev's probabilities (`results/2026-09-25T07-18-09-hybrid-deepseek-v4-flash.json`). `npm run eval -- --sweep` on that file found that every tag reaches 100% precision and recall. None needs the spec's fallback to the LLM.
- **Why the middle of the gap:** each threshold is set halfway between the lowest-scoring flawed clause and the highest-scoring other clause, rounded to 0.05. The sweep's own pick sits right at the edge, just under the lowest flawed clause. The eval scores come out the same, and the middle leaves more margin for unseen clauses.

| Tag | Lowest flawed clause | Highest other clause | Threshold |
|---|---|---|---|
| Vague | 0.94 | 0.66 | 0.80 |
| Untestable | 0.81 | 0.47 | 0.65 |
| Vendor-locking | 0.55 | 0.20 | 0.35 |
| Compound | 0.88 | 0.65 | 0.75 |

The confirming 3-run results are in `results/2026-09-25T07-22-41-hybrid-deepseek-v4-flash.json`.

### Against batched `strict` (#4)

#4 changed llm mode to check parallel slices of 8 clauses. Run after the merge, 3 runs (`results/2026-09-25T07-51-43-deepseek-v4-flash.json`):

| | `strict`, batched | `hybrid` |
|---|---|---|
| Clause recall | 90% | **100%** |
| Clause precision | 96% | **100%** |
| False alarms on 20 valid clauses | 0.7 per run (#11, "Severity 1" called Vague) | **0** |
| Avg time | **69.4 s** (96.5, 88.7, 23.1) | 78.6 s (51.2, 132.8, 51.7) |
| Median time | 88.7 s | **51.7 s** |

- **Misses:** batched `strict` missed #29 (Vendor-locking) and #6 (one side of the audit-log conflict) in every run.
- **Speed:** the two are about even. Batched `strict` is ahead on average and hybrid on the median, and both swing more between runs than they differ from each other. The runs weren't interleaved, so time-of-day load on OpenCode Go may account for some of the difference.
- **What hybrid now buys:** accuracy, not speed. It also sends clean clauses to the LLM only once (in the conflict call), instead of asking the model to review them.

### Latency in the app

Jev is not the bottleneck: 40 clauses take under 1 s. The time goes to the two LLM steps, whose latency on OpenCode Go varies a lot.
- **Conflict call:** 25–79 s over 40 clauses.
- **8 clauses, one after the other:** `llm` mode took 19 s and then 46 s; `hybrid` took 8.9 s and then 55 s. The conflict call alone varied from 1.7 s to 17.5 s.

Through the Worker (`npm run dev`):
- **40-clause paste:** failed after 60 s with "The check took too long". The conflict call went over the app's 60 s per-call LLM timeout. The old llm mode fails the same way on long pastes (52–260 s), so this isn't a regression, but hybrid doesn't fix it either.
- **8-clause paste:** completed in 50 s, with every flawed clause flagged correctly.
- **Earlier hang:** one earlier 8-clause request never answered, and the local dev server stopped responding at near-zero CPU. After a restart it didn't happen again, and the cause is unknown.

### Hybrid limitations

- **Tuned and tested on the same 40 clauses.** The margins are wide (≥ 0.28 on every tag), but they may not hold on real drafts.
- **Thresholds are only valid for `jev-1.13.0`.** Change `JEV_TUNED_MODEL` and `THRESHOLDS` together.
- **The LLM calls set the latency.** One rewrite call per flagged clause and a conflict call over the whole list both depend on OpenCode Go's response time. Long pastes still hit the 60 s per-call timeout.
- **Subrequests:** a check of N clauses makes up to 2N + 1 outbound requests, which is over the Workers Free plan's 50 for long pastes (see README).

## Limitations and failed attempts

- **Ceiling effect.** Both prompts scored 100% precision, so the dataset can't show whether `strict`'s "don't nitpick" instructions reduce false alarms. The valid clauses are too clean. The next version should add borderline valid clauses (for example, a named open standard or a list of supported formats) that a loose prompt might flag.
- **Small sample.** 40 clauses and 3 runs per prompt. A single clause swings recall by 5 points.
- **First attempt failed.** Every 40-clause `kimi-k3` run hit the app's 60s timeout, so the eval runner now allows 5 minutes.
- **Latency is a product problem.** A 40-clause check takes 52–260s. That is above the app's 60s model timeout, so in the app, long pastes fail with "The check took too long". Short pastes (about 8 clauses) finish in about 10s. Fixing this means either raising the timeout or splitting long pastes into batches, and batching would hurt Conflicting detection across batches.
- **Hand-written flaws.** The flawed clauses were written by the team, so they may be easier to spot than flaws in real drafts.
