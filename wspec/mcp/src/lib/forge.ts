import path from "node:path";
import { readYamlScalars } from "./changes.js";
import { runCommand } from "./shell.js";

export type Forge = "github" | "gitlab";

export function detectForge(repoRoot: string): Forge {
  const remote = runCommand("git", ["remote", "get-url", "origin"], repoRoot);
  const url = remote.code === 0 ? remote.stdout.trim().toLowerCase() : "";
  // github.com is the only host we treat as GitHub; every other remote (gitlab.com,
  // self-hosted GitLab, bare IPs) is assumed to be GitLab since that's the only other
  // forge in use across these repos.
  if (/(^|[@/.])github\.com([:/]|$)/.test(url)) return "github";
  return "gitlab";
}

export function resolveForge(repoRoot: string, explicit?: string): Forge {
  const requested = (explicit ?? "").trim().toLowerCase();
  if (requested === "github" || requested === "gitlab") return requested;

  const cfg = readYamlScalars(path.join(repoRoot, "wspec", "config.yaml"));
  const fromConfig = (cfg.forge ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (fromConfig === "github" || fromConfig === "gitlab") return fromConfig;

  return detectForge(repoRoot);
}

export interface ForgeDetection {
  forge: Forge | null;
  host: string | null;
  confidence: "explicit" | "host-match" | "assumed";
}

/**
 * Richer detection than {@link detectForge}/{@link resolveForge}: those two always return a
 * concrete `Forge`, which is the right contract for their six existing call sites (they need a
 * CLI to shell out to no matter what). But that means a repo with no `origin` — or no `origin`
 * named remote at all — silently lands on the "gitlab" fallback rather than admitting it
 * couldn't tell. wSpec's own repo is exactly this shape: remotes named `github-public` and
 * `gitlab`, no `origin`.
 *
 * This function is additive on purpose — it does not change `detectForge`/`resolveForge` — and
 * is the only thing the ticket-mirror feature consults. It enumerates every remote, prefers
 * `origin`, and is honest about "assumed" vs. actually matched, so the ticket layer can refuse to
 * act on a forge it only guessed at instead of silently mirroring to the wrong tracker.
 */
export function detectForgeInfo(repoRoot: string): ForgeDetection {
  const cfg = readYamlScalars(path.join(repoRoot, "wspec", "config.yaml"));
  const fromConfig = (cfg.forge ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (fromConfig === "github" || fromConfig === "gitlab") {
    return { forge: fromConfig, host: null, confidence: "explicit" };
  }

  const remotesOut = runCommand("git", ["remote", "-v"], repoRoot);
  if (remotesOut.code !== 0 || !remotesOut.stdout.trim()) {
    return { forge: null, host: null, confidence: "assumed" };
  }

  const urlsByName = new Map<string, string>();
  for (const line of remotesOut.stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match) urlsByName.set(match[1], match[2]);
  }

  const classify = (url: string): { forge: Forge; host: string | null } | null => {
    const lower = url.toLowerCase();
    const hostMatch = /^(?:[a-z]+:\/\/)?(?:[^@/]+@)?([^/:]+)/.exec(lower);
    const host = hostMatch ? hostMatch[1] : null;
    if (/(^|[@/.])github\.com([:/]|$)/.test(lower)) return { forge: "github", host: host ?? "github.com" };
    if (/gitlab/.test(lower)) return { forge: "gitlab", host };
    return null;
  };

  const ordered = [
    ...(urlsByName.has("origin") ? [["origin", urlsByName.get("origin") as string] as const] : []),
    ...Array.from(urlsByName.entries()).filter(([name]) => name !== "origin")
  ];

  for (const [, url] of ordered) {
    const hit = classify(url);
    if (hit) return { forge: hit.forge, host: hit.host, confidence: "host-match" };
  }

  // Remotes exist but none matched a known forge (self-hosted under an unrecognized name/host) —
  // preserve today's "assume gitlab" behavior for this case, since that's the only other forge
  // in use across these repos, but keep it labeled "assumed" rather than a real match.
  return { forge: "gitlab", host: null, confidence: "assumed" };
}

export function forgeCli(forge: Forge): "gh" | "glab" {
  return forge === "gitlab" ? "glab" : "gh";
}

export function vcsReady(cli: "gh" | "glab", repoRoot: string): { ok: boolean; reason: string | null } {
  const which = runCommand(cli, ["--version"], repoRoot);
  if (which.code !== 0) {
    return { ok: false, reason: `${cli} CLI not found on PATH` };
  }

  const auth = runCommand(cli, ["auth", "status"], repoRoot);
  if (auth.code !== 0) {
    return { ok: false, reason: `${cli} is installed but not authenticated (${cli} auth login)` };
  }

  return { ok: true, reason: null };
}
