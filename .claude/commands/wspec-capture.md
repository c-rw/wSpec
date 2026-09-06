# wSpec Capture

## User Input

```text
$ARGUMENTS
```

If `$ARGUMENTS` is non-empty, ground everything that follows in it before doing anything else.

---

## Overview

`/wspec-capture` turns a free-form brain-dump into tracked tracker issues (GitHub via
`gh`, GitLab via `glab`) so ideas survive past the moment they're typed, without forcing
an immediate `/wspec-propose` on each one. It is deliberately lightweight — no research,
no clarification questions, no artifacts. Just: decompose, reconcile against what's
already tracked, confirm, write.

Run `/wspec-propose #<n>` (or `/wspec-propose <n>`) later to turn any captured issue into
a full change packet.

**The reasoning happens here, not in the tools** — `wspec.captureIssue`,
`wspec.listIssues`, `wspec.getIssue`, `wspec.updateIssue`, and `wspec.commentIssue` are
dumb CRUD wrappers over `gh`/`glab`. Deciding what counts as one ticket, and whether new
text belongs in an existing ticket or a new one, is this command's job.

---

## Step 1: Load context

Read `wspec/config.yaml` for `capture_label` (default `wspec`) and `forge`.

Call MCP tool `wspec.listIssues` with `{ "label": "<capture_label>", "state": "open" }` to
get the current captured backlog: `[{ number, title, url, labels }]`.

Also keep track, for the rest of this conversation, of any issues **this command created
earlier in the same session** — those are the freshest and most likely match targets for a
follow-up dump, even before a fresh `listIssues` call would reliably reflect them.

If `$ARGUMENTS` is empty, ask:
> "What's on your mind? Dump as many ideas as you want — I'll sort them into tickets."

---

## Step 2: Decompose the dump

Read through the brain-dump and split it into **discrete pieces of work** — one ticket
per coherent idea, not one ticket per sentence. Lines that clearly belong to the same
effort (a feature and its sub-details, a bug and its repro notes) collapse into a single
item; unrelated ideas mentioned back-to-back become separate items.

For each item draft:
- **Title**: short, imperative, specific enough to disambiguate from neighbors
- **Body**: 2-5 sentences capturing the problem/intent as the user described it — this is
  a ticket, not a spec. Do not invent scope the user didn't mention.

---

## Step 3: Reconcile against existing tickets

This is the routing step — decide, per drafted item, **new ticket** or **append to an
existing one**.

For each item, compare it against:
1. Issues carried forward from earlier in this session (Step 1)
2. Open issues returned by `wspec.listIssues` (Step 1)

Match on title/intent overlap, not just keyword overlap — "add retry to payment webhook"
and "payment webhooks need to retry on 5xx" are the same ticket even with no shared words
beyond "payment". Treat a match as **append** when the new item is clearly *more detail
on* something already tracked, rather than a related-but-distinct piece of work.

- **Append** → note the target issue number and draft what changes: prefer merging the
  new detail into the issue **body** (call `wspec.getIssue` first to read the current
  body, then compose the merged version — append a dated subsection rather than
  overwriting existing content) when the addition is substantive scope; use a plain
  **comment** instead when it's an incidental note ("also, low priority").
- **New** → no strong match; goes through Step 2's draft as-is.
- **Ambiguous** → don't guess. Flag it for the user in Step 4 with both candidates named.

---

## Step 4: Confirm, then act

Show the reconciled plan, grouped:

```
## Capture Plan

**Create (N)**
1. <title> — <1-line body summary>
2. ...

**Update (M)**
1. #<number> <existing title> ← append: <1-line summary of what's being merged in>
2. ...

<if any ambiguous matches>
**Needs a call**
1. "<new item>" — could be new, or could belong to #<number> "<existing title>"?
```

Ask via **AskUserQuestion**: "Proceed with this plan?" → "Yes — create/update as shown",
"Let me adjust", "Cancel". If the user wants to resolve ambiguous items, ask each one
individually (new vs. which existing ticket) before proceeding.

On approval:
- For each **Create** item: call `wspec.captureIssue` with `{ title, body, labels:
  ["<capture_label>"] }`. Record `{ number, url }`.
- For each **Update** item: call `wspec.updateIssue` with `{ number, body: <merged body>
  }` (body-merge case) or `wspec.commentIssue` with `{ number, body: <note> }`
  (comment case).

---

## Step 5: Summarize

```
## ✓ Captured

**Created**
- #<n> <title> — <url>

**Updated**
- #<n> <title> — <url> (body merged | commented)

Run /wspec-propose #<n> to turn any of these into a full change packet — the ticket then
tracks phases, findings, spend, and dates automatically as work happens.
Keep dumping — a follow-up /wspec-capture in this thread will route into these same tickets.
```

---

## Guardrails

- **Never create or modify an issue without confirmation** — always show the plan first
- **No code or spec artifacts here** — this command only touches the tracker, never
  `wspec/changes/`
- **Do not silently guess** on an ambiguous new-vs-append call — ask
- **Do not overwrite existing ticket content on append** — merge/append within the body,
  never replace what's already there
- If `gh`/`glab` is not installed or not authenticated, surface the tool's error message
  verbatim and stop — do not fall back to writing local files as a substitute
