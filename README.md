# wSpec

A spec-driven change workflow for Claude Code. Propose, implement, and finalize changes with structured specs, adversarial quality gates, and per-phase validation.

## Prior Art

wSpec began as an amalgamation of two other MIT-licensed projects. From [GitHub Spec Kit](https://github.com/github/spec-kit) it took the spec/tasks artifact vocabulary: Given/When/Then acceptance criteria, `FR-NNN`/`SC-NNN` numbering, phased task lists, and the branch-numbering scheme. From [Fission-AI OpenSpec](https://github.com/Fission-AI/OpenSpec) it took the change-folder lifecycle: active changes under `wspec/changes/`, finalized capability specs synced into a separate library, and delta-spec archival.

Everything past that borrowed vocabulary is original: the MCP server (33 tools), the model-pinned subagent layer, the adversarial attack pass, per-phase validation gates, fingerprint-bound overrides with TTL, git and Claude Code hook wiring, the token/cost ledger, and a living ticket mirror that keeps a linked GitHub/GitLab issue in sync with packet state as work happens. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the exact file-by-file breakdown and both projects' license text.

## Install

wSpec's commands, agents, hooks, and MCP server are a Claude Code plugin
(`.claude-plugin/plugin.json`). Try it locally first:

```bash
claude --plugin-dir /path/to/wSpec
```

To install permanently, add this repo as a marketplace and install from it (see
[Discover and install plugins](https://code.claude.com/docs/en/discover-plugins)):

```text
/plugin marketplace add c-rw/wSpec
/plugin install wspec
```

Then, in each project you want to use wSpec in, run once:

```text
/wspec:setup
```

A plugin can't ship everything, so `/wspec:setup` puts a few things in your project:

- `wspec/templates`, `wspec/schemas` — read by relative path from command prompt text and MCP
  tools, neither of which gets `${CLAUDE_PLUGIN_ROOT}` substitution the way hook/MCP/agent config
  does
- `wspec/scripts` (git hook shims) and `core.hooksPath` — git invokes hooks directly and has no
  notion of a Claude Code plugin
- `permissions.allow` in `.claude/settings.json` — a plugin's own `settings.json` only supports
  the `agent`/`subagentStatusLine` keys, not this
- seed files — `wspec/config.yaml`, `wspec/principles.md`, and empty `wspec/changes`, `specs`,
  `archive` — plus `.gitignore` entries for wSpec's generated files

It previews everything first, asks before wiring git hooks or touching `.claude/settings.json`,
never overwrites your `config.yaml`, `principles.md`, or change packets, and is safe to re-run.
Re-run it after updating the plugin: the git hooks find the plugin by an absolute path, which
changes when the plugin moves or updates, and setup refreshes it.

Prefer a script? `install.sh` / `install.ps1` do the same from a checkout of this repo:

```powershell
./install.ps1 -Folder <repo-path>            # Windows; add -Upgrade to refresh an existing install
```

```bash
./install.sh --folder <repo-path>            # macOS/Linux; add --upgrade to refresh
```

## Commands

Run these as Claude Code slash commands (plugin-namespaced):

```text
/wspec:setup                 - one-time (and after plugin updates) project setup: templates, git hooks, permissions
/wspec:capture <brain-dump>  - turn free-form ideas into tracked GitHub/GitLab issues
/wspec:principles            - scan the repo and write enforceable MUST/MUST NOT guardrails
/wspec:propose <idea|#issue> - research, clarify, branch, and generate the full change packet
/wspec:research [id]         - refresh research for an existing change mid-lifecycle
/wspec:implement [id]        - execute tasks phase by phase with validation gates
/wspec:finalize [id]         - sync specs, archive, and close out
```

`/wspec:setup` and `/wspec:capture` are Claude Code-only - they have no terminal script, unlike the other four.

## Terminal CLI

The same workflows are also available from a terminal. The wrapper scripts live in this repo (and in
the plugin's installed directory — see `/plugin` or `claude plugin list`); they are not copied into
your projects. Run them by path from inside the project you want to work on, after `/wspec:setup`
has been run there (the workflows read `wspec/templates`):

```bash
cd my-project
/path/to/wSpec/wspec-propose "add payment retry"
/path/to/wSpec/wspec-implement 123-payment-retry
/path/to/wSpec/wspec-finalize 123-payment-retry
```

Windows: use the `.cmd` wrappers (e.g. `C:\path\to\wSpec\wspec-propose.cmd`).

For direct MCP tool access, run the plugin's bundled CLI from your project:

```bash
node /path/to/wSpec/wspec/mcp/dist/cli.js list-tools
node /path/to/wSpec/wspec/mcp/dist/cli.js tool wspec.status '{}'
node /path/to/wSpec/wspec/mcp/dist/cli.js state:banner
```

See [wspec/README.md](wspec/README.md) for full command behavior, configuration, and gate/override reference.

## License

MIT - see [LICENSE](LICENSE). Portions derived from GitHub Spec Kit and Fission-AI OpenSpec (both also MIT) are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
