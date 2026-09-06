import fs from "node:fs";
import path from "node:path";
import { parseTaskInfo } from "./changes.js";

/**
 * Deterministic FR/SC → task → test matching, computed by string matching rather than the
 * wspec-analyst subagent reading every artifact and reasoning it out. Narrows what the opus
 * analyst pass has to judge to "is this gap actually a problem," not "does this gap exist."
 *
 * Convention: a task in tasks.md opts in to a requirement by tagging it inline, e.g.
 *   - [ ] T012 [US1] [unit] [FR-007] Cadence occurrences stay in range — src/lib/cadence.ts
 * `[FR-007]`/`[SC-003]` marks which requirement the task serves; `[unit]`/`[intg]`/`[e2e]`
 * (already part of the tasks-template.md grammar) marks it as a test task. A task with a
 * requirement tag but no test-level tag counts toward has_task but not has_test.
 */

export interface CoverageGap {
  requirement: string;
  has_task: boolean;
  task_ids: string[];
  has_test: boolean;
  test_ids: string[];
}

export interface CoverageReport {
  change_id: string;
  requirements: string[];
  gaps: CoverageGap[];
}

const REQUIREMENT_TAG = /\[((?:FR|SC)-\d{3})\]/g;
const TEST_LEVEL_TAG = /\[(unit|intg|e2e)\]/;

function extractRequirementIds(specContent: string): string[] {
  const ids = new Set<string>();
  for (const line of specContent.split(/\r?\n/)) {
    const match = /^-\s*\*\*((?:FR|SC)-\d{3})\*\*/.exec(line.trim());
    if (match) ids.add(match[1]);
  }
  return Array.from(ids).sort();
}

export function computeCoverage(repoRoot: string, id: string): CoverageReport {
  const changeDir = path.join(repoRoot, "wspec", "changes", id);
  const specPath = path.join(changeDir, "spec.md");
  const tasksPath = path.join(changeDir, "tasks.md");

  const specContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, "utf8") : "";
  const requirements = extractRequirementIds(specContent);
  const tasks = parseTaskInfo(tasksPath);

  const taskIdsByRequirement = new Map<string, Set<string>>();
  const testTaskIdsByRequirement = new Map<string, Set<string>>();

  for (const phase of tasks.phases) {
    for (const task of phase.tasks) {
      const isTest = TEST_LEVEL_TAG.test(task.description);
      const tagMatches = task.description.matchAll(REQUIREMENT_TAG);
      for (const match of tagMatches) {
        const req = match[1];
        if (!taskIdsByRequirement.has(req)) taskIdsByRequirement.set(req, new Set());
        taskIdsByRequirement.get(req)!.add(task.id);
        if (isTest) {
          if (!testTaskIdsByRequirement.has(req)) testTaskIdsByRequirement.set(req, new Set());
          testTaskIdsByRequirement.get(req)!.add(task.id);
        }
      }
    }
  }

  const gaps: CoverageGap[] = requirements.map((requirement) => {
    const taskIds = Array.from(taskIdsByRequirement.get(requirement) ?? []).sort();
    const testIds = Array.from(testTaskIdsByRequirement.get(requirement) ?? []).sort();
    return {
      requirement,
      has_task: taskIds.length > 0,
      task_ids: taskIds,
      has_test: testIds.length > 0,
      test_ids: testIds
    };
  });

  return { change_id: id, requirements, gaps };
}
