# wSpec

A spec-driven development workflow for Claude Code. Capture ideas as tracked issues, then explore, build, and ship - backed by structured specs, adversarial quality gates, and a per-phase validation engine.

> For what this project owes to GitHub Spec Kit and Fission-AI OpenSpec, see [Prior Art](../README.md#prior-art) in the root README.

---

## Quick Start

Optionally, brain-dump ideas into tracked issues first:

```text
/wspec-capture Two things: retry payment webhooks on 5xx, and the dashboard needs a dark mode toggle
```

Then propose from a raw idea or a captured issue:

```text
/wspec-propose Add user authentication with email and password
/wspec-propose #42
```

wSpec asks a few questions, creates `feat/001-user-auth`, and generates the full change packet (research, proposal, spec, design, tasks, analysis - including an adversarial attack pass). When ready to build:

```text
/wspec-implement
```

Work through the phases. When done:

```text
/wspec-finalize
```

---

## Commands

### `/wspec-principles`

**Set your project guardrails.** Build or refresh `wspec/principles.md` by scanning the codebase and running an adaptive questionnaire.

1. Scans existing code and specs to infer stack, testing, security, delivery, and quality norms
2. Asks high-impact questions only where confidence is low or tradeoffs are unclear
3. Writes or updates `wspec/principles.md` with clear MUST/MUST NOT guidance
4. Shows confidence notes and unresolved assumptions for human review

Run this once at the start of a project, then refresh when the stack or team norms change.

### `/wspec-capture <brain-dump>`

**Turn ideas into tracked issues.** Free-form brain-dump in, GitHub/GitLab issues out (via `gh`/`glab`) - no research, no artifacts, just capture so ideas survive past the moment they're typed.

1. Reads `wspec/config.yaml` for `capture_label` and `forge`, and lists the open captured backlog via `wspec.listIssues`
2. Logically decomposes the dump into discrete work items (one ticket per coherent idea)
3. Reconciles each item against already-open (or just-created-this-session) tickets - new work becomes a new issue, follow-up detail on something already tracked gets merged into that issue's body instead of duplicating it
4. Shows a Create/Update plan and confirms before writing anything
5. Creates issues via `wspec.captureIssue`; merges follow-ups via `wspec.updateIssue`/`wspec.commentIssue`

Run `/wspec-propose #<n>` on any captured issue to turn it into a full change packet.

### `/wspec-propose <idea | #issue>`

**Start a change.** Explore the idea, research prior art, clarify requirements, create a feature branch, and generate the full ready-to-implement packet in one run.

0. Resolves the idea from raw text, a referenced issue (`#42`), or an offered pick from the open `/wspec-capture` backlog (`wspec.getIssue` / `wspec.listIssues`)
1. Runs `wspec.repoScan` and fans out parallel `wspec-researcher` subagents (model: haiku; prior art, risks, conventions)
2. Asks for optional reference URLs
3. Asks 3–5 high-impact clarifying questions, one at a time, with recommendations
4. Confirms and creates a `feat/NNN-name` branch
5. Generates `research.md`, `proposal.md`, `spec.md`, `design.md`, `tasks.md`; binds the ticket (`wspec.bindTicket` - links the source issue, or creates one per `ticket.create_on_propose`)
6. Adversarially attacks the spec and runs the cross-artifact scan in one pass via the `wspec-analyst` subagent (model: opus, Phase 4.55) - boundary, edge-case, and cross-artifact findings feed into `analysis.md` as CRITICAL/HIGH findings that gate `/wspec-implement`, checked with `wspec.validateAnalysis`
7. Offers to commit the packet

### `/wspec-research [change-id]`

**Refresh research mid-lifecycle.** Use when new questions surface after `/wspec-propose` (which already produces the initial `research.md`).

1. Selects an existing active change packet
2. Re-scans `wspec/specs/`, `wspec/archive/`, and current change artifacts
3. Incorporates user-provided external references when available
4. Overwrites `wspec/changes/<NNN-name>/research.md` with refreshed constraints, risks, and recommendations

### `/wspec-implement [change-id]`

**Do the work.** Execute tasks phase by phase with a validation gate between every phase.

1. Reads `wspec/state.json` to re-hydrate in-flight context cheaply
2. Loads all change artifacts and the project principles
3. Executes tasks from `tasks.md` phase by phase, marking each done
4. After every phase: validates against spec requirements, analysis findings, and project principles
5. Stops and reports if validation fails - never silently skips issues
6. Offers to commit after each successful phase (controlled by `implement_phase_commits` in config)

Branch requirement: implementation must run from the change branch recorded in `metadata.yaml`. wSpec stops if the current branch does not match.

### `/wspec-finalize [change-id]`

**Close it out.** Validate completion, sync delta specs to the capability library, commit, and archive.

1. Reads `wspec/state.json` to re-hydrate in-flight context
2. Checks task and artifact completion (warns on gaps, never silently ignores)
3. Diffs and optionally merges delta specs from the change into `wspec/specs/<capability>/`
4. Prompts for a final commit
5. Archives the change to `wspec/archive/YYYY-MM-DD-NNN-name/` - if a ticket is linked, this
   automatically posts the final render (all phases checked, spend, elapsed time) and closes it
   (`ticket.close_on_finalize`, default on)
6. Optional post-archive action: open PR, merge locally, or skip (config-driven)

---

## Subagents

Each command delegates its context-heavy or judgment-heavy work to a purpose-built subagent in
`.claude/agents/`, each pinned to a model chosen for what it does rather than a single default:

| Agent | Model | Purpose | Called by |
| ----- | ----- | ------- | --------- |
| `wspec-researcher` | haiku | Prior-art/convention dossier, one angle per dispatch | `/wspec-propose` (1.3), `/wspec-research` |
| `wspec-analyst` | opus | Adversarial spec attack (boundary/equivalence/error/ambiguity/security) + cross-artifact quality scan, writes `analysis.md` | `/wspec-propose` (4.55) |
| `wspec-phase-validator` | sonnet | Per-phase diff review against requirements/principles | `/wspec-implement` (4d) |
| `wspec-scan-gapfiller` | haiku | Closes one low-confidence `repoScan` topic | `/wspec-principles` (Step 2) |

Adversarial and cross-artifact analysis run on the strongest available model because a weak model
there produces false confidence - CRITICAL/HIGH findings from this gate `/wspec-implement`
and the git hooks. Routine research and gap-filling run on the cheapest model since their output
is easy to verify and high-volume.

---

## Directory Layout

```text
.claude/
  agents/               # Subagent definitions (see Subagents above)
  commands/             # The wspec-* slash commands (capture, propose, research, implement, finalize, principles)
wspec/
  config.yaml           # Project context and settings
  principles.md         # Non-negotiable MUST/MUST NOT guardrails
  state.json            # Rebuildable change index (generated; gitignored)
  templates/            # Artifact templates
  mcp/                  # MCP server + CLI
  scripts/
    hooks/              # git hook shims (pre-commit, pre-push, etc.)
  changes/
    NNN-kebab-name/     # Active change packet
      metadata.yaml     # id, title, status, branch, capability; issue/issue_url/issue_forge,
                        # milestone, due_date, started, completed, pr_url (ticket mirror,
                        # see Ticket Mirror below)
      .ticket/          # Ticket-mirror receipt + prelude cache (gitignored, machine-local)
      research.md       # Prior art, references, risks, recommendation
      proposal.md       # What & why
      spec.md           # Requirements, scenarios, acceptance criteria
      design.md         # Architecture, decisions, research notes
      tasks.md          # Phased task list
      analysis.md       # Cross-artifact quality findings (machine-readable YAML)
      specs/            # Optional delta specs for capability sync at finalize
        <capability>/
          spec.md
  specs/
    <capability>/       # Finalized, capability-oriented spec library
      spec.md
  archive/
    YYYY-MM-DD-NNN-name/  # Completed changes (immutable)
```

**Key principle**: active changes are *feature-oriented*; finalized specs are *capability-oriented*.

---

## Validation

`/wspec-implement` validates every phase against four sources:

| Source                  | What is checked                                                   |
| ----------------------- | ----------------------------------------------------------------- |
| `checks:` (config.yaml) | Declared test/typecheck/lint commands actually pass — execution evidence, not document review. Skipped entirely if unconfigured. |
| `spec.md`       | FRs and SCs addressed by the phase are implemented and testable   |
| `analysis.md`   | CRITICAL/HIGH findings for the phase are resolved or deferred     |
| `principles.md` | No MUST/MUST NOT statements are violated                          |

A failing required check **blocks before** the `wspec-phase-validator` subagent is dispatched —
reviewing a diff that doesn't build or pass its own tests wastes the pass. CRITICAL analysis
findings and principles violations also **block progress**. HIGH findings must be resolved or
explicitly deferred with a reason.

The adversarial attack pass (Phase 4.55 of `/wspec-propose`, run by `wspec-analyst`) produces `Adversarial/Boundary` category findings in `analysis.md`. CRITICAL/HIGH findings from that pass block `/wspec-implement` and the git pre-push hook until resolved or overridden.

`wspec.computeCoverage` deterministically matches `spec.md` FR-NNN/SC-NNN requirements against
`tasks.md` tasks tagged `[FR-NNN]`/`[SC-NNN]`, and whether a matching task also carries a
`[unit]`/`[intg]`/`[e2e]` test-level tag. `wspec-analyst` consumes this as authoritative input
rather than re-deriving it, so a requirement with a task but no test surfaces as a `Coverage Gap`
finding without spending an opus reasoning pass to find it.

---

## Ticket Mirror

When a change packet is linked to a GitHub/GitLab issue (`metadata.yaml`'s `issue:`, set by
`wspec.bindTicket`), wSpec keeps that ticket's description re-rendered from live packet state -
phase checklist, the `/wspec-propose` clarification Q&A, open findings, checks, running spend,
dates - and posts short comments on meaningful events (packet created, implementation started,
phase complete, a new CRITICAL/HIGH finding, archived). The ticket is a *projection*, never an
input: `metadata.yaml`/`state.json` stay authoritative, and a failed sync (offline, no CLI,
unauthed) just logs a warning and self-heals on the next successful one - no queue, no
reconciliation logic.

- **Fully automatic.** Mirroring is folded into the tools that already mutate state
  (`wspec.setStatus`, `wspec.markTask`, `wspec.validatePhase`, `wspec.appendFindings`,
  `wspec.archive`) - never a separate step to remember, never an extra permission prompt.
- **A human-written `/wspec-capture` body is never overwritten.** The rendered dashboard lives in
  a sentinel-delimited region (`<!-- wspec:begin -->...<!-- wspec:end -->`) spliced into whatever
  the issue body already contains.
- **Inert with no linked ticket** - a change nobody bound to an issue costs zero forge calls.
- **Capability-aware.** GitLab issues get a real due date (derived from `estimated_effort`) and a
  milestone (defaulting to `capability`); GitHub issues get the milestone only (no due-date field
  on GitHub issues) plus native sub-issue/dependency support where the installed `gh` version
  supports it. Detected once via `wspec.forgeCaps`, cached, and re-probed if a feature turns out
  to be tier-gated (e.g. GitLab Premium-only dependencies).
- **Bind a ticket** with `wspec.bindTicket` (`{ "id": "<CHANGE_ID>", "number": <n> }` to attach an
  existing issue, or `{ "id": "<CHANGE_ID>", "create": true }` to open one). `/wspec-propose` does
  this automatically per `ticket.create_on_propose` (see Configuration below).
- **Force a re-render** with `wspec.syncTicket` (`{ "id": "<CHANGE_ID>" }`) if a ticket ever looks
  stale - it's idempotent (a byte-identical render is a no-op) and safe to run any time.
- **Verify offline** with `wspec.syncTicket { "dryRun": true }` - renders the body/comments and
  returns them as data, making zero `gh`/`glab` calls. Works with no CLI installed and no auth.

See the `ticket:` block in Configuration for the full set of controls, and
`wspec/mcp/src/lib/ticket.ts` / `ticketRender.ts` for the implementation (I/O and pure rendering
are deliberately split so the render half is fully unit-testable offline).

---

## Git Hooks

wSpec installs four git hook shims (POSIX sh → Node):

| Hook | Behaviour |
| ---- | --------- |
| `pre-commit` | Blocks on unresolved CRITICAL findings for the active change |
| `pre-push` | Blocks on unresolved CRITICAL/HIGH findings and on a recorded failing required check (`checks:` in config.yaml, if configured); warns on status/state drift and on a change that has never run `wspec.runChecks` |
| `commit-msg` | Validates commit message format |
| `prepare-commit-msg` | Prepares commit message scaffolding |

To bypass a gate with an audit trail:
```bash
# One-shot env override (logged to wspec/overrides.log)
WSPEC_OVERRIDE_REASON="unblocking: X is resolved in next commit" git push

# Persistent per-finding override (14-day TTL, fingerprint-bound)
node wspec/mcp/dist/cli.js tool wspec.recordOverride '{"gate":"pre-push","reason":"..."}'
```

Overrides are automatically revoked when the underlying finding changes or the TTL expires.

---

## Claude Code Hooks

Beyond the git hooks above, the installer wires five Claude Code native hooks (see
`.claude/settings.example.json`) so the harness enforces its own guardrails instead of relying on
command prose alone:

| Event | Matcher | Command | Behaviour |
| ----- | ------- | ------- | --------- |
| `PreToolUse` | `Edit\|Write\|MultiEdit` | `hook:guard-edit` | Warns and blocks (exit 2) edits outside `wspec/changes/<id>/` while a change is `status: drafting`; bypass with `WSPEC_OVERRIDE_REASON` (audited, same pattern as the git gates) |
| `PostToolUse` | `mcp__wspec__wspec.markTask` etc. | `state:sync` | Defense-in-depth `state.json` refresh after the tools that already call it internally |
| `Stop` | (none) | `hook:nudge-validate` | Non-blocking reminder when a change has all tasks done but is still `status: implementing` |
| `Stop` | (none) | `hook:usage-track` | Attributes this turn's token usage to the most recent `/wspec-*` command and records a segment in the active change's `usage.json` - see Effort & Cost Tracking below |
| `UserPromptSubmit` | (none) | `state:banner` | Cheap per-turn active-change context, same banner as `SessionStart` |

MCP tool matchers use `mcp__<serverName>__<toolName>`. This server's tool names already embed a
`wspec.` prefix (see `wspec/mcp/src/lib/tools.ts`), so the wire name is literally `wspec.markTask`
- matcher `mcp__wspec__wspec.markTask`, not `mcp__wspec__markTask`.

---

## Configuration

### `wspec/config.yaml`

```yaml
schema_version: "1.0"
branch_numbering: sequential
post_archive_action: ask      # none | ask | pr | merge
forge: auto                   # auto | github | gitlab - CLI to use for post_archive_action: pr and /wspec-capture issue ops
capture_label: wspec          # label applied to /wspec-capture issues; default filter for wspec.listIssues
implement_phase_commits: ask  # ask | auto
override_ttl_days: 14

# Optional: execution-evidence gate (wspec.runChecks). Declared, not inferred, so this stays
# language-agnostic. Absent/empty = feature off, no behavior change.
# checks:
#   test: "npm run test"
#   typecheck: "npm run check"
#   required: [test]

# Optional: project context for AI artifact generation
# context: |
#   Tech stack: TypeScript, Node.js
#   Domain: e-commerce platform

# Optional: per-artifact rule overrides
# rules:
#   proposal:
#     - Keep proposals under 300 words

# Optional: ticket mirror (see the Ticket Mirror section above). Commented out on purpose -
# install/upgrade never rewrites this file, so absence must mean these exact defaults.
# ticket:
#   enabled: true
#   create_on_propose: ask          # ask | always | never
#   sync_on: phase                  # transition | phase | task
#   events: [packet_created, implementation_started, phase_complete, finding_critical, archived]
#   comment_findings_at: CRITICAL   # CRITICAL | HIGH | never
#   show_spend: true
#   milestone: capability           # capability | none | "<fixed title>"
#   due_from_effort: true
#   close_on_finalize: true
#   timeout_ms: 15000
```

### `.mcp.json` and `.claude/settings.json`

The installer writes the MCP server registration into `.mcp.json` at the project root
(Claude Code only picks up `mcpServers` from `.mcp.json` or `claude mcp add` — not from
`settings.json`):

```json
{
  "mcpServers": {
    "wspec": {
      "command": "node",
      "args": ["wspec/mcp/dist/cli.js", "serve"],
      "type": "stdio"
    }
  }
}
```

It separately merges wSpec-owned settings into `.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node wspec/mcp/dist/cli.js state:banner"
  }
}
```

`statusLine` shows the active change status in the Claude Code status bar. Existing keys in
your `settings.json` (and `.mcp.json`) are preserved. Restart Claude Code after install/upgrade
so it picks up the new `.mcp.json` registration.

### `wspec/state.json`

A rebuildable central index generated from the change packet filesystem. Provides fast context re-hydration at the start of each `/wspec-implement` or `/wspec-finalize` session without re-walking the entire directory tree. Gitignored - never commit it.

### Repository Memory

When available, wSpec agents read `/memories/repo/wspec-notes.md` to reuse proven repo-specific lessons. `/wspec-finalize` appends concise, durable lessons learned so future propose/implement/principles runs improve over time.

### Effort & Cost Tracking

A `Stop` hook (`hook:usage-track`) attributes token usage to whichever `/wspec-*` command most
recently ran, per change:

- **Percentages aren't tracked, tokens are.** "% of context used" resets to 0 on a session reset
  or compaction and can't be summed. Every assistant turn in a Claude Code transcript carries an
  exact `usage` object (input/output/cache-write/cache-read tokens, model, `requestId`) that's
  additive and immune to resets - a session reset just starts a new transcript file, and the
  ledger below keeps accumulating independently of any one session.
- **Granularity: one segment per command invocation.** Re-running `/wspec-implement` three times
  on one change produces three segments that roll up into the change total.
- **Attribution is cursor-based, not paired-hook-based.** A command can span multiple `Stop`
  events (e.g. `AskUserQuestion` round-trips), so rather than bracketing "one command = one Stop"
  precisely, the hook tracks a per-transcript cursor (`wspec/usage-cursor.json`, gitignored) and
  attributes each new batch of transcript lines to the most recent `/wspec-*` command seen,
  carrying it forward across continuations. Subagent transcripts (researcher, analyst,
  phase-validator) are picked up the same way, so their fan-out counts toward the parent command.
- **Storage:**
  - `wspec/changes/<id>/usage.json` - per-change ledger of segments; travels into
    `wspec/archive/` automatically since `/wspec-finalize` moves the whole folder.
  - `wspec/usage-log.jsonl` - append-only, one line per finalized change, written by
    `wspec.archive`. Durable history of what a change here typically costs.
  - `wspec/state.json` - each active change gets a small `usage: {tokens, cost_usd}` rollup, and
    the statusLine banner appends `~$N.NN` when a change has recorded usage.
- **Cost is an estimate, not a bill.** Computed from a cached per-model $/MTok pricing table
  (with the exact 5m/1h cache-write split read from each transcript entry, not guessed) - useful
  for comparing an Opus-heavy `/wspec-propose` against a Sonnet-heavy `/wspec-implement`, even
  when actual out-of-pocket cost is $0 on a Max-style plan. An unrecognized model id is recorded
  with `priced: false` and $0 cost rather than a fabricated rate.
- Query any change's usage with `wspec.usageReport` (`{"id": "<change-id>"}`), or omit `id` for
  an aggregate across active changes plus the finalized-change rollup log.

Known limitation: plain chat interleaved with wSpec commands in the same session, without ever
starting a new `/wspec-*` command, gets attributed to whichever command ran most recently. This
is an internal effort signal, not precise billing.

---

## MCP Tool Reference

The MCP server exposes 32 tools, callable from Claude Code or directly via the CLI:

```bash
node wspec/mcp/dist/cli.js list-tools
node wspec/mcp/dist/cli.js tool wspec.status '{}'
node wspec/mcp/dist/cli.js tool wspec.gateCheck '{"gate":"pre-push"}'
node wspec/mcp/dist/cli.js state:banner
```

Key tools:

| Tool | Purpose |
| ---- | ------- |
| `wspec.status` | List all active changes with health summary |
| `wspec.loadChange` | Load full change context for implementation |
| `wspec.createFeatureBranch` | Compute and create `feat/NNN-name` |
| `wspec.validatePhase` | Run deterministic phase validation gate |
| `wspec.runChecks` | Run declared test/typecheck/lint commands for a change; returns a truncated pass/fail digest, never raw output |
| `wspec.computeCoverage` | Deterministically match spec.md FR-NNN/SC-NNN requirements to tagged tasks and their test-level tags |
| `wspec.markTask` | Mark a task done in `tasks.md` |
| `wspec.setStatus` | Update change status in `metadata.yaml` |
| `wspec.syncSpec` | Diff/apply delta specs to capability library |
| `wspec.archive` | Move completed change to archive |
| `wspec.postArchive` | Open PR or merge after archiving |
| `wspec.syncState` | Rebuild and write `wspec/state.json` |
| `wspec.gateCheck` | Run pre-commit or pre-push gate check |
| `wspec.recordOverride` | Record a fingerprint-bound gate override |
| `wspec.validateAnalysis` | Validate a change's `analysis.md` YAML block against the schema |
| `wspec.appendFindings` | Deterministically merge findings into `analysis.md` (dedupe, renumber, recompute counts) |
| `wspec.validateAll` | Run `validatePhase` across every phase plus a manual gate check, in one call |
| `wspec.doctor` | Health probe: tool availability, build freshness, hook wiring, state/lock sync |
| `wspec.captureIssue` | Create a tracker issue (`gh`/`glab`), ensuring its labels exist first |
| `wspec.listIssues` | List tracker issues, optionally filtered by label and state |
| `wspec.getIssue` | Read a single tracker issue's title, body, and URL |
| `wspec.commentIssue` | Post a comment on a tracker issue |
| `wspec.updateIssue` | Amend a tracker issue's body/title in place (merges follow-up capture detail) |
| `wspec.closeIssue` | Close a tracker issue, optionally with a closing comment |
| `wspec.usageReport` | Report token usage and equivalent API cost for a change, or an aggregate across active + finalized changes |
| `wspec.forgeCaps` | Read-only capability probe for the linked forge (CLI presence, auth, due dates/milestones/sub-issues/dependencies support) |
| `wspec.syncTicket` | Re-render the linked ticket's body from current state and post one event comment if due; `dryRun` renders with zero forge calls |
| `wspec.bindTicket` | Link a change to an existing or newly created ticket; writes `issue`/`milestone`/`due_date` into `metadata.yaml` |

---

## Commits

wSpec prompts at lifecycle boundaries by default:

- After `/wspec-propose` writes the change packet
- Optionally after each phase in `/wspec-implement` (controlled by `implement_phase_commits`)
- Before archiving in `/wspec-finalize`

Set `implement_phase_commits: auto` in `wspec/config.yaml` to auto-commit validated phases that include real code changes. Bookkeeping-only changes (`tasks.md` / `metadata.yaml`) are always deferred to the next real commit or to `/wspec-finalize`.

---

## Terminal CLI

For running wSpec workflows directly from a terminal:

```bash
./wspec-propose "add payment retry with idempotency"
./wspec-implement 123-payment-retry
./wspec-finalize 123-payment-retry
```

`/wspec-capture` has no terminal script - it's a Claude Code slash command only (the
decomposition/reconciliation reasoning it does isn't something the deterministic CLI
layer can replicate). Its underlying tools (`wspec.captureIssue`, `wspec.listIssues`,
etc.) are still reachable individually via `node wspec/mcp/dist/cli.js tool <name>`.

Windows:
```cmd
wspec-propose.cmd "add payment retry with idempotency"
```

Full workflow help:
```bash
node wspec/mcp/dist/cli.js workflow
```
