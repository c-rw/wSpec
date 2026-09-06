import type { CommandUsageBreakdown } from "./usage.js";
import type { TokenTotals } from "./usage.js";

/**
 * Pure snapshot -> markdown rendering for the ticket mirror. Zero I/O, never throws — every
 * field on TicketSnapshot is optional/nullable and every render path degrades to a short line
 * instead of erroring, because real change packets (see spicesurfer's archive) routinely lack
 * analysis.md, usage.json, .checks/, or an issue: link entirely.
 *
 * This module has no knowledge of gh/glab, forges, or the filesystem — see ticket.ts for the I/O
 * side (snapshot collection, the forge write path, the receipt). Keeping this half pure is what
 * makes it fully verifiable offline via `wspec.syncTicket { dryRun: true }`.
 */

export interface TicketSnapshotPhase {
  num: number;
  title: string;
  done: number;
  total: number;
  complete: boolean;
}

export interface TicketSnapshotFinding {
  id: string;
  severity: string;
  category: string;
  summary: string;
  location: string;
  resolved: boolean;
}

export interface TicketSnapshotChecks {
  status: string;
  completed_at: string;
  passed: string[];
  failed: string[];
}

export interface TicketSnapshotUsage {
  tokens: TokenTotals;
  cost_usd: number;
  segment_count: number;
  by_command: Record<string, CommandUsageBreakdown>;
  last_ended_at: string | null;
}

export interface TicketSnapshotClarification {
  question: string;
  answer: string;
}

export interface TicketSnapshot {
  change_id: string;
  title: string | null;
  status: string | null;
  branch: string | null;
  capability: string | null;
  issue: number | null;
  issue_url: string | null;
  issue_forge: string | null;
  milestone: string | null;
  due_date: string | null;
  created: string | null;
  started: string | null;
  completed: string | null;
  estimated_effort: string | null;
  pr_url: string | null;
  archived: boolean;
  archive_path: string | null;
  phases: TicketSnapshotPhase[];
  tasks: { total: number; done: number; pending: number };
  findings: TicketSnapshotFinding[];
  checks: TicketSnapshotChecks | null;
  usage: TicketSnapshotUsage | null;
  clarifications: TicketSnapshotClarification[];
  artifacts: Record<string, boolean>;
  warnings: string[];
  rendered_at: string;
}

const MAX_PHASE_ROWS = 25;
const MAX_CLARIFICATION_ROWS = 10;
const MAX_FINDING_ROWS = 12;
const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * Best-effort parse of the free-text `estimated_effort` field ("~3 days", "1 week", "4 hours")
 * into a whole number of calendar days. Returns null rather than guessing when the text doesn't
 * match a known shape — an absent due date is honest; a wrong one is worse than useless.
 */
export function parseEffortToDays(effort: string | null | undefined): number | null {
  if (!effort) return null;
  const text = effort.trim().toLowerCase();

  // Range like "3-4 days" or "3 to 4 days" — take the upper bound.
  const range = /(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(day|week|hour|hr)/.exec(text);
  if (range) {
    return toDays(Number(range[2]), range[3]);
  }

  const single = /(\d+(?:\.\d+)?)\s*(day|week|hour|hr)/.exec(text);
  if (single) {
    return toDays(Number(single[1]), single[2]);
  }

  if (/half[\s-]?day/.test(text)) return 1;

  return null;
}

function toDays(amount: number, unit: string): number {
  const days = unit.startsWith("week") ? amount * 7 : unit.startsWith("hour") || unit.startsWith("hr") ? Math.max(1, amount / 8) : amount;
  return Math.max(1, Math.ceil(days));
}

export function addDaysToIsoDate(isoDate: string, days: number): string | null {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function formatProgressBar(done: number, total: number, width = 10): string {
  if (total <= 0) return "░".repeat(width);
  const filled = Math.round((done / total) * width);
  return "█".repeat(Math.min(width, filled)) + "░".repeat(Math.max(0, width - filled));
}

function pct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

function fmtUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Friendly display form for a raw ISO timestamp (or a Date, for the "now" call site) — minute
 * granularity, no seconds/milliseconds. Shared by every timestamp shown in the rendered body
 * (the footer's "last synced", the Spend section's "as of last completed run", the Checks
 * section) so they're all formatted the same way instead of some raw-ISO and some friendly.
 */
export function formatDisplayTimestamp(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function fmtTokens(totals: TokenTotals): string {
  const total = totals.input_tokens + totals.output_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens;
  return `${(total / 1000).toFixed(0)}k tokens`;
}

const BEGIN = (id: string, rev: number) => `<!-- wspec:begin id=${id} rev=${rev} -->`;
const END = "<!-- wspec:end -->";

/**
 * Render the full managed-region block (including its begin/end sentinel markers) from a
 * snapshot. Callers splice this into whatever the issue body already contains via
 * {@link spliceManagedRegion} — never call updateIssue with this string alone, since that would
 * discard any human-written text above the marker.
 */
export function renderTicketBody(snapshot: TicketSnapshot, rev: number): string {
  const lines: string[] = [BEGIN(snapshot.change_id, rev), "---", "", `### wSpec · \`${snapshot.change_id}\`${snapshot.title ? ` — ${snapshot.title}` : ""}`, ""];

  const doneStatus = (snapshot.status ?? "").toLowerCase() === "done";
  const nextIncomplete = snapshot.phases.find((p) => !p.complete);

  lines.push("| | |", "|---|---|");
  lines.push(`| **Status** | \`${snapshot.status ?? "unknown"}\`${nextIncomplete ? ` — Phase ${nextIncomplete.num} of ${snapshot.phases.length}` : ""} |`);
  if (snapshot.branch) lines.push(`| **Branch** | \`${snapshot.branch}\` |`);
  if (snapshot.capability) lines.push(`| **Capability** | \`${snapshot.capability}\` |`);
  if (snapshot.started) lines.push(`| **Started** | ${snapshot.started} |`);

  if (doneStatus && snapshot.completed) {
    const elapsedDays = snapshot.started ? daysBetween(snapshot.started, snapshot.completed) : null;
    lines.push(`| **Completed** | ${snapshot.completed}${elapsedDays !== null ? ` *(${elapsedDays}d elapsed)*` : ""} |`);
  } else if (snapshot.due_date) {
    lines.push(`| **Target** | ${snapshot.due_date}${snapshot.estimated_effort ? ` *(est. ${snapshot.estimated_effort})*` : ""} |`);
  }

  if (snapshot.tasks.total > 0) {
    lines.push(
      `| **Progress** | ${snapshot.tasks.done} / ${snapshot.tasks.total} tasks — \`${formatProgressBar(snapshot.tasks.done, snapshot.tasks.total)}\` ${pct(snapshot.tasks.done, snapshot.tasks.total)}% |`
    );
  }
  lines.push("");

  if (snapshot.phases.length > 0) {
    lines.push("#### Phases");
    const shown = snapshot.phases.slice(0, MAX_PHASE_ROWS);
    for (const phase of shown) {
      const box = phase.complete ? "x" : " ";
      const marker = !phase.complete && phase === nextIncomplete ? " ← *in progress*" : "";
      lines.push(`- [${box}] **Phase ${phase.num} — ${phase.title}** · ${phase.done}/${phase.total}${marker}`);
    }
    if (snapshot.phases.length > MAX_PHASE_ROWS) {
      lines.push(`- …and ${snapshot.phases.length - MAX_PHASE_ROWS} more`);
    }
    lines.push("");
  }

  const unresolved = snapshot.findings.filter((f) => !f.resolved);
  if (snapshot.findings.length > 0) {
    const blockingCount = unresolved.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH").length;
    const criticalCount = unresolved.filter((f) => f.severity === "CRITICAL").length;
    lines.push(`#### Open findings — ${unresolved.length} unresolved${blockingCount > 0 ? ` (${criticalCount} blocking)` : ""}`);
    if (unresolved.length > 0) {
      lines.push("| ID | Severity | Category | Summary |", "|---|---|---|---|");
      const sorted = [...unresolved].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
      const shown = sorted.slice(0, MAX_FINDING_ROWS);
      for (const f of shown) {
        const sev = f.severity === "CRITICAL" ? `**${f.severity}**` : f.severity;
        lines.push(`| ${f.id} | ${sev} | ${f.category} | ${escapeTableCell(f.summary)} |`);
      }
      if (sorted.length > MAX_FINDING_ROWS) {
        lines.push(`| … | | | +${sorted.length - MAX_FINDING_ROWS} more unresolved |`);
      }
    }
    lines.push("");
  }

  if (snapshot.checks) {
    const parts = [...snapshot.checks.passed.map((n) => `${n} PASS`), ...snapshot.checks.failed.map((n) => `${n} FAIL`)];
    lines.push("#### Checks", `\`${parts.join(" · ") || "no checks configured"}\` — ${formatDisplayTimestamp(snapshot.checks.completed_at)}`, "");
  }

  if (snapshot.usage && snapshot.usage.segment_count > 0) {
    lines.push(
      `#### Spend — as of last completed run${snapshot.usage.last_ended_at ? ` (${formatDisplayTimestamp(snapshot.usage.last_ended_at)})` : ""}`
    );
    lines.push(`${fmtTokens(snapshot.usage.tokens)} · ${fmtUsd(snapshot.usage.cost_usd)} · ${snapshot.usage.segment_count} runs`);
    const byCommand = Object.entries(snapshot.usage.by_command)
      .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
      .map(([cmd, v]) => `${cmd} ${fmtUsd(v.cost_usd)}`)
      .join(" · ");
    if (byCommand) lines.push(`\`${byCommand}\``);
    lines.push("");
  }

  if (snapshot.clarifications.length > 0) {
    lines.push("#### Clarifications");
    const shown = snapshot.clarifications.slice(0, MAX_CLARIFICATION_ROWS);
    shown.forEach((c, i) => {
      lines.push(`${i + 1}. ${escapeTableCell(c.question)}`);
      lines.push(`   → ${escapeTableCell(c.answer)}`);
    });
    if (snapshot.clarifications.length > MAX_CLARIFICATION_ROWS) {
      lines.push(`…and ${snapshot.clarifications.length - MAX_CLARIFICATION_ROWS} more — see spec.md`);
    }
    lines.push("");
  }

  const presentArtifacts = Object.entries(snapshot.artifacts)
    .filter(([, present]) => present)
    .map(([name]) => `\`${name}\``);
  if (presentArtifacts.length > 0) {
    lines.push("#### Documents", presentArtifacts.join(" · "));
    lines.push(`<sub>Packet: \`wspec/changes/${snapshot.change_id}/\`</sub>`, "");
  }

  if (snapshot.pr_url) {
    lines.push(`**Merge request:** ${snapshot.pr_url}`, "");
  }

  if (snapshot.warnings.length > 0) {
    lines.push("#### Notes", ...snapshot.warnings.map((w) => `- ${w}`), "");
  }

  lines.push("---", `<sub>Maintained automatically by wSpec — last synced ${snapshot.rendered_at}.</sub>`, END);

  return lines.join("\n");
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function daysBetween(startIso: string, endIso: string): number | null {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

const BEGIN_RE = /<!--\s*wspec:begin\s+id=\S+\s+rev=\d+\s*-->/;
const END_RE = /<!--\s*wspec:end\s*-->/;

/**
 * Splice a rendered managed-region block (with its own begin/end markers) into an existing issue
 * body, preserving anything the block doesn't own:
 *   1. both markers present -> replace the span between them (inclusive)
 *   2. only one marker, or malformed -> strip from the first marker to EOF and re-append (self-heal)
 *   3. neither present -> append below the existing text (e.g. a human-written /wspec-capture body)
 */
export function spliceManagedRegion(existingBody: string, block: string): string {
  const beginMatch = BEGIN_RE.exec(existingBody);
  const endMatch = END_RE.exec(existingBody);

  if (beginMatch && endMatch && endMatch.index > beginMatch.index) {
    const before = existingBody.slice(0, beginMatch.index).trimEnd();
    const after = existingBody.slice(endMatch.index + endMatch[0].length).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n");
  }

  if (beginMatch) {
    const before = existingBody.slice(0, beginMatch.index).trimEnd();
    return [before, block].filter(Boolean).join("\n\n");
  }
  if (endMatch) {
    const before = existingBody.slice(0, endMatch.index).trimEnd();
    return [before, block].filter(Boolean).join("\n\n");
  }

  const trimmed = existingBody.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/**
 * Return the non-managed portion of an existing issue body — the part a human wrote via
 * /wspec-capture, or nothing if the marker isn't present. Cached at bind time
 * (wspec/changes/<id>/.ticket/prelude.md) so a steady-state sync doesn't need a getIssue read
 * before every write; see ticket.ts.
 */
export function extractPrelude(existingBody: string): string {
  const beginMatch = BEGIN_RE.exec(existingBody);
  if (beginMatch) return existingBody.slice(0, beginMatch.index).trimEnd();
  const endMatch = END_RE.exec(existingBody);
  if (endMatch) return existingBody.slice(0, endMatch.index).trimEnd();
  return existingBody.trimEnd();
}

export type TicketEvent =
  | "packet_created"
  | "implementation_started"
  | "phase_complete"
  | "finding_critical"
  | "checks_failed"
  | "blocked"
  | "archived";

export interface TicketEventPayload {
  phase?: number;
  findingIds?: string[];
}

/** Comment text for a single lifecycle event. Deliberately short — the body carries the state,
 * comments are the timeline. */
export function renderEvent(event: TicketEvent, snapshot: TicketSnapshot, payload?: TicketEventPayload): string {
  switch (event) {
    case "packet_created": {
      const docs = Object.entries(snapshot.artifacts)
        .filter(([, present]) => present)
        .map(([name]) => name)
        .join(", ");
      return [
        `**Change packet created** — \`${snapshot.change_id}\` on branch \`${snapshot.branch ?? "?"}\``,
        docs ? `Documents: ${docs}` : null
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "implementation_started":
      return `**Implementation started**${snapshot.started ? ` — ${snapshot.started}` : ""}${
        snapshot.due_date ? ` · target ${snapshot.due_date}` : ""
      }`;
    case "phase_complete": {
      const phase = snapshot.phases.find((p) => p.num === payload?.phase);
      const checksLine = snapshot.checks
        ? `\nChecks \`${snapshot.checks.status}\`${snapshot.checks.failed.length > 0 ? ` (failed: ${snapshot.checks.failed.join(", ")})` : ""}`
        : "";
      const spendLine = snapshot.usage && snapshot.usage.segment_count > 0 ? `\nSpend to date: ~${fmtUsd(snapshot.usage.cost_usd)} · ${snapshot.usage.segment_count} runs` : "";
      return `**Phase ${payload?.phase ?? "?"} complete${phase ? ` — ${phase.title}` : ""}** · ${phase?.done ?? "?"}/${phase?.total ?? "?"} tasks${checksLine}${spendLine}`;
    }
    case "finding_critical": {
      const ids = payload?.findingIds ?? [];
      const findings = snapshot.findings.filter((f) => ids.includes(f.id));
      const blocks = findings.map(
        (f) => `🔴 **${f.severity} finding ${f.id}** — \`${f.category}\`\n${f.summary} — \`${f.location}\``
      );
      return blocks.length > 0 ? blocks.join("\n\n") : `🔴 New CRITICAL/HIGH finding(s): ${ids.join(", ")}`;
    }
    case "checks_failed":
      return `❌ **Checks failed**${snapshot.checks?.failed.length ? ` — ${snapshot.checks.failed.join(", ")}` : ""}`;
    case "blocked":
      return `⛔ **Blocked** — unresolved CRITICAL/HIGH findings prevent progress.`;
    case "archived": {
      const elapsed = snapshot.started && snapshot.completed ? daysBetween(snapshot.started, snapshot.completed) : null;
      const spend = snapshot.usage && snapshot.usage.segment_count > 0 ? `${fmtTokens(snapshot.usage.tokens)} · ${fmtUsd(snapshot.usage.cost_usd)} · ${snapshot.usage.segment_count} runs` : null;
      const lines = [
        `**Archived** — \`${snapshot.change_id}\`${snapshot.archive_path ? ` at \`${snapshot.archive_path}\`` : ""}`,
        elapsed !== null ? `Started ${snapshot.started} · completed ${snapshot.completed} · ${elapsed}d elapsed` : null,
        spend ? `Total spend: ${spend}` : null,
        snapshot.pr_url ? `Merge request: ${snapshot.pr_url}` : null,
        ...(snapshot.warnings.length > 0 ? snapshot.warnings.map((w) => `⚠️ ${w}`) : [])
      ];
      return lines.filter(Boolean).join("\n");
    }
  }
}
