import { z } from "zod";
import { createFeatureBranch } from "./branch.js";
import {
  listChangeSummaries,
  loadChangeContext,
  lockPrinciples,
  markTaskState,
  parseAnalysisBlock,
  setChangeStatus,
  validatePhase
} from "./changes.js";
import { computeCoverage } from "./coverage.js";
import { runChecks } from "./checks.js";
import { runDoctor } from "./doctor.js";
import { archiveChange, postArchiveAction, syncSpec } from "./finalize.js";
import { appendFindings, type IncomingFinding } from "./findings.js";
import { getForgeCaps } from "./forgeCaps.js";
import { closeIssue, commentIssue, createIssue, ensureLabel, getIssue, listIssues, updateIssue } from "./issues.js";
import { findRepoRoot } from "./root.js";
import { repoScan } from "./scan.js";
import { loadState, verifyState, writeState, writeStateBestEffort } from "./state.js";
import { bindTicket, readTicketConfig, syncTicket, syncTicketBestEffort } from "./ticket.js";
import { validateAll } from "./validateAll.js";
import { validateAnalysisFile } from "./validate.js";
import { gateCheck, recordOverride } from "./gate.js";
import path from "node:path";
import {
  addTotals,
  emptyTotals,
  loadUsageLedger,
  readUsageLog,
  rollupByCommand,
  rollupLedger,
  type TokenTotals
} from "./usage.js";

const emptySchema = z.object({}).strict().optional();

const gateCheckSchema = z.object({
  gate: z.enum(["pre-commit", "pre-push", "manual"]),
  id: z.string().optional()
});

const recordOverrideSchema = z.object({
  gate: z.enum(["pre-commit", "pre-push", "manual"]).optional(),
  id: z.string().optional(),
  findingId: z.string().min(1),
  reason: z.string().min(1)
});

const createFeatureBranchSchema = z.object({
  featureDescription: z.string().min(1),
  shortName: z.string().optional(),
  dryRun: z.boolean().optional(),
  allowExistingBranch: z.boolean().optional()
});

const statusSchema = z.object({
  id: z.string().optional()
});

const loadChangeSchema = z.object({
  id: z.string().min(1)
});

const setStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["drafting", "implementing", "ready", "done"])
});

const markTaskSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  pending: z.boolean().optional(),
  dryRun: z.boolean().optional()
});

const validatePhaseSchema = z.object({
  id: z.string().min(1),
  phase: z.number().int().min(1)
});

const runChecksSchema = z.object({
  id: z.string().min(1),
  phase: z.number().int().min(1).optional()
});

const computeCoverageSchema = z.object({
  id: z.string().min(1)
});

const lockPrinciplesSchema = z.object({
  refresh: z.boolean().optional()
});

const syncSpecSchema = z.object({
  id: z.string().min(1),
  apply: z.boolean().optional()
});

const archiveSchema = z.object({
  id: z.string().min(1),
  dryRun: z.boolean().optional()
});

const validateAnalysisSchema = z.object({
  id: z.string().min(1)
});

const validateAllSchema = z.object({
  id: z.string().min(1)
});

const incomingFindingSchema = z.object({
  category: z.string().min(1),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  location: z.string().min(1),
  summary: z.string().min(1),
  affects_phases: z.array(z.string()).optional(),
  resolved: z.boolean().optional(),
  defer_reason: z.string().optional()
});

const appendFindingsSchema = z.object({
  id: z.string().min(1),
  findings: z.array(incomingFindingSchema).min(1)
});

const forgeEnum = z.enum(["github", "gitlab"]).optional();

const captureIssueSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  labels: z.array(z.string()).optional(),
  forge: forgeEnum
});

const listIssuesSchema = z.object({
  label: z.string().optional(),
  state: z.enum(["open", "closed", "all"]).optional(),
  forge: forgeEnum
});

const getIssueSchema = z.object({
  number: z.number().int().positive(),
  forge: forgeEnum
});

const commentIssueSchema = z.object({
  number: z.number().int().positive(),
  body: z.string().min(1),
  forge: forgeEnum
});

const updateIssueSchema = z
  .object({
    number: z.number().int().positive(),
    body: z.string().optional(),
    title: z.string().optional(),
    forge: forgeEnum
  })
  .refine((v) => v.body !== undefined || v.title !== undefined, {
    message: "At least one of body or title is required"
  });

const closeIssueSchema = z.object({
  number: z.number().int().positive(),
  comment: z.string().optional(),
  forge: forgeEnum
});

const usageReportSchema = z.object({
  id: z.string().optional()
});

const postArchiveSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["none", "pr", "merge"]).optional(),
  title: z.string().optional(),
  defaultBranch: z.string().optional(),
  deleteBranch: z.boolean().optional(),
  push: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  forge: z.enum(["github", "gitlab"]).optional()
});

const forgeCapsSchema = z.object({
  refresh: z.boolean().optional(),
  forge: forgeEnum
});

const ticketEventEnum = z.enum([
  "packet_created",
  "implementation_started",
  "phase_complete",
  "finding_critical",
  "checks_failed",
  "blocked",
  "archived"
]);

const syncTicketSchema = z.object({
  id: z.string().min(1),
  event: ticketEventEnum.optional(),
  phase: z.number().int().min(1).optional(),
  findingIds: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  forge: forgeEnum
});

const bindTicketSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive().optional(),
    create: z.boolean().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    milestone: z.string().optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dryRun: z.boolean().optional(),
    forge: forgeEnum
  })
  .refine((v) => v.number !== undefined || v.create === true, {
    message: "Provide `number` to bind an existing issue, or `create: true`"
  });

export const toolDefinitions = [
  {
    name: "wspec.createFeatureBranch",
    description: "Create or dry-run a feat/NNN-name branch and return identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        featureDescription: { type: "string" },
        shortName: { type: "string" },
        dryRun: { type: "boolean" },
        allowExistingBranch: { type: "boolean" }
      },
      required: ["featureDescription"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = createFeatureBranchSchema.parse(args);
      const repoRoot = findRepoRoot();
      return createFeatureBranch(
        repoRoot,
        input.featureDescription,
        input.shortName,
        input.dryRun ?? false,
        input.allowExistingBranch ?? false
      );
    }
  },
  {
    name: "wspec.status",
    description: "List active change packets and status summary.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = statusSchema.parse(args ?? {});
      const repoRoot = findRepoRoot();
      return listChangeSummaries(repoRoot, input.id);
    }
  },
  {
    name: "wspec.loadChange",
    description: "Load detailed context for a single change packet.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = loadChangeSchema.parse(args);
      const repoRoot = findRepoRoot();
      return loadChangeContext(repoRoot, input.id);
    }
  },
  {
    name: "wspec.setStatus",
    description: "Set change metadata status value.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["drafting", "implementing", "ready", "done"] }
      },
      required: ["id", "status"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = setStatusSchema.parse(args);
      const repoRoot = findRepoRoot();
      const result = setChangeStatus(repoRoot, input.id, input.status);
      writeStateBestEffort(repoRoot);
      const event = input.status === "implementing" && result.previous_status !== "implementing" ? "implementation_started" : undefined;
      syncTicketBestEffort(repoRoot, input.id, event);
      return result;
    }
  },
  {
    name: "wspec.markTask",
    description: "Mark a task complete or pending in tasks.md.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        taskId: { type: "string" },
        pending: { type: "boolean" },
        dryRun: { type: "boolean" }
      },
      required: ["id", "taskId"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = markTaskSchema.parse(args);
      const repoRoot = findRepoRoot();
      const result = markTaskState(repoRoot, input.id, input.taskId, input.pending ?? false, input.dryRun ?? false);
      writeStateBestEffort(repoRoot);
      // Only the "task" tier mirrors every tick. "phase" (default) and "transition" both leave
      // phase-boundary syncing to wspec.validatePhase below — it's the one place that actually
      // *knows* a phase closed, so it's the sole trigger rather than a second guess made here
      // from a completed-task's position in tasks.md.
      if (result.applied && readTicketConfig(repoRoot).sync_on === "task") {
        syncTicketBestEffort(repoRoot, input.id);
      }
      return result;
    }
  },
  {
    name: "wspec.validatePhase",
    description: "Run deterministic validation checks for a completed phase.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        phase: { type: "number" }
      },
      required: ["id", "phase"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = validatePhaseSchema.parse(args);
      const repoRoot = findRepoRoot();
      const result = validatePhase(repoRoot, input.id, input.phase);
      // The one place in the system that *knows* a phase closed — this is the fold-in site for
      // the "Phase N complete" comment, not markTask (which only sees individual ticks).
      if (result.status === "pass") {
        syncTicketBestEffort(repoRoot, input.id, "phase_complete", { phase: input.phase });
      }
      return result;
    }
  },
  {
    name: "wspec.runChecks",
    description:
      "Execution-evidence gate: run the check commands declared in wspec/config.yaml's checks: block (test/typecheck/lint) for a change, and report pass/fail. Returns a truncated digest plus a log file path per failing check — never the raw command output. Returns { enabled: false } when no checks: block is configured (pass-through, no behavior change).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        phase: { type: "number" }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = runChecksSchema.parse(args);
      const repoRoot = findRepoRoot();
      const report = runChecks(repoRoot, input.id, input.phase ?? null);
      writeStateBestEffort(repoRoot);
      syncTicketBestEffort(repoRoot, input.id, report.status === "fail" ? "checks_failed" : undefined);
      return report;
    }
  },
  {
    name: "wspec.computeCoverage",
    description:
      "Deterministically match spec.md FR-NNN/SC-NNN requirements against tasks.md tasks tagged with a matching [FR-NNN]/[SC-NNN] marker, and note whether any matching task also carries a [unit]/[intg]/[e2e] test-level tag. Pure string matching, not judgment — intended as input to the wspec-analyst subagent's coverage-gap pass, not a replacement for it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = computeCoverageSchema.parse(args);
      const repoRoot = findRepoRoot();
      return computeCoverage(repoRoot, input.id);
    }
  },
  {
    name: "wspec.repoScan",
    description: "Scan repository for lifecycle evidence (stack, quality, delivery, security, ops) excluding wspec framework paths.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    run: (_args: unknown) => {
      const repoRoot = findRepoRoot();
      return repoScan(repoRoot);
    }
  },
  {
    name: "wspec.lockPrinciples",
    description: "Generate or refresh the principles lock cache (principles.lock.json).",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean" }
      },
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = lockPrinciplesSchema.parse(args ?? {});
      const repoRoot = findRepoRoot();
      return lockPrinciples(repoRoot, input.refresh ?? false);
    }
  },
  {
    name: "wspec.syncSpec",
    description: "Diff and optionally apply delta specs from a change into wspec/specs.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        apply: { type: "boolean" }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = syncSpecSchema.parse(args);
      const repoRoot = findRepoRoot();
      const result = syncSpec(repoRoot, input.id, input.apply ?? false);
      writeStateBestEffort(repoRoot);
      return result;
    }
  },
  {
    name: "wspec.archive",
    description: "Archive a change to wspec/archive/YYYY-MM-DD-<id>, with optional dry-run.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        dryRun: { type: "boolean" }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = archiveSchema.parse(args);
      const repoRoot = findRepoRoot();
      const result = archiveChange(repoRoot, input.id, input.dryRun ?? false);
      writeStateBestEffort(repoRoot);
      if (!input.dryRun && result.moved) {
        syncTicketBestEffort(repoRoot, input.id, "archived");
      }
      return result;
    }
  },
  {
    name: "wspec.postArchive",
    description: "Execute post-archive action (none/pr/merge); for 'pr', opens a GitHub PR (gh) or GitLab MR (glab), auto-detected from origin (override with 'forge').",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        action: { type: "string", enum: ["none", "pr", "merge"] },
        title: { type: "string" },
        defaultBranch: { type: "string" },
        deleteBranch: { type: "boolean" },
        push: { type: "boolean" },
        dryRun: { type: "boolean" },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = postArchiveSchema.parse(args ?? {});
      const repoRoot = findRepoRoot();
      return postArchiveAction(
        repoRoot,
        input.id,
        input.action,
        input.title,
        input.defaultBranch,
        input.deleteBranch ?? false,
        input.push ?? false,
        input.dryRun ?? false,
        input.forge
      );
    }
  },
  {
    name: "wspec.syncState",
    description: "Rebuild and atomically write the central state index (wspec/state.json) from disk.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    run: (args: unknown) => {
      emptySchema.parse(args ?? {});
      const repoRoot = findRepoRoot();
      return writeState(repoRoot, { force: true });
    }
  },
  {
    name: "wspec.loadState",
    description: "Read the committed central state index (rebuilds in memory if none is committed yet).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    run: (args: unknown) => {
      emptySchema.parse(args ?? {});
      const repoRoot = findRepoRoot();
      return loadState(repoRoot);
    }
  },
  {
    name: "wspec.verifyState",
    description: "Rebuild in memory and diff against the committed state index; reports in_sync + drift.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    run: (args: unknown) => {
      emptySchema.parse(args ?? {});
      const repoRoot = findRepoRoot();
      return verifyState(repoRoot);
    }
  },
  {
    name: "wspec.gateCheck",
    description: "Block/allow decision for a git gate (pre-commit/pre-push) based on unresolved findings and active overrides.",
    inputSchema: {
      type: "object",
      properties: {
        gate: { type: "string", enum: ["pre-commit", "pre-push", "manual"] },
        id: { type: "string" }
      },
      required: ["gate"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = gateCheckSchema.parse(args);
      const repoRoot = findRepoRoot();
      return gateCheck(repoRoot, input.gate, input.id);
    }
  },
  {
    name: "wspec.validateAnalysis",
    description: "Validate a change's analysis.md YAML block against the analysis-findings schema.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = validateAnalysisSchema.parse(args);
      const repoRoot = findRepoRoot();
      const analysisPath = path.join(repoRoot, "wspec", "changes", input.id, "analysis.md");
      return { change_id: input.id, ...validateAnalysisFile(analysisPath) };
    }
  },
  {
    name: "wspec.appendFindings",
    description: "Merge one or more findings into a change's analysis.md YAML block (dedupe, renumber, recompute counts).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string" },
              severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
              location: { type: "string" },
              summary: { type: "string" },
              affects_phases: { type: "array", items: { type: "string" } },
              resolved: { type: "boolean" },
              defer_reason: { type: "string" }
            },
            required: ["category", "severity", "location", "summary"],
            additionalProperties: false
          }
        }
      },
      required: ["id", "findings"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = appendFindingsSchema.parse(args);
      const repoRoot = findRepoRoot();
      const result = appendFindings(repoRoot, input.id, input.findings as IncomingFinding[]);
      writeStateBestEffort(repoRoot);

      if (result.added.length > 0) {
        const threshold = readTicketConfig(repoRoot).comment_findings_at;
        if (threshold !== "never") {
          const analysisPath = path.join(repoRoot, "wspec", "changes", input.id, "analysis.md");
          const merged = parseAnalysisBlock(analysisPath);
          const bySeverity = new Set(threshold === "CRITICAL" ? ["CRITICAL"] : ["CRITICAL", "HIGH"]);
          const qualifying = merged.findings.filter((f) => result.added.includes(f.id) && bySeverity.has(f.severity)).map((f) => f.id);
          if (qualifying.length > 0) {
            syncTicketBestEffort(repoRoot, input.id, "finding_critical", { findingIds: qualifying });
          }
        }
      }

      return result;
    }
  },
  {
    name: "wspec.validateAll",
    description: "Run wspec.validatePhase across every phase of a change plus a manual gateCheck, in one call.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = validateAllSchema.parse(args);
      const repoRoot = findRepoRoot();
      return validateAll(repoRoot, input.id);
    }
  },
  {
    name: "wspec.doctor",
    description: "Health probe for the wSpec install (tool availability, build freshness, hook wiring, state/principles sync, analysis.md schema).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    run: (_args: unknown) => {
      const repoRoot = findRepoRoot();
      return runDoctor(repoRoot);
    }
  },
  {
    name: "wspec.captureIssue",
    description: "Create a tracker issue (GitHub via gh, GitLab via glab) for a captured idea, ensuring its labels exist first.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      required: ["title", "body"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = captureIssueSchema.parse(args);
      const repoRoot = findRepoRoot();
      for (const label of input.labels ?? []) {
        ensureLabel(repoRoot, label, input.forge);
      }
      return createIssue(repoRoot, input);
    }
  },
  {
    name: "wspec.listIssues",
    description: "List tracker issues (GitHub via gh, GitLab via glab), optionally filtered by label and state.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = listIssuesSchema.parse(args ?? {});
      const repoRoot = findRepoRoot();
      return listIssues(repoRoot, input);
    }
  },
  {
    name: "wspec.getIssue",
    description: "Read a single tracker issue's title, body, and URL.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number" },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      required: ["number"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = getIssueSchema.parse(args);
      const repoRoot = findRepoRoot();
      return getIssue(repoRoot, input);
    }
  },
  {
    name: "wspec.commentIssue",
    description: "Post a comment on a tracker issue (e.g. linking a wSpec change branch back to its source issue).",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number" },
        body: { type: "string" },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      required: ["number", "body"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = commentIssueSchema.parse(args);
      const repoRoot = findRepoRoot();
      commentIssue(repoRoot, input);
      return { number: input.number, commented: true };
    }
  },
  {
    name: "wspec.updateIssue",
    description: "Amend a tracker issue's body and/or title in place (merges follow-up capture detail into an existing issue).",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number" },
        body: { type: "string" },
        title: { type: "string" },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      required: ["number"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = updateIssueSchema.parse(args);
      const repoRoot = findRepoRoot();
      updateIssue(repoRoot, input);
      return { number: input.number, updated: true };
    }
  },
  {
    name: "wspec.closeIssue",
    description: "Close a tracker issue, optionally leaving a closing comment first.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number" },
        comment: { type: "string" },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      required: ["number"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = closeIssueSchema.parse(args);
      const repoRoot = findRepoRoot();
      closeIssue(repoRoot, input);
      return { number: input.number, closed: true };
    }
  },
  {
    name: "wspec.recordOverride",
    description: "Record a reasoned override for one unresolved finding, bound to its content fingerprint + a TTL.",
    inputSchema: {
      type: "object",
      properties: {
        gate: { type: "string", enum: ["pre-commit", "pre-push", "manual"] },
        id: { type: "string" },
        findingId: { type: "string" },
        reason: { type: "string" }
      },
      required: ["findingId", "reason"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = recordOverrideSchema.parse(args);
      const repoRoot = findRepoRoot();
      return recordOverride(repoRoot, {
        gate: input.gate ?? "manual",
        findingId: input.findingId,
        reason: input.reason,
        changeId: input.id
      });
    }
  },
  {
    name: "wspec.usageReport",
    description:
      "Report token usage and equivalent API cost. With 'id', reports one change's ledger (per-command breakdown included). Without it, reports an aggregate across active changes plus the durable finalized-change rollup log (wspec/usage-log.jsonl).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = usageReportSchema.parse(args ?? {});
      const repoRoot = findRepoRoot();

      if (input.id) {
        const ledger = loadUsageLedger(repoRoot, input.id);
        const rollup = rollupLedger(ledger);

        return {
          change_id: input.id,
          segment_count: ledger.segments.length,
          tokens: rollup.tokens,
          cost_usd: rollup.cost_usd,
          by_model: rollup.by_model,
          by_command: rollupByCommand(ledger)
        };
      }

      // No id: active changes still in flight (read live from their usage.json) plus the durable
      // rollup log written for every change /wspec-finalize has already archived.
      const active = listChangeSummaries(repoRoot).changes;
      let tokens = emptyTotals();
      let costUsd = 0;

      const activeBreakdown = active.map((change) => {
        const ledger = loadUsageLedger(repoRoot, change.id);
        const rollup = rollupLedger(ledger);
        tokens = addTotals(tokens, rollup.tokens);
        costUsd += rollup.cost_usd;
        return { id: change.id, tokens: rollup.tokens, cost_usd: rollup.cost_usd };
      });

      const finalized = readUsageLog(repoRoot);
      for (const entry of finalized) {
        tokens = addTotals(tokens, entry.tokens);
        costUsd += entry.cost_usd;
      }

      return {
        active_changes: activeBreakdown,
        finalized_changes: finalized.map((entry) => ({
          id: entry.id,
          title: entry.title,
          archived_at: entry.archived_at,
          tokens: entry.tokens,
          cost_usd: entry.cost_usd
        })),
        totals: { tokens, cost_usd: costUsd }
      };
    }
  },
  {
    name: "wspec.forgeCaps",
    description:
      "Read-only capability probe for the linked forge (GitHub via gh, GitLab via glab): CLI presence, auth, and which ticket-mirror features are usable (due dates, milestones, quick actions, sub-issues, dependencies). Cached; pass refresh:true to re-probe.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean" },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = forgeCapsSchema.parse(args ?? {});
      const repoRoot = findRepoRoot();
      return getForgeCaps(repoRoot, input.forge, { refresh: input.refresh });
    }
  },
  {
    name: "wspec.syncTicket",
    description:
      "Re-render the linked ticket's body from current packet state and, if 'event' is given and not already posted, append one event comment. Never fails a wSpec command over ticket I/O — returns { skipped: true, reason } instead of throwing. dryRun:true performs zero gh/glab calls and returns the rendered markdown, for offline verification with no CLI or auth required.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        event: {
          type: "string",
          enum: ["packet_created", "implementation_started", "phase_complete", "finding_critical", "checks_failed", "blocked", "archived"]
        },
        phase: { type: "number" },
        findingIds: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
        force: { type: "boolean" },
        dryRun: { type: "boolean" },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = syncTicketSchema.parse(args);
      const repoRoot = findRepoRoot();
      return syncTicket(repoRoot, input.id, input);
    }
  },
  {
    name: "wspec.bindTicket",
    description:
      "Link a change packet to a forge ticket — an existing one (`number`) or a newly created one (`create: true`) — and persist issue/issue_url/issue_forge/milestone/due_date into metadata.yaml. Ensures a milestone (defaulting to the change's capability) and, on GitLab, a due date derived from estimated_effort, where the forge supports it. Posts the first packet_created render. Never throws — returns { skipped: true, reason } on failure.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        number: { type: "number" },
        create: { type: "boolean" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        milestone: { type: "string" },
        dueDate: { type: "string" },
        dryRun: { type: "boolean" },
        forge: { type: "string", enum: ["github", "gitlab"] }
      },
      required: ["id"],
      additionalProperties: false
    },
    run: (args: unknown) => {
      const input = bindTicketSchema.parse(args);
      const repoRoot = findRepoRoot();
      return bindTicket(repoRoot, input.id, input);
    }
  }
] as const;

export function findToolByName(name: string) {
  return toolDefinitions.find((tool) => tool.name === name);
}
