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
3. **Archive** — move the change folder to `wspec/archive/YYYY-MM-DD-<CHANGE_ID>/`
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

### 2a. Task completion

If `tasks.done < tasks.total`:
- Show: "⚠ <N> tasks are not marked complete in tasks.md" (where N = total - done)
- Ask via **AskUserQuestion**: "Continue with incomplete tasks?" → "Yes, archive anyway" / "No, go back"
- Proceed only on confirmation.

### 2b. Artifact completeness

For any artifact whose value is `false`, warn the user (do not block).

### 2c. Analysis status

If `analysis.critical > 0`:
- Show the unresolved CRITICAL IDs.
- Ask: "Archive with unresolved critical findings?" → "Yes, archive anyway" / "No, go back".

### 2d. Full re-validation

The summary counts above are a fast index, not a re-check — a phase could have been marked done
without ever passing `wspec.validatePhase` (e.g. after a manual `tasks.md` edit). Run MCP tool
`wspec.validateAll` with `{ "id": "<CHANGE_ID>" }` to re-run every phase's validation plus a
manual gate check in one call.

If `status` is `fail` or `warn`:
- Show the failing/warning phase(s) and their `blocking_findings`.
- Ask via **AskUserQuestion**: "Archive despite failed re-validation?" → "Yes, archive anyway" /
  "No, go back and fix"
- Proceed only on confirmation.

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
updates `metadata.yaml` (`status: done`, `updated: <today>`) inside the archive folder — do not
duplicate that work.

---

## Step 4.5: Close linked issue

Read the `issue:` field directly from `wspec/archive/<target>/metadata.yaml` (the archived
copy, since the folder just moved in Step 4).

- **Empty or missing** → skip this step entirely; this change wasn't proposed from a
  `/wspec-capture` issue.
- **Set** → the field is a quoted string (`issue: "42"`); parse it as an integer, then
  call MCP tool `wspec.closeIssue` with:
  ```
  { "number": <parsed issue integer>, "comment": "Finalized as `<CHANGE_ID>` — archived at wspec/archive/<target>/." }
  ```
  If the call fails (e.g. `gh`/`glab` not authed, issue already closed), surface the error
  as a warning and continue — a failed issue-close must never block archiving, which has
  already succeeded by this point.

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

---

## Step 7: Output

After the archive completes, call MCP tool `wspec.usageReport` with `{ "id": "<CHANGE_ID>" }`
(the archive step already folded this change's `usage.json` into `wspec/usage-log.jsonl` via
`wspec.archive`, so this call reads back that same rollup). If it returns `segment_count: 0`
(no `Stop` hook ever recorded usage for this change — e.g. usage tracking wasn't wired up when
the change started), omit the Effort/Cost line rather than showing zeros.

```
## ✓ Change Archived

**Change**:  <CHANGE_ID>
**Branch**:  feat/<CHANGE_ID>
**Archived**: wspec/archive/YYYY-MM-DD-<CHANGE_ID>/
**Specs**:   <synced to wspec/specs/<capability>/ | no delta specs | sync skipped>
**Branch action**: <PR/MR opened: <url> | merged into <default> (pushed|local only) | skipped | not configured>
**Source issue**: <#N closed | no linked issue | close failed: <reason>>
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
