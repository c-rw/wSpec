import fs from "node:fs";
import path from "node:path";
import { pluginCliPath, pluginRoot } from "./pluginPaths.js";
import { findRepoRoot } from "./root.js";
import { mergeWspecSettings } from "./settingsMerge.js";
import { runCommand } from "./shell.js";

/**
 * Project-side setup for the wSpec plugin: the things a plugin cannot ship, copied or written into
 * the user's project — the templates/schemas the command prompts read by relative path, the git
 * hook shims, .gitignore entries, read-only permissions in .claude/settings.json, and the seed
 * config/principles files. Backs /wspec:setup, and does what install.sh/install.ps1 do.
 *
 * Preview by default (`apply: false`) computes every action by comparing against what is on disk
 * and writes nothing; apply runs the identical code path. Only the three write helpers below
 * branch on `apply`, so a preview can't drift from what apply does. Safe to re-run — a second run
 * reports everything `unchanged` — and re-running after a plugin update refreshes the absolute
 * path the git shims use to find the plugin's cli.js.
 */

export type SetupActionKind = "add" | "update" | "unchanged" | "remove" | "skip" | "error";

export interface SetupAction {
  path: string;
  action: SetupActionKind;
  note?: string;
}

export interface SetupOptions {
  /** Write changes. Default false: preview only. */
  apply?: boolean;
  /** Configure git hooks (core.hooksPath + shim path). Default true. */
  hooks?: boolean;
  /** Merge wSpec's entries into .claude/settings.json. Default true. */
  settings?: boolean;
  /** Where to start looking for the project root. Default: process.cwd(). */
  cwd?: string;
}

export interface SetupResult {
  applied: boolean;
  projectRoot: string;
  pluginRoot: string;
  actions: SetupAction[];
  summary: Record<SetupActionKind, number>;
  notes: string[];
}

const HOOKS_PATH = "wspec/scripts/hooks";
const HOOK_SHIMS = ["prepare-commit-msg", "commit-msg", "pre-commit", "pre-push"];
const CLI_PATH_FILE = ".wspec-mcp-cli-path";
// Older installs copied these terminal wrappers into the project root, where they need a wspec/mcp
// that plugin users don't have. Not copied any more; setup just points out leftovers.
const OLD_WRAPPERS = ["wspec-propose", "wspec-research", "wspec-principles", "wspec-implement", "wspec-finalize"].flatMap((name) => [name, `${name}.cmd`]);
// Detach stdin: this runs inside a stdio MCP server, whose stdin is the protocol stream.
const GIT_OPTS = { stdinMode: "ignore" } as const;

// Generated / machine-local files wSpec writes into a project. Whole-line matching (below) is
// deliberate: a substring test would treat `wspec/state.json.lock` as already covering
// `wspec/state.json`.
const GITIGNORE_BLOCK: { comment: string; entries: string[] }[] = [
  { comment: "Rebuildable state index and its lock/temp files", entries: ["wspec/state.json", "wspec/state.json.lock", "wspec/.state.*.tmp"] },
  { comment: "Per-transcript cursor for cost tracking — ephemeral and machine-local", entries: ["wspec/usage-cursor.json"] },
  { comment: "Ticket-mirror receipts and cache — machine-local bookkeeping", entries: ["wspec/changes/*/.ticket/", "wspec/archive/*/.ticket/"] },
  { comment: "Forge capability probe cache — re-probed as needed", entries: ["wspec/.cache/"] }
];

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Every non-directory entry beneath `dir`, as posix paths relative to it. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out.sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runSetup(opts: SetupOptions = {}): SetupResult {
  const apply = opts.apply ?? false;
  const wantHooks = opts.hooks ?? true;
  const wantSettings = opts.settings ?? true;
  const plugin = pluginRoot();
  const pluginWspec = path.join(plugin, "wspec");
  const notes: string[] = [];
  const actions: SetupAction[] = [];

  let projectRoot: string;
  let hasRepoRoot = true;
  try {
    projectRoot = findRepoRoot(opts.cwd);
  } catch {
    projectRoot = path.resolve(opts.cwd ?? process.cwd());
    hasRepoRoot = false;
    notes.push(
      `No git repository or wspec/ found above ${projectRoot}; setting up in that folder. wSpec creates a feat/NNN branch for each change, so run \`git init\` here and re-run /wspec:setup to wire the git hooks.`
    );
  }

  // Refuse to mirror a plugin onto itself: copying is harmless, but the orphan pass would delete
  // files, and running from a wSpec checkout (or a plugin cache dir) means source == destination.
  const realProject = fs.realpathSync(projectRoot);
  const realPlugin = fs.realpathSync(plugin);
  const projectWspec = path.join(realProject, "wspec");
  if (realProject === realPlugin || isInside(realPlugin, realProject) || (fs.existsSync(projectWspec) && isInside(fs.realpathSync(projectWspec), realPlugin))) {
    throw new Error(
      `Refusing to run setup inside the wSpec plugin itself (${realPlugin}). Run it from the project you want to use wSpec in.`
    );
  }

  const push = (rel: string, action: SetupActionKind, note?: string) => {
    actions.push(note ? { path: rel, action, note } : { path: rel, action });
  };

  // --- Write helpers: the only places that branch on `apply`. Each returns false if the write
  // failed, having recorded an `error` action instead of throwing, so one unwritable file doesn't
  // abort the rest of the setup.

  const write = (rel: string, target: string, data: Buffer | string): boolean => {
    if (!apply) return true;
    try {
      const existing = lstatOrNull(target);
      if (existing && !existing.isFile()) fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      return true;
    } catch (error) {
      push(rel, "error", errorMessage(error));
      return false;
    }
  };

  const remove = (rel: string, target: string): boolean => {
    if (!apply) return true;
    try {
      fs.rmSync(target, { force: true });
      return true;
    } catch (error) {
      push(rel, "error", errorMessage(error));
      return false;
    }
  };

  const relativeToProject = (absolute: string) => toPosix(path.relative(projectRoot, absolute));

  /** Copy one file, comparing bytes so an unchanged file is reported as such. */
  const syncFile = (source: string, target: string, note?: string) => {
    const rel = relativeToProject(target);
    const data = fs.readFileSync(source);
    const existing = lstatOrNull(target);
    let kind: SetupActionKind;
    let why = note;
    if (!existing) {
      kind = "add";
    } else if (existing.isFile()) {
      kind = Buffer.compare(data, fs.readFileSync(target)) === 0 ? "unchanged" : "update";
      if (kind === "update") why = note ?? "differs from the plugin's copy — local edits are overwritten";
    } else {
      kind = "update";
      why = "was a directory or link where a file is needed — replaced";
    }
    if (kind !== "unchanged" && !write(rel, target, data)) return;
    push(rel, kind, kind === "unchanged" ? undefined : why);
  };

  /** Make `targetDir` an exact copy of `sourceDir`: add/update files, delete files with no
   * counterpart, prune emptied directories. `keep` names files that are legitimately not in the
   * source (written by setup itself) and must survive the orphan pass. */
  const mirrorTree = (sourceDir: string, targetDir: string, keep: ReadonlySet<string> = new Set()) => {
    if (!fs.existsSync(sourceDir)) return;
    const sourceFiles = listFiles(sourceDir);
    for (const rel of sourceFiles) syncFile(path.join(sourceDir, rel), path.join(targetDir, rel));

    const wanted = new Set(sourceFiles);
    for (const rel of listFiles(targetDir)) {
      if (wanted.has(rel) || keep.has(path.posix.basename(rel))) continue;
      const target = path.join(targetDir, rel);
      if (remove(relativeToProject(target), target)) push(relativeToProject(target), "remove", "no longer part of wSpec");
    }

    if (apply && fs.existsSync(targetDir)) {
      // Deepest-first, so a directory emptied by the deletions above can go too.
      const dirs: string[] = [];
      const collect = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const child = path.join(current, entry.name);
          collect(child);
          dirs.push(child);
        }
      };
      collect(targetDir);
      for (const dir of dirs) {
        try {
          fs.rmdirSync(dir);
        } catch {
          // Not empty — leave it.
        }
      }
    }
  };

  /** Copy a seed file only if the project doesn't have one; never overwrite. */
  const seedFile = (source: string, target: string) => {
    const rel = relativeToProject(target);
    if (lstatOrNull(target)) {
      push(rel, "skip", "already exists — left as-is");
      return;
    }
    if (write(rel, target, fs.readFileSync(source))) push(rel, "add");
  };

  // --- Framework files the command prompts read by relative path.
  mirrorTree(path.join(pluginWspec, "templates"), path.join(projectRoot, "wspec", "templates"));
  mirrorTree(path.join(pluginWspec, "schemas"), path.join(projectRoot, "wspec", "schemas"));
  // wspec/scripts holds the git shims (and merge-settings.cjs, which install.sh still needs in the
  // project — it has a source counterpart, so the mirror leaves it alone). The shim-path file is
  // written by the hooks step below, not shipped, so it must survive the orphan pass.
  mirrorTree(path.join(pluginWspec, "scripts"), path.join(projectRoot, "wspec", "scripts"), new Set([CLI_PATH_FILE]));
  syncFile(path.join(pluginWspec, "README.md"), path.join(projectRoot, "wspec", "README.md"));

  // --- Legacy files from before the plugin repackage.
  const constitution = path.join(projectRoot, "wspec", "constitution.md");
  if (lstatOrNull(constitution) && remove("wspec/constitution.md", constitution)) push("wspec/constitution.md", "remove", "obsolete");
  const leftoverWrappers = OLD_WRAPPERS.filter((name) => lstatOrNull(path.join(projectRoot, name)));
  if (leftoverWrappers.length > 0) {
    notes.push(
      `${leftoverWrappers.join(", ")} in the project root came from an older wSpec install and no longer work here (they need wspec/mcp in the project). They are safe to delete; run the workflows by path from the plugin directory instead, e.g. ${toPosix(path.join(plugin, "wspec-propose"))} "idea".`
    );
  }
  if (fs.existsSync(path.join(projectRoot, "wspec", "mcp"))) {
    notes.push("wspec/mcp/ from a pre-plugin install is no longer used (the MCP server now runs from the plugin); it was left in place and can be deleted.");
  }

  // --- .gitignore
  {
    const target = path.join(projectRoot, ".gitignore");
    const existedBefore = fs.existsSync(target);
    const existingText = existedBefore ? fs.readFileSync(target, "utf8") : "";
    const eol = existingText.includes("\r\n") ? "\r\n" : "\n";
    const present = new Set(existingText.split(/\r?\n/).map((line) => line.trim()));
    const lines: string[] = [];
    for (const group of GITIGNORE_BLOCK) {
      const missing = group.entries.filter((entry) => !present.has(entry));
      if (missing.length === 0) continue;
      lines.push(`# ${group.comment}`, ...missing);
    }
    if (lines.length === 0) {
      push(".gitignore", "unchanged");
    } else {
      const separator = existingText === "" ? "" : existingText.endsWith("\n") ? eol : eol + eol;
      const block = `${separator}# wSpec generated / machine-local files${eol}${lines.join(eol)}${eol}`;
      const missingCount = lines.filter((line) => !line.startsWith("# ")).length;
      if (write(".gitignore", target, existingText + block)) {
        push(".gitignore", existedBefore ? "update" : "add", `adds ${missingCount} entr${missingCount === 1 ? "y" : "ies"}`);
      }
    }
  }

  // --- .claude/settings.json
  if (wantSettings) {
    const rel = ".claude/settings.json";
    const target = path.join(projectRoot, ".claude", "settings.json");
    let parsed: Record<string, unknown> | null = {};
    let originalText: string | null = null;
    if (fs.existsSync(target)) {
      originalText = fs.readFileSync(target, "utf8");
      try {
        const value = JSON.parse(originalText);
        parsed = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
    }
    if (parsed === null) {
      // The installer's merge script warns and starts over here, which would overwrite the user's
      // file. Leave it alone instead.
      push(rel, "error", "not valid JSON (or not an object) — left untouched; fix it and re-run to add wSpec's permissions");
    } else {
      const { settings, changes } = mergeWspecSettings(parsed);
      const rendered = `${JSON.stringify(settings, null, 2)}\n`;
      if (originalText === rendered) {
        push(rel, "unchanged");
      } else {
        const note = changes.length > 0 ? changes.join("; ") : "reformatted";
        // Temp file + rename, so a crash mid-write can't leave a half-written settings file.
        let ok = true;
        if (apply) {
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const temp = `${target}.wspec-tmp`;
            fs.writeFileSync(temp, rendered);
            fs.renameSync(temp, target);
          } catch (error) {
            ok = false;
            push(rel, "error", errorMessage(error));
          }
        }
        if (ok) push(rel, originalText === null ? "add" : "update", note);
      }
    }
  } else {
    notes.push("Skipped .claude/settings.json (settings: false).");
  }

  // --- Git hooks
  if (wantHooks) {
    const inWorkTree = hasRepoRoot && runCommand("git", ["rev-parse", "--is-inside-work-tree"], projectRoot, GIT_OPTS).stdout.trim() === "true";
    if (!inWorkTree) {
      push("git core.hooksPath", "skip", "not a git repository — run `git init`, then re-run /wspec:setup to wire the hooks");
    } else {
      const current = runCommand("git", ["config", "--get", "core.hooksPath"], projectRoot, GIT_OPTS);
      const value = current.code === 0 ? current.stdout.trim() : "";
      let hooksOk = true;
      if (value === HOOKS_PATH) {
        push("git core.hooksPath", "unchanged");
      } else if (value === "") {
        if (apply) hooksOk = runCommand("git", ["config", "core.hooksPath", HOOKS_PATH], projectRoot, GIT_OPTS).code === 0;
        if (hooksOk) push("git core.hooksPath", "add", `set to ${HOOKS_PATH}`);
        else push("git core.hooksPath", "error", "git config failed");
      } else {
        push(
          "git core.hooksPath",
          "skip",
          `already set to '${value}' by something else — left as-is. Unset it (git config --unset core.hooksPath) and re-run to use wSpec's hooks.`
        );
      }

      // The shims run the plugin's cli.js by absolute path, since ${CLAUDE_PLUGIN_ROOT}
      // substitution isn't available to a git hook. Refreshed on every run: this is the file that
      // goes stale when the plugin moves or updates. Written even under a foreign hooksPath so
      // the shims are correct if the user later points git at them.
      const pathFile = path.join(projectRoot, HOOKS_PATH, CLI_PATH_FILE);
      const wanted = `${toPosix(pluginCliPath())}\n`;
      const existing = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, "utf8") : null;
      const rel = relativeToProject(pathFile);
      if (existing === wanted) {
        push(rel, "unchanged");
      } else if (write(rel, pathFile, wanted)) {
        push(rel, existing === null ? "add" : "update", "where the git shims find the plugin's cli.js");
      }

      if (apply) {
        for (const shim of HOOK_SHIMS) {
          const shimPath = path.join(projectRoot, HOOKS_PATH, shim);
          try {
            if (fs.existsSync(shimPath)) fs.chmodSync(shimPath, 0o755);
          } catch {
            // Windows has no executable bit; Git for Windows runs the shims regardless.
          }
        }
      }
    }
  } else {
    notes.push("Skipped git hooks (hooks: false). Nothing about core.hooksPath was changed.");
  }

  // --- Seed files and empty change folders (never overwritten).
  seedFile(path.join(pluginWspec, "config.yaml"), path.join(projectRoot, "wspec", "config.yaml"));
  seedFile(path.join(pluginWspec, "principles.md"), path.join(projectRoot, "wspec", "principles.md"));
  for (const dir of ["changes", "specs", "archive"]) {
    const keep = path.join(projectRoot, "wspec", dir, ".gitkeep");
    const rel = relativeToProject(keep);
    if (lstatOrNull(keep)) push(rel, "unchanged");
    else if (write(rel, keep, "")) push(rel, "add");
  }

  const summary: Record<SetupActionKind, number> = { add: 0, update: 0, unchanged: 0, remove: 0, skip: 0, error: 0 };
  for (const action of actions) summary[action.action] += 1;

  if (apply && actions.some((a) => a.path === ".claude/settings.json" && (a.action === "add" || a.action === "update"))) {
    notes.push("Settings changed — restart Claude Code for the new permissions to take effect.");
  }

  return { applied: apply, projectRoot, pluginRoot: plugin, actions, summary, notes };
}
