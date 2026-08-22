#!/usr/bin/env node
'use strict';
// Merges wSpec-owned keys into .claude/settings.json, leaving everything else intact.
// Also registers the MCP server in the project's .mcp.json (sibling of .claude/), since
// Claude Code does not read MCP server definitions from settings.json — mcpServers only
// takes effect from .mcp.json (project scope) or `claude mcp add` (local/user scope).
// Idempotent: safe to run on every install and upgrade.
// Usage: node merge-settings.cjs <settings-path>

const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { dirname, resolve, join } = require('path');

const settingsPath = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  process.stderr.write('Usage: node merge-settings.js <settings-path>\n');
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

// 1. mcpServers.wspec — registered via .mcp.json (see below), not settings.json. Drop any
// dead mcpServers.wspec key a prior version of this script wrote into settings.json; it was
// never read by Claude Code, so leaving it behind would just be confusing clutter.
if (settings.mcpServers && settings.mcpServers.wspec) {
  delete settings.mcpServers.wspec;
  if (Object.keys(settings.mcpServers).length === 0) {
    delete settings.mcpServers;
  }
}

const projectRoot = dirname(dirname(settingsPath)); // settingsPath = <root>/.claude/settings.json
const mcpJsonPath = join(projectRoot, '.mcp.json');
let mcpJson = {};
try {
  mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') {
    process.stderr.write(`Warning: ${mcpJsonPath} is not valid JSON — starting fresh.\n`);
  }
}
mcpJson.mcpServers ??= {};
mcpJson.mcpServers.wspec = {
  command: 'node',
  args: ['wspec/mcp/dist/cli.js', 'serve'],
  type: 'stdio',
};
writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + '\n');

// 2. statusLine — only if not already present (user may have their own)
if (!settings.statusLine) {
  settings.statusLine = {
    type: 'command',
    command: 'node wspec/mcp/dist/cli.js state:banner',
  };
}

// 3. hooks.<EventName> — append a wSpec entry if this exact (matcher, command) pair isn't
// already registered under that event. Idempotent across install/upgrade and never clobbers a
// user's own hooks under the same event.
settings.hooks ??= {};

function ensureHookEntry(eventName, command, matcher) {
  settings.hooks[eventName] ??= [];
  const hasEntry = settings.hooks[eventName].some(
    (entry) =>
      (entry?.matcher ?? undefined) === matcher &&
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((h) => h?.command === command)
  );
  if (!hasEntry) {
    const entry = { hooks: [{ type: 'command', command }] };
    if (matcher !== undefined) entry.matcher = matcher;
    settings.hooks[eventName].push(entry);
  }
}

const bannerCmd = 'node wspec/mcp/dist/cli.js state:banner';
ensureHookEntry('SessionStart', bannerCmd, undefined);
ensureHookEntry('UserPromptSubmit', bannerCmd, undefined);
ensureHookEntry('PreToolUse', 'node wspec/mcp/dist/cli.js hook:guard-edit', 'Edit|Write|MultiEdit');
ensureHookEntry(
  'PostToolUse',
  'node wspec/mcp/dist/cli.js state:sync',
  'mcp__wspec__wspec.markTask|mcp__wspec__wspec.setStatus|mcp__wspec__wspec.syncSpec'
);
ensureHookEntry('Stop', 'node wspec/mcp/dist/cli.js hook:nudge-validate', undefined);
ensureHookEntry('Stop', 'node wspec/mcp/dist/cli.js hook:usage-track', undefined);

// 4. permissions.allow — append each wSpec entry if not already present. Only read-only wspec
// MCP tools and read-only git inspection are auto-allowed; mutating tools/commands are left
// ungated so Claude Code's normal per-call prompt still applies to them.
settings.permissions ??= {};
settings.permissions.allow ??= [];
const wspecPerms = [
  'Bash(node wspec/mcp/dist/cli.js:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'mcp__wspec__wspec.status',
  'mcp__wspec__wspec.loadChange',
  'mcp__wspec__wspec.repoScan',
  'mcp__wspec__wspec.loadState',
  'mcp__wspec__wspec.verifyState',
  'mcp__wspec__wspec.gateCheck',
  'mcp__wspec__wspec.validateAnalysis',
  'mcp__wspec__wspec.validateAll',
  'mcp__wspec__wspec.doctor',
  'mcp__wspec__wspec.listIssues',
  'mcp__wspec__wspec.getIssue',
  'mcp__wspec__wspec.usageReport',
];
for (const perm of wspecPerms) {
  if (!settings.permissions.allow.includes(perm)) {
    settings.permissions.allow.push(perm);
  }
}

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
