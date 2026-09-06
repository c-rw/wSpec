import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseAnalysisBlock,
  parseClarifications,
  parseTaskInfo,
  readYamlScalars,
  resolveChangeDir,
  upsertMetadataScalars
} from "./changes.js";
import { readLatestChecksFromDir } from "./checks.js";
import { getForgeCaps, type ForgeCaps } from "./forgeCaps.js";
import {
  closeIssue,
  commentIssue,
  createIssue,
  ensureMilestone,
  getIssue,
  setIssueDueDate,
  setIssueMilestone,
  updateIssue
} from "./issues.js";
import {
  addDaysToIsoDate,
  extractPrelude,
  formatDisplayTimestamp,
  parseEffortToDays,
  renderEvent,
  renderTicketBody,
  type TicketEvent,
  type TicketSnapshot,
  type TicketSnapshotChecks,
  type TicketSnapshotFinding,
  type TicketSnapshotPhase,
  type TicketSnapshotUsage
} from "./ticketRender.js";
import { loadUsageLedgerFromDir, rollupByCommand, rollupLedger } from "./usage.js";

/**
 * Orchestration + I/O for the ticket mirror: config, snapshot collection, the on-disk receipt,
 * and the forge write path. Rendering itself lives in ticketRender.ts (pure); this module is
 * where that meets the filesystem and gh/glab.
 */

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export interface TicketConfig {
  enabled: boolean;
  create_on_propose: "ask" | "always" | "never";
  sync_on: "transition" | "phase" | "task";
  events: TicketEvent[];
  comment_findings_at: "CRITICAL" | "HIGH" | "never";
  show_spend: boolean;
  /** "capability" = use metadata.yaml's capability field; "none" = skip; anything else = a fixed
   * milestone title. */
  milestone: string;
  due_from_effort: boolean;
  close_on_finalize: boolean;
  timeout_ms: number;
}

const DEFAULT_TICKET_CONFIG: TicketConfig = {
  enabled: true,
  create_on_propose: "ask",
  sync_on: "phase",
  events: ["packet_created", "implementation_started", "phase_complete", "finding_critical", "archived"],
  comment_findings_at: "CRITICAL",
  show_spend: true,
  milestone: "capability",
  due_from_effort: true,
  close_on_finalize: true,
  timeout_ms: 15000
};

const TICKET_EVENT_VALUES: TicketEvent[] = [
  "packet_created",
  "implementation_started",
  "phase_complete",
  "finding_critical",
  "checks_failed",
  "blocked",
  "archived"
];

/**
 * Parse the optional `ticket:` block from wspec/config.yaml. Absence must mean working defaults
 * — install.ps1/install.sh only seed config.yaml on first install, never on upgrade, so none of
 * the pre-existing installs will ever have this block written into them automatically. The
 * shipped config.yaml ships this block fully commented out for exactly that reason: only an
 * *uncommented* `ticket:` line activates any override.
 */
export function readTicketConfig(repoRoot: string): TicketConfig {
  const file = path.join(repoRoot, "wspec", "config.yaml");
  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = content.split(/\r?\n/);

  const blockStart = lines.findIndex((line) => /^ticket\s*:\s*$/.test(line));
  if (blockStart < 0) return { ...DEFAULT_TICKET_CONFIG };

  const config: TicketConfig = { ...DEFAULT_TICKET_CONFIG };
  for (let i = blockStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (!/^\s+/.test(line)) break; // dedent — end of the ticket: block

    const kv = /^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.replace(/\s*#.*$/, "").trim();
    const unquoted = value.replace(/^['"]|['"]$/g, "");

    switch (key) {
      case "enabled":
        config.enabled = unquoted === "true";
        break;
      case "create_on_propose":
        if (unquoted === "ask" || unquoted === "always" || unquoted === "never") config.create_on_propose = unquoted;
        break;
      case "sync_on":
        if (unquoted === "transition" || unquoted === "phase" || unquoted === "task") config.sync_on = unquoted;
        break;
      case "events": {
        const arrayMatch = /^\[(.*)\]$/.exec(value);
        if (arrayMatch) {
          const parsed = arrayMatch[1]
            .split(",")
            .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
            .filter((v): v is TicketEvent => (TICKET_EVENT_VALUES as string[]).includes(v));
          config.events = parsed;
        }
        break;
      }
      case "comment_findings_at":
        if (unquoted === "CRITICAL" || unquoted === "HIGH" || unquoted === "never") config.comment_findings_at = unquoted;
        break;
      case "show_spend":
        config.show_spend = unquoted === "true";
        break;
      case "milestone":
        if (unquoted) config.milestone = unquoted;
        break;
      case "due_from_effort":
        config.due_from_effort = unquoted === "true";
        break;
      case "close_on_finalize":
        config.close_on_finalize = unquoted === "true";
        break;
      case "timeout_ms": {
        const n = Number.parseInt(unquoted, 10);
        if (Number.isFinite(n) && n > 0) config.timeout_ms = n;
        break;
      }
    }
  }
  return config;
}

// ---------------------------------------------------------------------------------------------
// Snapshot collection (pure I/O, zero process spawns)
// ---------------------------------------------------------------------------------------------

const ARTIFACT_NAMES = ["research.md", "proposal.md", "spec.md", "design.md", "tasks.md", "analysis.md"];

export function collectSnapshot(repoRoot: string, id: string): TicketSnapshot {
  const resolved = resolveChangeDir(repoRoot, id);
  if (!resolved) {
    throw new Error(`Change not found: ${id} (looked in wspec/changes/${id} and wspec/archive/*-${id})`);
  }

  const dir = resolved.dir;
  const metadata = readYamlScalars(path.join(dir, "metadata.yaml"));
  const taskInfo = parseTaskInfo(path.join(dir, "tasks.md"));
  const analysis = parseAnalysisBlock(path.join(dir, "analysis.md"));
  const clarifications = parseClarifications(path.join(dir, "spec.md"));
  const checksReport = readLatestChecksFromDir(dir);
  const usageLedger = loadUsageLedgerFromDir(dir);

  const artifacts: Record<string, boolean> = {};
  for (const name of ARTIFACT_NAMES) {
    artifacts[name] = fs.existsSync(path.join(dir, name));
  }

  const phases: TicketSnapshotPhase[] = taskInfo.phases.map((phase) => ({
    num: phase.num,
    title: phase.title,
    done: phase.done,
    total: phase.total,
    complete: phase.total > 0 && phase.done === phase.total
  }));

  const findings: TicketSnapshotFinding[] = analysis.findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    category: finding.category,
    summary: finding.summary,
    location: finding.location,
    resolved: finding.resolved
  }));

  let checks: TicketSnapshotChecks | null = null;
  if (checksReport) {
    checks = {
      status: checksReport.status,
      completed_at: checksReport.completed_at,
      passed: checksReport.checks.filter((c) => c.status === "pass").map((c) => c.name),
      failed: checksReport.checks.filter((c) => c.status !== "pass").map((c) => c.name)
    };
  }

  let usage: TicketSnapshotUsage | null = null;
  if (usageLedger.segments.length > 0) {
    const rollup = rollupLedger(usageLedger);
    const lastEnded = usageLedger.segments.reduce<string | null>(
      (max, seg) => (!max || seg.ended_at > max ? seg.ended_at : max),
      null
    );
    usage = {
      tokens: rollup.tokens,
      cost_usd: rollup.cost_usd,
      segment_count: usageLedger.segments.length,
      by_command: rollupByCommand(usageLedger),
      last_ended_at: lastEnded
    };
  }

  const issueRaw = (metadata.issue ?? "").trim();
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : Number.NaN;

  return {
    change_id: id,
    title: metadata.title || null,
    status: metadata.status || null,
    branch: metadata.branch || null,
    capability: metadata.capability || null,
    issue: Number.isFinite(issueNumber) && issueNumber > 0 ? issueNumber : null,
    issue_url: metadata.issue_url || null,
    issue_forge: metadata.issue_forge || null,
    milestone: metadata.milestone || null,
    due_date: metadata.due_date || null,
    created: metadata.created || null,
    started: metadata.started || null,
    completed: metadata.completed || null,
    estimated_effort: metadata.estimated_effort || null,
    pr_url: metadata.pr_url || null,
    archived: resolved.archived,
    archive_path: resolved.archived ? path.relative(repoRoot, dir).replace(/\\/g, "/") : null,
    phases,
    tasks: { total: taskInfo.total, done: taskInfo.done, pending: taskInfo.pending },
    findings,
    checks,
    usage,
    clarifications,
    artifacts,
    warnings: [],
    rendered_at: formatDisplayTimestamp(new Date())
  };
}

// ---------------------------------------------------------------------------------------------
// Receipt + prelude cache (wspec/changes/<id>/.ticket/ — gitignored, machine-local)
// ---------------------------------------------------------------------------------------------

export interface TicketReceipt {
  schema_version: string;
  forge: string | null;
  issue: number | null;
  url: string | null;
  rev: number;
  content_hash: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  posted_events: string[];
  milestone_set: string | null;
  due_set: string | null;
}

function emptyReceipt(): TicketReceipt {
  return {
    schema_version: "1.1",
    forge: null,
    issue: null,
    url: null,
    rev: 0,
    content_hash: null,
    last_synced_at: null,
    last_error: null,
    posted_events: [],
    milestone_set: null,
    due_set: null
  };
}

function ticketDir(changeDir: string): string {
  return path.join(changeDir, ".ticket");
}

function receiptPath(changeDir: string): string {
  return path.join(ticketDir(changeDir), "state.json");
}

function preludePath(changeDir: string): string {
  return path.join(ticketDir(changeDir), "prelude.md");
}

/**
 * True if the receipt's stored content_hash matches a fresh snapshot of current packet state —
 * i.e. nothing semantically meaningful has changed since the last successful sync. Used by
 * state.ts's rebuildState to populate `active[].ticket.in_sync` for wspec.loadState / the session
 * banner. Local file reads only, no process spawn, no render — safe for rebuildState's
 * cheap-and-side-effect-free invariant, and cheaper than re-rendering the body.
 */
export function isTicketInSync(repoRoot: string, id: string): boolean {
  const resolved = resolveChangeDir(repoRoot, id);
  if (!resolved) return false;
  const receipt = readTicketReceipt(resolved.dir);
  if (!receipt || !receipt.content_hash) return false;
  try {
    const snapshot = collectSnapshot(repoRoot, id);
    return snapshotContentHash(snapshot) === receipt.content_hash;
  } catch {
    return false;
  }
}

/** Read-only accessor, exposed for wspec.loadState / StateActiveChange surfacing — never spawns
 * a process, matching rebuildState's cheap-and-side-effect-free invariant. */
export function readTicketReceipt(changeDir: string): TicketReceipt | null {
  const file = receiptPath(changeDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as TicketReceipt;
  } catch {
    return null;
  }
}

function writeReceipt(changeDir: string, receipt: TicketReceipt): void {
  try {
    fs.mkdirSync(ticketDir(changeDir), { recursive: true });
    const file = receiptPath(changeDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // The receipt is an optimization + dedup key, not the source of truth — a write failure here
    // must never fail the sync that produced it. Worst case: one extra body write or duplicate
    // comment next time.
  }
}

function readPrelude(changeDir: string): string | null {
  const file = preludePath(changeDir);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writePrelude(changeDir: string, prelude: string): void {
  try {
    fs.mkdirSync(ticketDir(changeDir), { recursive: true });
    fs.writeFileSync(preludePath(changeDir), prelude, "utf8");
  } catch {
    // Best-effort cache — a miss just costs one extra getIssue read next sync.
  }
}

function composeBody(prelude: string, block: string): string {
  const trimmed = prelude.trim();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

function sha256(text: string): string {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

/**
 * Content hash used to decide whether a sync needs to write anything at all. Deliberately hashes
 * the *snapshot*, not the rendered markdown — the render embeds `rev` (a monotonic counter) and
 * the snapshot's own `rendered_at` timestamp, both of which change on every call regardless of
 * whether anything meaningful did, which would make any hash of the rendered text always differ
 * from the last one. Excluding `rendered_at` here is what makes the hash actually stable across
 * no-op syncs. Object key order out of collectSnapshot is deterministic (same construction order
 * every call; array fields come from stable file-order parsing), so plain JSON.stringify is
 * sufficient — no sortKeysDeep pass needed.
 */
function snapshotContentHash(snapshot: TicketSnapshot): string {
  const { rendered_at: _rendered_at, ...stable } = snapshot;
  return sha256(JSON.stringify(stable));
}

// ---------------------------------------------------------------------------------------------
// wspec.syncTicket
// ---------------------------------------------------------------------------------------------

export interface SyncTicketOptions {
  event?: TicketEvent;
  phase?: number;
  findingIds?: string[];
  warnings?: string[];
  force?: boolean;
  dryRun?: boolean;
  forge?: string;
}

export interface SyncTicketResult {
  change_id: string;
  issue: number | null;
  url: string | null;
  body_updated: boolean;
  body_skip_reason: string | null;
  comments_posted: string[];
  comments_skipped: string[];
  close_error: string | null;
  skipped: boolean;
  reason: string | null;
  error: string | null;
  rendered_body?: string;
  rendered_comments?: string[];
  snapshot?: TicketSnapshot;
  caps?: ForgeCaps;
}

function eventKeyOf(event?: TicketEvent, phase?: number): string | null {
  if (!event) return null;
  return phase !== undefined ? `${event}:${phase}` : event;
}

/**
 * Re-render the ticket body from current packet state and, if `event` is given and not already
 * posted, append one event comment. Never throws — every failure path returns
 * `{ skipped: true, reason }` instead. The body is a total function of the snapshot, so a failed
 * write here self-heals on the next successful sync with no queue or retry logic needed.
 *
 * `dryRun: true` performs **zero** gh/glab calls — it renders and returns the markdown so the
 * whole feature is verifiable with no CLI installed and no auth (see wspec/mcp/src/cli.ts's
 * `tool` subcommand).
 */
export function syncTicket(repoRoot: string, id: string, opts: SyncTicketOptions = {}): SyncTicketResult {
  const base: Omit<SyncTicketResult, "issue" | "url"> = {
    change_id: id,
    body_updated: false,
    body_skip_reason: null,
    comments_posted: [],
    comments_skipped: [],
    close_error: null,
    skipped: false,
    reason: null,
    error: null
  };

  const resolved = resolveChangeDir(repoRoot, id);
  if (!resolved) {
    return { ...base, issue: null, url: null, skipped: true, reason: `change not found: ${id}` };
  }

  const snapshot = collectSnapshot(repoRoot, id);
  snapshot.warnings = opts.warnings ?? [];

  const receipt = readTicketReceipt(resolved.dir) ?? emptyReceipt();
  const issueNumber = snapshot.issue ?? receipt.issue;

  if (!issueNumber) {
    return {
      ...base,
      issue: null,
      url: null,
      skipped: true,
      reason: "no linked ticket (metadata.yaml has no issue:) — run wspec.bindTicket first",
      snapshot: opts.dryRun ? snapshot : undefined
    };
  }

  // Gate on a hash of the *snapshot* (rendered_at excluded), not of the rendered markdown — the
  // render embeds `rev` and `rendered_at`, both of which change on every call regardless of
  // whether anything meaningful did, which would make a hash of the rendered text differ from
  // the last one every time. `rev` only advances when a write is actually about to happen, so it
  // stays a meaningful "how many real content changes" counter instead of a call counter.
  const contentHash = snapshotContentHash(snapshot);
  const willWrite = Boolean(opts.force) || contentHash !== receipt.content_hash;
  const rev = willWrite ? receipt.rev + 1 : receipt.rev;
  const block = renderTicketBody(snapshot, rev);

  const eventKey = eventKeyOf(opts.event, opts.phase);
  const alreadyPosted = eventKey !== null && receipt.posted_events.includes(eventKey);
  const commentText = opts.event && !alreadyPosted ? renderEvent(opts.event, snapshot, { phase: opts.phase, findingIds: opts.findingIds }) : null;

  const forge = opts.forge ?? snapshot.issue_forge ?? undefined;

  if (opts.dryRun) {
    return {
      ...base,
      issue: issueNumber,
      url: snapshot.issue_url ?? receipt.url,
      body_skip_reason: willWrite ? null : "unchanged (content hash match)",
      rendered_body: block,
      rendered_comments: commentText ? [commentText] : [],
      snapshot,
      caps: getForgeCaps(repoRoot, forge)
    };
  }

  if (process.env.WSPEC_TICKET_OFF) {
    return { ...base, issue: issueNumber, url: snapshot.issue_url ?? receipt.url, skipped: true, reason: "disabled via WSPEC_TICKET_OFF" };
  }

  const config = readTicketConfig(repoRoot);
  if (!config.enabled) {
    return { ...base, issue: issueNumber, url: snapshot.issue_url ?? receipt.url, skipped: true, reason: "ticket sync disabled in wspec/config.yaml" };
  }

  const caps = getForgeCaps(repoRoot, forge);
  if (!caps.available || !caps.authed || !caps.forge) {
    return { ...base, issue: issueNumber, url: snapshot.issue_url ?? receipt.url, skipped: true, reason: caps.reason ?? "forge unavailable" };
  }

  let body_updated = false;
  let body_skip_reason: string | null = null;

  try {
    if (willWrite) {
      let prelude = readPrelude(resolved.dir);
      if (prelude === null) {
        const current = getIssue(repoRoot, { number: issueNumber, forge: caps.forge });
        prelude = extractPrelude(current.body);
        writePrelude(resolved.dir, prelude);
      }
      updateIssue(repoRoot, { number: issueNumber, body: composeBody(prelude, block), forge: caps.forge });
      body_updated = true;
    } else {
      body_skip_reason = "unchanged (content hash match)";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    receipt.last_error = message;
    writeReceipt(resolved.dir, receipt);
    return { ...base, issue: issueNumber, url: snapshot.issue_url ?? receipt.url, skipped: true, reason: message, error: message };
  }

  const comments_posted: string[] = [];
  const comments_skipped: string[] = [];
  if (eventKey) {
    if (alreadyPosted) {
      comments_skipped.push(eventKey);
    } else if (commentText) {
      try {
        commentIssue(repoRoot, { number: issueNumber, body: commentText, forge: caps.forge });
        comments_posted.push(eventKey);
        receipt.posted_events.push(eventKey);
      } catch (error) {
        comments_skipped.push(eventKey);
        receipt.last_error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  receipt.forge = caps.forge;
  receipt.issue = issueNumber;
  receipt.url = snapshot.issue_url ?? receipt.url;
  receipt.rev = rev;
  receipt.content_hash = contentHash;
  receipt.last_synced_at = new Date().toISOString();
  if (body_updated) receipt.last_error = null;
  writeReceipt(resolved.dir, receipt);

  let close_error: string | null = null;
  if (config.close_on_finalize && opts.event === "archived" && (snapshot.status ?? "").toLowerCase() === "done") {
    try {
      closeIssue(repoRoot, { number: issueNumber, forge: caps.forge });
    } catch (error) {
      close_error = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...base,
    issue: issueNumber,
    url: receipt.url,
    body_updated,
    body_skip_reason,
    comments_posted,
    comments_skipped,
    close_error
  };
}

/**
 * Best-effort wrapper for the fold-in call sites (setStatus, markTask, validatePhase,
 * appendFindings, archive) — mirrors writeStateBestEffort's contract exactly: never throws,
 * logs a one-line stderr warning on failure, and the caller ignores the return value entirely.
 */
export function syncTicketBestEffort(repoRoot: string, id: string, event?: TicketEvent, payload?: SyncTicketOptions): void {
  try {
    if (process.env.WSPEC_TICKET_OFF) return;
    const config = readTicketConfig(repoRoot);
    if (!config.enabled) return;

    const useEvent = event && config.events.includes(event) ? event : undefined;
    const result = syncTicket(repoRoot, id, { ...payload, event: useEvent });
    if (result.error) {
      process.stderr.write(`[wspec] ticket sync skipped: ${result.error}\n`);
    }
  } catch (error) {
    process.stderr.write(`[wspec] ticket sync skipped: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// wspec.bindTicket
// ---------------------------------------------------------------------------------------------

export interface BindTicketOptions {
  number?: number;
  create?: boolean;
  title?: string;
  body?: string;
  labels?: string[];
  milestone?: string;
  dueDate?: string;
  dryRun?: boolean;
  forge?: string;
}

export interface BindTicketResult {
  change_id: string;
  issue: number | null;
  url: string | null;
  forge: string | null;
  milestone: string | null;
  due_date: string | null;
  created: boolean;
  skipped: boolean;
  reason: string | null;
  error: string | null;
}

/**
 * Link a change packet to a forge ticket — either an existing one (`number`) or a newly created
 * one (`create: true`) — persist the link into metadata.yaml, ensure a milestone/due date where
 * the forge supports it, and post the first `packet_created` render. Never throws.
 */
export function bindTicket(repoRoot: string, id: string, opts: BindTicketOptions): BindTicketResult {
  const base = {
    change_id: id,
    issue: null as number | null,
    url: null as string | null,
    forge: null as string | null,
    milestone: null as string | null,
    due_date: null as string | null,
    created: false,
    skipped: false,
    reason: null as string | null,
    error: null as string | null
  };

  if (opts.number === undefined && opts.create !== true) {
    return { ...base, skipped: true, reason: "provide `number` to bind an existing issue, or `create: true`" };
  }

  const resolved = resolveChangeDir(repoRoot, id);
  if (!resolved) {
    return { ...base, skipped: true, reason: `change not found: ${id}` };
  }

  const config = readTicketConfig(repoRoot);
  const caps = getForgeCaps(repoRoot, opts.forge);
  if (!caps.available || !caps.authed || !caps.forge) {
    return { ...base, skipped: true, reason: caps.reason ?? "forge unavailable" };
  }

  if (opts.dryRun) {
    return { ...base, forge: caps.forge, reason: "dry run — no forge calls made" };
  }

  const metadataPath = path.join(resolved.dir, "metadata.yaml");
  let issueNumber: number;
  let issueUrl: string;
  let created = false;

  try {
    if (opts.number !== undefined) {
      const detail = getIssue(repoRoot, { number: opts.number, forge: caps.forge });
      issueNumber = detail.number;
      issueUrl = detail.url;
    } else {
      const metadata = readYamlScalars(metadataPath);
      const title = opts.title ?? metadata.title ?? id;
      const bodyText = opts.body ?? `Tracked by wSpec change \`${id}\`.`;
      const result = createIssue(repoRoot, { title, body: bodyText, labels: opts.labels, forge: caps.forge });
      issueNumber = result.number;
      issueUrl = result.url;
      created = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, forge: caps.forge, skipped: true, reason: message, error: message };
  }

  const values: Record<string, string> = { issue: String(issueNumber), issue_url: issueUrl, issue_forge: caps.forge };
  let milestoneTitle: string | null = null;
  let dueDate: string | null = null;

  if (caps.features.milestones) {
    const metadata = readYamlScalars(metadataPath);
    const desired =
      opts.milestone ?? (config.milestone === "capability" ? metadata.capability : config.milestone === "none" ? null : config.milestone);

    if (desired) {
      try {
        let due: string | null = opts.dueDate ?? null;
        if (!due && config.due_from_effort && caps.features.due_date) {
          const days = parseEffortToDays(metadata.estimated_effort);
          const start = metadata.started || metadata.created;
          if (days && start) due = addDaysToIsoDate(start, days);
        }
        ensureMilestone(repoRoot, { title: desired, dueDate: due, forge: caps.forge });
        setIssueMilestone(repoRoot, { number: issueNumber, milestone: desired, forge: caps.forge });
        milestoneTitle = desired;
        values.milestone = desired;

        if (due && caps.features.due_date) {
          setIssueDueDate(repoRoot, { number: issueNumber, dueDate: due, forge: caps.forge });
          dueDate = due;
          values.due_date = due;
        }
      } catch (error) {
        // Milestone/due-date is a nice-to-have — a failure here must not fail the bind itself,
        // but stay silent about it and the gap is undebuggable, unlike every other best-effort
        // path in this feature.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[wspec] milestone/due-date sync skipped: ${message}\n`);
      }
    }
  }

  upsertMetadataScalars(metadataPath, values);

  const receipt = readTicketReceipt(resolved.dir) ?? emptyReceipt();
  receipt.forge = caps.forge;
  receipt.issue = issueNumber;
  receipt.url = issueUrl;
  if (milestoneTitle) receipt.milestone_set = milestoneTitle;
  if (dueDate) receipt.due_set = dueDate;
  writeReceipt(resolved.dir, receipt);

  syncTicketBestEffort(repoRoot, id, "packet_created");

  return {
    change_id: id,
    issue: issueNumber,
    url: issueUrl,
    forge: caps.forge,
    milestone: milestoneTitle,
    due_date: dueDate,
    created,
    skipped: false,
    reason: null,
    error: null
  };
}
