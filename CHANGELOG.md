# Changelog

## [2026-09-06]

### Added

- **Living ticket mirror.** A change packet linked to a GitHub/GitLab issue
  (`metadata.yaml`'s `issue:`, set by the new `wspec.bindTicket`) now gets that issue's
  description re-rendered from live packet state — phase checklist, open findings, checks,
  running token/cost spend, and dates — with short comments posted on meaningful events
  (packet created, implementation started, phase complete, a new CRITICAL/HIGH finding,
  archived). Previously the ticket only received three posts in the entire lifecycle
  (created at capture, linked at propose, closed at finalize); everything in between —
  all of `/wspec-implement` — was silent.
  - Fully automatic: folded into the tools that already mutate state (`wspec.setStatus`,
    `wspec.markTask`, `wspec.validatePhase`, `wspec.appendFindings`, `wspec.archive`) rather
    than a separate step or a new permission prompt.
  - Never destroys a human-written `/wspec-capture` body — the rendered dashboard lives in
    a sentinel-delimited region spliced into whatever the issue body already contains.
  - Capability-aware: GitLab issues get a real due date (derived from `estimated_effort`)
    and a milestone (defaulting to the change's `capability`); GitHub issues get the
    milestone only, since GitHub issues have no due-date field. Detected once via the new
    `wspec.forgeCaps` and cached.
  - Verifiable with zero network calls via `wspec.syncTicket { "dryRun": true }`.
  - New MCP tools: `wspec.forgeCaps`, `wspec.syncTicket`, `wspec.bindTicket`.
  - New `metadata.yaml` fields: `issue_url`, `issue_forge`, `milestone`, `due_date`,
    `started`, `completed`, `pr_url`.
  - New `wspec/config.yaml` block: `ticket:` (enablement, event selection, sync frequency,
    milestone/due-date behavior — commented out by default so upgrades never change
    behavior for an existing install).
- **Execution-evidence gate.** `wspec.runChecks` executes declared test/typecheck/lint
  commands at phase gates and pre-push, blocking before the `wspec-phase-validator`
  subagent runs on a build that doesn't pass its own tests — validating running software,
  not just documents. Declared via a new `checks:` block in `wspec/config.yaml`; additive
  and off by default (no block = no behavior change).
- **Clarifications on the ticket.** The Q → A pairs recorded during `/wspec-propose`'s
  clarification phase (already saved to `spec.md`'s `## Clarifications` section) now render
  as a section in the ticket body, same as findings/documents — so a stakeholder watching
  the ticket can see *why* a decision was made without opening `spec.md`. Reuses the existing
  "body is a projection of packet files" architecture; no new event, no new config, nothing
  to post since propose already renders the body once its artifacts exist.
- **Deterministic FR/SC coverage traceability.** `wspec.computeCoverage` matches
  `spec.md`'s FR-NNN/SC-NNN requirements against `tasks.md` tasks tagged with a matching
  marker, and notes whether a matching task also carries a `[unit]`/`[intg]`/`[e2e]`
  test-level tag — pure string matching that replaces part of what the `wspec-analyst`
  subagent previously had to re-derive by reading every artifact.

### Fixed

- Forge detection (`gh` vs `glab`) silently defaulted to GitLab for any repo whose remotes
  aren't named `origin`. Detection now enumerates all remotes, prefers `origin`, and falls
  back to the first remote matching a known forge host before assuming GitLab.
- Metadata writes (`status`, `updated`, and now `started`/`completed`/etc.) used a
  hand-rolled `content.replace(/^key:.*$/m, ...)` pattern that silently no-opped when the
  target key line didn't already exist in `metadata.yaml` — a real risk for any packet
  created before a given field was added to the template. Replaced with an upsert helper
  that appends the line when it's missing.
- Forge CLI calls (`gh`/`glab`) had no timeout and inherited stdin, so a hung or
  interactively-prompting CLI could block the MCP server indefinitely. Forge calls now run
  with a timeout and detached stdin; local git calls are unaffected.
- The ticket mirror's "skip the write if nothing changed" check hashed the *rendered*
  markdown, which embeds a monotonic revision counter and a sync timestamp — both change on
  every call, so the hash never matched and every sync performed a real forge write.
  Confirmed on a real end-to-end run: 29 real writes for 10 actual semantic events. Now
  hashes the underlying snapshot instead (timestamp excluded), so an unchanged ticket is a
  true no-op. The same bug made `ticket.in_sync` in `wspec.loadState` read `false` almost
  always; fixed as the same change.
- `wspec.markTask` and `wspec.validatePhase` both triggered a sync at the same
  phase-completion moment (double-writing every phase boundary); `markTask` no longer
  special-cases phase completion, leaving `validatePhase` as the sole trigger.
- Generated `metadata.yaml` had orphaned comment fragments after `wspec.bindTicket` filled a
  field whose template comment wrapped onto a second line (e.g. `issue: "42"` followed by a
  dangling comment continuation with nothing above it). Template comments are now single-line.

## Initial public release

First public release on GitHub (MIT), plus two follow-up fixes:
- Register the wSpec MCP server via `.mcp.json` instead of `settings.json`.
- Add the missing `/wspec-capture` entry to the root README's command list.

This release consolidates the pre-1.0 development history: the MCP tool migration from
PowerShell, the adversarial red-team pass, native Claude Code hook wiring, the state index,
token/cost tracking, and the wspec-capture → propose → implement → finalize lifecycle itself.
