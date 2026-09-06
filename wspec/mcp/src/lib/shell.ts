import { spawnSync } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
}

export interface RunCommandOptions {
  /** Omit (default) to keep today's exact no-timeout behavior — only pass this for forge CLI
   * calls, where a prompting/hung `gh`/`glab` must not block the MCP server forever. */
  timeoutMs?: number;
  /** "ignore" detaches stdin so a CLI can't sit waiting on an interactive prompt inside a
   * headless MCP server. Default "inherit" preserves existing behavior for every other caller. */
  stdinMode?: "inherit" | "ignore";
}

export function runCommand(command: string, args: string[], cwd: string, opts?: RunCommandOptions): RunResult {
  const child = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: opts?.timeoutMs,
    stdio: [opts?.stdinMode === "ignore" ? "ignore" : "inherit", "pipe", "pipe"]
  });

  // Same "close enough" timeout signal as runShellCommand below: status null + a signal set.
  const timed_out = child.status === null && child.signal !== null;

  return {
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    code: child.status ?? (timed_out ? 124 : 1),
    timed_out
  };
}

export type ShellRunResult = RunResult;

/**
 * Run a user-declared shell command line (e.g. "npm run test") rather than a fixed
 * program + argv. Used for wspec.runChecks, where the command is whatever the repo owner
 * wrote in wspec/config.yaml — arbitrary shell syntax (pipes, `&&`, npm scripts), not a
 * single executable. `shell: true` delegates parsing to cmd.exe on Windows / sh elsewhere,
 * which is the only portable way to honor that. A timeout is mandatory: a hung watcher
 * (e.g. `vitest` in watch mode by mistake) must not stall a phase gate or git push forever.
 */
export function runShellCommand(commandLine: string, cwd: string, timeoutMs: number): ShellRunResult {
  const child = spawnSync(commandLine, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024
  });

  // spawnSync kills the child on timeout: status comes back null and signal is set (SIGTERM).
  // A crashed-by-signal-but-not-timed-out process also has status null + a signal, so this
  // is a "close enough" timeout signal, not a certainty — good enough for a gate digest.
  const timed_out = child.status === null && child.signal !== null;

  return {
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    code: child.status ?? (timed_out ? 124 : 1),
    timed_out
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
