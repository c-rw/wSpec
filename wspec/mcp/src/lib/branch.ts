/**
 * Feature-branch naming and numbering.
 *
 * The branch-numbering algorithm (scan branches + directories for the highest `NNN-` prefix),
 * the stop-word list used to derive a short name from a free-text description, and the
 * BRANCH_NAME/FEATURE_NUM/HAS_GIT output shape are a TypeScript port of
 * scripts/powershell/create-new-feature.ps1 in GitHub Spec Kit
 * (https://github.com/github/spec-kit), MIT licensed. See THIRD-PARTY-NOTICES.md.
 * Extended for wSpec with existing-branch handling and the WSPEC_OVERRIDE_REASON override.
 */
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./shell.js";

function kebabName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
}

function shortNameFromDescription(description: string): string {
  const stopWords = new Set([
    "i",
    "a",
    "an",
    "the",
    "to",
    "for",
    "of",
    "in",
    "on",
    "at",
    "by",
    "with",
    "from",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "should",
    "could",
    "can",
    "may",
    "might",
    "must",
    "this",
    "that",
    "these",
    "those",
    "my",
    "your",
    "our",
    "their",
    "want",
    "need",
    "add",
    "get",
    "set",
    "create",
    "build",
    "make"
  ]);

  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w.length >= 3 && !stopWords.has(w));

  if (words.length > 0) {
    return words.slice(0, 4).join("-");
  }

  return kebabName(description)
    .split("-")
    .slice(0, 3)
    .join("-");
}

function highestFromNames(names: string[]): number {
  let highest = 0;
  for (const name of names) {
    const cleaned = name.replace(/^feat\//, "");
    const match = /^(\d{3,})-/.exec(cleaned);
    if (!match) continue;

    const value = Number.parseInt(match[1], 10);
    if (!Number.isNaN(value) && value > highest) {
      highest = value;
    }
  }
  return highest;
}

function highestFromDirectory(dir: string): number {
  if (!fs.existsSync(dir)) {
    return 0;
  }

  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .map((name) => {
      const archiveMatch = /^\d{4}-\d{2}-\d{2}-(\d{3,})-/.exec(name);
      if (archiveMatch) return `${archiveMatch[1]}-`;
      return name;
    });

  return highestFromNames(names);
}

function highestFromGit(repoRoot: string): number {
  const branches = runCommand("git", ["branch", "-a"], repoRoot);
  if (branches.code !== 0) {
    return 0;
  }

  const names = branches.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s+/, ""))
    .filter(Boolean)
    .map((line) => line.replace(/^remotes\/[^/]+\//, ""));

  return highestFromNames(names);
}

function nextNumber(repoRoot: string): number {
  const changesDir = path.join(repoRoot, "wspec", "changes");
  const archiveDir = path.join(repoRoot, "wspec", "archive");

  const max = Math.max(highestFromDirectory(changesDir), highestFromDirectory(archiveDir), highestFromGit(repoRoot));
  return max + 1;
}

function hasGit(repoRoot: string): boolean {
  const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], repoRoot);
  return result.code === 0 && result.stdout.trim() === "true";
}

export function createFeatureBranch(
  repoRoot: string,
  featureDescription: string,
  shortName?: string,
  dryRun = false,
  allowExistingBranch = false
) {
  const envBranch = process.env.WSPEC_BRANCH_NAME;
  let branchName: string;
  let changeId: string;
  let featureNum: string;

  if (envBranch) {
    branchName = envBranch;
    const match = /^feat\/(\d{3,})-(.+)$/.exec(branchName);
    if (match) {
      featureNum = match[1];
      changeId = `${featureNum}-${match[2]}`;
    } else {
      featureNum = branchName;
      changeId = branchName;
    }
  } else {
    const suffix = kebabName(shortName ?? shortNameFromDescription(featureDescription));
    featureNum = String(nextNumber(repoRoot)).padStart(3, "0");
    changeId = `${featureNum}-${suffix}`;
    branchName = `feat/${changeId}`;
  }

  const repoHasGit = hasGit(repoRoot);

  if (!dryRun && repoHasGit) {
    const existing = runCommand("git", ["branch", "--list", branchName], repoRoot);
    const exists = existing.code === 0 && existing.stdout.trim().length > 0;

    if (exists) {
      if (!allowExistingBranch) {
        throw new Error(`Branch '${branchName}' already exists. Use allowExistingBranch to switch to it or choose a different name.`);
      }

      const checkout = runCommand("git", ["checkout", "-q", branchName], repoRoot);
      if (checkout.code !== 0) {
        throw new Error(`Branch '${branchName}' exists but could not be checked out.`);
      }
    } else {
      const created = runCommand("git", ["checkout", "-q", "-b", branchName], repoRoot);
      if (created.code !== 0) {
        throw new Error(`Failed to create git branch '${branchName}'.`);
      }
    }
  }

  return {
    BRANCH_NAME: branchName,
    CHANGE_ID: changeId,
    FEATURE_NUM: featureNum,
    HAS_GIT: repoHasGit,
    DRY_RUN: Boolean(dryRun)
  };
}
