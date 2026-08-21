# wSpec Principles

## User Input

```text
$ARGUMENTS
```

If `$ARGUMENTS` includes intent (for example "greenfield" or "migrate legacy"), treat it as extra context.

---

## Overview

`/wspec-principles` creates or updates `wspec/principles.md` using two sources:
1. **Repository scan** for objective signals already present in code/config/docs
2. **Adaptive questionnaire** for unresolved, high-impact decisions

Goal: produce enforceable, project-specific guardrails with minimal guesswork.

---

## Step 1: Load Context

Read these first:
- `wspec/config.yaml`
- `wspec/principles.md` (if present)
- `wspec/README.md`
- `wspec/specs/` (if capability specs exist)
- `/memories/repo/wspec-notes.md` (if available)

If repo memory exists, use it to avoid re-asking already-decided guardrails unless
current repository evidence contradicts prior notes.

---

## Step 2: Repository Scan

Run MCP tool `wspec.repoScan` **first**.

It returns a scan object with:
- `topics[]` entries containing `topic`, `evidence` (concrete file paths), `confidence` (`high` / `medium` / `low`), and optional metadata (`anomalies`, `detected_signals`, `truncated`)
- optional `gaps[]` entries with explicit missing or partial evidence
- optional `summary` for platform/readiness context

Use those results as your evidence table directly. **Do not** open manifests, CI files, or
lint configs in the main context just to confirm presence — the helper already did that.

For any topic with `confidence: low` or any `gaps[]` entry that still needs clarity, dispatch the
`wspec-scan-gapfiller` subagent (model: haiku), one topic per dispatch — its own definition
already carries the narrow-scope instruction and return contract. Example prompt:

> "Topic: testing strategy. Inspect this repo's scripts, configs, and test directories."

Merge the subagent's reply into your evidence table. Preserve any `partial-evidence` gaps as
explicit assumptions if they cannot be closed in this run.

---

## Step 3: Adaptive Questionnaire

Ask only high-impact questions where scan confidence is medium/low or where tradeoffs are ambiguous.

Rules:
- Ask one question at a time via **AskUserQuestion**
- Prefer multiple-choice with a recommended default and short rationale
- Stop once unresolved high-impact ambiguity is cleared (typically 3-7 questions)
- If user says "use recommended" or equivalent, accept the recommendation

Required coverage before writing:
- Simplicity vs extensibility default
- Testing baseline and release gate strength
- Dependency policy (new deps, pinning, security updates)
- Data/security/privacy expectations (include: does this project accept user input from untrusted sources — web, API, file upload — and how should that be validated?)
- Operational expectations (performance, reliability, observability — structured logging, metrics emission, feature flags for safe rollout?)
- Documentation/change-management expectations
- Domain model strategy: does this project use DDD vocabulary (aggregates, bounded contexts, ubiquitous language)? Should specs enforce consistent naming?
- SOLID/design philosophy: should SOLID principles be enforced as quality rules, or is this codebase more pragmatic/procedural?
- Primary quality attributes: which matter most — latency, throughput, availability, modifiability, security? These become MUST/SHOULD rules in principles.md.

---

## Step 4: Write Principles

Create or update `wspec/principles.md` with this structure:

1. Title: `<PROJECT> Project Principles`
2. `How This File Is Maintained`
3. `Repository Signals` (facts from scan)
4. `Core Principles` (3-7 named principles)
5. `Quality Rules` (explicit MUST/MUST NOT/SHOULD)
6. `Governance` (ratification, amendment rules)

Content requirements:
- Use actionable language with testable MUST/MUST NOT wording
- Avoid generic statements that cannot be validated
- Preserve existing valid principles unless superseded by confirmed answers
- If uncertain, record as an explicit assumption or open question

After writing or updating the file, warm the principles cache so subsequent wSpec commands
do not re-parse the file from scratch by calling MCP tool `wspec.lockPrinciples` with
`{ "refresh": true }`.

The output confirms how many MUST/MUST NOT statements were extracted. If the count looks
wrong, review the file for template scaffolding that may need cleanup.

---

## Step 5: Output

Return:
- What was inferred from scan
- Which questions were asked and answers used
- A concise summary of updated principles
- Remaining assumptions (if any)
- Suggestion to run `/wspec-propose` next if starting a new feature

---

## Guardrails

- Do not invent repository facts without evidence
- Do not over-question; ask only what materially changes project guardrails
- Do not edit files outside `wspec/principles.md` unless explicitly requested
- Keep wording implementation-agnostic where possible, but still enforceable
