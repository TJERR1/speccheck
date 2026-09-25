# Handoff: Project 5 — SpecCheck

## Context

Project 5 ("Final app") from the Day 2 course page: https://docs.tk.sg/Day-2-3fddd9d8b64482e38c9a814f1b0bce1f

Rules:

1. Work in twos or threes (agents + humans collaboration)
2. The app must use an AI back-end (server-side LLM calls via the OpenCode Go key, same as Lunch Uncle — OpenAI-compatible endpoint)
3. Include one "extra knowledge" build: a skill, MCP server, browser/CLI automation, or evaluation

The LLM must do a task that can't be handled reliably with simple parsing or a fixed template. We deliberately chose an idea **outside** the course's example problem statements (HADR, supply chain, OSINT, maritime, incident comms, after-action reports).

## The idea: SpecCheck — tender specification linter

Paste the requirements section of a tender / statement of work. The model reviews each requirement and flags:

| Flag | Example |
|---|---|
| **Vague** | "The system shall be user-friendly" |
| **Untestable** | No way to verify it at acceptance |
| **Vendor-locking** | Brand names, or specs only one supplier meets |
| **Conflicting** | Contradicts another requirement in the same document |
| **Compound** | Several requirements packed into one "shall" |

For each flag: the reason, and a suggested rewrite.

### Target user

An engineer or project officer drafting their first few tender specs, before the spec goes to review or out to market.

### Problem statement

Weak requirements get caught late: in review, in vendor clarification questions, or at acceptance testing, when "fast response" means different things to you and the vendor. Reviewers spend their time on basic wording problems instead of substance.

### Why it needs an LLM

A keyword list catches "user-friendly" or "etc." It can't judge whether "the system shall support 500 users" is testable, whether two clauses 12 pages apart contradict, or whether a spec quietly describes one vendor's product.

### Outcome metric

Fewer ambiguity-driven vendor clarification questions and review comments. **Demo proxy:** % of known-bad requirements caught before review, at an acceptable false-positive rate.

### Assumptions

1. Spec writers will run drafts through the tool *before* review, not after.
2. ⚠️ **Riskiest:** the model's flags are precise enough. If most flags are nitpicks, users ignore all of them.
3. Suggested rewrites keep the author's intent and don't change what's being bought.

## Extra-knowledge build: Evaluation

- Build a labelled set of ~40 requirements: good ones plus ones with a known flaw. Take them from public tenders (e.g. GeBIZ notices) and write some bad ones by hand.
- Compare **two prompts** (or two models) on precision and recall per flag type.
- Use the result to make **one project decision**, e.g. which prompt ships, or whether low-confidence flags are hidden.
- This directly tests the riskiest assumption (false-positive rate), which becomes pitch evidence.
- Keep a record of what was tried, what changed, and one limitation or failed attempt.

## MVP (one vertical slice)

1. Paste text into a textarea
2. Split into individual requirements
3. One LLM call classifies each and suggests rewrites (structured JSON output)
4. Results table: requirement | flag(s) | reason | suggested fix

Confirm a real LLM call works with the key **before** expanding the product.

### Outside the MVP

- Word or PDF upload
- Checking against a standards library
- Team review workflow
- Diffing between spec versions
- Logins / accounts

### Demo moment

Paste a deliberately bad spec live, watch it light up, then accept rewrites one by one.

## Project gate (post to Padlet first)

- [ ] Problem statement (see above)
- [ ] Outcome metric (see above)
- [ ] Riskiest assumption: flag precision
- [ ] Features outside the MVP (see above)
- [ ] Extra-knowledge build: evaluation, why it fits, how we'll test it

## Remaining course steps

- [ ] Product thinking: watch Product Thinking 4 (metrics) and 5 (assumptions and risks)
- [ ] Run the **grill-me** skill with the outcome metric + riskiest assumption as input; finish the interview before planning
- [ ] Scaffold + one complete vertical slice with a real LLM call
- [ ] Build and run the eval; make one decision from it
- [ ] `/design` a few options, pick one and revise; `/design` an app icon + logo; share name, icon, logo on Padlet
- [ ] Watch Product Thinking 6 (customer experience); polish first screen, instructions, loading and error states
- [ ] Public landing page (frontend-design skill or Claude Design) with the icon

## Submission checklist

- [ ] Public landing page: app name, team, problem statement, target user, outcome metric, riskiest assumption, evidence
- [ ] Working app: deployed link, or a screenshot if it runs locally
- [ ] Source repo with a short README on how to run it. **Check that no API keys or secrets are committed** (use `.env`, gitignored)
- [ ] Extra-knowledge build: link, what it enabled, evidence it worked, one limitation or failed attempt
- [ ] Visuals: icon, logo, at least one product screenshot

## Pitch is judged on

A clear 4Cs problem statement · a named outcome metric · evidence the riskiest assumption was addressed · a thoughtful customer experience · a working, well-built product · a useful extra-knowledge build with evidence

## Alternatives we considered (backups)

- **Handover Buddy:** a departing officer's notes go in; out comes a structured handover doc plus "questions your successor will ask that these notes don't answer". Extra build: a skill that interviews the leaver.
- **Policy Q&A with receipts:** ask questions of policy documents; every answer quotes the exact clause, or says "not covered". Extra build: an MCP server over the document store + a grounding eval.
