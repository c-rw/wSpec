# wSpec Git Hooks

These hooks are managed by `install.ps1` or `install.sh` and are active when `core.hooksPath` points here.
By default, both installers enable hooks for git repositories.
Installers require a successful `wspec/mcp` dependency install and build before hook configuration is applied.

## Enable

```powershell
./install.ps1
```

```bash
./install.sh
```

## Disable

```powershell
./install.ps1 -NoHooks
```

```bash
./install.sh --no-hooks
```

Each hook is a tiny POSIX `sh` shim that `exec`s the cross-platform Node CLI
(`wspec/mcp/dist/cli.js hook:<name>`). Git for Windows runs the shim through its bundled bash,
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
node wspec/mcp/dist/cli.js tool wspec.recordOverride '{"gate":"pre-push","findingId":"A1","reason":"why this is safe"}'
```

Overrides auto-revoke when the finding changes/disappears or after `override_ttl_days`
(config, default 14). All grants and prunes are logged to `wspec/overrides.log`.

## Bypass

- `WSPEC_OVERRIDE_REASON="..."` — one-shot audited bypass of a blocking gate (logged).
- `git commit --no-verify` / `git push --no-verify` — skip hooks entirely (silent, last resort).
