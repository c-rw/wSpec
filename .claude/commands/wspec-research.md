# wSpec Research

## User Input

```text
$ARGUMENTS
```

You **MUST** consider user input before proceeding.

---

## Overview

`/wspec-research` refreshes research for an existing change. Re-collects internal prior art,
optional external references, constraints, and recommendations, then overwrites
`wspec/changes/<id>/research.md`. Use mid-lifecycle when new questions surface
after the initial `/wspec-propose` run (which already produces `research.md`).

---

## Step 1: Resolve target change

1. Call MCP tool `wspec.status`.
2. If `$ARGUMENTS` contains a specific change id, use that.
3. Else if exactly one active change exists, select it.
4. Else ask the user to choose an active change id.
5. If no active changes exist, ask the user to run `/wspec-propose` first — propose
   produces the initial `research.md`; this command only refreshes an existing one.

Set `<CHANGE_ID>` to the selected change.

If `wspec/changes/<CHANGE_ID>/research.md` already exists, note that this run will
**overwrite** it. That is the intended behavior — this command is a refresh.

---

## Step 2: Gather internal prior art

Dispatch the `wspec-researcher` subagent (model: haiku) with a prompt like:

> "Read-only research for change `<CHANGE_ID>`. Cover internal prior art (related capability
> specs in `wspec/specs/`, relevant archived changes in `wspec/archive/`, implementation
> patterns/conventions in the repo) and risks/edge cases."

Also read these files directly if present:
- `wspec/changes/<CHANGE_ID>/proposal.md`
- `wspec/changes/<CHANGE_ID>/spec.md`
- `wspec/changes/<CHANGE_ID>/design.md`
- `/memories/repo/wspec-notes.md` (if available)

---

## Step 3: Gather external context (optional)

If the user provided URLs, fetch and summarize only those URLs.
Do not browse arbitrary sites unless the user asked for web research.

---

## Step 4: Write `research.md`

Create or overwrite `wspec/changes/<CHANGE_ID>/research.md` (see
`wspec/templates/research-template.md` if uncertain of section headings/order). Fill
Scope, Internal Prior Art, External References ("None provided" if none), Constraints
and Risks, Recommendation, and Open Questions. Keep it concise and actionable — avoid
long quotes.

---

## Step 5: Report summary

Return:
- where `research.md` was written
- 3-5 key takeaways
- whether `/wspec-implement` can proceed immediately or needs clarifications

If this refresh surfaced a concrete new risk that should gate implementation and
`wspec/changes/<CHANGE_ID>/analysis.md` already exists, offer to record it: MCP tool
`wspec.appendFindings` with `{ "id": "<CHANGE_ID>", "findings": [{ "category": ..., "severity":
..., "location": ..., "summary": ... }] }` merges it in deterministically (dedupe + renumber)
without needing a full `wspec-analyst` re-run. Ask the user before adding a CRITICAL/HIGH finding
this way, since it will start blocking gates immediately.

---

## Guardrails

- Read-only exploration except writing `research.md`
- No implementation changes
- No branch creation in this command
- If uncertainty remains, list explicit open questions instead of guessing
