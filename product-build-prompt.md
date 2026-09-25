You are my product builder. Below is the PRD for a first version of my AI use-case. Build it.

Build this as a small, runnable project. Set up the file structure first, then implement the core flow end to end before adding extras.

# SpecCheck (v1 Demo)

## Problem

Draft requirements in tenders and statements of work (SOWs) often contain vague, untestable, compound, or vendor-locking language. Today, these drafting flaws are caught too late—during senior management reviews, through tedious vendor clarification questions, or at acceptance testing disputes. Reviewers waste time line-editing basic wording instead of focusing on technical substance.

## Why now / outcome

LLMs can now reliably parse and evaluate text against structured drafting rules in seconds.
**Outcome:** Spec writers catch and resolve common requirement defects before submission, reducing review cycle times and preventing post-award ambiguity.

## Target user

Engineers, project officers, and procurement writers drafting tender specifications or SOW clauses who need a fast, pre-review sanity check.

## Success metric

- **Demo proxy:** $\ge 80\%$ recall (catching known bad clauses) and $\ge 70\%$ precision (limiting annoying false alarms) on a test set of ~40 labelled requirements.
- **Long-term:** Reduction in wording-related review comments and vendor clarification questions per published tender.

## Scope — v1 features

- **Single text input:** Web-based text box to paste raw requirement text with zero setup.
- **Clause splitter:** Automatically parses pasted text into discrete, checkable requirement rows.
- **Flaw detection engine:** Evaluates each requirement against five specific tags: _Vague_, _Untestable_, _Vendor-locking_, _Conflicting_, or _Compound_.
- **Diagnostic breakdown:** Returns a clean table showing the original clause, the flagged issue, a plain-English explanation, and an actionable rewrite.
- **One-click copy:** Quick-action button to copy suggested rewrites to the clipboard.
- **Export cleaned spec:** One-click button to export all accepted requirements as clean plain text.

## Out of scope

- File uploads (`.docx`, `.pdf`) or document formatting retention.
- User accounts, authentication, or saved document history.
- Domain-specific engineering verification (e.g., verifying structural loads or circuit math).
- Integrations with formal e-procurement portals (e.g., GeBIZ, SAM.gov).
- Real-time collaborative multi-user editing.

## Key user flow

1. User opens the tool and pastes their draft requirements section into the main text box.
2. User clicks **"Check Requirements"**.
3. Within 10 seconds, the UI displays a structured results table highlighting flagged clauses alongside clean ones.
4. User clicks a flagged row to read why it failed (e.g., _"Untestable: 'fast response' lacks a specific metric"_) and views the proposed fix (e.g., _"'Response time under 200ms at peak load'"_).
5. User copies the suggested rewrites or edits in-line, then clicks **"Copy All Cleaned"** to paste the updated text back into their main draft.

## Riskiest assumption & cheapest test

- **Riskiest assumption:** The LLM's flags are accurate and helpful enough to build user trust, rather than generating pedantic, false-positive nitpicks that users dismiss.
- **Cheapest test:** Assemble a test dataset of 40 requirements (20 valid clauses from public tenders, 20 deliberately flawed clauses). Test two system prompts against this benchmark. Ship the prompt with the best precision/recall balance, suppressing any defect tag that creates excessive false positives.

## Data & privacy notes

- Stateless architecture: Pasted text is processed in memory and never saved to a database or local storage.
- LLM API calls must use enterprise privacy settings with zero data retention and no model training on submitted text.
- The UI will display a prominent notice reminding users not to paste classified or restricted information.

Requirements:

- Build only what is in scope above — nothing extra.
- Design the first screen around the key user flow.
- Keep it simple enough to demo to five users this week.
- Before writing code, summarise back to me what you will build in three lines and ask me one clarifying question if anything is unclear.
