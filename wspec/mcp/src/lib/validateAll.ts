import { loadChangeContext, validatePhase } from "./changes.js";
import { gateCheck } from "./gate.js";

/**
 * Runs wspec.validatePhase across every phase of a change plus a manual gateCheck, in one call.
 * Used by /wspec-finalize (and CI) to confirm a change is actually clean end-to-end instead of
 * inferring completion from summary counts alone.
 */
export function validateAll(repoRoot: string, id: string) {
  const context = loadChangeContext(repoRoot, id);

  const phases = context.phases.map((phase) => {
    try {
      return validatePhase(repoRoot, id, phase.num);
    } catch (error) {
      return {
        status: "fail" as const,
        phase: phase.num,
        phase_title: phase.title,
        incomplete_tasks: [],
        blocking_findings: [],
        principles_musts_to_check: [],
        notes: [error instanceof Error ? error.message : String(error)]
      };
    }
  });

  const gate = gateCheck(repoRoot, "manual", id);

  const anyPhaseFailed = phases.some((p) => p.status === "fail");
  const anyPhaseWarned = phases.some((p) => p.status === "warn");
  const status = anyPhaseFailed || gate.blocked ? "fail" : anyPhaseWarned ? "warn" : "pass";

  return {
    change_id: id,
    status,
    phases,
    gate
  };
}
