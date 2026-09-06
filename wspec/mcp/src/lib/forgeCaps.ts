import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectForgeInfo, forgeCli, type Forge } from "./forge.js";
import { runCommand } from "./shell.js";

/**
 * Capability probe for the linked forge (GitHub via gh, GitLab via glab): what CLI is on PATH,
 * whether it's authed, and which ticket-mirror features are actually usable here. Never throws —
 * every ticket operation guards on `caps.available && caps.authed && caps.features.<x>` and
 * degrades to a skipped-with-reason result instead.
 *
 * Cheap by construction: forge/host detection + CLI presence + auth = 3 process spawns, memoized
 * per-process and cached to disk with a 24h TTL, so a long-lived `cli.js serve` process pays this
 * exactly once, and a fresh `cli.js tool ...` invocation (git hooks, bash) pays it once per day.
 */

export interface ForgeCapsFeatures {
  issues: boolean;
  comments: boolean;
  body_update: boolean;
  labels: boolean;
  milestones: boolean;
  /** GitLab only — GitHub issues have no due-date field (only milestone due dates). */
  due_date: boolean;
  /** GitLab quick actions in a note body (/due, /estimate, /spend, /label, /milestone). */
  quick_actions: boolean;
  /** GitHub native sub-issues, gh >= 2.94.0. */
  sub_issues: boolean;
  /** GitHub native; GitLab Premium+ only — starts true, pinned false on first tier-rejection. */
  issue_deps: boolean;
  /** GitHub org repos only — starts true, pinned false on first tier-rejection. */
  issue_types: boolean;
}

export interface ForgeCaps {
  forge: Forge | null;
  confidence: "explicit" | "host-match" | "assumed";
  cli: "gh" | "glab" | null;
  host: string | null;
  available: boolean;
  authed: boolean;
  cli_version: string | null;
  reason: string | null;
  features: ForgeCapsFeatures;
  probed_at: string;
}

const DISABLED_FEATURES: ForgeCapsFeatures = {
  issues: false,
  comments: false,
  body_update: false,
  labels: false,
  milestones: false,
  due_date: false,
  quick_actions: false,
  sub_issues: false,
  issue_deps: false,
  issue_types: false
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const memo = new Map<string, ForgeCaps>();

function cacheDir(repoRoot: string): string {
  return path.join(repoRoot, "wspec", ".cache");
}

function cacheFile(repoRoot: string): string {
  return path.join(cacheDir(repoRoot), "forge-caps.json");
}

function cacheKey(repoRoot: string, explicitForge?: string): string {
  return crypto
    .createHash("sha256")
    .update(`${path.resolve(repoRoot)}|${explicitForge ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

interface DiskCache {
  [key: string]: ForgeCaps;
}

function readDiskCache(repoRoot: string): DiskCache {
  const file = cacheFile(repoRoot);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DiskCache;
  } catch {
    return {};
  }
}

function writeDiskCache(repoRoot: string, key: string, caps: ForgeCaps): void {
  try {
    fs.mkdirSync(cacheDir(repoRoot), { recursive: true });
    const all = readDiskCache(repoRoot);
    all[key] = caps;
    const file = cacheFile(repoRoot);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // Disk cache is a pure optimization — never fail a probe over it.
  }
}

/** gh 2.98.0 / glab 1.116.0 style version strings — pull the first x.y.z. */
function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: [number, number, number] | null, min: [number, number, number]): boolean {
  if (!version) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > min[i]) return true;
    if (version[i] < min[i]) return false;
  }
  return true;
}

function featuresFor(forge: Forge, cliVersion: string | null): ForgeCapsFeatures {
  const version = cliVersion ? parseVersion(cliVersion) : null;
  if (forge === "gitlab") {
    return {
      issues: true,
      comments: true,
      body_update: true,
      labels: true,
      milestones: true,
      due_date: true,
      quick_actions: true,
      sub_issues: false,
      issue_deps: true, // Premium-gated — discovered negatively on first tier-rejection
      issue_types: false
    };
  }
  return {
    issues: true,
    comments: true,
    body_update: true,
    labels: true,
    milestones: true,
    due_date: false,
    quick_actions: false,
    sub_issues: versionAtLeast(version, [2, 94, 0]),
    issue_deps: versionAtLeast(version, [2, 94, 0]),
    issue_types: false // org-repo-only — discovered negatively, stays off for personal repos
  };
}

function probe(repoRoot: string, explicitForge?: string): ForgeCaps {
  const detection = detectForgeInfo(repoRoot);
  const forge = (explicitForge as Forge | undefined) ?? detection.forge;
  const confidence = explicitForge ? "explicit" : detection.confidence;
  const probed_at = new Date().toISOString();

  if (!forge) {
    return {
      forge: null,
      confidence,
      cli: null,
      host: detection.host,
      available: false,
      authed: false,
      cli_version: null,
      reason: "could not determine forge (no origin remote, and no wspec/config.yaml forge: override)",
      features: DISABLED_FEATURES,
      probed_at
    };
  }

  const cli = forgeCli(forge);
  const versionOut = runCommand(cli, ["--version"], repoRoot, { timeoutMs: 5000 });
  if (versionOut.code !== 0) {
    return {
      forge,
      confidence,
      cli,
      host: detection.host,
      available: false,
      authed: false,
      cli_version: null,
      reason: `${cli} CLI not found on PATH`,
      features: DISABLED_FEATURES,
      probed_at
    };
  }

  const cli_version = versionOut.stdout.trim().split(/\r?\n/)[0] ?? null;

  const authOut = runCommand(cli, ["auth", "status"], repoRoot, { timeoutMs: 8000 });
  if (authOut.code !== 0) {
    return {
      forge,
      confidence,
      cli,
      host: detection.host,
      available: true,
      authed: false,
      cli_version,
      reason: `${cli} is installed but not authenticated (${cli} auth login)`,
      features: DISABLED_FEATURES,
      probed_at
    };
  }

  return {
    forge,
    confidence,
    cli,
    host: detection.host,
    available: true,
    authed: true,
    cli_version,
    reason: null,
    features: featuresFor(forge, cli_version),
    probed_at
  };
}

/**
 * Get (or refresh) capabilities for the forge linked to this repo. Never throws — every failure
 * mode collapses into `{ available: false }` or `{ authed: false }` with a human-readable
 * `reason`, and every feature flag false.
 */
export function getForgeCaps(repoRoot: string, explicitForge?: string, opts?: { refresh?: boolean }): ForgeCaps {
  const key = cacheKey(repoRoot, explicitForge);

  if (!opts?.refresh) {
    const inMemory = memo.get(key);
    if (inMemory) return inMemory;

    const disk = readDiskCache(repoRoot)[key];
    if (disk && Date.now() - Date.parse(disk.probed_at) < CACHE_TTL_MS) {
      memo.set(key, disk);
      return disk;
    }
  }

  let caps: ForgeCaps;
  try {
    caps = probe(repoRoot, explicitForge);
  } catch (error) {
    caps = {
      forge: null,
      confidence: "assumed",
      cli: null,
      host: null,
      available: false,
      authed: false,
      cli_version: null,
      reason: error instanceof Error ? error.message : String(error),
      features: DISABLED_FEATURES,
      probed_at: new Date().toISOString()
    };
  }

  memo.set(key, caps);
  writeDiskCache(repoRoot, key, caps);
  return caps;
}

/**
 * Pin a tier-gated feature (GitLab Premium dependencies, GitHub org-only issue types) to `false`
 * for this repo after a live forge call rejects it — e.g. a 403 mentioning "premium"/"ultimate".
 * Cheaper than probing tier up front: the common case never pays for a check nobody needed.
 */
export function noteFeatureUnsupported(
  repoRoot: string,
  feature: keyof ForgeCapsFeatures,
  evidence: string,
  explicitForge?: string
): void {
  const key = cacheKey(repoRoot, explicitForge);
  const current = memo.get(key) ?? readDiskCache(repoRoot)[key];
  if (!current) return;

  const updated: ForgeCaps = {
    ...current,
    features: { ...current.features, [feature]: false },
    reason: current.reason ?? `feature '${feature}' unsupported: ${evidence}`
  };
  memo.set(key, updated);
  writeDiskCache(repoRoot, key, updated);
}
