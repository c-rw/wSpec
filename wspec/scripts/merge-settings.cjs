#!/usr/bin/env node
'use strict';
// Merges the wSpec-owned keys a Claude Code plugin CANNOT ship into .claude/settings.json,
// leaving everything else intact. As of the plugin repackage (see .claude-plugin/plugin.json),
// mcpServers and hooks come from the plugin itself once it's installed -- this script no longer
// touches either. What's left is what a plugin's own settings.json doesn't support (only
// `agent`/`subagentStatusLine` are supported there): permissions.allow. See
// .claude/settings.example.json for the annotated reference.
// wSpec no longer sets a statusLine -- the plugin's SessionStart/UserPromptSubmit hooks already
// surface the same state banner -- and this script removes one that an earlier version wrote.
// Idempotent: safe to run on every install and upgrade.
// Usage: node merge-settings.cjs <settings-path>

const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { dirname, resolve } = require('path');

const settingsPath = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  process.stderr.write('Usage: node merge-settings.js <settings-path> [cli-path]\n');
  process.exit(1);
}

let settings = {};
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') {
    process.stderr.write(`Warning: ${settingsPath} is not valid JSON — starting fresh.\n`);
  }
}

// Drop dead keys a pre-plugin version of this script wrote, now that the plugin supplies them.
if (settings.mcpServers && settings.mcpServers.wspec) {
  delete settings.mcpServers.wspec;
  if (Object.keys(settings.mcpServers).length === 0) {
    delete settings.mcpServers;
  }
}
if (settings.hooks) {
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    settings.hooks[event] = entries.filter(
      (entry) => !(Array.isArray(entry?.hooks) && entry.hooks.some((h) => String(h?.command ?? '').includes('wspec/mcp/dist/cli.js')))
    );
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

// 1. subagentPromptCacheTtl — only if not already present (user may have their own preference).
// Lets same-model parallel subagent fan-outs (wspec-researcher, wspec-analyst) share a prompt
// cache prefix for an hour instead of the default 5 minutes.
if (!settings.subagentPromptCacheTtl) {
  settings.subagentPromptCacheTtl = '1h';
}

// 2. statusLine -- no longer set by wSpec. Remove one an earlier version wrote (the command is
// always `node <path>/wspec/mcp/dist/cli.js state:banner`, relative or absolute, forward or back
// slashes), and leave any statusLine the user set themselves alone.
{
  const cmd = String(settings.statusLine?.command ?? '').replace(/[\\/]+/g, '/');
  if (cmd.includes('wspec/mcp/dist/cli.js') && cmd.includes('state:banner')) {
    delete settings.statusLine;
  }
}

// 3. permissions.allow — append each wSpec entry if not already present. Only read-only wspec
// MCP tools and read-only git inspection are auto-allowed; mutating tools/commands are left
// ungated so Claude Code's normal per-call prompt still applies to them.
settings.permissions ??= {};
settings.permissions.allow ??= [];
// Keep in step with WSPEC_PERMISSIONS in wspec/mcp/src/lib/settingsMerge.ts (what /wspec:setup
// writes) and .claude/settings.example.json.
const wspecPerms = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'mcp__plugin_wspec_wspec__wspec_status',
  'mcp__plugin_wspec_wspec__wspec_loadChange',
  'mcp__plugin_wspec_wspec__wspec_repoScan',
  'mcp__plugin_wspec_wspec__wspec_loadState',
  'mcp__plugin_wspec_wspec__wspec_verifyState',
  'mcp__plugin_wspec_wspec__wspec_gateCheck',
  'mcp__plugin_wspec_wspec__wspec_validateAnalysis',
  'mcp__plugin_wspec_wspec__wspec_validateAll',
  'mcp__plugin_wspec_wspec__wspec_doctor',
  'mcp__plugin_wspec_wspec__wspec_listIssues',
  'mcp__plugin_wspec_wspec__wspec_getIssue',
  'mcp__plugin_wspec_wspec__wspec_usageReport',
  'mcp__plugin_wspec_wspec__wspec_forgeCaps',
  'mcp__plugin_wspec_wspec__wspec_syncTicket',
];
for (const perm of wspecPerms) {
  if (!settings.permissions.allow.includes(perm)) {
    settings.permissions.allow.push(perm);
  }
}
// Drop dead allow rules earlier versions of this script wrote: the node-cli rule from before the
// plugin repackage, and the `mcp__wspec__wspec.<tool>` names -- as a plugin the server is
// `plugin_wspec_wspec` and Claude Code rewrites the dot to `_`, so those never matched.
settings.permissions.allow = settings.permissions.allow.filter(
  (perm) =>
    perm !== 'Bash(node wspec/mcp/dist/cli.js:*)' && !perm.startsWith('mcp__wspec__wspec.')
);

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
