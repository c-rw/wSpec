import { spawnSync } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runCommand(command: string, args: string[], cwd: string): RunResult {
  const child = spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });

  return {
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    code: child.status ?? 1
  };
}

export function runPowerShellJson(scriptPath: string, scriptArgs: string[], cwd: string): unknown {
  const result = runCommand("pwsh", ["-NoProfile", "-File", scriptPath, ...scriptArgs, "-Json"], cwd);
  if (result.code !== 0) {
    throw new Error(result.stderr || `PowerShell script failed: ${scriptPath}`);
  }

  const text = result.stdout.trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Script returned non-JSON output: ${scriptPath}\n${text}`);
  }
}
