import fs from "node:fs";
import path from "node:path";
import { fingerprintFinding, getCurrentBranch, parseAnalysisBlock, readYamlScalars } from "./changes.js";
import { readChecksConfig, readLatestChecks } from "./checks.js";
import { loadState, verifyState, writeStateWithOverrides, type StateOverride } from "./state.js";

export type GateName = "pre-commit" | "pre-push" | "manual";

const DEFAULT_OVERRIDE_TTL_DAYS = 14;
const DAY_MS = 86_400_000;

function changeIdFromBranch(repoRoot: string): string | null {
  const branch = getCurrentBranch(repoRoot);
  if (!branch) return null;
  const match = /^feat\/(\d{3,}-[^/]+)$/.exec(branch);
  return match ? match[1] : null;
}

function resolveChangeId(repoRoot: string, explicit?: string): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  return changeIdFromBranch(repoRoot);
}

function overrideTtlDays(repoRoot: string): number {
  const cfg = readYamlScalars(path.join(repoRoot, "wspec", "config.yaml"));
  const raw = (cfg.override_ttl_days ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OVERRIDE_TTL_DAYS;
}

/** Best-effort audit trail. Shared by the git-hook gates and the PreToolUse guard-edit hook. */
export function appendOverrideLog(repoRoot: string, line: string): void {
  try {
    fs.appendFileSync(path.join(repoRoot, "wspec", "overrides.log"), `${line}\n`, "utf8");
  } catch {
    // Audit log is best-effort.
  }
}

interface FindingBlockingReason {
  kind: "finding";
  id: string;
  severity: string;
  category: string;
  summary: string;
  location: string;
  fingerprint: string;
}

interface CheckBlockingReason {
  kind: "check";
  name: string;
  command: string;
  summary: string | null;
  log_path: string | null;
}

type BlockingReason = FindingBlockingReason | CheckBlockingReason;

export interface GateResult {
  gate: GateName;
  change_id: string | null;
  blocked: boolean;
  blocking_reasons: BlockingReason[];
  warnings: string[];
  overridable: boolean;
  overrides_applied: string[];
}

/**
 * Deterministic block/allow decision for a git gate.
 *
 * - pre-commit BLOCKS on unresolved CRITICAL findings (HIGH is advisory — surfaced as a warning).
 * - pre-push BLOCKS on unresolved CRITICAL/HIGH findings, and WARNS on unfinalized status + stale
 *   state.json (those are publish-readiness signals, not hard blocks, so WIP branch pushes work).
 * - A blocking finding is suppressed when an unexpired override shares its fingerprint.
 */
export function gateCheck(repoRoot: string, gate: GateName, changeId?: string): GateResult {
  const id = resolveChangeId(repoRoot, changeId);
  const result: GateResult = {
    gate,
    change_id: id,
    blocked: false,
    blocking_reasons: [],
    warnings: [],
    overridable: true,
    overrides_applied: []
  };

  if (!id) {
    result.warnings.push("No active change on the current branch; nothing to gate.");
    return result;
  }

  const changeDir = path.join(repoRoot, "wspec", "changes", id);
  if (!fs.existsSync(changeDir)) {
    result.warnings.push(`Change folder not found for '${id}'; nothing to gate.`);
    return result;
  }

  const analysis = parseAnalysisBlock(path.join(changeDir, "analysis.md"));
  const unresolved = analysis.findings.filter((finding) => !finding.resolved);

  const now = Date.now();
  const activeOverrides = loadState(repoRoot).overrides.filter(
    (override) => Date.parse(override.expires_at) > now
  );
  const overriddenFingerprints = new Set(activeOverrides.map((override) => override.fingerprint));

  const blockSeverities = gate === "pre-commit" ? ["CRITICAL"] : ["CRITICAL", "HIGH"];

  for (const finding of unresolved) {
    if (!blockSeverities.includes(finding.severity)) continue;
    const fingerprint = fingerprintFinding(id, finding);
    if (overriddenFingerprints.has(fingerprint)) {
      result.overrides_applied.push(fingerprint);
      continue;
    }
    result.blocking_reasons.push({
      kind: "finding",
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      summary: finding.summary,
      location: finding.location,
      fingerprint
    });
  }

  if (gate === "pre-commit") {
    const advisoryHighs = unresolved.filter(
      (finding) => finding.severity === "HIGH" && !overriddenFingerprints.has(fingerprintFinding(id, finding))
    );
    if (advisoryHighs.length > 0) {
      result.warnings.push(`${advisoryHighs.length} unresolved HIGH finding(s) — these will block on push.`);
    }
  }

  if (gate === "pre-push") {
    const meta = readYamlScalars(path.join(changeDir, "metadata.yaml"));
    const status = (meta.status ?? "").toLowerCase();
    if (status === "implementing" || status === "ready") {
      result.warnings.push(`Change '${id}' is still status=${status}; run /wspec-finalize before publishing complete work.`);
    }
    const verification = verifyState(repoRoot);
    if (!verification.in_sync) {
      result.warnings.push(`state.json out of sync (${verification.drift.join(", ")}); run wspec.syncState.`);
    }

    // Execution-evidence gate. Only activates once checks: is declared in config.yaml — a repo
    // that never configured it sees no change here. Once configured, a change that never ran
    // wspec.runChecks gets a warning (not a hard block, so enabling checks: doesn't retroactively
    // brick a push mid-implementation); a change with a recorded failing required check blocks.
    const checksConfig = readChecksConfig(repoRoot);
    if (checksConfig) {
      const lastChecks = readLatestChecks(repoRoot, id);
      if (!lastChecks) {
        result.warnings.push(
          `checks: configured but wspec.runChecks has not been run for '${id}' yet; not blocking this push, but /wspec-implement will start requiring it.`
        );
      } else if (lastChecks.status === "fail") {
        for (const check of lastChecks.checks) {
          if (check.required && check.status !== "pass") {
            result.blocking_reasons.push({
              kind: "check",
              name: check.name,
              command: check.command,
              summary: check.summary,
              log_path: check.log_path
            });
          }
        }
      }
    }
  }

  result.blocked = result.blocking_reasons.length > 0;
  return result;
}

export interface RecordOverrideArgs {
  gate: GateName;
  findingId: string;
  reason: string;
  changeId?: string;
}

/**
 * Record an override that excuses one specific finding. Bound to the finding's content
 * fingerprint + a TTL, so it auto-revokes when the finding changes/disappears or the TTL lapses.
 */
export function recordOverride(repoRoot: string, args: RecordOverrideArgs) {
  const { gate, findingId, reason } = args;
  if (!reason || !reason.trim()) {
    throw new Error("An override requires a non-empty reason.");
  }

  const id = resolveChangeId(repoRoot, args.changeId);
  if (!id) {
    throw new Error("No change specified and none inferable from the current branch.");
  }

  const changeDir = path.join(repoRoot, "wspec", "changes", id);
  const analysis = parseAnalysisBlock(path.join(changeDir, "analysis.md"));
  const finding = analysis.findings.find((entry) => entry.id === findingId && !entry.resolved);
  if (!finding) {
    throw new Error(`No unresolved finding '${findingId}' found in change '${id}'.`);
  }

  const fingerprint = fingerprintFinding(id, finding);
  const ttlDays = overrideTtlDays(repoRoot);
  const ts = new Date();
  const override: StateOverride = {
    ts: ts.toISOString(),
    gate,
    change: id,
    reason: reason.trim(),
    fingerprint,
    expires_at: new Date(ts.getTime() + ttlDays * DAY_MS).toISOString()
  };

  const existing = loadState(repoRoot).overrides.filter((entry) => entry.fingerprint !== fingerprint);
  existing.push(override);
  const write = writeStateWithOverrides(repoRoot, existing);

  appendOverrideLog(
    repoRoot,
    `${ts.toISOString()} GRANTED gate=${gate} change=${id} finding=${findingId} fingerprint=${fingerprint} ttl_days=${ttlDays} reason="${reason.trim()}"`
  );

  return {
    recorded: write.written,
    override,
    finding: { id: finding.id, severity: finding.severity, category: finding.category },
    write
  };
}
