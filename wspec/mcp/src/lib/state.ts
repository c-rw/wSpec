import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  fingerprintFinding,
  getCurrentBranch,
  listChangeSummaries,
  loadChangeContext,
  parseAnalysisBlock
} from "./changes.js";
import { loadUsageLedger, rollupForState, type TokenTotals } from "./usage.js";

export const STATE_SCHEMA_VERSION = "1.0";
const LOCK_STALE_MS = 5000;
const LOCK_MAX_ATTEMPTS = 2;

export interface StateOverride {
  ts: string;
  gate: string;
  change: string;
  reason: string;
  fingerprint: string;
  expires_at: string;
}

interface StatePhase {
  num: number;
  title: string;
  total: number;
  done: number;
  complete: boolean;
}

interface StateActiveChange {
  id: string;
  title: string | null;
  status: string | null;
  branch: string | null;
  capability: string | null;
  tasks: { total: number; done: number; pending: number };
  phases: StatePhase[];
  next_phase: { num: number; title: string } | null;
  pending_task_ids: string[];
  unresolved_finding_ids: string[];
  blocking_finding_ids: string[];
  usage: { tokens: TokenTotals; cost_usd: number } | null;
}

interface StateArchivedChange {
  id: string;
  date: string;
}

export interface WspecState {
  schema_version: string;
  generated_at: string;
  source_mtime_max: number;
  current_branch: string | null;
  active: StateActiveChange[];
  archived: StateArchivedChange[];
  overrides: StateOverride[];
  last_session: unknown;
}

function statePath(repoRoot: string): string {
  return path.join(repoRoot, "wspec", "state.json");
}

function readStateFile(repoRoot: string): WspecState | null {
  const file = statePath(repoRoot);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as WspecState;
  } catch {
    return null;
  }
}

/** Exported for reuse by doctor.ts's dist-freshness check. */
export function maxMtimeMs(targetPath: string): number {
  let max = 0;
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.mtimeMs > max) {
      max = stat.mtimeMs;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    }
  }
  return max;
}

function computeSourceMtimeMax(repoRoot: string): number {
  const targets = [
    path.join(repoRoot, "wspec", "changes"),
    path.join(repoRoot, "wspec", "archive"),
    path.join(repoRoot, "wspec", "principles.md")
  ];
  return targets.reduce((acc, target) => Math.max(acc, maxMtimeMs(target)), 0);
}

function listArchived(repoRoot: string): StateArchivedChange[] {
  const archiveDir = path.join(repoRoot, "wspec", "archive");
  if (!fs.existsSync(archiveDir)) {
    return [];
  }
  const out: StateArchivedChange[] = [];
  for (const entry of fs.readdirSync(archiveDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(entry.name);
    if (!match) continue;
    out.push({ date: match[1], id: match[2] });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Rebuild the central state index purely from the filesystem.
 *
 * The derivable parts (active changes, archived changes) come from disk every time, so this
 * function is idempotent and last-writer-wins is correct. Non-derivable state authored by other
 * tools — `overrides` (WS2) and `last_session` — is carried forward from the existing committed
 * index so a rebuild never loses it.
 */
export function rebuildState(repoRoot: string): WspecState {
  const previous = readStateFile(repoRoot);
  const { changes } = listChangeSummaries(repoRoot);

  const liveFingerprints = new Set<string>();
  const active: StateActiveChange[] = changes.map((summary) => {
    const ctx = loadChangeContext(repoRoot, summary.id);
    const analysis = parseAnalysisBlock(path.join(repoRoot, "wspec", "changes", summary.id, "analysis.md"));
    const unresolved = analysis.findings.filter((finding) => !finding.resolved);
    for (const finding of unresolved) {
      liveFingerprints.add(fingerprintFinding(summary.id, finding));
    }
    const blocking = unresolved.filter(
      (finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH"
    );

    const usageLedger = loadUsageLedger(repoRoot, summary.id);
    const usage = usageLedger.segments.length > 0 ? rollupForState(usageLedger) : null;

    return {
      id: ctx.id,
      title: ctx.title ?? null,
      status: ctx.status ?? null,
      branch: ctx.branch ?? null,
      capability: ctx.capability ?? null,
      tasks: ctx.tasks,
      phases: ctx.phases,
      next_phase: ctx.next_phase ? { num: ctx.next_phase.num, title: ctx.next_phase.title } : null,
      pending_task_ids: ctx.next_phase ? ctx.next_phase.pending_tasks.map((task) => task.id) : [],
      unresolved_finding_ids: unresolved.map((finding) => finding.id),
      blocking_finding_ids: blocking.map((finding) => finding.id),
      usage
    };
  });

  // Zombie pruning: an override survives only while a live unresolved finding still shares its
  // fingerprint and its TTL has not lapsed. A re-architected/renamed finding changes its
  // fingerprint, so its override is dropped automatically here on the next rebuild.
  const now = Date.now();
  const carried = Array.isArray(previous?.overrides) ? (previous?.overrides as StateOverride[]) : [];
  const overrides = carried.filter(
    (override) => Date.parse(override.expires_at) > now && liveFingerprints.has(override.fingerprint)
  );

  return {
    schema_version: STATE_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source_mtime_max: computeSourceMtimeMax(repoRoot),
    current_branch: getCurrentBranch(repoRoot),
    active,
    archived: listArchived(repoRoot),
    overrides,
    last_session: previous?.last_session ?? null
  };
}

function logOverrideEvents(repoRoot: string, lines: string[]): void {
  if (lines.length === 0) return;
  try {
    const logPath = path.join(repoRoot, "wspec", "overrides.log");
    fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Audit log is best-effort; never fail a write over it.
  }
}

function tryAcquireLock(lockPath: string, attempt = 1): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, `${process.pid}`);
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    if (attempt >= LOCK_MAX_ATTEMPTS) {
      return false;
    }
    // Reclaim a stale lock (holder crashed) and retry once.
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
      } else {
        return false;
      }
    } catch {
      // Lock vanished between open and stat — fall through to retry.
    }
    return tryAcquireLock(lockPath, attempt + 1);
  }
}

export interface WriteStateResult {
  written: boolean;
  reason: "ok" | "locked" | "fresh" | "error";
  error: string | null;
  state: WspecState | null;
}

/**
 * Atomically publish the rebuilt index to wspec/state.json.
 *
 * - Exclusive lock with stale reclaim, skip-don't-wait (never blocks the caller).
 * - Freshness guard: skip if the committed index already reflects an equal-or-newer source mtime,
 *   unless `force` is set (used by wspec.syncState and override writes).
 * - Atomic publish via temp file + rename so readers never observe a partial file.
 */
export function writeState(repoRoot: string, opts: { force?: boolean } = {}): WriteStateResult {
  const file = statePath(repoRoot);
  const lockPath = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (!tryAcquireLock(lockPath)) {
    return { written: false, reason: "locked", error: null, state: null };
  }

  try {
    const committed = readStateFile(repoRoot);
    const next = rebuildState(repoRoot);

    if (!opts.force) {
      if (committed && typeof committed.source_mtime_max === "number" && committed.source_mtime_max >= next.source_mtime_max) {
        return { written: false, reason: "fresh", error: null, state: committed };
      }
    }

    if (committed && Array.isArray(committed.overrides)) {
      const survivors = new Set(next.overrides.map((override) => override.fingerprint));
      const pruned = committed.overrides.filter((override) => !survivors.has(override.fingerprint));
      logOverrideEvents(
        repoRoot,
        pruned.map(
          (override) =>
            `${new Date().toISOString()} PRUNED gate=${override.gate} change=${override.change} fingerprint=${override.fingerprint} reason="finding resolved/changed or TTL expired"`
        )
      );
    }

    const tmp = path.join(
      path.dirname(file),
      `.state.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
    );
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return { written: true, reason: "ok", error: null, state: next };
  } catch (error) {
    return { written: false, reason: "error", error: error instanceof Error ? error.message : String(error), state: null };
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/**
 * Best-effort index refresh wired into mutating tools. A failure here must never fail the
 * underlying mutation — the next mutation or wspec.syncState reconciles the index.
 */
export function writeStateBestEffort(repoRoot: string): void {
  try {
    const result = writeState(repoRoot);
    if (!result.written && result.reason === "error" && result.error) {
      process.stderr.write(`[wspec] state index update skipped: ${result.error}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[wspec] state index update skipped: ${message}\n`);
  }
}

/**
 * Persist an explicit overrides list (used by recordOverride). Rebuilds the derivable index from
 * disk, then replaces the overrides field with the caller-validated set and publishes atomically.
 */
export function writeStateWithOverrides(repoRoot: string, overrides: StateOverride[]): WriteStateResult {
  const file = statePath(repoRoot);
  const lockPath = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (!tryAcquireLock(lockPath)) {
    return { written: false, reason: "locked", error: null, state: null };
  }

  try {
    const next = rebuildState(repoRoot);
    next.overrides = overrides;
    const tmp = path.join(
      path.dirname(file),
      `.state.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
    );
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return { written: true, reason: "ok", error: null, state: next };
  } catch (error) {
    return { written: false, reason: "error", error: error instanceof Error ? error.message : String(error), state: null };
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

export function loadState(repoRoot: string): WspecState {
  const existing = readStateFile(repoRoot);
  if (existing) {
    return existing;
  }
  // No committed index yet — rebuild in memory (do not force a write on a read path).
  return rebuildState(repoRoot);
}

/**
 * One-line status banner for the Claude Code statusLine / SessionStart hook. Reads the committed
 * index only (fast, no rebuild) and returns "" when there is nothing to show.
 */
export function formatStateBanner(repoRoot: string): string {
  const state = readStateFile(repoRoot);
  const active = state?.active ?? [];
  if (active.length === 0) {
    return "";
  }
  if (active.length === 1) {
    const change = active[0];
    const progress = change.next_phase
      ? `phase ${change.next_phase.num}/${change.phases.length}`
      : `${change.tasks.done}/${change.tasks.total} tasks`;
    const blockers = change.blocking_finding_ids.length;
    const blockerNote = blockers > 0 ? ` · ${blockers} blocking finding(s)` : "";
    // change.usage is absent on a state.json committed before usage tracking existed — guard.
    const cost = change.usage?.cost_usd;
    const costNote = cost && cost > 0 ? ` · ~$${cost.toFixed(2)}` : "";
    return `wspec: ${change.id} · ${change.status ?? "?"} · ${progress}${blockerNote}${costNote}`;
  }
  return `wspec: ${active.length} active changes (${active.map((change) => change.id).join(", ")})`;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export interface VerifyStateResult {
  in_sync: boolean;
  committed: boolean;
  drift: string[];
}

/**
 * Rebuild in memory and diff against the committed index (ignoring the volatile generated_at
 * timestamp). Used by hooks/CI to detect a stale or hand-edited state.json.
 */
export function verifyState(repoRoot: string): VerifyStateResult {
  const committed = readStateFile(repoRoot);
  if (!committed) {
    return { in_sync: false, committed: false, drift: ["state.json missing — run wspec.syncState"] };
  }

  const fresh = rebuildState(repoRoot);
  const drift: string[] = [];
  const keys: Array<keyof WspecState> = [
    "schema_version",
    "source_mtime_max",
    "current_branch",
    "active",
    "archived",
    "overrides"
  ];

  for (const key of keys) {
    if (canonical(fresh[key]) !== canonical(committed[key])) {
      drift.push(String(key));
    }
  }

  return { in_sync: drift.length === 0, committed: true, drift };
}
