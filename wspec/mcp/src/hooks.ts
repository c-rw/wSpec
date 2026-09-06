import fs from "node:fs";
import path from "node:path";
import { readYamlScalars } from "./lib/changes.js";
import { appendOverrideLog, gateCheck, type GateName } from "./lib/gate.js";
import { findRepoRoot, normalizePathForGit } from "./lib/root.js";
import { runCommand } from "./lib/shell.js";
import { loadState, writeStateBestEffort } from "./lib/state.js";
import {
  addTotals,
  appendUsageSegment,
  computeCost,
  emptyTotals,
  findSubagentTranscripts,
  loadCursor,
  readUsageEntries,
  saveCursor,
  type UsageCursorEntry,
  type UsageSegment
} from "./lib/usage.js";

function currentBranch(repoRoot: string): string | null {
  const out = runCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot);
  if (out.code !== 0) return null;
  const value = out.stdout.trim();
  return value ? value : null;
}

function extractChangeId(branch: string | null): string | null {
  if (!branch) return null;
  const match = /^feat\/(\d{3,}-[^/]+)$/.exec(branch);
  return match ? match[1] : null;
}

function gitCachedPaths(repoRoot: string): string[] {
  const out = runCommand("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], repoRoot);
  if (out.code !== 0) return [];
  return out.stdout
    .split("\0")
    .map((v) => normalizePathForGit(v))
    .filter(Boolean);
}

export function runCommitMsgHook(): number {
  const repoRoot = findRepoRoot();
  const branch = currentBranch(repoRoot);
  const changeId = extractChangeId(branch);
  if (!changeId) return 0;

  const paths = gitCachedPaths(repoRoot);
  if (paths.length === 0) return 0;

  const bookkeeping = /^wspec\/changes\/[^/]+\/(tasks\.md|metadata\.yaml)$/;
  const allBookkeeping = paths.every((v) => bookkeeping.test(v));
  if (!allBookkeeping) return 0;

  process.stderr.write("[wspec] blocking bookkeeping-only commit (tasks.md / metadata.yaml only).\n");
  process.stderr.write("[wspec] defer this to the next real commit, or use --no-verify to force.\n");
  return 1;
}

export function runPrepareCommitMsgHook(messageFile: string, commitSource?: string): number {
  if (!messageFile || !fs.existsSync(messageFile)) return 0;
  if (commitSource && commitSource !== "message" && commitSource !== "template") return 0;

  const repoRoot = findRepoRoot();
  const branch = currentBranch(repoRoot);
  const changeId = extractChangeId(branch);
  if (!changeId) return 0;

  const raw = fs.readFileSync(messageFile, "utf8");
  if (!raw.trim()) return 0;

  const prefix = `feat(${changeId}): `;
  const lineBreak = raw.includes("\r\n") ? "\r\n" : "\n";
  const parts = raw.split(/\r?\n/, 2);
  const subject = parts[0] ?? "";

  if (new RegExp(`^feat\\(${changeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\):\\s+`).test(subject)) {
    return 0;
  }

  const newSubject = prefix + subject;
  const newRaw = parts.length > 1 ? `${newSubject}${lineBreak}${parts[1]}` : newSubject;
  fs.writeFileSync(messageFile, newRaw, "utf8");
  process.stdout.write(`[wspec] commit subject normalized for ${branch}\n`);
  return 0;
}

function envOverrideReason(): string | null {
  const value = process.env.WSPEC_OVERRIDE_REASON;
  return value && value.trim() ? value.trim() : null;
}

/**
 * Shared gate runner for the blocking hooks. Prints warnings, then either blocks (exit 1) with
 * remediation instructions, or allows after an audited one-shot env override.
 */
function runGate(gate: GateName): number {
  const repoRoot = findRepoRoot();
  const result = gateCheck(repoRoot, gate);

  for (const warning of result.warnings) {
    process.stderr.write(`[wspec] WARN: ${warning}\n`);
  }

  if (!result.blocked) {
    return 0;
  }

  const reason = envOverrideReason();
  if (reason) {
    try {
      fs.appendFileSync(
        path.join(repoRoot, "wspec", "overrides.log"),
        `${new Date().toISOString()} ENV-OVERRIDE gate=${gate} change=${result.change_id ?? "?"} reason="${reason}"\n`,
        "utf8"
      );
    } catch {
      // Audit log is best-effort.
    }
    process.stderr.write(`[wspec] ${gate} gate overridden via WSPEC_OVERRIDE_REASON (logged to wspec/overrides.log).\n`);
    return 0;
  }

  process.stderr.write(`\n[wspec] ${gate} BLOCKED for change '${result.change_id}':\n`);
  const findingBlockers = result.blocking_reasons.filter(
    (b): b is Extract<(typeof result.blocking_reasons)[number], { kind: "finding" }> => b.kind === "finding"
  );
  const checkBlockers = result.blocking_reasons.filter(
    (b): b is Extract<(typeof result.blocking_reasons)[number], { kind: "check" }> => b.kind === "check"
  );
  for (const blocker of findingBlockers) {
    process.stderr.write(`  - ${blocker.severity} ${blocker.id} (${blocker.category}): ${blocker.summary} [${blocker.location}]\n`);
  }
  for (const blocker of checkBlockers) {
    const location = blocker.log_path ? ` — see ${blocker.log_path}` : "";
    process.stderr.write(`  - CHECK FAILED: ${blocker.name} (\`${blocker.command}\`)${location}\n`);
    if (blocker.summary) {
      for (const line of blocker.summary.split("\n")) {
        process.stderr.write(`      ${line}\n`);
      }
    }
  }
  if (findingBlockers.length > 0) {
    process.stderr.write("\nResolve the finding(s) in analysis.md, or record a reasoned override per finding:\n");
    for (const blocker of findingBlockers) {
      process.stderr.write(
        `  node wspec/mcp/dist/cli.js tool wspec.recordOverride '{"gate":"${gate}","findingId":"${blocker.id}","reason":"<why this is safe>"}'\n`
      );
    }
  }
  if (checkBlockers.length > 0) {
    process.stderr.write(`\nFix the failing check(s), then re-run: node wspec/mcp/dist/cli.js tool wspec.runChecks '{"id":"${result.change_id}"}'\n`);
  }
  process.stderr.write('\nOr set WSPEC_OVERRIDE_REASON="..." for a one-shot audited bypass, or use --no-verify to skip hooks entirely.\n');
  return 1;
}

export function runPreCommitHook(): number {
  return runGate("pre-commit");
}

export function runPrePushHook(): number {
  // Drain redirected stdin (git sends refs) only in hook contexts, to avoid EPIPE.
  if (!process.stdin.isTTY) {
    try {
      fs.readFileSync(0, "utf8");
    } catch {
      // Ignore stdin read issues.
    }
  }

  return runGate("pre-push");
}

interface ClaudeCodeToolPayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

function readHookStdinJson<T>(): T | null {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * PreToolUse guard for Edit/Write/MultiEdit. Enforces the /wspec-propose guardrail ("no file
 * edits outside wspec/changes/<CHANGE_ID>/" while a change is still spec-only `drafting`) as real
 * infrastructure instead of prose the model might skip. Warn-and-override, not a hard block: it
 * only refuses (exit 2) the narrow drafting + out-of-folder case, and WSPEC_OVERRIDE_REASON always
 * lets a legitimate side-quest through, audited the same way the git gates are.
 *
 * Fails open on any uncertainty (missing/malformed stdin payload, no active change, wrong status,
 * unreadable metadata) — this hook must never block ordinary work due to a parsing edge case.
 */
export function runGuardEditHook(): number {
  const payload = readHookStdinJson<ClaudeCodeToolPayload>();
  const filePath = payload?.tool_input?.file_path;
  if (!filePath) return 0;

  const repoRoot = findRepoRoot();
  const branch = currentBranch(repoRoot);
  const changeId = extractChangeId(branch);
  if (!changeId) return 0;

  const metadataPath = path.join(repoRoot, "wspec", "changes", changeId, "metadata.yaml");
  if (!fs.existsSync(metadataPath)) return 0;

  const status = (readYamlScalars(metadataPath).status ?? "").toLowerCase();
  if (status !== "drafting") return 0;

  const absoluteTarget = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  const relTarget = normalizePathForGit(path.relative(repoRoot, absoluteTarget));
  const changeFolder = `wspec/changes/${changeId}/`;
  if (relTarget.startsWith(changeFolder)) return 0;

  const reason = envOverrideReason();
  if (reason) {
    appendOverrideLog(
      repoRoot,
      `${new Date().toISOString()} ENV-OVERRIDE gate=guard-edit change=${changeId} target=${relTarget} reason="${reason}"\n`
    );
    process.stderr.write(`[wspec] guard-edit overridden via WSPEC_OVERRIDE_REASON (logged to wspec/overrides.log).\n`);
    return 0;
  }

  process.stderr.write(
    `\n[wspec] guard-edit BLOCKED: change '${changeId}' is still status=drafting (spec-only phase).\n` +
      `Edit target '${relTarget}' is outside ${changeFolder}.\n\n` +
      `If this edit is intentional (e.g. a legitimate side-quest), set WSPEC_OVERRIDE_REASON="..." and retry,\n` +
      `or move past drafting first (wspec.setStatus) if the packet is actually ready for implementation.\n`
  );
  return 2;
}

/**
 * PostToolUse hook wired to markTask/setStatus/syncSpec. Those tools already call
 * writeStateBestEffort internally, so this is a defense-in-depth refresh for any state.json drift
 * caused by a mutation made outside the MCP tool path (e.g. a hand-edited tasks.md). Always
 * non-blocking.
 */
export function runStateSyncHook(): number {
  try {
    writeStateBestEffort(findRepoRoot());
  } catch {
    // Best-effort; a Stop/PostToolUse hook must never fail the host over an index refresh.
  }
  return 0;
}

/**
 * Stop hook: non-blocking nudge when a change looks implementation-complete (all tasks done) but
 * is still status=implementing, meaning the final phase validation + status flip in
 * /wspec-implement Step 5 likely never ran to completion. Never blocks — this is a reminder only.
 */
export function runNudgeValidateHook(): number {
  try {
    const repoRoot = findRepoRoot();
    const state = loadState(repoRoot);
    for (const change of state.active) {
      if (change.status === "implementing" && change.tasks.total > 0 && change.tasks.done === change.tasks.total) {
        process.stderr.write(
          `[wspec] change '${change.id}' has all tasks marked done but is still status=implementing.\n` +
            `Run /wspec-implement to finish phase validation, or /wspec-finalize if it's already validated.\n`
        );
      }
    }
  } catch {
    // Best-effort; never fail the Stop hook over a state read.
  }
  return 0;
}

/**
 * Matches Claude Code's actual slash-command transcript encoding — a user turn whose content is
 * `<command-message>wspec-implement</command-message>\n<command-name>/wspec-implement</command-name>`,
 * not a bare string starting with `/wspec-implement` as prose. Anchoring on `<command-name>`
 * (rather than dropping the `^` anchor entirely) also avoids false positives from the command
 * merely being *mentioned* in conversation.
 */
const WSPEC_COMMAND_REGEX = /<command-name>\/wspec-(propose|research|implement|finalize)<\/command-name>/;

/** Extract plain text from a transcript message's `content`, which is either a bare string or an
 * array of content blocks (only `text`-bearing blocks matter for command detection). */
function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "text" in (block as Record<string, unknown>)) {
          return String((block as Record<string, unknown>).text ?? "");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

/**
 * Stop hook: attribute this turn's token usage to whichever `/wspec-*` command most recently
 * appeared in the transcript, and append a segment to that change's usage.json ledger.
 *
 * Deliberately does NOT try to bracket "one slash command = one Stop event" with a paired
 * UserPromptSubmit hook — a command can span multiple Stop events (e.g. AskUserQuestion
 * round-trips), and Claude Code's exact turn-boundary behavior there isn't a stable contract to
 * build on. Instead this is cursor-based: read only the transcript lines appended since the last
 * time this hook ran (tracked per transcript path in wspec/usage-cursor.json, keyed by path so a
 * session reset or a concurrent session both just work), attribute the delta to the last-seen
 * command (carrying it forward across continuations), and advance the cursor. See
 * wspec/README.md § Effort & Cost Tracking for the full design rationale.
 *
 * Always fails open — a usage-tracking bug must never block or error the Stop hook.
 */
export function runUsageTrackHook(): number {
  try {
    const payload = readHookStdinJson<{ transcript_path?: string; session_id?: string }>();
    const transcriptPath = payload?.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;

    const repoRoot = findRepoRoot();
    const cursorFile = loadCursor(repoRoot);
    const cursor: UsageCursorEntry = cursorFile[transcriptPath] ?? {
      lineOffset: 0,
      lastCommand: null,
      updatedAt: new Date(0).toISOString()
    };
    const sinceMs = Date.parse(cursor.updatedAt) || 0;

    const raw = fs.readFileSync(transcriptPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

    // Find the most recent /wspec-* command among the newly-appended lines; else carry forward
    // the prior command (handles multi-turn continuations of the same command).
    let command = cursor.lastCommand;
    for (let i = cursor.lineOffset; i < lines.length; i += 1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const obj = parsed as { type?: string; message?: { role?: string; content?: unknown } };
      if (obj.type !== "user" || obj.message?.role !== "user") continue;
      const text = extractUserText(obj.message?.content).trim();
      const match = WSPEC_COMMAND_REGEX.exec(text);
      if (match) {
        command = match[1];
      }
    }

    const now = new Date().toISOString();

    if (!command) {
      // No wspec command has ever run in this transcript — nothing to attribute. Still advance
      // the cursor so the next Stop event doesn't rescan from the start of the file.
      cursorFile[transcriptPath] = { lineOffset: lines.length, lastCommand: null, updatedAt: now };
      saveCursor(repoRoot, cursorFile);
      return 0;
    }

    const { entries: parentEntries } = readUsageEntries(transcriptPath, cursor.lineOffset);
    const subagentFiles = findSubagentTranscripts(transcriptPath, sinceMs);
    const subagentEntries = subagentFiles.flatMap((file) => readUsageEntries(file, 0).entries);
    const allEntries = [...parentEntries, ...subagentEntries];

    cursorFile[transcriptPath] = { lineOffset: lines.length, lastCommand: command, updatedAt: now };
    saveCursor(repoRoot, cursorFile);

    if (allEntries.length === 0) return 0;

    const branch = currentBranch(repoRoot);
    const changeId = extractChangeId(branch);
    if (!changeId) return 0;

    // Only write into an active change folder. If the branch's change has already been
    // archived (e.g. more turns happen on a feat/NNN branch after /wspec-finalize), silently
    // drop the segment rather than recreating a phantom wspec/changes/<id>/ directory —
    // there is no reliable way to append into the already-committed archive location here.
    const activeMetadataPath = path.join(repoRoot, "wspec", "changes", changeId, "metadata.yaml");
    if (!fs.existsSync(activeMetadataPath)) return 0;

    const summary = computeCost(allEntries);
    const tokens = Object.values(summary.by_model).reduce((acc, m) => addTotals(acc, m.tokens), emptyTotals());

    const segment: UsageSegment = {
      command,
      session_id: payload?.session_id ?? null,
      started_at: cursor.updatedAt,
      ended_at: now,
      subagent_count: subagentFiles.length,
      tokens,
      cost_usd: summary.total_usd,
      by_model: summary.by_model
    };

    appendUsageSegment(repoRoot, changeId, segment);
  } catch {
    // Best-effort; never fail the Stop hook over a usage-tracking bug.
  }
  return 0;
}
