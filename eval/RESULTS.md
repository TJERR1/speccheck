# Eval results: which prompt ships

**Decision: ship the `strict` prompt** (`ACTIVE_PROMPT = "strict"` in `src/prompts.js`). No tags are suppressed.

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

## Limitations and failed attempts

- **Ceiling effect.** Both prompts scored 100% precision, so the dataset can't show whether `strict`'s "don't nitpick" instructions reduce false alarms. The valid clauses are too clean. The next version should add borderline valid clauses (for example, a named open standard or a list of supported formats) that a loose prompt might flag.
- **Small sample.** 40 clauses and 3 runs per prompt. A single clause swings recall by 5 points.
- **First attempt failed.** Every 40-clause `kimi-k3` run hit the app's 60s timeout, so the eval runner now allows 5 minutes.
- **Latency is a product problem.** A 40-clause check takes 52–260s. That is above the app's 60s model timeout, so in the app, long pastes fail with "The check took too long". Short pastes (about 8 clauses) finish in about 10s. Fixing this means either raising the timeout or splitting long pastes into batches, and batching would hurt Conflicting detection across batches.
- **Hand-written flaws.** The flawed clauses were written by the team, so they may be easier to spot than flaws in real drafts.
