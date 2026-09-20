import fs from "node:fs";
import path from "node:path";
import { listChangeSummaries } from "./changes.js";
import { readChecksConfig, readLatestChecks } from "./checks.js";
import { getForgeCaps } from "./forgeCaps.js";
import { pluginCliPath, pluginRoot } from "./pluginPaths.js";
import { runCommand } from "./shell.js";
import { maxMtimeMs, verifyState } from "./state.js";
import { validateAnalysisFile } from "./validate.js";

/**
 * Health probe for a wSpec setup: tool availability, the plugin's server bundle, the project-side
 * files /wspec:setup installs, git hook wiring, state index sync, principles lock freshness, and
 * analysis.md schema validity across active changes. Read-only. Surfaced by `wspec.doctor`,
 * `/wspec:setup`, and the Stop hook.
 */

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  status: DoctorStatus;
  checks: DoctorCheck[];
}

function worstOf(a: DoctorStatus, b: DoctorStatus): DoctorStatus {
  const rank: Record<DoctorStatus, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[b] > rank[a] ? b : a;
}

function projectFilesCheck(repoRoot: string): DoctorCheck {
  const missingHard: string[] = [];
  const missingSoft: string[] = [];

  if (!fs.existsSync(path.join(repoRoot, "wspec", "config.yaml"))) missingHard.push("wspec/config.yaml");

  // Templates are read by the command prompts and by wspec workflows; schemas are reference
  // material only (validation rules are built into the server), so a missing schema just warns.
  let pluginWspec = "";
  try {
    pluginWspec = path.join(pluginRoot(), "wspec");
  } catch {
    // The bundle check above already reports this.
  }
  const missingIn = (dir: string): string[] => {
    const source = path.join(pluginWspec, dir);
    if (!pluginWspec || !fs.existsSync(source)) return [];
    return fs.readdirSync(source).filter((name) => !fs.existsSync(path.join(repoRoot, "wspec", dir, name))).map((name) => `wspec/${dir}/${name}`);
  };
  missingHard.push(...missingIn("templates"));
  missingSoft.push(...missingIn("schemas"));
  if (!fs.existsSync(path.join(repoRoot, "wspec", "principles.md"))) missingSoft.push("wspec/principles.md");

  if (missingHard.length > 0) {
    return {
      name: "wSpec project files",
      status: "fail",
      detail: `missing ${missingHard.join(", ")} — this project has not been set up; run /wspec:setup`
    };
  }
  if (missingSoft.length > 0) {
    return { name: "wSpec project files", status: "warn", detail: `missing ${missingSoft.join(", ")}; run /wspec:setup` };
  }
  return { name: "wSpec project files", status: "ok", detail: "config, templates, schemas, and principles present" };
}

function hookCliPathCheck(repoRoot: string, currentCli: string): DoctorCheck {
  const name = "hook cli path";
  const pathFile = path.join(repoRoot, "wspec", "scripts", "hooks", ".wspec-mcp-cli-path");
  if (!fs.existsSync(pathFile)) {
    // A wSpec checkout has no path file: the shims fall back to the bundle next to them.
    if (fs.existsSync(path.join(repoRoot, "wspec", "mcp", "dist", "cli.js"))) {
      return { name, status: "ok", detail: "shims use this checkout's own bundle" };
    }
    return { name, status: "warn", detail: "wspec/scripts/hooks/.wspec-mcp-cli-path is missing, so the git hooks can't find the plugin; run /wspec:setup" };
  }
  const recorded = fs.readFileSync(pathFile, "utf8").trim();
  if (!fs.existsSync(recorded)) {
    return { name, status: "warn", detail: `git hooks point at ${recorded}, which no longer exists (plugin moved or updated?); run /wspec:setup to refresh` };
  }
  if (currentCli && fs.existsSync(currentCli) && fs.realpathSync(recorded) !== fs.realpathSync(currentCli)) {
    return { name, status: "warn", detail: `git hooks point at ${recorded}, not the running plugin (${currentCli}); run /wspec:setup to refresh` };
  }
  return { name, status: "ok", detail: "git hooks point at the running plugin" };
}

export function runDoctor(repoRoot: string): DoctorReport {
  const checks: DoctorCheck[] = [];

  const git = runCommand("git", ["--version"], repoRoot);
  checks.push({
    name: "git",
    status: git.code === 0 ? "ok" : "fail",
    detail: git.code === 0 ? git.stdout.trim() : "git not found on PATH"
  });

  const gh = runCommand("gh", ["--version"], repoRoot);
  checks.push({
    name: "gh (optional)",
    status: gh.code === 0 ? "ok" : "warn",
    detail: gh.code === 0 ? gh.stdout.trim().split(/\r?\n/)[0] : "gh CLI not found; only needed for post_archive_action: pr on GitHub remotes"
  });

  const glab = runCommand("glab", ["--version"], repoRoot);
  checks.push({
    name: "glab (optional)",
    status: glab.code === 0 ? "ok" : "warn",
    detail: glab.code === 0 ? glab.stdout.trim().split(/\r?\n/)[0] : "glab CLI not found; only needed for post_archive_action: pr on GitLab remotes"
  });

  // The server runs from the plugin's own bundle, never from the project — so this checks that
  // bundle, not <project>/wspec/mcp.
  let cliPath = "";
  try {
    cliPath = pluginCliPath();
    checks.push({
      name: "mcp server bundle",
      status: fs.existsSync(cliPath) ? "ok" : "fail",
      detail: fs.existsSync(cliPath) ? `running from ${cliPath}` : `${cliPath} is missing; reinstall the wspec plugin`
    });
  } catch (error) {
    checks.push({ name: "mcp server bundle", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }

  // Only meaningful in a wSpec checkout, where src sits next to the bundle it builds.
  if (fs.existsSync(path.join(repoRoot, "wspec", "mcp", "src"))) {
    const srcMax = maxMtimeMs(path.join(repoRoot, "wspec", "mcp", "src"));
    const distMax = maxMtimeMs(path.join(repoRoot, "wspec", "mcp", "dist"));
    const stale = srcMax > distMax;
    checks.push({
      name: "mcp dist freshness",
      status: stale ? "warn" : "ok",
      detail: stale ? "wspec/mcp/src is newer than dist; run npm run build in wspec/mcp" : "dist is up to date with src"
    });
  }

  checks.push(projectFilesCheck(repoRoot));

  const hooksPathOut = runCommand("git", ["config", "--get", "core.hooksPath"], repoRoot);
  const hooksPath = hooksPathOut.code === 0 ? hooksPathOut.stdout.trim() : "";
  checks.push({
    name: "git hooksPath",
    status: hooksPath === "wspec/scripts/hooks" ? "ok" : "warn",
    detail: hooksPath
      ? `core.hooksPath=${hooksPath} (expected wspec/scripts/hooks)`
      : "core.hooksPath not set; run /wspec:setup, or hooks are intentionally disabled"
  });

  // The git shims can't use ${CLAUDE_PLUGIN_ROOT}, so /wspec:setup records the plugin's cli.js
  // path in a file next to them. It goes stale when the plugin moves or updates.
  if (hooksPath === "wspec/scripts/hooks") {
    checks.push(hookCliPathCheck(repoRoot, cliPath));
  }

  const caps = getForgeCaps(repoRoot);
  checks.push({
    name: "forge capabilities (ticket mirror)",
    status: !caps.forge ? "warn" : !caps.available || !caps.authed ? "warn" : "ok",
    detail: !caps.forge
      ? (caps.reason ?? "could not determine forge")
      : `${caps.forge} via ${caps.cli} (${caps.confidence})${caps.cli_version ? ` — ${caps.cli_version}` : ""}${caps.reason ? ` — ${caps.reason}` : ""}`
  });

  const stateVerify = verifyState(repoRoot);
  checks.push({
    name: "state.json sync",
    status: stateVerify.in_sync ? "ok" : "warn",
    detail: stateVerify.in_sync ? "in sync" : `drift: ${stateVerify.drift.join(", ")}`
  });

  const principlesPath = path.join(repoRoot, "wspec", "principles.md");
  const lockPath = path.join(repoRoot, "wspec", "principles.lock.json");
  if (fs.existsSync(principlesPath)) {
    const lockFresh = fs.existsSync(lockPath) && fs.statSync(lockPath).mtimeMs >= fs.statSync(principlesPath).mtimeMs;
    checks.push({
      name: "principles lock",
      status: lockFresh ? "ok" : "warn",
      detail: lockFresh ? "wspec/principles.lock.json is fresh" : "principles.lock.json missing or stale; run wspec.lockPrinciples"
    });
  }

  const checksConfig = readChecksConfig(repoRoot);
  if (checksConfig) {
    const { changes: activeForChecks } = listChangeSummaries(repoRoot, undefined, false);
    const neverRun = activeForChecks.filter((change) => !readLatestChecks(repoRoot, change.id));
    checks.push({
      name: "checks: execution evidence",
      status: neverRun.length === 0 ? "ok" : "warn",
      detail:
        neverRun.length === 0
          ? `${Object.keys(checksConfig.commands).length} command(s) declared (${Object.keys(checksConfig.commands).join(", ")})`
          : `${neverRun.length} active change(s) have never run wspec.runChecks: ${neverRun.map((c) => c.id).join(", ")}`
    });
  }

  const { changes } = listChangeSummaries(repoRoot, undefined, false);
  let analysisInvalid = 0;
  let analysisChecked = 0;
  for (const change of changes) {
    const analysisPath = path.join(repoRoot, "wspec", "changes", change.id, "analysis.md");
    if (!fs.existsSync(analysisPath)) continue;
    analysisChecked += 1;
    if (!validateAnalysisFile(analysisPath).valid) analysisInvalid += 1;
  }
  checks.push({
    name: "analysis.md schema",
    status: analysisInvalid === 0 ? "ok" : "warn",
    detail:
      analysisChecked === 0
        ? "no analysis.md files to check"
        : analysisInvalid === 0
          ? `${analysisChecked} change(s) checked, all schema-valid`
          : `${analysisInvalid}/${analysisChecked} change(s) have a schema-invalid analysis.md; run wspec.validateAnalysis`
  });

  const status = checks.reduce<DoctorStatus>((acc, check) => worstOf(acc, check.status), "ok");
  return { status, checks };
}
