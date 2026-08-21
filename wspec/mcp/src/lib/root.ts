import fs from "node:fs";
import path from "node:path";

export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);

  while (true) {
    const hasWspec = fs.existsSync(path.join(current, "wspec"));
    const hasGit = fs.existsSync(path.join(current, ".git"));
    if (hasWspec || hasGit) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate repository root (expected wspec/ or .git)");
    }
    current = parent;
  }
}

export function normalizePathForGit(input: string): string {
  return input.replace(/\\/g, "/").trim();
}
