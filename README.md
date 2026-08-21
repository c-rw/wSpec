# wSpec

A spec-driven change workflow for Claude Code. Propose, implement, and finalize changes with structured specs, adversarial quality gates, and per-phase validation.

## Prior Art

wSpec began as an amalgamation of two other MIT-licensed projects. From [GitHub Spec Kit](https://github.com/github/spec-kit) it took the spec/tasks artifact vocabulary: Given/When/Then acceptance criteria, `FR-NNN`/`SC-NNN` numbering, phased task lists, and the branch-numbering scheme. From [Fission-AI OpenSpec](https://github.com/Fission-AI/OpenSpec) it took the change-folder lifecycle: active changes under `wspec/changes/`, finalized capability specs synced into a separate library, and delta-spec archival.

Everything past that borrowed vocabulary is original: the MCP server (27 tools), the model-pinned subagent layer, the adversarial attack pass, per-phase validation gates, fingerprint-bound overrides with TTL, git and Claude Code hook wiring, and the token/cost ledger. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the exact file-by-file breakdown and both projects' license text.

## Install

Into an existing project - Windows:

```powershell
./install.ps1 -Folder <repo-path>
```

macOS/Linux:

```bash
./install.sh --folder <repo-path>
```

The installer copies framework files, builds `wspec/mcp`, configures git hooks, merges wSpec settings into `.claude/settings.json`, and seeds `wspec/config.yaml` and `wspec/principles.md` on first run.

To upgrade an existing install:

```powershell
./install.ps1 -Folder <repo-path> -Upgrade
```

## Commands

Run these as Claude Code slash commands:

```text
/wspec-capture <brain-dump> - turn free-form ideas into tracked GitHub/GitLab issues
/wspec-principles           - scan the repo and write enforceable MUST/MUST NOT guardrails
/wspec-propose <idea|#issue> - research, clarify, branch, and generate the full change packet
/wspec-research [id]        - refresh research for an existing change mid-lifecycle
/wspec-implement [id]       - execute tasks phase by phase with validation gates
/wspec-finalize [id]        - sync specs, archive, and close out
```

`/wspec-capture` is Claude Code-only - it has no terminal script, unlike the other five.

## Terminal CLI

The same workflows are also available from a terminal:

```bash
./wspec-propose "add payment retry"
./wspec-implement 123-payment-retry
./wspec-finalize 123-payment-retry
```

Windows: use the `.cmd` wrappers (e.g. `./wspec-propose.cmd`).

For direct MCP tool access:

```bash
node wspec/mcp/dist/cli.js list-tools
node wspec/mcp/dist/cli.js tool wspec.status '{}'
node wspec/mcp/dist/cli.js state:banner
```

See [wspec/README.md](wspec/README.md) for full command behavior, configuration, and gate/override reference.

## License

MIT - see [LICENSE](LICENSE). Portions derived from GitHub Spec Kit and Fission-AI OpenSpec (both also MIT) are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
