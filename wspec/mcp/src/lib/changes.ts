import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./shell.js";

interface ParsedTask {
  id: string;
  description: string;
  done: boolean;
}

interface ParsedPhase {
  num: number;
  title: string;
  tasks: ParsedTask[];
  done: number;
  total: number;
}

interface ParsedAnalysisFinding {
  id: string;
  severity: string;
  category: string;
  summary: string;
  location: string;
  resolved: boolean;
  affects_phases: string[];
  defer_reason: string | null;
}

/**
 * Stable identity hash for a finding, used to bind an override to the exact issue it excuses.
 * Excludes the free-text summary (survives minor rewording) but revokes on any material change
 * (relocation, recategorization, severity bump) or id-reuse for a different issue.
 */
export function fingerprintFinding(
  changeId: string,
  finding: { id: string; location: string; category: string; severity: string }
): string {
  const material = [changeId, finding.id, finding.location, finding.category, finding.severity].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

interface ParsedAnalysis {
  present: boolean;
  status: string | null;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  findings: ParsedAnalysisFinding[];
}

function readFileIfExists(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Parse a single YAML-ish scalar from the text following "key:", honoring a leading matching
 * quote as the value delimiter rather than blanket-excluding `#`/quote characters. This preserves
 * an apostrophe or `#` inside a quoted value (e.g. `summary: "user's cache #2 miss"`), which a
 * naive `[^"'#]+` character class would truncate at the first apostrophe or `#` it sees.
 */
function parseInlineScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return trimmed.slice(1, end);
  } else if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  const hashIdx = trimmed.indexOf("#");
  return (hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed).trim();
}

export function readYamlScalars(filePath: string): Record<string, string> {
  const content = readFileIfExists(filePath);
  if (!content) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine)) continue;

    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!match) continue;

    output[match[1]] = parseInlineScalar(match[2]);
  }

  return output;
}

export function getCurrentBranch(repoRoot: string): string | null {
  const currentBranchResult = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  return currentBranchResult.code === 0 ? currentBranchResult.stdout.trim() : null;
}

export function assertChangeBranch(repoRoot: string, id: string, action: string) {
  const metadataPath = path.join(repoRoot, "wspec", "changes", id, "metadata.yaml");
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`metadata.yaml not found for change: ${id}`);
  }

  const metadata = readYamlScalars(metadataPath);
  const expectedBranch = metadata.branch?.trim();
  if (!expectedBranch) {
    return {
      enforced: false,
      expected_branch: null,
      current_branch: getCurrentBranch(repoRoot),
      branch_matches: true,
      reason: "metadata branch missing"
    };
  }

  const currentBranch = getCurrentBranch(repoRoot);
  if (!currentBranch) {
    return {
      enforced: false,
      expected_branch: expectedBranch,
      current_branch: null,
      branch_matches: true,
      reason: "git branch unavailable"
    };
  }

  if (currentBranch !== expectedBranch) {
    throw new Error(
      `Refusing to ${action} for change '${id}' on branch '${currentBranch}'. Expected branch '${expectedBranch}'. Switch to the change branch and retry.`
    );
  }

  return {
    enforced: true,
    expected_branch: expectedBranch,
    current_branch: currentBranch,
    branch_matches: true,
    reason: null
  };
}

export function parseTaskInfo(tasksPath: string): { total: number; done: number; pending: number; phases: ParsedPhase[] } {
  const content = readFileIfExists(tasksPath);
  if (!content) {
    return { total: 0, done: 0, pending: 0, phases: [] };
  }

  const result = {
    total: 0,
    done: 0,
    pending: 0,
    phases: [] as ParsedPhase[]
  };

  let currentPhase: ParsedPhase | null = null;

  for (const line of content.split(/\r?\n/)) {
    const phaseMatch = /^##\s+Phase\s+(\d+)\s*:\s*(.+?)\s*$/.exec(line);
    if (phaseMatch) {
      if (currentPhase) {
        result.phases.push(currentPhase);
      }
      currentPhase = {
        num: Number.parseInt(phaseMatch[1], 10),
        title: phaseMatch[2].trim(),
        tasks: [],
        done: 0,
        total: 0
      };
      continue;
    }

    const taskMatch = /^\s*-\s*\[([ xX])\]\s*(T\d+)(.*)$/.exec(line);
    if (!taskMatch || !currentPhase) {
      continue;
    }

    const isDone = taskMatch[1].trim().toLowerCase() === "x";
    const description = taskMatch[3].trim().replace(/^[\u2014\-\s]+/, "").trim();
    const task: ParsedTask = {
      id: taskMatch[2],
      description,
      done: isDone
    };

    currentPhase.tasks.push(task);
    currentPhase.total += 1;
    result.total += 1;

    if (isDone) {
      currentPhase.done += 1;
      result.done += 1;
    }
  }

  if (currentPhase) {
    result.phases.push(currentPhase);
  }

  result.pending = result.total - result.done;
  return result;
}

/** File-path wrapper around {@link parseAnalysisText}; kept for existing callers. */
export function parseAnalysisBlock(analysisPath: string): ParsedAnalysis {
  const content = readFileIfExists(analysisPath);
  if (!content) {
    return {
      present: false,
      status: null,
      total: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      findings: []
    };
  }
  return parseAnalysisText(content);
}

/**
 * Pure text-in parser for the analysis.md machine-readable YAML block. Exported separately from
 * {@link parseAnalysisBlock} so callers that already have the file content in memory (e.g. the
 * schema validator in validate.ts) don't need a second regex implementation or a round-trip
 * through the filesystem.
 */
export function parseAnalysisText(content: string): ParsedAnalysis {
  const output: ParsedAnalysis = {
    present: false,
    status: null,
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    findings: []
  };

  const blockMatch = /```yaml\s*([\s\S]*?)```/.exec(content);
  if (!blockMatch) {
    return output;
  }

  output.present = true;
  const yaml = blockMatch[1];

  const scalarKeys = ["status", "total", "critical", "high", "medium", "low"] as const;
  for (const key of scalarKeys) {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "m").exec(yaml);
    if (!match) continue;

    const value = parseInlineScalar(match[1]);
    if (key === "status") {
      output.status = value;
    } else {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        output[key] = parsed;
      }
    }
  }

  const findingsStart = yaml.indexOf("findings:");
  if (findingsStart < 0) {
    return output;
  }

  let findingsChunk = yaml.slice(findingsStart);
  const findingsEnd = /^\s*(coverage_gaps|principles_issues)\s*:/m.exec(findingsChunk);
  if (findingsEnd && typeof findingsEnd.index === "number") {
    findingsChunk = findingsChunk.slice(0, findingsEnd.index);
  }

  const idRegex = /^\s*-\s*id:\s*(.*)$/gm;
  const entries: Array<{ id: string; index: number }> = [];
  for (const match of findingsChunk.matchAll(idRegex)) {
    const id = parseInlineScalar(match[1] ?? "");
    const index = match.index ?? 0;
    entries.push({ id, index });
  }

  for (let i = 0; i < entries.length; i += 1) {
    const start = entries[i].index;
    const end = i + 1 < entries.length ? entries[i + 1].index : findingsChunk.length;
    const block = findingsChunk.slice(start, end);

    const severity = parseInlineScalar(/^\s*severity:\s*(.*)$/m.exec(block)?.[1] ?? "");
    const category = parseInlineScalar(/^\s*category:\s*(.*)$/m.exec(block)?.[1] ?? "");
    const summary = parseInlineScalar(/^\s*summary:\s*(.*)$/m.exec(block)?.[1] ?? "");
    const location = parseInlineScalar(/^\s*location:\s*(.*)$/m.exec(block)?.[1] ?? "");
    const resolved = (/^\s*resolved:\s*(true|false)/m.exec(block)?.[1] ?? "false").toLowerCase() === "true";

    const phasesRaw = /^\s*affects_phases:\s*\[([^\]]*)\]/m.exec(block)?.[1] ?? "";
    const affectsPhases = phasesRaw
      .split(",")
      .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);

    const deferReasonMatch = /^\s*defer_reason:\s*(.*)$/m.exec(block);
    const deferReason = deferReasonMatch ? parseInlineScalar(deferReasonMatch[1]) : null;

    output.findings.push({
      id: entries[i].id,
      severity,
      category,
      summary,
      location,
      resolved,
      affects_phases: affectsPhases,
      defer_reason: deferReason || null
    });
  }

  return output;
}

/**
 * A finding with an empty `affects_phases` list was not scoped by its author (e.g. a red-team
 * finding emitted before phases existed) — treat that as "affects every phase" rather than "affects
 * no phase". An unscoped finding must never silently skip every implement-phase gate while still
 * blocking globally at commit/push (see gate.ts).
 */
export function findingAffectsPhase(finding: { affects_phases: string[] }, phaseLabel: string): boolean {
  return finding.affects_phases.length === 0 || finding.affects_phases.includes(phaseLabel);
}

export function parsePrinciplesMusts(principlesPath: string): string[] {
  const content = readFileIfExists(principlesPath);
  if (!content) {
    return [];
  }

  const musts: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (!/\bMUST(?:\s+NOT)?\b/.test(rawLine)) continue;
    let line = rawLine.trim();
    if (!line) continue;
    if (/^\s*<!--/.test(line)) continue;
    if (/\[(requirement|prohibition|recommendation|PRINCIPLE[^\]]*|PROJECT_NAME)\]/.test(line)) continue;
    if (/Example:/.test(line)) continue;

    line = line.replace(/^[-* >]+/, "").trim();
    if (line) musts.push(line);
  }

  return Array.from(new Set(musts));
}

export function getPrinciplesMusts(repoRoot: string): string[] {
  const principlesPath = path.join(repoRoot, "wspec", "principles.md");
  const lockPath = path.join(repoRoot, "wspec", "principles.lock.json");

  if (fs.existsSync(principlesPath) && fs.existsSync(lockPath)) {
    const principlesMtime = fs.statSync(principlesPath).mtimeMs;
    const lockMtime = fs.statSync(lockPath).mtimeMs;
    if (lockMtime >= principlesMtime) {
      try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { musts?: unknown };
        if (Array.isArray(parsed.musts)) {
          return parsed.musts.filter((v): v is string => typeof v === "string");
        }
      } catch {
        // Ignore lock parse failures and fall through.
      }
    }
  }

  return parsePrinciplesMusts(principlesPath);
}

export function lockPrinciples(repoRoot: string, refresh = false) {
  const principlesPath = path.join(repoRoot, "wspec", "principles.md");
  const lockPath = path.join(repoRoot, "wspec", "principles.lock.json");

  if (!fs.existsSync(principlesPath)) {
    throw new Error("principles.md not found");
  }

  const principlesMtime = fs.statSync(principlesPath).mtimeMs;
  const lockExists = fs.existsSync(lockPath);
  const lockMtime = lockExists ? fs.statSync(lockPath).mtimeMs : 0;

  let refreshed = false;
  if (refresh || !lockExists || lockMtime < principlesMtime) {
    const musts = parsePrinciplesMusts(principlesPath);
    const payload = {
      source: "wspec/principles.md",
      cache_path: "wspec/principles.lock.json",
      refreshed: true,
      generated_at: new Date().toISOString(),
      musts_count: musts.length,
      musts
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    refreshed = true;
  }

  const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
    musts?: unknown;
    source?: unknown;
    cache_path?: unknown;
  };

  const musts = Array.isArray(current.musts) ? current.musts.filter((v): v is string => typeof v === "string") : [];

  return {
    source: typeof current.source === "string" ? current.source : "wspec/principles.md",
    cache_path: typeof current.cache_path === "string" ? current.cache_path : "wspec/principles.lock.json",
    refreshed,
    musts_count: musts.length,
    musts
  };
}

export function getChangeSummary(changeDir: string, repoRoot: string) {
  const id = path.basename(changeDir);
  const metadata = readYamlScalars(path.join(changeDir, "metadata.yaml"));
  const tasks = parseTaskInfo(path.join(changeDir, "tasks.md"));
  const analysis = parseAnalysisBlock(path.join(changeDir, "analysis.md"));

  const artifacts: Record<string, boolean> = {};
  for (const name of ["metadata.yaml", "research.md", "proposal.md", "spec.md", "design.md", "tasks.md", "analysis.md"]) {
    artifacts[name] = fs.existsSync(path.join(changeDir, name));
  }

  const deltaSpecsDir = path.join(changeDir, "specs");
  const delta_specs = fs.existsSync(deltaSpecsDir)
    ? fs
        .readdirSync(deltaSpecsDir, { withFileTypes: true })
        .filter((v: fs.Dirent) => v.isDirectory())
        .map((v: fs.Dirent) => v.name)
    : [];

  const unresolved_ids = analysis.findings.filter((f) => !f.resolved).map((f) => f.id);

  return {
    id,
    path: changeDir,
    title: metadata.title,
    status: metadata.status,
    branch: metadata.branch,
    capability: metadata.capability,
    tasks: {
      total: tasks.total,
      done: tasks.done,
      pending: tasks.pending
    },
    artifacts,
    analysis: {
      present: analysis.present,
      status: analysis.status,
      critical: analysis.critical,
      high: analysis.high,
      unresolved_ids
    },
    delta_specs
  };
}

export function listChangeSummaries(repoRoot: string, id?: string, activeOnly = true) {
  const changesDir = path.join(repoRoot, "wspec", "changes");
  if (!fs.existsSync(changesDir)) {
    return { changes: [] as Array<ReturnType<typeof getChangeSummary>> };
  }

  const dirs = fs
    .readdirSync(changesDir, { withFileTypes: true })
    .filter((v: fs.Dirent) => v.isDirectory())
    .map((v: fs.Dirent) => v.name)
    .sort((a: string, b: string) => a.localeCompare(b))
    .filter((name: string) => !id || name === id)
    .map((name: string) => path.join(changesDir, name));

  const changes = dirs.map((dir: string) => getChangeSummary(dir, repoRoot));

  // A change left at status "done" but not yet archived (or a stray fixture) must not count as
  // "active" — otherwise it pollutes auto-select in /wspec-implement and /wspec-finalize. Explicit
  // id lookups (e.g. wspec.loadChange) always bypass this filter.
  const filtered = activeOnly && !id ? changes.filter((change) => (change.status ?? "").toLowerCase() !== "done") : changes;

  return { changes: filtered };
}

export function loadChangeContext(repoRoot: string, id: string) {
  const changeDir = path.join(repoRoot, "wspec", "changes", id);
  if (!fs.existsSync(changeDir)) {
    throw new Error(`Change not found: ${id} (looked in wspec/changes/${id})`);
  }

  const summary = getChangeSummary(changeDir, repoRoot);
  const tasks = parseTaskInfo(path.join(changeDir, "tasks.md"));
  const analysis = parseAnalysisBlock(path.join(changeDir, "analysis.md"));
  const principles_musts = getPrinciplesMusts(repoRoot);

  const current_branch = getCurrentBranch(repoRoot);

  const phases = tasks.phases.map((phase) => ({
    num: phase.num,
    title: phase.title,
    total: phase.total,
    done: phase.done,
    complete: phase.total > 0 && phase.done === phase.total
  }));

  const nextPhase = tasks.phases.find((phase) => phase.total > 0 && phase.done < phase.total) ?? null;

  let next_phase: {
    num: number;
    title: string;
    pending_tasks: Array<{ id: string; description: string }>;
  } | null = null;

  let unresolved_findings_for_next_phase: Array<{ id: string; severity: string; summary: string; location: string }> = [];

  if (nextPhase) {
    next_phase = {
      num: nextPhase.num,
      title: nextPhase.title,
      pending_tasks: nextPhase.tasks
        .filter((task) => !task.done)
        .map((task) => ({ id: task.id, description: task.description }))
    };

    const phaseLabel = `Phase ${nextPhase.num}`;
    unresolved_findings_for_next_phase = analysis.findings
      .filter((finding) => !finding.resolved && findingAffectsPhase(finding, phaseLabel))
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        summary: finding.summary,
        location: finding.location
      }));
  }

  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    branch: summary.branch,
    capability: summary.capability,
    current_branch,
    branch_matches: current_branch === summary.branch,
    tasks: summary.tasks,
    phases,
    next_phase,
    unresolved_findings_for_next_phase,
    analysis: summary.analysis,
    principles_musts,
    artifacts: summary.artifacts,
    delta_specs: summary.delta_specs
  };
}

export function setChangeStatus(repoRoot: string, id: string, status: "drafting" | "implementing" | "ready" | "done") {
  assertChangeBranch(repoRoot, id, `set status to '${status}'`);

  const metadataPath = path.join(repoRoot, "wspec", "changes", id, "metadata.yaml");
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`metadata.yaml not found for change: ${id}`);
  }

  const metadata = readYamlScalars(metadataPath);
  const previous_status = metadata.status;
  const updated = new Date().toISOString().slice(0, 10);

  let content = fs.readFileSync(metadataPath, "utf8");
  content = content.replace(/^status\s*:.*$/m, `status: "${status}"`);
  content = content.replace(/^updated\s*:.*$/m, `updated: "${updated}"`);

  fs.writeFileSync(metadataPath, content, "utf8");

  return {
    change_id: id,
    previous_status,
    new_status: status,
    updated,
    error: null
  };
}

export function validatePhase(repoRoot: string, id: string, phase: number) {
  assertChangeBranch(repoRoot, id, `validate phase ${phase}`);

  const changeDir = path.join(repoRoot, "wspec", "changes", id);
  if (!fs.existsSync(changeDir)) {
    throw new Error(`Change not found: ${id}`);
  }

  const tasks = parseTaskInfo(path.join(changeDir, "tasks.md"));
  const analysis = parseAnalysisBlock(path.join(changeDir, "analysis.md"));
  const principles_musts_to_check = getPrinciplesMusts(repoRoot);

  const phaseObj = tasks.phases.find((p) => p.num === phase);
  if (!phaseObj) {
    throw new Error(`Phase ${phase} not found in tasks.md`);
  }

  const incomplete_tasks = phaseObj.tasks
    .filter((task) => !task.done)
    .map((task) => ({ id: task.id, description: task.description }));

  const phaseLabel = `Phase ${phase}`;
  const blocking_findings = analysis.findings
    .filter((finding) => !finding.resolved && findingAffectsPhase(finding, phaseLabel))
    .filter((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH")
    .map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      summary: finding.summary,
      location: finding.location
    }));

  const criticalCount = blocking_findings.filter((f) => f.severity === "CRITICAL").length;
  const status =
    incomplete_tasks.length === 0 && criticalCount === 0
      ? blocking_findings.length === 0
        ? "pass"
        : "warn"
      : "fail";

  return {
    status,
    phase,
    phase_title: phaseObj.title,
    incomplete_tasks,
    blocking_findings,
    principles_musts_to_check,
    notes: [
      "CRITICAL findings = STOP. HIGH findings = STOP unless explicitly deferred.",
      "Principles checks require LLM judgment against the code changed in this phase."
    ]
  };
}

export function markTaskState(
  repoRoot: string,
  id: string,
  taskId: string,
  pending: boolean,
  dryRun: boolean
) {
  assertChangeBranch(repoRoot, id, `${pending ? "mark" : "complete"} task '${taskId}'`);

  const tasksPath = path.join(repoRoot, "wspec", "changes", id, "tasks.md");
  if (!fs.existsSync(tasksPath)) {
    throw new Error(`tasks.md not found for change: ${id}`);
  }

  const raw = fs.readFileSync(tasksPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const taskPattern = new RegExp(`^\\s*-\\s*\\[([ xX])\\]\\s*${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

  let lineIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (taskPattern.test(lines[i])) {
      lineIndex = i;
      break;
    }
  }

  if (lineIndex < 0) {
    throw new Error(`Task '${taskId}' not found in tasks.md for change: ${id}`);
  }

  const wasDone = /^\s*-\s*\[[xX]\]/.test(lines[lineIndex]);
  const previous_state = wasDone ? "done" : "pending";
  const new_state = pending ? "pending" : "done";
  const already_correct = previous_state === new_state;

  let applied = false;
  if (!dryRun && !already_correct) {
    const marker = pending ? " " : "x";
    lines[lineIndex] = lines[lineIndex].replace(/\[([ xX])\]/, `[${marker}]`);
    fs.writeFileSync(tasksPath, lines.join(eol), "utf8");
    applied = true;
  }

  return {
    change_id: id,
    task_id: taskId,
    action: new_state,
    previous_state,
    new_state,
    already_correct,
    line_num: lineIndex + 1,
    dry_run: dryRun,
    applied,
    error: null
  };
}
