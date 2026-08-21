#!/usr/bin/env node
import {
  runCommitMsgHook,
  runGuardEditHook,
  runNudgeValidateHook,
  runPreCommitHook,
  runPrepareCommitMsgHook,
  runPrePushHook,
  runStateSyncHook,
  runUsageTrackHook
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
      "  node dist/cli.js hook:nudge-validate",
      "  node dist/cli.js hook:usage-track",
      ""
    ].join("\n")
  );
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
    case "hook:nudge-validate": {
      process.exitCode = runNudgeValidateHook();
      return;
    }
    case "hook:usage-track": {
      process.exitCode = runUsageTrackHook();
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
