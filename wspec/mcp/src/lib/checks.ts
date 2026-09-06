import fs from "node:fs";
import path from "node:path";
import { runShellCommand } from "./shell.js";

/**
 * Execution-evidence gate: runs the check commands declared in wspec/config.yaml's `checks:`
 * block (test/typecheck/lint/etc.) and reports pass/fail, instead of trusting an LLM's diff
 * review as proof the code works. This is deliberately dumb about *why* a command failed — it
 * has no per-framework test-output parser — so it treats each declared command as one pass/fail
 * unit and leaves failure triage to the log file it writes.
 *
 * Language-agnostic by construction: the repo owner declares the actual command ("npm run test",
 * "pytest", "Invoke-Pester"), wspec never infers or hardcodes one.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_SUMMARY_LINES = 5;
const MAX_LINE_CHARS = 200;

export interface ChecksConfig {
  commands: Record<string, string>;
  required: string[];
  timeout_ms: number;
}

export interface CheckResult {
  name: string;
  command: string;
  required: boolean;
  status: "pass" | "fail" | "error";
  exit_code: number | null;
  duration_ms: number;
  log_path: string | null;
  summary: string | null;
}

export interface ChecksReport {
  enabled: boolean;
  status: "pass" | "fail" | "skipped";
  change_id: string | null;
  phase: number | null;
  completed_at: string;
  checks: CheckResult[];
  notes: string[];
}

function configPath(repoRoot: string): string {
  return path.join(repoRoot, "wspec", "config.yaml");
}

/**
 * Hand-rolled parse of the `checks:` block only — consistent with readYamlScalars elsewhere in
 * this codebase (changes.ts), which avoids a YAML library dependency for a small, fixed shape.
 * Supports:
 *   checks:
 *     test: "npm run test"
 *     typecheck: "npm run check"
 *     lint: ""                 # blank/omitted = skip
 *     required: [test]
 *     timeout_ms: 180000        # optional, defaults to 120000
 * Returns null when the block is absent, commented out, or declares no non-blank commands —
 * that is the "feature is off" state, and every caller must treat it as a pass-through.
 */
export function readChecksConfig(repoRoot: string): ChecksConfig | null {
  const content = fs.existsSync(configPath(repoRoot)) ? fs.readFileSync(configPath(repoRoot), "utf8") : "";
  const lines = content.split(/\r?\n/);

  const blockStart = lines.findIndex((line) => /^checks\s*:\s*$/.test(line));
  if (blockStart < 0) return null;

  const commands: Record<string, string> = {};
  let required: string[] = [];
  let timeout_ms = DEFAULT_TIMEOUT_MS;

  for (let i = blockStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (!/^\s+/.test(line)) break; // dedent — end of the checks: block

    const kv = /^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.replace(/\s*#.*$/, "").trim();

    if (key === "required") {
      const arrayMatch = /^\[(.*)\]$/.exec(value);
      if (arrayMatch) {
        required = arrayMatch[1]
          .split(",")
          .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
      continue;
    }

    if (key === "timeout_ms") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) timeout_ms = parsed;
      continue;
    }

    const unquoted = value.replace(/^['"]|['"]$/g, "").trim();
    if (unquoted) {
      commands[key] = unquoted;
    }
  }

  if (Object.keys(commands).length === 0) return null;

  // A declared command with no `required:` entry is advisory-only by default — safer than
  // silently treating every declared command as blocking the moment `checks:` is added.
  return { commands, required: required.filter((name) => name in commands), timeout_ms };
}

function truncate(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** Tail-of-output digest: full text goes to the log file, only a few lines ride in the report. */
function summarize(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return combined.slice(-MAX_SUMMARY_LINES).map(truncate).join("\n");
}

function checksDir(repoRoot: string, changeId: string): string {
  return path.join(repoRoot, "wspec", "changes", changeId, ".checks");
}

function latestPath(repoRoot: string, changeId: string): string {
  return path.join(checksDir(repoRoot, changeId), "latest.json");
}

/**
 * Execute every declared check command for a change and persist a digest. Called explicitly by
 * wspec.runChecks — never from a read path like state.ts's rebuildState, which must stay
 * side-effect-free and cheap.
 */
export function runChecks(repoRoot: string, changeId: string, phase: number | null): ChecksReport {
  const config = readChecksConfig(repoRoot);
  if (!config) {
    return {
      enabled: false,
      status: "skipped",
      change_id: changeId,
      phase,
      completed_at: new Date().toISOString(),
      checks: [],
      notes: ["No checks: block configured in wspec/config.yaml — gate treats this as pass-through."]
    };
  }

  const dir = checksDir(repoRoot, changeId);
  fs.mkdirSync(dir, { recursive: true });

  const results: CheckResult[] = [];
  for (const [name, command] of Object.entries(config.commands)) {
    const required = config.required.includes(name);
    const startedAt = Date.now();
    const run = runShellCommand(command, repoRoot, config.timeout_ms);
    const duration_ms = Date.now() - startedAt;

    const status: CheckResult["status"] = run.timed_out ? "error" : run.code === 0 ? "pass" : "fail";

    let log_path: string | null = null;
    let summary: string | null = null;
    if (status !== "pass") {
      const logFile = path.join(dir, `${phase ?? "manual"}-${name}.log`);
      const header = run.timed_out ? `[timed out after ${config.timeout_ms}ms]\n\n` : "";
      fs.writeFileSync(logFile, `${header}$ ${command}\n\n${run.stdout}\n${run.stderr}`, "utf8");
      log_path = path.relative(repoRoot, logFile);
      summary = run.timed_out ? `Command timed out after ${config.timeout_ms}ms` : summarize(run.stdout, run.stderr);
    }

    results.push({
      name,
      command,
      required,
      status,
      exit_code: run.timed_out ? null : run.code,
      duration_ms,
      log_path,
      summary
    });
  }

  const failedRequired = results.some((r) => r.required && r.status !== "pass");
  const report: ChecksReport = {
    enabled: true,
    status: failedRequired ? "fail" : "pass",
    change_id: changeId,
    phase,
    completed_at: new Date().toISOString(),
    checks: results,
    notes: []
  };

  fs.writeFileSync(latestPath(repoRoot, changeId), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

/** Read a `.checks/latest.json` digest from an arbitrary change-folder directory (active
 * `changes/<id>/` or an already-archived `archive/YYYY-MM-DD-<id>/`) — mirrors
 * usage.ts's loadUsageLedgerFromDir, for the same reason: the ticket-mirror snapshot needs to
 * read this after wspec.archive has moved the folder. */
export function readLatestChecksFromDir(changeDir: string): ChecksReport | null {
  const file = path.join(changeDir, ".checks", "latest.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ChecksReport;
  } catch {
    return null;
  }
}

/**
 * Read-only accessor for the last persisted run, used by state.ts (rebuildState must never
 * execute commands) and gate.ts's pre-push check.
 */
export function readLatestChecks(repoRoot: string, changeId: string): ChecksReport | null {
  return readLatestChecksFromDir(path.join(repoRoot, "wspec", "changes", changeId));
}
