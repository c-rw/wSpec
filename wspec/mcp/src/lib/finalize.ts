import fs from "node:fs";
import path from "node:path";
import { assertChangeBranch, readYamlScalars, resolveChangeDir, upsertMetadataScalars } from "./changes.js";
import { forgeCli, resolveForge, vcsReady, type Forge } from "./forge.js";
import { runCommand } from "./shell.js";
import { appendUsageLogLine, loadUsageLedgerFromDir, rollupLedger } from "./usage.js";

function readSections(specPath: string): Record<string, string> {
  const sections: Record<string, string> = {};
  if (!fs.existsSync(specPath)) {
    return sections;
  }

  let current = "__preamble__";
  let buffer: string[] = [];
  const lines = fs.readFileSync(specPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (/^#{1,6}\s+.+\s*$/.test(line)) {
      sections[current] = buffer.join("\n");
      current = line.trim();
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  sections[current] = buffer.join("\n");
  return sections;
}

export function syncSpec(repoRoot: string, id: string, apply = false) {
  assertChangeBranch(repoRoot, id, apply ? "sync specs" : "inspect spec sync status");

  const changeDir = path.join(repoRoot, "wspec", "changes", id);
  if (!fs.existsSync(changeDir)) {
    throw new Error(`Change not found: ${id}`);
  }

  const deltaSpecsDir = path.join(changeDir, "specs");
  const capabilities: Array<{
    name: string;
    delta_path: string;
    target_path: string;
    target_exists: boolean;
    added_sections: string[];
    removed_sections: string[];
    modified_sections: string[];
    in_sync: boolean;
    applied: boolean;
    error: string | null;
  }> = [];

  if (fs.existsSync(deltaSpecsDir)) {
    const capDirs = fs.readdirSync(deltaSpecsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const capDir of capDirs) {
      const deltaPath = path.join(deltaSpecsDir, capDir.name, "spec.md");
      if (!fs.existsSync(deltaPath)) continue;

      const targetPath = path.join(repoRoot, "wspec", "specs", capDir.name, "spec.md");
      const targetExists = fs.existsSync(targetPath);

      const deltaSections = readSections(deltaPath);
      const targetSections = targetExists ? readSections(targetPath) : {};

      const addedSections: string[] = [];
      const removedSections: string[] = [];
      const modifiedSections: string[] = [];

      for (const key of Object.keys(deltaSections)) {
        if (key === "__preamble__") continue;
        if (!(key in targetSections)) {
          addedSections.push(key);
        } else if (targetSections[key] !== deltaSections[key]) {
          modifiedSections.push(key);
        }
      }

      for (const key of Object.keys(targetSections)) {
        if (key === "__preamble__") continue;
        if (!(key in deltaSections)) {
          removedSections.push(key);
        }
      }

      let applied = false;
      let error: string | null = null;
      if (apply) {
        try {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.copyFileSync(deltaPath, targetPath);
          applied = true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }

      capabilities.push({
        name: capDir.name,
        delta_path: `wspec/changes/${id}/specs/${capDir.name}/spec.md`,
        target_path: `wspec/specs/${capDir.name}/spec.md`,
        target_exists: targetExists,
        added_sections: addedSections,
        removed_sections: removedSections,
        modified_sections: modifiedSections,
        in_sync: addedSections.length === 0 && removedSections.length === 0 && modifiedSections.length === 0,
        applied,
        error
      });
    }
  }

  return {
    change_id: id,
    has_deltas: capabilities.length > 0,
    apply,
    capabilities
  };
}

function hasGitWorktree(repoRoot: string): boolean {
  const out = runCommand("git", ["rev-parse", "--is-inside-work-tree"], repoRoot);
  return out.code === 0 && out.stdout.trim() === "true";
}

export function archiveChange(repoRoot: string, id: string, dryRun = false) {
  assertChangeBranch(repoRoot, id, dryRun ? "prepare archive" : "archive change");

  const source = path.join(repoRoot, "wspec", "changes", id);
  if (!fs.existsSync(source)) {
    throw new Error(`Change not found: ${id}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const targetName = `${today}-${id}`;
  const archiveRoot = path.join(repoRoot, "wspec", "archive");
  const target = path.join(archiveRoot, targetName);
  const targetExists = fs.existsSync(target);

  let moved = false;
  let moveStrategy: string | null = null;
  let error: string | null = null;

  if (!dryRun) {
    if (targetExists) {
      error = `Archive target already exists: wspec/archive/${targetName}`;
    } else {
      try {
        fs.mkdirSync(archiveRoot, { recursive: true });
        const useGitMv = hasGitWorktree(repoRoot);

        if (useGitMv) {
          const relSource = `wspec/changes/${id}`;
          const relTarget = `wspec/archive/${targetName}`;
          const mv = runCommand("git", ["mv", "--", relSource, relTarget], repoRoot);
          if (mv.code !== 0) {
            fs.renameSync(source, target);
            moveStrategy = "move-item-fallback";
          } else {
            moveStrategy = "git-mv";
          }
        } else {
          fs.renameSync(source, target);
          moveStrategy = "move-item";
        }

        moved = true;

        const metadataPath = path.join(target, "metadata.yaml");
        if (fs.existsSync(metadataPath)) {
          upsertMetadataScalars(metadataPath, { status: "done", updated: today, completed: today });
        }

        // Fold this change's usage.json (now living at its archived path) into the durable
        // repo-level rollup log. Best-effort: appendUsageLogLine never throws, and a change with
        // no recorded segments (e.g. usage tracking wasn't wired up yet, or nothing ran) just
        // contributes nothing rather than a zeroed-out row.
        const usageLedger = loadUsageLedgerFromDir(target);
        if (usageLedger.segments.length > 0) {
          const rollup = rollupLedger(usageLedger);
          const finalMetadata = fs.existsSync(metadataPath) ? readYamlScalars(metadataPath) : {};
          appendUsageLogLine(repoRoot, {
            id,
            title: finalMetadata.title ?? null,
            archived_at: today,
            tokens: rollup.tokens,
            cost_usd: rollup.cost_usd,
            by_model: rollup.by_model,
            segment_count: usageLedger.segments.length
          });
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    source: `wspec/changes/${id}`,
    target: `wspec/archive/${targetName}`,
    target_exists: targetExists,
    dry_run: dryRun,
    moved,
    move_strategy: moveStrategy,
    error
  };
}

function resolveDefaultBranch(repoRoot: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();

  const originHead = runCommand("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (originHead.code === 0 && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^origin\//, "");
  }

  for (const fallback of ["main", "master"]) {
    const check = runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${fallback}`], repoRoot);
    if (check.code === 0) return fallback;
  }

  throw new Error("Could not determine default branch (no origin/HEAD and no main/master).");
}

function resolvePostArchiveAction(repoRoot: string, action?: string): "none" | "pr" | "merge" {
  const explicit = (action ?? "").trim().toLowerCase();
  if (explicit === "none" || explicit === "pr" || explicit === "merge") {
    return explicit;
  }

  const cfg = readYamlScalars(path.join(repoRoot, "wspec", "config.yaml"));
  const fromConfig = (cfg.post_archive_action ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (fromConfig === "none" || fromConfig === "pr" || fromConfig === "merge") {
    return fromConfig;
  }

  return "none";
}

function resolveChangeTitle(repoRoot: string, id: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();

  const resolved = resolveChangeDir(repoRoot, id);
  if (resolved) {
    const parsed = readYamlScalars(path.join(resolved.dir, "metadata.yaml"));
    if (parsed.title) return parsed.title;
  }

  return id;
}

export function postArchiveAction(
  repoRoot: string,
  id: string,
  action?: string,
  title?: string,
  defaultBranch?: string,
  deleteBranch = false,
  push = false,
  dryRun = false,
  forge?: string
) {
  const resolved = resolveChangeDir(repoRoot, id);
  if (resolved && !resolved.archived) {
    assertChangeBranch(repoRoot, id, `run post-archive action '${action ?? "auto"}'`);
  } else if (resolved?.archived) {
    const archivedMetadata = readYamlScalars(path.join(resolved.dir, "metadata.yaml"));
    const expectedBranch = archivedMetadata.branch?.trim();
    const branchRes = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    const currentBranch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
    if (expectedBranch && currentBranch && currentBranch !== expectedBranch) {
      throw new Error(
        `Refusing to run post-archive action for change '${id}' on branch '${currentBranch}'. Expected branch '${expectedBranch}'. Switch to the change branch and retry.`
      );
    }
  }

  const resolvedAction = resolvePostArchiveAction(repoRoot, action);
  const branchRes = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (branchRes.code !== 0) {
    throw new Error(`Unable to resolve current branch: ${branchRes.stderr || branchRes.stdout}`);
  }

  const branch = branchRes.stdout.trim();
  const resolvedTitle = resolveChangeTitle(repoRoot, id, title);

  const result: {
    id: string;
    action: "none" | "pr" | "merge";
    branch: string;
    default_branch: string | null;
    title: string;
    dry_run: boolean;
    forge: Forge | null;
    pr_url: string | null;
    pushed_branch: boolean;
    merged: boolean;
    pushed_default: boolean;
    branch_deleted: boolean;
    skipped_reason: string | null;
    error: string | null;
    // Where HEAD actually ends up. A "merge" action checks out the default branch to perform the
    // merge; if the feature branch survives (deleteBranch=false) we check back out to it so
    // follow-up wspec commands on this branch don't fail assertChangeBranch unexpectedly. Callers
    // should trust this field over assuming `branch` is still checked out.
    current_branch: string;
  } = {
    id,
    action: resolvedAction,
    branch,
    default_branch: null,
    title: resolvedTitle,
    dry_run: dryRun,
    forge: null,
    pr_url: null,
    pushed_branch: false,
    merged: false,
    pushed_default: false,
    branch_deleted: false,
    skipped_reason: null,
    error: null,
    current_branch: branch
  };

  try {
    if (resolvedAction === "none") {
      result.skipped_reason = "action=none";
      return result;
    }

    const resolvedDefaultBranch = resolveDefaultBranch(repoRoot, defaultBranch);
    result.default_branch = resolvedDefaultBranch;

    if (branch === resolvedDefaultBranch) {
      throw new Error(`Refusing to act: HEAD is already on the default branch (${resolvedDefaultBranch}).`);
    }

    if (resolvedAction === "pr") {
      const resolvedForge = resolveForge(repoRoot, forge);
      const cli = forgeCli(resolvedForge);
      result.forge = resolvedForge;

      const vcs = vcsReady(cli, repoRoot);
      if (!vcs.ok) {
        throw new Error(vcs.reason ?? `${cli} unavailable`);
      }

      if (!dryRun) {
        const upstream = runCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoRoot);
        if (upstream.code !== 0) {
          const pushSet = runCommand("git", ["push", "-u", "origin", branch], repoRoot);
          if (pushSet.code !== 0) {
            throw new Error(`Failed to push branch with upstream: ${pushSet.stderr || pushSet.stdout}`);
          }
          result.pushed_branch = true;
        }

        const body = `Finalized via /wspec-finalize.\n\n- Change: ${id}\n- Archive: wspec/archive/${new Date().toISOString().slice(0, 10)}-${id}/\n`;
        const createArgs =
          cli === "gh"
            ? ["pr", "create", "--base", resolvedDefaultBranch, "--head", branch, "--title", `feat(${id}): ${resolvedTitle}`, "--body", body]
            : [
                "mr",
                "create",
                "--target-branch",
                resolvedDefaultBranch,
                "--source-branch",
                branch,
                "--title",
                `feat(${id}): ${resolvedTitle}`,
                "--description",
                body,
                "--yes"
              ];
        const pr = runCommand(cli, createArgs, repoRoot);
        if (pr.code !== 0) {
          throw new Error(`${cli} ${cli === "gh" ? "pr create" : "mr create"} failed: ${pr.stderr || pr.stdout}`);
        }

        const url = `${pr.stdout}\n${pr.stderr}`
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^https?:\/\//.test(line))
          .pop();
        result.pr_url = url ?? null;

        // Persist so the ticket-mirror render stays a pure function of packet state — passing
        // this URL in as transient render data would make it vanish on the next re-render.
        if (result.pr_url) {
          const target = resolveChangeDir(repoRoot, id);
          if (target) {
            const metadataPath = path.join(target.dir, "metadata.yaml");
            if (fs.existsSync(metadataPath)) {
              upsertMetadataScalars(metadataPath, { pr_url: result.pr_url });
            }
          }
        }
      }
      return result;
    }

    if (resolvedAction === "merge") {
      const dirty = runCommand("git", ["status", "--porcelain"], repoRoot);
      if (dirty.code !== 0) {
        throw new Error(`Failed to inspect worktree: ${dirty.stderr || dirty.stdout}`);
      }
      if (dirty.stdout.trim()) {
        throw new Error(`Working tree is not clean; cannot merge:\n${dirty.stdout}`);
      }

      if (!dryRun) {
        const checkoutDefault = runCommand("git", ["checkout", resolvedDefaultBranch], repoRoot);
        if (checkoutDefault.code !== 0) {
          throw new Error(`Failed to checkout ${resolvedDefaultBranch}: ${checkoutDefault.stderr || checkoutDefault.stdout}`);
        }

        const merge = runCommand("git", ["merge", "--no-ff", branch, "-m", `merge: ${id} - ${resolvedTitle}`], repoRoot);
        if (merge.code !== 0) {
          runCommand("git", ["merge", "--abort"], repoRoot);
          runCommand("git", ["checkout", branch], repoRoot);
          throw new Error(`git merge --no-ff ${branch} failed:\n${merge.stderr || merge.stdout}`);
        }
        result.merged = true;
        result.current_branch = resolvedDefaultBranch;

        if (deleteBranch) {
          const del = runCommand("git", ["branch", "-d", branch], repoRoot);
          if (del.code !== 0) {
            throw new Error(`Failed to delete branch ${branch}: ${del.stderr || del.stdout}`);
          }
          result.branch_deleted = true;
        }

        if (push) {
          const pushDefault = runCommand("git", ["push", "origin", resolvedDefaultBranch], repoRoot);
          if (pushDefault.code !== 0) {
            throw new Error(`Failed to push ${resolvedDefaultBranch}: ${pushDefault.stderr || pushDefault.stdout}`);
          }
          result.pushed_default = true;
        }

        // The merge left HEAD on the default branch. If the feature branch still exists, restore
        // it so this repo's working-branch state matches what it was before this call — a silent
        // HEAD switch to the default branch would otherwise surprise a follow-up wspec command.
        if (!result.branch_deleted) {
          const restore = runCommand("git", ["checkout", branch], repoRoot);
          if (restore.code === 0) {
            result.current_branch = branch;
          }
        }
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}
