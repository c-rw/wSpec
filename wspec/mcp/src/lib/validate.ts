import fs from "node:fs";
import { parseAnalysisText } from "./changes.js";

/**
 * Hand-rolled structural validator for the analysis.md machine-readable YAML block, checked
 * against the rules in wspec/schemas/analysis-findings.schema.json. No YAML/JSON-schema library
 * dependency: the schema shape is small and fixed, and the repo already has a regex-based parser
 * (parseAnalysisText) that this reuses rather than duplicating. This is what makes the schema an
 * enforced contract instead of a decorative file that silently drifts from what the commands and
 * subagents actually emit.
 *
 * Known limitation: coverage_gaps[] and principles_issues[] are checked for key presence only,
 * not deep structural validation (parseAnalysisText does not currently parse those arrays).
 */

export interface AnalysisValidationIssue {
  path: string;
  message: string;
}

export interface AnalysisValidationResult {
  valid: boolean;
  present: boolean;
  issue_count: number;
  issues: AnalysisValidationIssue[];
}

const ALLOWED_CATEGORIES = new Set([
  "Coverage Gap",
  "Ambiguity",
  "Duplication",
  "Inconsistency",
  "Underspecification",
  "Principles",
  "SOLID Violation",
  "Security",
  "Architecture Risk",
  "Scope Creep",
  "Adversarial",
  "Boundary"
]);
const ALLOWED_SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const ALLOWED_STATUS = new Set(["pass", "warnings", "issues"]);
const ID_PATTERN = /^A[0-9]+$/;
const PHASE_PATTERN = /^Phase [0-9]+$/;

export function validateAnalysisContent(content: string): AnalysisValidationResult {
  const hasYamlBlock = /```yaml\s*([\s\S]*?)```/.test(content);
  if (!hasYamlBlock) {
    return {
      valid: false,
      present: false,
      issue_count: 1,
      issues: [{ path: "analysis", message: "No ```yaml machine-readable block found in analysis.md" }]
    };
  }

  const issues: AnalysisValidationIssue[] = [];
  const parsed = parseAnalysisText(content);

  if (!ALLOWED_STATUS.has(parsed.status ?? "")) {
    issues.push({ path: "analysis.status", message: `status must be one of pass|warnings|issues, got '${parsed.status}'` });
  }

  const seenIds = new Set<string>();
  parsed.findings.forEach((finding, index) => {
    const fp = `analysis.findings[${index}]`;
    if (!ID_PATTERN.test(finding.id)) {
      issues.push({ path: `${fp}.id`, message: `id '${finding.id}' does not match ^A[0-9]+$` });
    } else if (seenIds.has(finding.id)) {
      issues.push({ path: `${fp}.id`, message: `duplicate id '${finding.id}'` });
    } else {
      seenIds.add(finding.id);
    }

    if (!ALLOWED_CATEGORIES.has(finding.category)) {
      issues.push({
        path: `${fp}.category`,
        message: `category '${finding.category}' is not in the allowed set (${Array.from(ALLOWED_CATEGORIES).join(", ")})`
      });
    }

    if (!ALLOWED_SEVERITIES.has(finding.severity)) {
      issues.push({ path: `${fp}.severity`, message: `severity '${finding.severity}' must be CRITICAL|HIGH|MEDIUM|LOW` });
    }

    if (!finding.location.trim()) {
      issues.push({ path: `${fp}.location`, message: "location must be non-empty" });
    }

    if (!finding.summary.trim()) {
      issues.push({ path: `${fp}.summary`, message: "summary must be non-empty" });
    }

    for (const phase of finding.affects_phases) {
      if (!PHASE_PATTERN.test(phase)) {
        issues.push({ path: `${fp}.affects_phases`, message: `phase entry '${phase}' does not match "Phase N"` });
      }
    }

    if (finding.resolved && !(finding.defer_reason ?? "").trim()) {
      issues.push({ path: `${fp}.defer_reason`, message: "resolved findings should carry a non-empty defer_reason" });
    }
  });

  if (!/coverage_gaps\s*:/.test(content)) {
    issues.push({ path: "analysis.coverage_gaps", message: "coverage_gaps key is missing from the YAML block" });
  }
  if (!/principles_issues\s*:/.test(content)) {
    issues.push({ path: "analysis.principles_issues", message: "principles_issues key is missing from the YAML block" });
  }

  return { valid: issues.length === 0, present: true, issue_count: issues.length, issues };
}

export function validateAnalysisFile(analysisPath: string): AnalysisValidationResult {
  if (!fs.existsSync(analysisPath)) {
    return { valid: false, present: false, issue_count: 1, issues: [{ path: "analysis", message: "analysis.md not found" }] };
  }
  return validateAnalysisContent(fs.readFileSync(analysisPath, "utf8"));
}
