import fs from "node:fs";
import path from "node:path";
import { assertChangeBranch, parseAnalysisText } from "./changes.js";

/**
 * Deterministic finding ingestion for analysis.md's machine-readable YAML block. Replaces the
 * "LLM must merge red-team findings into analysis.md verbatim without dropping or re-arguing them"
 * prose instruction with a mechanical merge: dedupe by (location, summary), renumber to the next
 * free `A#` id, never touch an existing finding's severity, and recompute the summary counts from
 * the merged set. Also usable outside the propose flow, e.g. adding a single finding discovered
 * mid-lifecycle without spinning up a subagent.
 *
 * Scope: only the machine-readable YAML block is rewritten (the source of truth every gate reads).
 * The human-readable Findings/Coverage tables elsewhere in analysis.md are left as-is; call
 * wspec-analyst again if you also want the prose tables regenerated.
 */

export interface IncomingFinding {
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  location: string;
  summary: string;
  affects_phases?: string[];
  resolved?: boolean;
  defer_reason?: string;
}

interface MergedFinding {
  id: string;
  category: string;
  severity: string;
  location: string;
  summary: string;
  affects_phases: string[];
  resolved: boolean;
  defer_reason: string | null;
}

function yamlStr(value: string): string {
  // A JSON double-quoted string is a valid YAML double-quoted scalar (YAML flow scalars are a
  // superset of JSON string syntax), so this safely round-trips summaries/locations containing
  // apostrophes, '#', or colons without a bespoke YAML string escaper.
  return JSON.stringify(value);
}

function serializeFindings(findings: MergedFinding[]): string {
  if (findings.length === 0) return "  findings: []";
  const lines = ["  findings:"];
  for (const f of findings) {
    lines.push(`    - id: ${yamlStr(f.id)}`);
    lines.push(`      category: ${yamlStr(f.category)}`);
    lines.push(`      severity: ${yamlStr(f.severity)}`);
    lines.push(`      location: ${yamlStr(f.location)}`);
    lines.push(`      summary: ${yamlStr(f.summary)}`);
    lines.push(`      affects_phases: [${f.affects_phases.map(yamlStr).join(", ")}]`);
    lines.push(`      resolved: ${f.resolved}`);
    if (f.defer_reason) {
      lines.push(`      defer_reason: ${yamlStr(f.defer_reason)}`);
    }
  }
  return lines.join("\n");
}

function extractTailBlock(yamlText: string): string {
  const match = /^\s*coverage_gaps\s*:/m.exec(yamlText);
  if (!match || typeof match.index !== "number") {
    return "  coverage_gaps: []\n  principles_issues: []";
  }
  return yamlText.slice(match.index).replace(/\n+$/, "");
}

export function appendFindings(repoRoot: string, id: string, incoming: IncomingFinding[]) {
  assertChangeBranch(repoRoot, id, "append findings to analysis.md");

  if (incoming.length === 0) {
    throw new Error("appendFindings requires at least one finding.");
  }

  const analysisPath = path.join(repoRoot, "wspec", "changes", id, "analysis.md");
  if (!fs.existsSync(analysisPath)) {
    throw new Error(`analysis.md not found for change: ${id}`);
  }

  const content = fs.readFileSync(analysisPath, "utf8");
  const blockMatch = /```yaml\s*([\s\S]*?)```/.exec(content);
  if (!blockMatch) {
    throw new Error(`analysis.md for change '${id}' has no machine-readable yaml block to append to.`);
  }

  const parsed = parseAnalysisText(content);
  const merged: MergedFinding[] = parsed.findings.map((f) => ({ ...f }));

  let maxNum = 0;
  for (const f of merged) {
    const m = /^A([0-9]+)$/.exec(f.id);
    if (m) maxNum = Math.max(maxNum, Number.parseInt(m[1], 10));
  }

  const added: string[] = [];
  const deduped: Array<{ summary: string; existing_id: string }> = [];

  for (const finding of incoming) {
    const dupe = merged.find((f) => f.location === finding.location && f.summary === finding.summary);
    if (dupe) {
      deduped.push({ summary: finding.summary, existing_id: dupe.id });
      continue;
    }
    maxNum += 1;
    const newId = `A${maxNum}`;
    merged.push({
      id: newId,
      category: finding.category,
      severity: finding.severity,
      location: finding.location,
      summary: finding.summary,
      affects_phases: finding.affects_phases ?? [],
      resolved: finding.resolved ?? false,
      defer_reason: finding.defer_reason ?? null
    });
    added.push(newId);
  }

  const critical = merged.filter((f) => f.severity === "CRITICAL").length;
  const high = merged.filter((f) => f.severity === "HIGH").length;
  const medium = merged.filter((f) => f.severity === "MEDIUM").length;
  const low = merged.filter((f) => f.severity === "LOW").length;
  const total = merged.length;
  const hasUnresolvedCriticalOrHigh = merged.some((f) => !f.resolved && (f.severity === "CRITICAL" || f.severity === "HIGH"));
  const hasUnresolved = merged.some((f) => !f.resolved);
  const status = hasUnresolvedCriticalOrHigh ? "issues" : hasUnresolved ? "warnings" : "pass";

  const tailBlock = extractTailBlock(blockMatch[1]);
  const newYaml = [
    "```yaml",
    "analysis:",
    `  status: ${yamlStr(status)}`,
    `  total: ${total}`,
    `  critical: ${critical}`,
    `  high: ${high}`,
    `  medium: ${medium}`,
    `  low: ${low}`,
    serializeFindings(merged),
    tailBlock,
    "```"
  ].join("\n");

  const newContent = content.replace(/```yaml\s*[\s\S]*?```/, newYaml);
  fs.writeFileSync(analysisPath, newContent, "utf8");

  return {
    change_id: id,
    added,
    deduped,
    total_findings: merged.length,
    status
  };
}
