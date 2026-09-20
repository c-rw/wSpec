# Changelog

## [2026-09-20]

### Changed

- **Repackaged as a Claude Code plugin.** Install with `/plugin marketplace add c-rw/wSpec`, then
  `/plugin install wspec` (manifests: `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`). `commands/`, `agents/`, `hooks/hooks.json`, and `.mcp.json`
  now live at the repo root and are plugin-owned rather than copied into each project's `.claude/`.
  The slash commands are namespaced — `/wspec:propose`, `/wspec:implement`, `/wspec:capture`,
  and so on; the `wspec-` filename prefix is gone since the namespace supplies it. The terminal
  wrappers (`wspec-propose` and friends) are no longer copied into projects — they ran a
  project-relative `wspec/mcp/dist/cli.js` that plugin users don't have. Run them by path from your
  project instead (`/path/to/wSpec/wspec-propose "idea"`); they are now executable in the repo, so
  `./wspec-propose` also works from a clone.
  - The MCP server ships prebuilt as a single dependency-free `wspec/mcp/dist/cli.js`, so there is
    no per-project `npm install` or `npm run build` anymore.
  - `/wspec:setup` (or `install.ps1`/`install.sh`) now only handles what a plugin can't ship: `wspec/templates`,
    `wspec/schemas`, `wspec/scripts` (the git hook shims), and the read-only `permissions.allow`
    entries merged into the project's `.claude/settings.json`. They no longer copy
    `.claude/commands`, `.claude/agents`, or `wspec/mcp`.
  - The git hook shims reach the plugin's `cli.js` by absolute path, resolved at install time (the
    shims read it from `wspec/scripts/hooks/.wspec-mcp-cli-path`, falling back to a path relative
    to themselves when run from wSpec's own checkout).
  - **The `statusLine` entry is gone.** The plugin's `SessionStart` and `UserPromptSubmit` hooks
    already surface the same state banner, and a statusline pointing at an absolute path breaks if
    the plugin moves. Upgrading removes a `statusLine` that wSpec wrote earlier; one you set
    yourself is left alone.
  - As a plugin, MCP tools are named `mcp__plugin_wspec_wspec__wspec_<tool>`. The `state:sync` hook
    matcher accepts both forms, and the auto-allowed read-only permissions use the plugin names.
  - **Upgrading a project from the previous layout:** run `/wspec:setup`, or re-run the installer
    with `--upgrade` (`-Upgrade` on Windows). It removes the old `mcpServers.wspec` entry, wSpec's old hook entries,
    the stale `mcp__wspec__wspec.*` permission entries, and the old `statusLine` from
    `.claude/settings.json`, but it does not delete files: remove the old
    `.claude/commands/wspec-*.md`, `.claude/agents/wspec-*.md`, and `wspec/mcp/` by hand once the
    plugin is installed.

### Added

- **`/wspec:setup`**, backed by a new `wspec.setup` MCP tool, sets wSpec up in a project from inside
  Claude Code: it previews every change, then installs the templates, schemas, and git hook shims,
  seeds `config.yaml`/`principles.md` and the empty change folders, adds `.gitignore` entries, and —
  only if you say yes — sets `core.hooksPath` and adds read-only permissions to
  `.claude/settings.json`. It is safe to re-run (a second run changes nothing), never overwrites your
  `config.yaml`, `principles.md`, or change packets, never overrides a `core.hooksPath` something else
  set, and leaves an unparsable `settings.json` untouched. Re-run it after a plugin update to refresh
  the path the git hooks use. The other commands now stop with a pointer to it if a project hasn't
  been set up.
- `workflows/wspec-research-fanout.js`, a dynamic workflow (`/wspec:wspec-research-fanout`) that
  replaces `/wspec:propose` Phase 1.3's inline, one-angle-at-a-time `wspec-researcher` dispatch.
  Merging N independent research angles into one dossier is a genuine barrier — single-shot agents
  whose combined output is one document — which is what a workflow's `parallel()` is for. A failed
  angle becomes a placeholder in the dossier instead of failing the run. `/wspec:propose` falls
  back to the inline dispatch when Dynamic workflows aren't available in the session.
- Subagent frontmatter: `effort` on all four subagents, plus `disallowedTools`, `maxTurns`, and
  `experimental.cacheTtl` where they apply (the read-only analyst and phase-validator can't
  Write/Edit; the researcher and analyst are capped at 30 turns, the scan-gapfiller at 8).
- Slash command frontmatter: `description`, `argument-hint`, `model`, `effort`, and
  `allowed-tools` on the six workflow commands.
- `subagentPromptCacheTtl: 1h`, merged into `.claude/settings.json` by the installer when unset, so
  the parallel `wspec-researcher` fan-out and `wspec-analyst` share a prompt-cache prefix for an
  hour instead of the default 5 minutes.
- Three new Claude Code hooks: `hook:pre-compact-sync` (PreCompact — flushes `state.json` before
  compaction), `hook:validate-analysis-write` (PostToolUse — schema-validates `analysis.md`
  immediately after it's written), and `hook:session-end` (SessionEnd — a final usage-ledger flush
  for session-ending paths that don't cleanly fire `Stop`).

### Fixed

- **The commit and push gates did nothing on a branch with no commits yet** — which is exactly
  the state of a new repo when its first commit is made. The current branch was looked up with
  `git rev-parse --abbrev-ref HEAD`, which fails there, so the gates concluded "no active change"
  and let the commit through even with unresolved CRITICAL findings. It now uses
  `git symbolic-ref`, which works before the first commit (a detached HEAD behaves as before). The
  same lookup fed change-branch checks and `state.json`'s `current_branch`, which were wrong on a new
  repo too.
- **The plugin's hooks wrote into projects that never ran setup.** With the plugin enabled, ending a
  turn in any git repo created `wspec/state.json` and `wspec/usage-cursor.json`. The Claude Code
  hooks and state sync now do nothing unless the project has a `wspec/config.yaml`.
- **`wspec.doctor` always reported `fail` for plugin users.** It looked for the server bundle inside
  the project (`wspec/mcp/dist/cli.js`), where it no longer lives. It now checks the plugin's own
  bundle, that the project has `wspec/config.yaml` and the templates (pointing at `/wspec:setup`
  when it doesn't), and that the git hooks still point at the running plugin.
- **The commands a blocked commit or push prints** to record an override or re-run checks used a
  project-relative `wspec/mcp/dist/cli.js` that doesn't exist for plugin users; they now print the
  plugin's real path.
- **`.gitignore` entries were incomplete.** wSpec's machine-local files — `wspec/.cache/`,
  `wspec/usage-cursor.json`, and the per-change `.ticket/` folders — showed up as untracked noise.
  Setup adds them, and matches whole lines instead of substrings (so an existing
  `wspec/state.json.lock` no longer hides a missing `wspec/state.json`).

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
