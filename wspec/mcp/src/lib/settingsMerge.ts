/**
 * The wSpec-owned edits to a project's .claude/settings.json: what a plugin's own settings.json
 * can't ship (only `agent`/`subagentStatusLine` are supported there), plus removal of keys that
 * earlier wSpec versions wrote and the plugin now supplies. Pure — takes parsed JSON, returns new
 * JSON and a list of what changed; the caller does the I/O.
 *
 * Keep WSPEC_PERMISSIONS in step with wspec/scripts/merge-settings.cjs (still used by
 * install.sh/install.ps1) and .claude/settings.example.json.
 */

type Json = Record<string, unknown>;

/** Read-only tools and git inspection, auto-allowed to cut friction. Mutating wSpec tools and git
 * commands are deliberately left out so Claude Code's normal per-call prompt still applies —
 * that includes wspec_setup, which edits settings and git config. wspec_syncTicket is allowed
 * despite writing to the forge because its content is derived from repo state, it only touches a
 * ticket wSpec already linked, and it is idempotent. */
export const WSPEC_PERMISSIONS: readonly string[] = [
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "mcp__plugin_wspec_wspec__wspec_status",
  "mcp__plugin_wspec_wspec__wspec_loadChange",
  "mcp__plugin_wspec_wspec__wspec_repoScan",
  "mcp__plugin_wspec_wspec__wspec_loadState",
  "mcp__plugin_wspec_wspec__wspec_verifyState",
  "mcp__plugin_wspec_wspec__wspec_gateCheck",
  "mcp__plugin_wspec_wspec__wspec_validateAnalysis",
  "mcp__plugin_wspec_wspec__wspec_validateAll",
  "mcp__plugin_wspec_wspec__wspec_doctor",
  "mcp__plugin_wspec_wspec__wspec_listIssues",
  "mcp__plugin_wspec_wspec__wspec_getIssue",
  "mcp__plugin_wspec_wspec__wspec_usageReport",
  "mcp__plugin_wspec_wspec__wspec_forgeCaps",
  "mcp__plugin_wspec_wspec__wspec_syncTicket"
];

// Allow rules earlier versions wrote that never match now: the node-cli rule from before the
// plugin repackage, and `mcp__wspec__wspec.<tool>` — as a plugin the server is `plugin_wspec_wspec`
// and Claude Code rewrites the dot to `_`.
const LEGACY_ALLOW_EXACT = "Bash(node wspec/mcp/dist/cli.js:*)";
const LEGACY_ALLOW_PREFIX = "mcp__wspec__wspec.";

const LEGACY_CLI = "wspec/mcp/dist/cli.js";

export interface SettingsMergeResult {
  settings: Json;
  changes: string[];
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Forward-slash a command so the same match works for POSIX and Windows-written paths. */
function normalizeCommand(command: unknown): string {
  return String(command ?? "").replace(/[\\/]+/g, "/");
}

export function mergeWspecSettings(input: Json): SettingsMergeResult {
  const settings = structuredClone(input);
  const changes: string[] = [];

  // Dead keys a pre-plugin version wrote, now that the plugin supplies them.
  if (isObject(settings.mcpServers) && "wspec" in settings.mcpServers) {
    delete settings.mcpServers.wspec;
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
    changes.push("removed the old mcpServers.wspec entry (the plugin registers the server)");
  }

  if (settings.hooks !== undefined) {
    if (!isObject(settings.hooks)) {
      changes.push("left `hooks` untouched (not an object)");
    } else {
      const hooks = settings.hooks;
      let removed = 0;
      for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) continue;
        const kept = entries.filter(
          (entry) =>
            !(isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some((h) => isObject(h) && normalizeCommand(h.command).includes(LEGACY_CLI)))
        );
        removed += entries.length - kept.length;
        if (kept.length === 0) delete hooks[event];
        else hooks[event] = kept;
      }
      if (Object.keys(hooks).length === 0) delete settings.hooks;
      if (removed > 0) changes.push(`removed ${removed} old wSpec hook entr${removed === 1 ? "y" : "ies"} (the plugin supplies them)`);
    }
  }

  // Only if unset — the user may have their own preference. Lets the parallel wspec-researcher
  // fan-out and wspec-analyst share a prompt-cache prefix for an hour instead of five minutes.
  if (!settings.subagentPromptCacheTtl) {
    settings.subagentPromptCacheTtl = "1h";
    changes.push("set subagentPromptCacheTtl: 1h");
  }

  // wSpec no longer sets a statusLine (the plugin's hooks surface the same banner). Remove one an
  // earlier version wrote — always `node <path>/wspec/mcp/dist/cli.js state:banner` — and never
  // touch one the user set themselves.
  if (isObject(settings.statusLine)) {
    const command = normalizeCommand(settings.statusLine.command);
    if (command.includes(LEGACY_CLI) && command.includes("state:banner")) {
      delete settings.statusLine;
      changes.push("removed wSpec's old statusLine entry");
    }
  }

  if (settings.permissions !== undefined && !isObject(settings.permissions)) {
    changes.push("left `permissions` untouched (not an object)");
  } else {
    const permissions = (settings.permissions ??= {}) as Json;
    if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
      changes.push("left `permissions.allow` untouched (not an array)");
    } else {
      const allow = (permissions.allow ??= []) as unknown[];
      let added = 0;
      for (const perm of WSPEC_PERMISSIONS) {
        if (!allow.includes(perm)) {
          allow.push(perm);
          added += 1;
        }
      }
      const kept = allow.filter((perm) => !(typeof perm === "string" && (perm === LEGACY_ALLOW_EXACT || perm.startsWith(LEGACY_ALLOW_PREFIX))));
      const dropped = allow.length - kept.length;
      permissions.allow = kept;
      if (added > 0) changes.push(`added ${added} read-only permission${added === 1 ? "" : "s"} to permissions.allow`);
      if (dropped > 0) changes.push(`removed ${dropped} stale permission rule${dropped === 1 ? "" : "s"} that no longer match`);
    }
  }

  return { settings, changes };
}
