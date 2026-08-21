# wSpec Propose

## User Input

```text
$ARGUMENTS
```

If `$ARGUMENTS` is non-empty, ground everything that follows in it before doing anything else.

---

## Overview

`/wspec-propose` covers the entire pre-implementation lifecycle:

0. **Issue source** — resolve the idea from a raw description, a referenced tracker
   issue (`/wspec-capture` output), or an offered pick from the open captured backlog
1. **Explore & Research** — understand the idea, scan the codebase, gather prior art and external references
2. **Clarify** — ask 3-5 high-impact questions, one at a time
3. **Branch** — compute and create `feat/NNN-name`, confirm with user
4. **Generate** — write all change artifacts in one pass (including `research.md`), then
   **red-team** the spec for boundary/edge cases before any code (Phase 4.55)
5. **Commit prompt** — offer to commit the packet, then link the branch back to the
   source issue if one was used

---

## Phase 0: Issue source

Resolve `<FEATURE_DESCRIPTION>` and `<ISSUE_NUMBER>` before Phase 1 — used everywhere
below in place of "the original user description" / `$ARGUMENTS`.

1. **`$ARGUMENTS` has an issue reference** (`#42`, bare `42`, or an issue URL like
   `.../issues/42` or `.../-/issues/42`) → call MCP tool `wspec.getIssue` with
   `{ "number": <n> }`. Set `<ISSUE_NUMBER>` = `n`, `<FEATURE_DESCRIPTION>` = the
   issue's `title` + `body`; fold any remaining `$ARGUMENTS` text in as extra context.
2. **No reference, `$ARGUMENTS` non-empty** → `<ISSUE_NUMBER>` unset,
   `<FEATURE_DESCRIPTION>` = `$ARGUMENTS` verbatim (original free-text behavior).
3. **`$ARGUMENTS` empty** → read `capture_label` from `wspec/config.yaml`, call MCP tool
   `wspec.listIssues` with `{ "label": "<capture_label>", "state": "open" }`.
   - No results → **AskUserQuestion**: "What do you want to build or change? Describe
     the idea." `<ISSUE_NUMBER>` unset, `<FEATURE_DESCRIPTION>` = the answer.
   - One or more → **AskUserQuestion** offering each issue title plus a "Describe a new
     idea" option. Picking an issue resolves exactly like case 1 (`wspec.getIssue`,
     set both vars); picking "new idea" asks directly and leaves `<ISSUE_NUMBER>` unset.

---

## Phase 1: Explore & Research

### 1.1 Load minimal context

Read only these (small) files directly:

- `wspec/config.yaml` — project context, rules, settings
- `wspec/principles.md` — project principles (if non-empty/ratified)
- `wspec/state.json` — changes already in flight (a single read; avoid proposing a duplicate of an active change)
- `/memories/repo/wspec-notes.md` — prior implementation lessons (if available)

If `wspec/principles.md` is still placeholder-only, recommend running `/wspec-principles`
before or after proposal generation. If repo memory exists, reuse relevant lessons
(tooling constraints, pitfalls, conventions) during clarify and artifact generation.

Run MCP tool `wspec.repoScan` at the end of this step and keep the result as shared
context for all subsequent phases, anchoring stack/testing/security assumptions.

`<FEATURE_DESCRIPTION>` is already resolved from Phase 0 — do not re-ask for the idea here.

### 1.2 Ask for reference URLs

Ask the user (via **AskUserQuestion**):
> "Any reference URLs to incorporate (docs, RFCs, prior discussions)? Paste a list, or say 'skip'."

Collect any URLs as `<REFERENCE_URLS>` for use in 1.3 and Phase 4.0. If the user skips,
set `<REFERENCE_URLS>` to empty.

### 1.3 Delegate research fan-out

**Do not** scan `wspec/specs/` or the source tree from this agent directly. Dispatch the
`wspec-researcher` subagent (model: haiku) in parallel, once per angle below, covering the
full research surface, then merge their briefs into a single research dossier:

1. Internal prior art
  > "Read-only research for a new wSpec change. The user wants: <restate idea>.
  > Return concise findings on: (a) related capability specs in `wspec/specs/`,
  > (b) relevant archived changes in `wspec/archive/`, (c) implementation patterns
  > and conventions in the repo. Cite file paths. Note likely overlap and conflicts."

2. Risks, constraints, and edge cases
  > "Read-only risk scan for this idea. Return concrete technical and workflow blockers,
  > security/privacy concerns, edge cases, and where they appear. Include confidence per risk."

3. Testing and conventions
  > "Read-only scan for test patterns, validation style, naming conventions, and repo
  > constraints relevant to this idea. Return concise implementation guidance."

If `<REFERENCE_URLS>` is non-empty, also fetch and summarize each URL — do not browse
arbitrary sites beyond what the user provided.

Pass the `wspec.repoScan` summary and any `gaps[]` into each subagent prompt (so
subagents focus on unresolved evidence, not solved signals) and treat `repoScan` as
baseline truth for repo-level signals — unresolved `gaps[]` become Phase 2 clarification
candidates.

Use the merged brief as your thinking input AND as the source for `research.md` in
Phase 4.0. ASCII diagrams are still welcome in your response to the user.

**Do NOT generate artifacts yet.** This is thinking time.

---

## Phase 2: Clarify

Generate a prioritized queue of 3–5 candidate clarification questions.
Ask **one question at a time** using the **AskUserQuestion** tool.

**High-impact criteria** — only ask if the answer materially affects:
- Architecture or data model choices
- Security or privacy posture
- Feature scope or user experience
- Operational requirements (performance, availability, compliance)

**Question format**:
- For multiple-choice: present your **Recommended** option with brief reasoning, then list all options in a table
- For open-ended: offer a **Suggested** answer with brief reasoning

**Mechanics**:
- If user says "yes", "recommended", or "suggested" → use your stated recommendation
- Stop early if all critical ambiguities are resolved before reaching 5 questions
- Stop if user says "skip", "good", "done", or similar

---

## Phase 3: Branch

### 3.1 Compute next number (dry run)

Call MCP tool:

`wspec.createFeatureBranch`

Arguments:
- `featureDescription`: `<FEATURE_DESCRIPTION>` from Phase 0
- `shortName`: optional 2-4 word kebab slug
- `dryRun`: `true`

Parse JSON output: `BRANCH_NAME`, `CHANGE_ID`, `FEATURE_NUM`.

`<short-name>`: 2-4 word kebab slug derived from the feature (e.g., `user-auth`, `payment-retry`).
`<feature description>`: `<FEATURE_DESCRIPTION>` from Phase 0.

### 3.2 Confirm with user

Ask (via **AskUserQuestion**):
> "Ready to create branch `feat/NNN-name` and change packet at `wspec/changes/NNN-name/`?"
> Options: "Create it", "Use a different name"

If user wants a different name, ask for their preferred short name and recompute with that `ShortName`.

### 3.3 Create branch

Call MCP tool `wspec.createFeatureBranch` again with the same arguments and `dryRun: false`.

---

## Phase 4: Generate Artifacts

Create the directory: `wspec/changes/<CHANGE_ID>/`.

The templates at `wspec/templates/*.md` describe the canonical structure. Open a template
on demand if you are unsure of a section heading or order; otherwise the field checklists
below are sufficient.

Generate artifacts in sequence.

### 4.0 `research.md`

Write the merged research dossier from Phase 1.3 to `wspec/changes/<CHANGE_ID>/research.md`
(see `wspec/templates/research-template.md` if uncertain of section headings/order). Fill
Scope, Internal Prior Art (cite paths in `wspec/specs/`, `wspec/archive/`, source tree),
External References (summarize `<REFERENCE_URLS>`, or "None provided"), Constraints and
Risks, Recommendation, and Open Questions (candidates for Phase 2 clarification or
`[NEEDS CLARIFICATION]` markers). Keep it concise and citable — this is the durable
discovery-context source for `design.md` and downstream phases.

### 4.1 `metadata.yaml`

Copy `wspec/templates/metadata-template.yaml`, fill:
- `id`: FEATURE_NUM (e.g., `"001"`)
- `name`: the kebab change id (e.g., `"user-auth"`)  — just the short name, not the NNN prefix
- `title`: human-readable title
- `status`: `"drafting"`
- `branch`: full branch name
- `capability`: domain name if identifiable (e.g., `auth`, `payments`, `search`); leave empty if unclear
- `issue`: `<ISSUE_NUMBER>` from Phase 0 if set, else leave empty. Written as a quoted
  string (`issue: "42"`, matching the template's scalar convention) — `/wspec-finalize`
  reads it and parses it as an integer before calling `wspec.closeIssue`.
- `created` / `updated`: today's date in ISO format

### 4.2 `proposal.md`

Fill (see `wspec/templates/proposal-template.md` if uncertain):
- **Summary**: 1-3 sentences of what and why
- **Problem**: concrete description of the gap or pain
- **Proposed Solution**: high-level outcome, not technical spec
- **Non-Goals**: explicit out-of-scope items surfaced during Explore/Clarify
- **Success Criteria**: measurable outcomes
- **Risks & Open Questions**: anything that remains unresolved

Second-system check: if `research.md` or `wspec/archive/` reveals a prior attempt at this
idea, add a **Scope Risk** note to the Non-Goals section naming what the prior version
over-built and what must explicitly stay out of scope this time.

### 4.3 `spec.md`

Fill (see `wspec/templates/spec-template.md` if uncertain):
- **User Scenarios**: 1+ scenarios with priorities (P1, P2, P3...), acceptance criteria, and independent tests
- **Edge Cases**: boundary conditions and error scenarios
- **Functional Requirements**: FR-001, FR-002, ... (testable, unambiguous)
- **Key Entities**: if data is involved
- **Success Criteria**: SC-001, SC-002, ... (measurable, technology-agnostic)
- **Assumptions**: documented defaults and out-of-scope decisions
- **Clarifications**: Q → A pairs from Phase 2

Maximum 3 `[NEEDS CLARIFICATION: ...]` markers. Prioritize by impact: scope > security > UX > technical.

### 4.4 `design.md`

Fill (see `wspec/templates/design-template.md` if uncertain):
- **Technical Context**: language, deps, storage, testing, platform, constraints
- **Architecture**: component diagram or description
- **Data Model**: entities, attributes, relationships, state transitions
- **Interface Contracts**: public APIs, CLI schemas, events — skip if purely internal
- **Key Decisions**: decision table with rationale and alternatives
- **Research Notes**: cite findings from `research.md` (Phase 4.0); cover any NEEDS CLARIFICATION items from spec.md
- **File / Module Structure**: directory tree for affected files
- **Principles Check**: verify each principle is satisfied or document justified exceptions

### 4.5 `tasks.md`

Fill (see `wspec/templates/tasks-template.md` if uncertain):
- **Phase 1 (Setup)**: project initialization tasks
- **Phase 2 (Foundational)**: blocking prerequisites for all scenarios
- **Phase 3+ (Scenarios)**: one phase per scenario, in priority order
- **Final Phase (Polish)**: cross-cutting improvements
- Each task: `- [ ] T### [P?] [US#?] [size?] [test-level?] Description — file/path/hint`
  - Size: S (< 1 hr), M (half-day), L (full day), XL (multi-day) — optional but encouraged
  - Test level for test tasks: `unit`, `intg`, or `e2e`
  - Add a `Seam:` note on the next line for any task modifying untested existing code
- Every phase ends with a Validation Checkpoint (pre-written in the template)
- After listing all tasks, add a rough effort comment at the top of each phase:
  `<!-- Phase estimate: ~N hours -->`

### 4.55 Adversarial Analysis → `analysis.md`

Delegate a single pass to the `wspec-analyst` subagent (model: opus, the strongest available,
since a weak model here produces false confidence) so the main context stays lean; its own
definition already carries the attack techniques, detection passes, severity/scoping rules, and
output structure, so do not restate them here. It first adversarially attacks the not-yet-
implemented spec so edge cases surface before any code is generated, then runs the cross-artifact
scan — its reasoning must NOT pollute the main context. Dispatch it with the paths:

> "Read-only adversarial and cross-artifact analysis for change `<CHANGE_ID>`. Paths:
> - wspec/changes/<CHANGE_ID>/research.md
> - wspec/changes/<CHANGE_ID>/proposal.md
> - wspec/changes/<CHANGE_ID>/spec.md
> - wspec/changes/<CHANGE_ID>/design.md
> - wspec/changes/<CHANGE_ID>/tasks.md
> - wspec/principles.md"

Then, in the main agent (do **not** re-summarize or argue with the payload):

1. Append the `edge-cases` bullets **verbatim** under the **Edge Cases** section of `spec.md`.
2. Write the remaining markdown verbatim to `analysis.md`. Its findings already include the
   `Adversarial`/`Boundary`/`Security` categories from the attack pass — CRITICAL/HIGH findings
   **block** `/wspec-implement` and the git gates until resolved or explicitly overridden.

This keeps the adversarial reasoning in the disposable subagent context; only the compact,
schema-shaped artifacts cross back.

Then call MCP tool `wspec.validateAnalysis` with `{ "id": "<CHANGE_ID>" }` to confirm the
machine-readable YAML block is schema-valid (categories, id pattern, required fields). If `valid`
is `false`, feed the `issues[]` back to the analyst subagent for one correction pass before
proceeding — do not hand-patch the YAML yourself, since that risks drifting the Findings table
out of sync with it.

---

## Phase 5: Commit Prompt

Show a brief summary:
```
✓ wspec/changes/<CHANGE_ID>/
  metadata.yaml
  research.md
  proposal.md
  spec.md
  design.md
  tasks.md
  analysis.md
```

Ask (via **AskUserQuestion**):
> "Commit this change packet?"
> Options: "Yes — commit", "No — skip for now"

If committing, run:
```bash
git add wspec/changes/<CHANGE_ID>/
git commit -m "feat(<CHANGE_ID>): add change packet"
```

### 5.1 Link back to the source issue

If `<ISSUE_NUMBER>` is set (Phase 0), call MCP tool `wspec.commentIssue` with:
```
{ "number": <ISSUE_NUMBER>, "body": "Proposed as `<CHANGE_ID>` on branch `<BRANCH_NAME>` — packet at wspec/changes/<CHANGE_ID>/." }
```
This runs regardless of whether the user chose to commit the packet — the branch already
exists at this point (Phase 3.3), so the issue comment is accurate either way. If the
comment call fails (e.g. `gh`/`glab` not authed), surface the error but do not block the
rest of the output — the change packet itself is already complete.

---

## Output

After completing all phases, show:

```
## Change Ready

**Change**: <CHANGE_ID>
**Branch**: feat/<CHANGE_ID>
**Packet**: wspec/changes/<CHANGE_ID>/
**Source issue**: <#ISSUE_NUMBER (linked) | none>

Artifacts created:
  research.md   — prior art, references, risks, recommendation
  proposal.md   — what & why
  spec.md       — requirements & scenarios
  design.md     — technical approach
  tasks.md      — implementation phases
  analysis.md   — cross-artifact quality check

Analysis status: <pass | warnings | issues>
<list any CRITICAL or HIGH findings if present>

Run /wspec-implement to start building.
```

---

## Guardrails

- **Do NOT implement** — no source code changes, no file edits outside `wspec/changes/<CHANGE_ID>/`.
  The `hook:guard-edit` PreToolUse hook enforces this while the change is `status: drafting`
  (warns and blocks, overridable via `WSPEC_OVERRIDE_REASON` for a legitimate side-quest) — but
  do not rely on the hook alone; respect this guardrail directly.
- **Do NOT skip clarification** unless the user explicitly says to skip it
- **Do NOT create the branch** without user confirmation
- **Do NOT auto-commit** — always prompt first
- Read every artifact template before filling it; do not invent a different structure
- If a change with the same name already exists, ask: continue it or start fresh?
- Verify each artifact file was written before proceeding to the next
