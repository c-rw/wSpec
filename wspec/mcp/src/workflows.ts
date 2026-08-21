import fs from "node:fs";
import path from "node:path";
import { findToolByName } from "./lib/tools.js";
import { findRepoRoot } from "./lib/root.js";
import { writeStateBestEffort } from "./lib/state.js";

type ToolArgs = Record<string, unknown>;

type WorkflowSummary = {
  command: string;
  repoRoot: string;
  details: Record<string, unknown>;
};

function runTool(name: string, args: ToolArgs = {}) {
  const tool = findToolByName(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.run(args);
}

function parseArgs(rawArgs: string[]) {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rawArgs[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    i += 1;
  }

  return { positional, flags };
}

function getFlagString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function getFlagBool(flags: Map<string, string | boolean>, key: string): boolean {
  const value = flags.get(key);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function chooseChangeId(explicitId: string | undefined): string {
  if (explicitId) {
    return explicitId;
  }

  const status = runTool("wspec.status", {}) as { changes?: Array<{ id?: string }> };
  const changes = Array.isArray(status.changes) ? status.changes : [];

  if (changes.length === 1 && typeof changes[0]?.id === "string") {
    return changes[0].id;
  }

  if (changes.length === 0) {
    throw new Error("No active changes found. Create one first with workflow:propose.");
  }

  throw new Error("Multiple active changes found. Provide a change id explicitly.");
}

function replaceTemplateTokens(content: string, values: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }

  result = result.replace(/\[TITLE\]/g, values.TITLE);
  result = result.replace(/\[NNN-kebab-name\]/g, values.CHANGE_ID);
  result = result.replace(/\[DATE\]/g, values.ISO_DATE);
  return result;
}

function writeFileIfMissing(filePath: string, content: string) {
  if (fs.existsSync(filePath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function scaffoldChangeArtifacts(repoRoot: string, changeId: string, branchName: string) {
  const today = new Date().toISOString().slice(0, 10);
  const title = changeId
    .replace(/^\d{3,}-/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const templatesDir = path.join(repoRoot, "wspec", "templates");
  const changeDir = path.join(repoRoot, "wspec", "changes", changeId);
  if (fs.existsSync(changeDir)) {
    throw new Error(`Change folder already exists: wspec/changes/${changeId}`);
  }
  fs.mkdirSync(changeDir, { recursive: true });

  const [featureNum, shortName] = changeId.split("-", 2);
  const values = {
    NNN: featureNum,
    "kebab-name": shortName,
    "Human Readable Title": title,
    ISO_DATE: today,
    TITLE: title,
    CHANGE_ID: changeId,
    BRANCH: branchName
  };

  const outputs: string[] = [];

  const metadataTemplate = fs.readFileSync(path.join(templatesDir, "metadata-template.yaml"), "utf8");
  const metadata = replaceTemplateTokens(metadataTemplate, values)
    .replace(/feat\/\{\{NNN\}\}-\{\{kebab-name\}\}/g, branchName)
    .replace(/^updated:\s*"\{\{ISO_DATE\}\}"/m, `updated: "${today}"`)
    .replace(/^created:\s*"\{\{ISO_DATE\}\}"/m, `created: "${today}"`);

  const files = [
    { name: "proposal.md", template: "proposal-template.md" },
    { name: "spec.md", template: "spec-template.md" },
    { name: "design.md", template: "design-template.md" },
    { name: "tasks.md", template: "tasks-template.md" },
    { name: "analysis.md", template: "analysis-template.md" }
  ];

  fs.writeFileSync(path.join(changeDir, "metadata.yaml"), metadata, "utf8");
  outputs.push(`wspec/changes/${changeId}/metadata.yaml`);

  for (const file of files) {
    const raw = fs.readFileSync(path.join(templatesDir, file.template), "utf8");
    const cooked = replaceTemplateTokens(raw, values);
    fs.writeFileSync(path.join(changeDir, file.name), cooked, "utf8");
    outputs.push(`wspec/changes/${changeId}/${file.name}`);
  }

  const scan = runTool("wspec.repoScan", {}) as {
    summary?: string;
    topics?: Array<{ topic?: string; confidence?: string }>;
    gaps?: Array<{ category?: string; suggestion?: string }>;
  };

  const topicLines = Array.isArray(scan.topics)
    ? scan.topics
        .slice(0, 8)
        .map((t) => `- ${t.topic ?? "unknown"}: confidence ${t.confidence ?? "unknown"}`)
        .join("\n")
    : "- No topics captured";

  const gapLines = Array.isArray(scan.gaps) && scan.gaps.length > 0
    ? scan.gaps.slice(0, 6).map((g) => `- ${g.category ?? "gap"}: ${g.suggestion ?? "n/a"}`).join("\n")
    : "- None";

  const research = [
    `# Research: ${title}`,
    "",
    "## Scope",
    `- Change: ${changeId}`,
    "- Question: Initial proposal research baseline",
    "",
    "## Internal Prior Art",
    "- TODO: Add related specs and archived changes",
    "",
    "## External References",
    "- None provided",
    "",
    "## Constraints and Risks",
    topicLines,
    "",
    "## Recommendation",
    `- ${scan.summary ?? "Use existing project conventions and iterate by phase."}`,
    "- Alternatives considered: TBD",
    "",
    "## Open Questions",
    gapLines,
    ""
  ].join("\n");

  fs.writeFileSync(path.join(changeDir, "research.md"), research, "utf8");
  outputs.push(`wspec/changes/${changeId}/research.md`);

  return outputs;
}

function workflowPropose(rawArgs: string[]): WorkflowSummary {
  const { positional, flags } = parseArgs(rawArgs);
  if (positional.length === 0) {
    throw new Error("workflow:propose requires a feature description.");
  }

  const featureDescription = positional.join(" ");
  const shortName = getFlagString(flags, "short-name");
  const dryRun = getFlagBool(flags, "dry-run");
  const allowExistingBranch = getFlagBool(flags, "allow-existing-branch");

  const branchResult = runTool("wspec.createFeatureBranch", {
    featureDescription,
    shortName,
    dryRun,
    allowExistingBranch
  }) as {
    BRANCH_NAME: string;
    CHANGE_ID: string;
    FEATURE_NUM: string;
    DRY_RUN: boolean;
  };

  const repoRoot = findRepoRoot();
  const files = dryRun ? [] : scaffoldChangeArtifacts(repoRoot, branchResult.CHANGE_ID, branchResult.BRANCH_NAME);
  if (!dryRun) {
    writeStateBestEffort(repoRoot);
  }

  return {
    command: "workflow:propose",
    repoRoot,
    details: {
      featureDescription,
      branch: branchResult.BRANCH_NAME,
      changeId: branchResult.CHANGE_ID,
      featureNum: branchResult.FEATURE_NUM,
      dryRun: branchResult.DRY_RUN,
      files
    }
  };
}

function workflowResearch(rawArgs: string[]): WorkflowSummary {
  const { positional } = parseArgs(rawArgs);
  const changeId = chooseChangeId(positional[0]);
  const repoRoot = findRepoRoot();
  const changeDir = path.join(repoRoot, "wspec", "changes", changeId);
  if (!fs.existsSync(changeDir)) {
    throw new Error(`Change not found: ${changeId}`);
  }

  const scan = runTool("wspec.repoScan", {}) as { summary?: string; gaps?: Array<{ category?: string; suggestion?: string }> };
  const today = new Date().toISOString().slice(0, 10);
  const title = changeId.replace(/^\d{3,}-/, "").replace(/-/g, " ");

  const gapLines = Array.isArray(scan.gaps) && scan.gaps.length > 0
    ? scan.gaps.map((g) => `- ${g.category ?? "gap"}: ${g.suggestion ?? "n/a"}`).join("\n")
    : "- None";

  const content = [
    `# Research: ${title}`,
    "",
    "## Scope",
    `- Change: ${changeId}`,
    `- Question: Research refresh run on ${today}`,
    "",
    "## Internal Prior Art",
    "- TODO: Capture relevant wspec/specs and wspec/archive references",
    "",
    "## External References",
    "- None provided",
    "",
    "## Constraints and Risks",
    gapLines,
    "",
    "## Recommendation",
    `- ${scan.summary ?? "Continue with existing architecture and resolve gaps during clarification."}`,
    "",
    "## Open Questions",
    gapLines,
    ""
  ].join("\n");

  fs.writeFileSync(path.join(changeDir, "research.md"), content, "utf8");

  return {
    command: "workflow:research",
    repoRoot,
    details: {
      changeId,
      wrote: `wspec/changes/${changeId}/research.md`
    }
  };
}

function workflowPrinciples(_rawArgs: string[]): WorkflowSummary {
  const repoRoot = findRepoRoot();
  const scan = runTool("wspec.repoScan", {}) as unknown;
  const lock = runTool("wspec.lockPrinciples", { refresh: true }) as unknown;

  return {
    command: "workflow:principles",
    repoRoot,
    details: {
      note: "Repo scan and lock refresh complete. Update wspec/principles.md with policy decisions if needed.",
      scan,
      lock
    }
  };
}

function workflowImplement(rawArgs: string[]): WorkflowSummary {
  const { positional, flags } = parseArgs(rawArgs);
  const changeId = chooseChangeId(positional[0]);
  const repoRoot = findRepoRoot();

  const setImplementing = getFlagBool(flags, "set-implementing");
  if (setImplementing) {
    runTool("wspec.setStatus", { id: changeId, status: "implementing" });
  }

  const taskId = getFlagString(flags, "mark-task");
  if (taskId) {
    runTool("wspec.markTask", {
      id: changeId,
      taskId,
      pending: getFlagBool(flags, "pending")
    });
  }

  const validatePhaseValue = getFlagString(flags, "validate-phase");
  const validateResult = validatePhaseValue
    ? runTool("wspec.validatePhase", { id: changeId, phase: Number.parseInt(validatePhaseValue, 10) })
    : null;

  const context = runTool("wspec.loadChange", { id: changeId }) as unknown;

  return {
    command: "workflow:implement",
    repoRoot,
    details: {
      changeId,
      markedTask: taskId ?? null,
      validateResult,
      context
    }
  };
}

function workflowFinalize(rawArgs: string[]): WorkflowSummary {
  const { positional, flags } = parseArgs(rawArgs);
  const changeId = chooseChangeId(positional[0]);
  const repoRoot = findRepoRoot();

  const inspectSync = runTool("wspec.syncSpec", { id: changeId, apply: false }) as unknown;
  const applySpecs = getFlagBool(flags, "apply-specs");
  const appliedSync = applySpecs ? runTool("wspec.syncSpec", { id: changeId, apply: true }) : null;

  const dryRunArchive = getFlagBool(flags, "dry-run") || !getFlagBool(flags, "archive");
  const archiveResult = runTool("wspec.archive", { id: changeId, dryRun: dryRunArchive }) as unknown;

  const postAction = getFlagString(flags, "post-action");
  const postResult = postAction
    ? runTool("wspec.postArchive", { id: changeId, action: postAction })
    : null;

  return {
    command: "workflow:finalize",
    repoRoot,
    details: {
      changeId,
      inspectSync,
      appliedSync,
      archiveResult,
      postResult
    }
  };
}

export function runWorkflow(name: string, args: string[]) {
  switch (name) {
    case "propose":
      return workflowPropose(args);
    case "research":
      return workflowResearch(args);
    case "principles":
      return workflowPrinciples(args);
    case "implement":
      return workflowImplement(args);
    case "finalize":
      return workflowFinalize(args);
    default:
      throw new Error(`Unknown workflow: ${name}`);
  }
}

export function workflowHelp() {
  return {
    workflows: {
      propose: "workflow:propose <feature description> [--short-name <kebab>] [--dry-run] [--allow-existing-branch]",
      research: "workflow:research [change-id]",
      principles: "workflow:principles",
      implement: "workflow:implement [change-id] [--set-implementing] [--mark-task T###] [--pending] [--validate-phase N]",
      finalize: "workflow:finalize [change-id] [--apply-specs] [--archive] [--dry-run] [--post-action none|pr|merge]"
    }
  };
}
