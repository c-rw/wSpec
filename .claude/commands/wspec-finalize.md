# wSpec Finalize

## User Input

```text
$ARGUMENTS
```

---

## Overview

`/wspec-finalize` closes out a wSpec change after implementation:

1. **Validate** — check that tasks and artifacts are complete
2. **Sync** — merge delta specs from the change into `wspec/specs/<capability>/`
3. **Archive** — move the change folder to `wspec/archive/YYYY-MM-DD-<CHANGE_ID>/`. If a
   ticket is linked, this automatically posts the final body render, an `archived`
   comment, and closes it — no separate step needed (see Step 4.6, which now only
   handles the warnings follow-up).
4. **Commit** — single commit that captures the sync + archive together
5. **Post-archive** — optionally open a PR or merge to the default branch (config-driven)

---

## Step 0: Re-hydrate

Read `wspec/state.json` first — a single read that recovers in-flight context cheaply (active
change(s), status, current phase, and open blocking findings) without re-walking the filesystem.
If it is missing or `wspec.verifyState` reports it stale, run MCP tool `wspec.syncState`. Treat it
as a fast index, not the source of truth — the change packet files remain authoritative.

---

## Step 1: Select Change

Run MCP tool `wspec.status`.

- If `$ARGUMENTS` names a change, use it.
- Else if exactly one entry exists with `status` of `ready` or `implementing`, auto-select and announce.
- Else use **AskUserQuestion** to pick from the list.
- If `changes` is empty, error: "No active changes found. Run /wspec-propose first."

The entry already includes `branch`, `status`, `tasks` totals, `artifacts` map, `analysis`
health, and `delta_specs` — use this directly instead of opening `metadata.yaml`.

---

## Step 2: Validate Completion

The status entry already exposes:
- `tasks.total` vs `tasks.done` — incomplete count is `total - done`
- `artifacts.<name>: true|false` — missing artifacts
- `analysis.critical` and `analysis.unresolved_ids`

For a per-finding severity breakdown of unresolved items, run:

MCP tool `wspec.loadChange` with `{ "id": "<CHANGE_ID>" }`.

Maintain a running `<FINALIZE_WARNINGS>` list (plain strings) across this whole step —
every "archive anyway" confirmation below appends one entry. It travels into the
ticket's final render in Step 4 as a permanent record of what was overridden to ship.

### 2a. Task completion

If `tasks.done < tasks.total`:
- Show: "⚠ <N> tasks are not marked complete in tasks.md" (where N = total - done)
- Ask via **AskUserQuestion**: "Continue with incomplete tasks?" → "Yes, archive anyway" / "No, go back"
- Proceed only on confirmation. On confirmation, append `"Archived with <N> incomplete
  tasks"` to `<FINALIZE_WARNINGS>`.

### 2b. Artifact completeness

For any artifact whose value is `false`, warn the user (do not block).

### 2c. Analysis status

If `analysis.critical > 0`:
- Show the unresolved CRITICAL IDs.
- Ask: "Archive with unresolved critical findings?" → "Yes, archive anyway" / "No, go back".
- On confirmation, append `"Archived with unresolved critical findings (user
  confirmed)"` to `<FINALIZE_WARNINGS>`.

### 2d. Full re-validation

The summary counts above are a fast index, not a re-check — a phase could have been marked done
without ever passing `wspec.validatePhase` (e.g. after a manual `tasks.md` edit). Run MCP tool
`wspec.validateAll` with `{ "id": "<CHANGE_ID>" }` to re-run every phase's validation plus a
manual gate check in one call.

If `status` is `fail` or `warn`:
- Show the failing/warning phase(s) and their `blocking_findings`.
- Ask via **AskUserQuestion**: "Archive despite failed re-validation?" → "Yes, archive anyway" /
  "No, go back and fix"
- Proceed only on confirmation. On confirmation, append `"Archived despite failed
  re-validation (<status>)"` to `<FINALIZE_WARNINGS>`.

---

## Step 3: Sync Delta Specs

Run MCP tool `wspec.syncSpec` with `{ "id": "<CHANGE_ID>", "apply": false }`.

If `has_deltas` is `false`, skip this step entirely.

Otherwise, for each entry in `capabilities`:
- Show a short summary: `name`, `target_exists`, counts of `added_sections` / `removed_sections` /
  `modified_sections` (with the heading names).
- Ask (via **AskUserQuestion**):
  - If `in_sync` is `false`: "Sync `<name>` spec now (recommended)?" → "Sync now", "Archive without syncing"
  - If `in_sync` is `true`: "Spec appears up to date. Archive now?"

If the user chooses to sync, run MCP tool `wspec.syncSpec` with
`{ "id": "<CHANGE_ID>", "apply": true }`.

Verify `applied: true` and `error: null` for the requested capability before announcing success.

---

## Step 4: Archive

Dry-run first with MCP tool `wspec.archive` using `{ "id": "<CHANGE_ID>", "dryRun": true }`
to compute the target and check for collision.

If `target_exists: true`, error: "Archive target already exists: `<target>`". Suggest renaming the
existing archive or waiting until a different date. **Do not** attempt the move.

Otherwise perform the move using MCP tool `wspec.archive` with
`{ "id": "<CHANGE_ID>", "dryRun": false }`.

Verify `moved: true` and `error: null`. The script uses `git mv` when the workspace is a git repo
(so the move is recorded as a rename) and falls back to a plain filesystem move otherwise. It also
updates `metadata.yaml` (`status: done`, `updated: <today>`, `completed: <today>`) inside the
archive folder — do not duplicate that work.

If a ticket is linked (`metadata.yaml` had an `issue:`), `wspec.archive` itself already
triggered the final ticket sync: full body re-render (all phases checked, completed
date, elapsed days, archive path, total spend), an `archived` comment, and closing the
ticket (if `ticket.close_on_finalize` is enabled, the default). Nothing further to do
here for that — **except** the warnings list:

If `<FINALIZE_WARNINGS>` (Step 2) is non-empty, call MCP tool `wspec.syncTicket` with
`{ "id": "<CHANGE_ID>", "warnings": <FINALIZE_WARNINGS> }` so they land in the ticket's
final body under its Notes section — the automatic sync above ran before you had this
list. If the call reports `skipped: true`, that just means there's no linked ticket;
ignore it and continue.

---

## Step 4.5: Compute effort/cost and elapsed time

Read `created` from `wspec/archive/<target>/metadata.yaml` (the archived copy). `updated` was
just set to today by the archive script in Step 4 — use that as the finalized date.

Call MCP tool `wspec.usageReport` with `{ "id": "<CHANGE_ID>" }` (the archive step already
folded this change's `usage.json` into `wspec/usage-log.jsonl` via `wspec.archive`, so this
call reads back that same rollup). Keep the result in memory — it's reused in Step 4.6 and
Step 7, not recomputed.

If `segment_count: 0` (no `Stop` hook ever recorded usage for this change — e.g. usage
tracking wasn't wired up when the change started), there's no Effort/Cost figure to report;
omit it in both Step 4.6 and Step 7 rather than showing zeros.

---

## Step 4.6: Ticket warnings follow-up

Handled above, inline with Step 4 — this step exists only as a heading for continuity
with the change history. If you skipped straight from Step 4 to Step 5, you didn't miss
anything: there was no `<FINALIZE_WARNINGS>` to attach.

---

## Step 5: Commit Prompt

This is the **single** commit that captures everything finalize did: spec sync (Step 3), the
archive move (Step 4), any leftover `status: ready` bookkeeping from `/wspec-implement`, and the
`status: done` flip the archive script just applied. Doing it last guarantees the archive rename
is included.

Suggest a commit message:
```
feat(<CHANGE_ID>): finalize change — <title>
```

Ask (via **AskUserQuestion**): "Commit finalization?" → "Yes — commit", "No — skip"

If committing:
```bash
git add -A wspec/
git commit -m "feat(<CHANGE_ID>): finalize change — <title>"
```

Use `git add -A` (not `git add`) so the archive delete-and-add pair is staged together and git
records it as a rename.

If the pending-phases list from `/wspec-implement` has more than one entry (i.e., the user
skipped phase commits and all real code changes are unstaged), ask via **AskUserQuestion**
before committing:
> "The branch has uncommitted code from multiple phases. Commit history strategy?"
> Options: "Squash all into one semantic commit", "Commit phase-by-phase (preserves history)"

- On squash: stage everything with `git add -A` and create one commit with the finalize message above.
- On phase-by-phase: commit one entry per pending phase first using
  `feat(<CHANGE_ID>): complete phase N — <title>`, then commit the finalize artifacts.

---

## Step 6: Post-archive action

Read `wspec/config.yaml` for `post_archive_action` (flat top-level key).
Accepted values: `none` (default), `ask`, `pr`, `merge`. Treat missing/unknown as `none`.

- If `none`: skip this step entirely.
- If `ask`: use **AskUserQuestion** to offer:
  > "Open a pull request, merge locally, or skip?" → "Open PR", "Merge locally", "Skip"
  - "Skip" → skip this step entirely.
  - "Open PR" → resolved action is `pr`.
  - "Merge locally" → resolved action is `merge`. Then ask two follow-ups:
    > "Delete local branch after merge?" → "Delete", "Keep"
    > "Push `<default>` after merge?" → "Push", "Skip"
- If `pr` or `merge` from config: use it directly. For `merge`, also ask the two follow-ups above plus:
  > "Squash all commits on this branch before merging?" → "Squash (clean history)", "Merge as-is (preserve commits)"
  Use `git merge --squash` for squash mode, `git merge --ff-only` (or `--no-ff`) for as-is.

Then call MCP tool `wspec.postArchive` with:

- `id`: `<CHANGE_ID>`
- `action`: `pr` or `merge`
- `deleteBranch`: optional (merge only)
- `push`: optional (merge only)
- `defaultBranch`: optional
- `title`: optional
- `dryRun`: optional
- `forge`: optional (`github` or `gitlab`) — only needed to override auto-detection from the
  `origin` remote or the `forge` key in `wspec/config.yaml`

The script returns a JSON object with `action`, `branch`, `default_branch`, `forge`, `pr_url`,
`merged`, `pushed_branch`, `pushed_default`, `branch_deleted`, `skipped_reason`, and `error`. If
`error` is non-null, exit code is `2` — surface the message and continue to Step 7 with the
action marked as failed.

For PR mode: `forge` tells you which CLI was used (`github` → `gh pr create`, `gitlab` → `glab mr
create`) — say "PR" or "MR" accordingly when reporting the result. If the helper reports gh/glab
isn't installed/authed (in `error`), offer **AskUserQuestion**: "Fall back to local merge or
skip?" and re-invoke if appropriate.

If `pr_url` is non-null, `wspec.postArchive` already persisted it to the archived
`metadata.yaml`. Call MCP tool `wspec.syncTicket` with `{ "id": "<CHANGE_ID>" }` (no
`event` — the ticket already closed in Step 4, this just re-renders the body once more
so the merge-request link appears in it). Skip this call entirely if `pr_url` is null.

---

## Step 7: Output

Reuse the `wspec.usageReport` result and `created`/`updated` dates gathered in Step 4.5 —
do not call `wspec.usageReport` again. Omit the Effort/Cost line if `segment_count: 0`.

```
## ✓ Change Archived

**Change**:  <CHANGE_ID>
**Branch**:  feat/<CHANGE_ID>
**Archived**: wspec/archive/YYYY-MM-DD-<CHANGE_ID>/
**Specs**:   <synced to wspec/specs/<capability>/ | no delta specs | sync skipped>
**Branch action**: <PR/MR opened: <url> | merged into <default> (pushed|local only) | skipped | not configured>
**Ticket**: <#N closed — url | no linked ticket>
**Effort/Cost**: <total tokens> tokens · ~$<cost_usd, 2dp> (<segment_count> command runs — see wspec/usage-log.jsonl)

<If warnings>
**Warnings**:
- Archived with N incomplete tasks
- Archived with unresolved critical findings (user confirmed)
- Delta spec sync skipped (user chose to skip)
- Post-archive action skipped: <reason>
```

## Step 8: Memory Update

Append 1-3 concise lessons learned to `/memories/repo/wspec-notes.md` when available.
Only include durable, repo-relevant notes (for example: tooling gotchas, validation
pitfalls, install quirks). Do not add temporary task details.

---

## Guardrails

- **Never auto-archive** without user confirmation on incomplete tasks or critical findings
- **Never auto-commit** — always prompt first
- **Never delete** the change folder — always move, never remove
- **Do not proceed** if the archive target already exists — prevent data loss
- **Never auto-resolve a merge conflict** — abort and report
- **Never force-push** as part of the post-archive action
- Show the full diff summary before asking about spec sync; never silently sync
- If sync is requested, verify the target file was written before announcing success
