import fs from "node:fs";
import path from "node:path";
import { listChangeSummaries } from "./changes.js";
import { readChecksConfig, readLatestChecks } from "./checks.js";
import { getForgeCaps } from "./forgeCaps.js";
import { runCommand } from "./shell.js";
import { maxMtimeMs, verifyState } from "./state.js";
import { validateAnalysisFile } from "./validate.js";

/**
 * Health probe for a wSpec install: tool availability, build freshness, git hook wiring, state
 * index sync, principles lock freshness, and analysis.md schema validity across active changes.
 * Read-only. Intended for `install.ps1`/`install.sh` post-install output and the Stop hook.
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

  const distEntry = path.join(repoRoot, "wspec", "mcp", "dist", "cli.js");
  const distExists = fs.existsSync(distEntry);
  checks.push({
    name: "mcp dist build",
    status: distExists ? "ok" : "fail",
    detail: distExists ? "wspec/mcp/dist/cli.js present" : "wspec/mcp/dist/cli.js missing; run npm run build in wspec/mcp"
  });

  if (distExists) {
    const srcMax = maxMtimeMs(path.join(repoRoot, "wspec", "mcp", "src"));
    const distMax = maxMtimeMs(path.join(repoRoot, "wspec", "mcp", "dist"));
    const stale = srcMax > distMax;
    checks.push({
      name: "mcp dist freshness",
      status: stale ? "warn" : "ok",
      detail: stale ? "wspec/mcp/src is newer than dist; run npm run build in wspec/mcp" : "dist is up to date with src"
    });
  }

  const hooksPathOut = runCommand("git", ["config", "--get", "core.hooksPath"], repoRoot);
  const hooksPath = hooksPathOut.code === 0 ? hooksPathOut.stdout.trim() : "";
  checks.push({
    name: "git hooksPath",
    status: hooksPath === "wspec/scripts/hooks" ? "ok" : "warn",
    detail: hooksPath
      ? `core.hooksPath=${hooksPath} (expected wspec/scripts/hooks)`
      : "core.hooksPath not set; run install.ps1/install.sh, or hooks are intentionally disabled"
  });

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
