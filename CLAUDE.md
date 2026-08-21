# wSpec for Claude Code

This repository supports wSpec workflows in Claude Code.

## Commands

Use these project commands:

- `/wspec-principles` to create or refresh `wspec/principles.md`
- `/wspec-capture <brain-dump>` to turn ideas into tracked GitHub/GitLab issues (no code/spec artifacts)
- `/wspec-propose <idea | #issue>` to create a full change packet, optionally from a captured issue
- `/wspec-research [change-id]` to refresh research for an active change
- `/wspec-implement [change-id]` to execute tasks with phase validation
- `/wspec-finalize [change-id]` to sync specs, close the linked issue (if any), and archive a completed change

## Required Context

When running any command:

1. Prefer MCP tools for stateful operations — full list at `wspec/README.md#mcp-tool-reference`.
2. Delegate research, adversarial cross-artifact analysis, phase validation, and principles-scan
   gap-filling to the named subagents in `.claude/agents/` (each pinned to a specific model), not
   a generic exploration agent. See `wspec/README.md#subagents`.
3. Preserve branch safety checks from `metadata.yaml`.
4. Keep edits constrained to the current workflow intent.
5. Follow repository principles in `wspec/principles.md`.

## Fallback

If command discovery is unavailable, execute the same workflow by asking explicitly in chat, for example:

"Run the wspec propose workflow for: add payment retry with idempotency."

You can also invoke deterministic workflow commands directly in terminal:

```bash
./wspec-propose "add payment retry with idempotency"
./wspec-implement 123-payment-retry --validate-phase 1
./wspec-finalize 123-payment-retry --apply-specs --archive
```
