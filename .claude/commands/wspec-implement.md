# wSpec Implement

## User Input

```text
$ARGUMENTS
```

---

## Overview

`/wspec-implement` executes the task phases from `tasks.md` and validates correctness at each phase boundary before moving on.

**Validation stack per phase**:
1. **Spec requirements** — FRs and SCs addressed by the phase are implemented and testable
2. **Analysis findings** — CRITICAL and HIGH findings from `analysis.md` relevant to the phase are resolved or explicitly deferred
3. **Project principles** — No MUST statements from `wspec/principles.md` are violated

---

## Step 0: Re-hydrate

Read `wspec/state.json` first — a single read that recovers in-flight context cheaply (active
change(s), current phase, pending task ids, and open blocking findings) without re-walking the
filesystem. This lets a fresh terminal or a post-compaction context resume exactly where the last
session stopped, with zero drift. If `state.json` is missing or `wspec.verifyState` reports it
stale, run MCP tool `wspec.syncState` to regenerate it. Treat it as a fast index, not the source
of truth — the change packet files remain authoritative.

---

## Step 1: Select Change

Run MCP tool `wspec.status` to enumerate active changes (single call, JSON).

- If `$ARGUMENTS` names a change, use it.
- Else if exactly one entry is returned, auto-select and announce: "Using change: `<CHANGE_ID>`".
- Else use **AskUserQuestion** to let the user pick from the list.
- If `changes` is empty, error: "No active changes found. Run /wspec-propose first."

---

## Step 2: Load Context

Run MCP tool `wspec.loadChange` once with `{ "id": "<CHANGE_ID>" }`.

Read `wspec/config.yaml` and extract `implement_phase_commits`.

- Allowed values: `ask` (default), `auto`
- If the key is missing or invalid, treat it as `ask`
- This setting only affects phases that produced real code changes after validation passes
- Never create a commit for bookkeeping alone (`tasks.md` / `metadata.yaml` only)

Read `/memories/repo/wspec-notes.md` if available and carry forward any relevant
implementation constraints or known pitfalls.

This returns: branch info, `branch_matches`, phase list with progress, the **next pending phase**
with its pending tasks, **only the unresolved findings that affect the next phase**, the analysis
health summary, the principles MUST/MUST NOT list, and the artifact presence map.

Do **NOT** read `proposal.md`, `spec.md`, `design.md`, or full `analysis.md` into context at this
step. Open them on demand only when a specific task needs deeper rationale.

If `branch_matches` is `false`, warn the user and ask whether to continue.

Set the change status to `implementing` with MCP tool `wspec.setStatus` using
`{ "id": "<CHANGE_ID>", "status": "implementing" }`.

---

## Step 3: Show Progress

Display:
```
## wSpec Implement — <CHANGE_ID>

Branch:  feat/<NNN-name>
Status:  <N>/<M> tasks complete

Remaining phases:
  Phase X: [title] — N tasks
  Phase Y: [title] — N tasks
  ...
```

If 3 or more phases remain and native plan mode is available in this session, consider entering
it here to present this phase breakdown as a formal plan and get explicit approval (ExitPlanMode)
before starting Step 4. This is a pilot, not a requirement: for a single remaining phase, or when
already mid-implementation on a prior approval, proceed straight to Step 4 without it. Plan mode
governs the whole turn (no Edit/Write until exited), so use it once here, not per-phase — the
existing per-phase gate in 4c/4d is the ongoing checkpoint once execution starts.

---

## Step 4: Implement (Phase Loop)

For each phase in `tasks.md`:

### 4a. Announce phase

```
## Starting Phase N: [title]
```

### 4b. Execute tasks

For each pending task (`- [ ]`) in the phase:

- Announce: "Working on T###: [description]"
- If the task has a **Seam:** note and the target code has no existing tests: write a
  characterization test that captures current behavior through the named seam first, then
  change behavior. Do not modify existing behavior without a test in place.
- Make the code changes required (keep changes minimal and focused)
- Mark the task complete with MCP tool `wspec.markTask`:
  `{ "id": "<CHANGE_ID>", "taskId": "T###" }`
- Continue to the next task in the phase

**Pause the phase if**:
- A task is unclear → use **AskUserQuestion** to clarify, then continue
- Implementation reveals a design issue → report the conflict, suggest updating `design.md`, ask for direction
- An error or blocker is encountered → report it and wait for guidance
- User interrupts

### 4c. Phase Validation Gate

After **all tasks in the phase are complete**, run MCP tool `wspec.validatePhase` with
`{ "id": "<CHANGE_ID>", "phase": <phase_num> }`.

The script returns:
- `status`: `pass` / `warn` / `fail`
- `incomplete_tasks`: deterministic blockers
- `blocking_findings`: unresolved CRITICAL/HIGH findings that target this phase
- `principles_musts_to_check`: the MUSTs the LLM must judge against the code changed in this phase

**Decision table**:

| Script `status` | Action |
| --- | --- |
| `pass` (+ LLM judges no MUST violation) | Announce `✓ Phase N validation passed` and proceed. |
| `warn` (HIGH findings present) | STOP. Present the report. Proceed only if user explicitly defers each finding. |
| `fail` | STOP. Present the report. Do not proceed. |

**Principles judgment** (LLM-only step): for each entry in `principles_musts_to_check`, verify the
code changes in this phase do not violate it. Flag any violation in the report.

**On STOP**, output:

```
## ⚠ Phase N Validation Failed

### Unmet Requirements / Incomplete Tasks
- T010: [description]

### Unresolved Analysis Findings
- A1 (HIGH): [summary] — wspec/changes/<CHANGE_ID>/analysis.md

### Principles Violations
- [MUST statement]: [why the diff violates it]

**Options**:
1. Fix the issues and re-validate
2. Defer a finding: update analysis.md marking it resolved with a reason
3. Update the spec or design to reflect a scope change
4. Override (explain why the finding does not apply here)
```

Wait for the user's direction before continuing.

### 4d. Validator subagent fan-out

After deterministic validation passes, dispatch the `wspec-phase-validator` subagent (model:
sonnet) as a focused judgment pass for the current phase; its own definition already carries the
diff-review approach and return contract, so do not restate them here:

> "Validate Phase <N> for change <CHANGE_ID>. Unresolved findings affecting this phase:
> <paste `blocking_findings` from wspec.validatePhase>. Principles MUSTs to check:
> <paste `principles_musts_to_check`>."

If the validator returns `warn` or `fail`, stop and present the report before
continuing to the next phase.

### 4e. Phase commit prompt

After a successful phase validation, decide whether a commit is warranted by inspecting the working tree.

Maintain an internal **pending phases** list (titles + numbers) across the loop. It starts empty.

1. Check whether anything beyond bookkeeping changed in this phase:
   ```powershell
   git status --porcelain |
     Where-Object { $_ -notmatch '^\s*\S+\s+wspec/changes/<CHANGE_ID>/(tasks\.md|metadata\.yaml)$' }
   ```
   - **No lines** (only `tasks.md` / `metadata.yaml` changed under this change folder):
     append phase N to the pending list, continue to the next phase. **Do not prompt.
     Do not commit.** The next phase with real code, or Step 5, absorbs it.
   - **Any lines** (real code changed): go to step 2.

2. Respect `implement_phase_commits`:
   - `auto` → run the **commit-pending-phases procedure** below for phase N now.
   - `ask` → **AskUserQuestion**, default `skip`: "Commit phase N progress? [skip / commit]"
     - `commit` → run the procedure below for phase N.
     - `skip` → append phase N to the pending list, continue.

**Commit-pending-phases procedure** (referenced here and from Step 5): run
```bash
git add -A
git commit -m "feat(<CHANGE_ID>): complete <phase_range> — <phase_titles>"
```
where `<phase_range>` covers every entry in the pending list plus the phase(s) just
confirmed (e.g. `phases 2–5`, or just `phase 3`), and `<phase_titles>` lists their
titles separated by `; `. Then **clear the pending list**.

---

## Step 5: Completion

When all phases are complete (or all desired phases are done), run MCP tool `wspec.validateAll`
with `{ "id": "<CHANGE_ID>" }` as a final end-to-end confidence check (it re-runs
`wspec.validatePhase` across every phase plus a manual gate check in one call, catching anything
a skipped or out-of-order phase validation missed). If `status` is `fail`, stop and resolve the
reported phase(s) before continuing — do not set status to `ready` over a failing check.

Set status to `ready` via MCP tool `wspec.setStatus` (do **not** create a dedicated
commit for this flip — `/wspec-finalize` will fold it into the finalize commit):
`{ "id": "<CHANGE_ID>", "status": "ready" }`.

If the pending-phases list from Step 4d is non-empty, inspect the working tree again with the same filter from Step 4e.

- No real code changes remain → leave the pending bookkeeping for `/wspec-finalize`.
- Real code changes remain, `implement_phase_commits` is `auto` → run the
  commit-pending-phases procedure (Step 4e) now.
- Real code changes remain, `implement_phase_commits` is `ask` → prompt once more:
  > "Commit pending phases <range>? [commit / skip]"
  - `commit` → run the commit-pending-phases procedure (Step 4e).
  - `skip` → leave the staged bookkeeping for `/wspec-finalize` to roll into its commit.

Show summary:
```
## ✓ Implementation Complete — <CHANGE_ID>

All N tasks complete.
All phase validations passed.

Run /wspec-finalize to sync specs, commit, and archive.
```

---

## Guardrails

- **Never skip validation** — the gate runs after every phase, no exceptions
- **CRITICAL analysis findings block progress** — do not continue past a failed phase
- **Principles MUST violations block progress** — do not continue past a failed phase
- **Keep changes minimal** — implement only what the task describes; no scope creep
- **Never modify artifact files** except: `tasks.md` (marking tasks done) and `metadata.yaml` (updating status)
- **Only auto-commit when `implement_phase_commits: auto`** — otherwise always prompt first
- **Never commit bookkeeping alone** — if the only changes are `tasks.md` / `metadata.yaml` under the change folder, defer to the next real commit
- **Never make a standalone commit for the status flip** — it must ride along with another commit (last phase, or `/wspec-finalize`)
- If `tasks.md` has no pending tasks, congratulate and suggest `/wspec-finalize`
