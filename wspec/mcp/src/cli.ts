#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  runCommitMsgHook,
  runGuardEditHook,
  runNudgeValidateHook,
  runPreCommitHook,
  runPreCompactSyncHook,
  runPrepareCommitMsgHook,
  runPrePushHook,
  runSessionEndUsageFlushHook,
  runStateSyncHook,
  runUsageTrackHook,
  runValidateAnalysisWriteHook
} from "./hooks.js";
import { findRepoRoot } from "./lib/root.js";
import { formatStateBanner } from "./lib/state.js";
import { findToolByName, toolDefinitions } from "./lib/tools.js";
import { startServer } from "./server.js";
import { runWorkflow, workflowHelp } from "./workflows.js";

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  node dist/cli.js serve",
      "  node dist/cli.js list-tools",
      "  node dist/cli.js tool <tool-name> [json-args]",
      "  node dist/cli.js workflow <propose|research|principles|implement|finalize> [args]",
      "  node dist/cli.js state:banner",
      "  node dist/cli.js state:sync",
      "  node dist/cli.js hook:commit-msg",
      "  node dist/cli.js hook:prepare-commit-msg <message-file> [commit-source]",
      "  node dist/cli.js hook:pre-commit",
      "  node dist/cli.js hook:pre-push",
      "  node dist/cli.js hook:guard-edit",
      "  node dist/cli.js hook:validate-analysis-write",
      "  node dist/cli.js hook:nudge-validate",
      "  node dist/cli.js hook:usage-track",
      "  node dist/cli.js hook:session-end",
      "  node dist/cli.js hook:pre-compact-sync",
      ""
    ].join("\n")
  );
}

// These ride along on every session where the plugin is enabled, which includes projects that never
// ran /wspec:setup. There they do nothing, rather than dropping a wspec/ folder (state.json,
// usage-cursor.json) into an unrelated repo. The git hooks (hook:pre-commit and friends) are only
// wired by setup, so they aren't gated; state:banner writes nothing.
const NEEDS_SETUP = new Set([
  "hook:guard-edit",
  "hook:validate-analysis-write",
  "hook:nudge-validate",
  "hook:usage-track",
  "hook:session-end",
  "hook:pre-compact-sync",
  "state:sync"
]);

function isSetUp(): boolean {
  try {
    return fs.existsSync(path.join(findRepoRoot(), "wspec", "config.yaml"));
  } catch {
    return false;
  }
}

function parseJsonArgs(raw: string | undefined): unknown {
  if (!raw || raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON arguments: ${message}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command && NEEDS_SETUP.has(command) && !isSetUp()) return;

  switch (command) {
    case "serve": {
      await startServer();
      return;
    }
    case "list-tools": {
      const tools = toolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description
      }));
      process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
      return;
    }
    case "tool": {
      const [toolName, rawArgs] = args;
      if (!toolName) {
        throw new Error("Missing tool name. Usage: node dist/cli.js tool <tool-name> [json-args]");
      }

      const tool = findToolByName(toolName);
      if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      const parsedArgs = parseJsonArgs(rawArgs);
      const result = tool.run(parsedArgs);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "workflow": {
      const [workflowName, ...workflowArgs] = args;
      if (!workflowName) {
        process.stdout.write(`${JSON.stringify(workflowHelp(), null, 2)}\n`);
        return;
      }

      const result = runWorkflow(workflowName, workflowArgs);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "state:banner": {
      // Best-effort: a status banner must never error out the host that renders it.
      try {
        const banner = formatStateBanner(findRepoRoot());
        if (banner) {
          process.stdout.write(`${banner}\n`);
        }
      } catch {
        // No repo / no state — render nothing.
      }
      return;
    }
    case "hook:commit-msg": {
      process.exitCode = runCommitMsgHook();
      return;
    }
    case "hook:pre-commit": {
      process.exitCode = runPreCommitHook();
      return;
    }
    case "hook:prepare-commit-msg": {
      const [messageFile, commitSource] = args;
      process.exitCode = runPrepareCommitMsgHook(messageFile ?? "", commitSource);
      return;
    }
    case "hook:pre-push": {
      process.exitCode = runPrePushHook();
      return;
    }
    case "hook:guard-edit": {
      process.exitCode = runGuardEditHook();
      return;
    }
    case "hook:validate-analysis-write": {
      process.exitCode = runValidateAnalysisWriteHook();
      return;
    }
    case "hook:nudge-validate": {
      process.exitCode = runNudgeValidateHook();
      return;
    }
    case "hook:usage-track": {
      process.exitCode = runUsageTrackHook();
      return;
    }
    case "hook:session-end": {
      process.exitCode = runSessionEndUsageFlushHook();
      return;
    }
    case "hook:pre-compact-sync": {
      process.exitCode = runPreCompactSyncHook();
      return;
    }
    case "state:sync": {
      process.exitCode = runStateSyncHook();
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      printUsage();
      return;
    }
    default: {
      printUsage();
      process.exitCode = 1;
    }
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
