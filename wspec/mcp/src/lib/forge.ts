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
