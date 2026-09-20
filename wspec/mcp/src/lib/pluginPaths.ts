import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the running wSpec plugin lives. The server, hooks, and git shims all run the one bundled
 * file <plugin>/wspec/mcp/dist/cli.js, so the plugin's own assets (templates, schemas, git hook
 * shims) are found relative to that file rather than to the user's project — a project only ever
 * has copies of them, made by /wspec:setup.
 */

let cachedRoot: string | undefined;

function looksLikePluginRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")) && fs.existsSync(path.join(dir, "wspec", "templates"));
}

/** Absolute path of the plugin's root directory (the one holding .claude-plugin/). */
export function pluginRoot(): string {
  if (cachedRoot) return cachedRoot;

  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled layout: <plugin>/wspec/mcp/dist/cli.js -> three levels up.
  let candidate = path.resolve(here, "..", "..", "..");
  if (!looksLikePluginRoot(candidate)) {
    // Not the bundled layout (e.g. run from somewhere unexpected): walk up looking for the manifest.
    let dir = here;
    candidate = "";
    while (true) {
      if (looksLikePluginRoot(dir)) {
        candidate = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (!candidate) {
    throw new Error(`Could not locate the wSpec plugin root from ${here} (expected .claude-plugin/plugin.json and wspec/templates above it)`);
  }

  cachedRoot = candidate;
  return candidate;
}

/** Absolute path of the bundled CLI/server the plugin runs. */
export function pluginCliPath(): string {
  return path.join(pluginRoot(), "wspec", "mcp", "dist", "cli.js");
}
