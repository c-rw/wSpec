# wSpec Git Hooks

These hooks are installed by `/wspec:setup` (or `install.sh`/`install.ps1`) and are active when
`core.hooksPath` points here. Setup offers to wire them for git repositories, and never overrides a
`core.hooksPath` something else already set.

## Enable

Run `/wspec:setup` and answer yes to git hooks. Re-run it after updating the wSpec plugin: the
shims find the plugin by an absolute path (recorded in `.wspec-mcp-cli-path`, next to them), and
that changes when the plugin moves or updates. `wspec.doctor` warns when it has gone stale.

## Disable

```bash
git config --unset core.hooksPath
```

Each hook is a tiny POSIX `sh` shim that `exec`s the wSpec plugin's cross-platform Node CLI
(`hook:<name>`). Git for Windows runs the shim through its bundled bash,
so the *same* shim works on Windows, macOS, and Linux — there is no per-platform dispatch. If
`node` is not on `PATH`, every shim fails open (skips the gate) rather than bricking git.

## Hooks

- `prepare-commit-msg`: on `feat/NNN-name` branches, prefixes the subject with
  `feat(NNN-name):` if missing.
- `commit-msg`: blocks commits that only stage
  `wspec/changes/<id>/tasks.md` and/or `wspec/changes/<id>/metadata.yaml`.
- `pre-commit`: **blocks** the commit if the active change has unresolved **CRITICAL**
  analysis findings (HIGH is surfaced as a warning). See `wspec.gateCheck`.
- `pre-push`: **blocks** the push if the active change has unresolved **CRITICAL or HIGH**
  findings; warns (does not block) on unfinalized status or a stale `state.json`.

## Overriding a blocking gate

Resolve the finding in `analysis.md`, or record a reasoned, fingerprint-bound override:

```bash
node "$(cat wspec/scripts/hooks/.wspec-mcp-cli-path)" tool wspec.recordOverride '{"gate":"pre-push","findingId":"A1","reason":"why this is safe"}'
```

(A blocked commit or push prints the exact command for each finding, or ask Claude to call the
`wspec.recordOverride` tool.)

Overrides auto-revoke when the finding changes/disappears or after `override_ttl_days`
(config, default 14). All grants and prunes are logged to `wspec/overrides.log`.

## Bypass

- `WSPEC_OVERRIDE_REASON="..."` — one-shot audited bypass of a blocking gate (logged).
- `git commit --no-verify` / `git push --no-verify` — skip hooks entirely (silent, last resort).
