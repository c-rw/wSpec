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
5. Generates `research.md`, `proposal.md`, `spec.md`, `design.md`, `tasks.md`
6. Adversarially attacks the spec and runs the cross-artifact scan in one pass via the `wspec-analyst` subagent (model: opus, Phase 4.55) - boundary, edge-case, and cross-artifact findings feed into `analysis.md` as CRITICAL/HIGH findings that gate `/wspec-implement`, checked with `wspec.validateAnalysis`
7. Offers to commit the packet, then comments the branch/packet link back on the source issue (`wspec.commentIssue`) if one was used

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
5. Archives the change to `wspec/archive/YYYY-MM-DD-NNN-name/`
6. Closes the linked source issue (`wspec.closeIssue`), if `metadata.yaml` has one, with a closing comment pointing at the archive path
7. Optional post-archive action: open PR, merge locally, or skip (config-driven)

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
      metadata.yaml     # id, title, status, branch, capability, issue (source tracker issue, if proposed from /wspec-capture)
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

`/wspec-implement` validates every phase against three sources:

| Source          | What is checked                                                   |
| --------------- | ----------------------------------------------------------------- |
| `spec.md`       | FRs and SCs addressed by the phase are implemented and testable   |
| `analysis.md`   | CRITICAL/HIGH findings for the phase are resolved or deferred     |
| `principles.md` | No MUST/MUST NOT statements are violated                          |

CRITICAL analysis findings and principles violations **block progress**. HIGH findings must be resolved or explicitly deferred with a reason.

The adversarial attack pass (Phase 4.55 of `/wspec-propose`, run by `wspec-analyst`) produces `Adversarial/Boundary` category findings in `analysis.md`. CRITICAL/HIGH findings from that pass block `/wspec-implement` and the git pre-push hook until resolved or overridden.

---

## Git Hooks

wSpec installs four git hook shims (POSIX sh → Node):

| Hook | Behaviour |
| ---- | --------- |
| `pre-commit` | Blocks on unresolved CRITICAL findings for the active change |
| `pre-push` | Blocks on unresolved CRITICAL/HIGH findings; warns on status/state drift |
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

# Optional: project context for AI artifact generation
# context: |
#   Tech stack: TypeScript, Node.js
#   Domain: e-commerce platform

# Optional: per-artifact rule overrides
# rules:
#   proposal:
#     - Keep proposals under 300 words
```

### `.claude/settings.json`

The installer merges wSpec-owned settings into `.claude/settings.json`:

```json
{
  "mcpServers": {
    "wspec": {
      "command": "node",
      "args": ["wspec/mcp/dist/cli.js", "serve"],
      "type": "stdio"
    }
  },
  "statusLine": {
    "type": "command",
    "command": "node wspec/mcp/dist/cli.js state:banner"
  }
}
```

`mcpServers.wspec` registers the MCP server so it auto-starts with Claude Code. `statusLine` shows the active change status in the Claude Code status bar. Existing keys in your `settings.json` are preserved.

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

The MCP server exposes 27 tools, callable from Claude Code or directly via the CLI:

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
