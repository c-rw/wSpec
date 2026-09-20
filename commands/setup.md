---
description: Set up wSpec in this project — installs the templates, git hooks, and permissions a plugin can't ship
model: inherit
effort: low
allowed-tools: Read, AskUserQuestion
---

# wSpec Setup

## User Input

```text
$ARGUMENTS
```

---

## Overview

A Claude Code plugin ships commands, agents, hooks, and the MCP server, but a few things have to
live in the project itself. `/wspec:setup` installs them through the `wspec.setup` MCP tool:

- `wspec/templates`, `wspec/schemas`, `wspec/README.md` — read by relative path from the commands
- `wspec/scripts/hooks` plus `core.hooksPath` — git runs hooks directly and has no notion of a plugin
- `.gitignore` entries for wSpec's generated and machine-local files
- read-only `permissions.allow` entries in `.claude/settings.json`
- seed files: `wspec/config.yaml`, `wspec/principles.md`, and empty `wspec/changes|specs|archive`

It is safe to run again. Run it after updating the plugin too: the git hooks find the plugin by an
absolute path that changes when the plugin moves or updates, and setup refreshes it.

It never overwrites `wspec/config.yaml`, `wspec/principles.md`, or anything under `changes/`,
`specs/`, `archive/`. Files it mirrors from the plugin (`wspec/templates`, `wspec/schemas`,
`wspec/scripts/hooks`) are overwritten to match the plugin, so local edits to those are lost.

**Never run `git commit` or `git push`** — leave the resulting changes for the user to review.

## Step 1 — Preview

Call `wspec.setup` with `{}`. With no arguments it only reports what it would do and writes nothing.

- If it fails with "Refusing to run setup inside the wSpec plugin itself", the session is running
  inside the wSpec checkout. Tell the user to run `/wspec:setup` from the project they want to use
  wSpec in, and stop.

## Step 2 — Show the plan

Summarize the result for the user. Group by action and hide the `unchanged` entries behind their
count:

- **add** — new files, entries, or settings
- **update** — existing files that differ. If a note says the file "differs from the plugin's copy",
  say plainly that the user's local edits to it will be overwritten.
- **remove** — files that are no longer part of wSpec
- **skip** — left alone on purpose. Quote the note, especially for `git core.hooksPath`: if it was
  already set to something else, wSpec never overrides it.
- **error** — something that could not be done, e.g. an unparsable `.claude/settings.json`, which
  setup leaves untouched. Explain how to fix it and say a re-run will pick it up.

Also relay anything in `notes`.

If every action is `unchanged` or `skip`, tell the user this project is already set up and stop.

## Step 3 — Ask about the two optional extras

Use `AskUserQuestion` — only for the extras the preview would actually change:

1. **Git hooks** (only if `git core.hooksPath` is an `add`): wire the pre-commit, commit-msg, and
   pre-push checks so blocking findings are caught at commit and push time. Sets `core.hooksPath`
   for this repository. Recommended.
2. **Permissions** (only if `.claude/settings.json` is an `add` or `update`): add the read-only
   wSpec tools and `git status`/`git diff` to `permissions.allow` so they don't prompt, set
   `subagentPromptCacheTtl: 1h`, and remove stale entries older wSpec versions wrote. Other keys are
   never touched. Recommended.

Offer "Yes (Recommended)" and "No" for each.

## Step 4 — Apply

Call `wspec.setup` with `{ "apply": true, "hooks": <answer>, "settings": <answer> }`. Claude Code
will ask the user to approve this call — that is expected, because it writes files, edits
`.claude/settings.json`, and can change git config.

## Step 5 — Verify and report

Call `wspec.doctor` and report any `fail` (and any `warn` that setup could have caused). Then tell
the user:

- what was added, updated, and removed, as counts
- if `.claude/settings.json` changed: restart Claude Code for the new permissions to take effect
- that `wspec/`, `.gitignore`, and `.claude/settings.json` changes are uncommitted and theirs to review
- the next step: `/wspec:principles` to fill in `wspec/principles.md`, then `/wspec:propose`
