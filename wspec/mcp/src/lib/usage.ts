import fs from "node:fs";
import path from "node:path";

/**
 * Effort/cost tracking for wSpec changes.
 *
 * Design note: Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl) carry
 * an exact per-request `usage` object on every assistant turn. Tokens are additive and immune
 * to context resets/compaction (unlike a "% of context used" figure, which resets to 0 and
 * can't be summed) — a session reset just means a new transcript file starts; the ledger below
 * accumulates independently of any one session. See wspec/README.md § Effort & Cost Tracking.
 *
 * IMPORTANT: the same `usage` object is repeated on every content-block line belonging to one
 * API request. Every summing path here dedupes by `requestId` before totaling tokens.
 */

export interface CacheCreationBreakdown {
  ephemeral_1h_input_tokens: number;
  ephemeral_5m_input_tokens: number;
}

export interface UsageEntry {
  model: string;
  requestId: string | null;
  timestamp: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation: CacheCreationBreakdown | null;
  cache_read_input_tokens: number;
}

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ModelCostBreakdown {
  tokens: TokenTotals;
  cost_usd: number;
  priced: boolean;
}

export interface CostSummary {
  total_usd: number;
  by_model: Record<string, ModelCostBreakdown>;
}

export interface UsageSegment {
  command: string;
  session_id: string | null;
  started_at: string;
  ended_at: string;
  subagent_count: number;
  tokens: TokenTotals;
  cost_usd: number;
  by_model: Record<string, ModelCostBreakdown>;
}

export interface UsageLedger {
  schema_version: string;
  segments: UsageSegment[];
}

export interface UsageCursorEntry {
  lineOffset: number;
  lastCommand: string | null;
  updatedAt: string;
}

export type UsageCursorFile = Record<string, UsageCursorEntry>;

/** $ per million tokens (input / output), before cache multipliers. */
interface ModelPrice {
  input: number;
  output: number;
}

/**
 * Cached snapshot (see shared/models.md in the claude-api skill). Unrecognized model ids are
 * priced at $0 with `priced: false` rather than guessed — never fabricate a rate.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-mythos-5": { input: 10.0, output: 50.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 }
};

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;
const CACHE_READ_MULTIPLIER = 0.1;

/** Strip a trailing dated-snapshot suffix (e.g. `-20251001`) before matching the pricing table. */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

export function emptyTotals(): TokenTotals {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens
  };
}

/**
 * Parse JSONL lines starting at `fromLine` (0-indexed), extracting assistant `usage` entries.
 * Dedupes by `requestId` — a single API request emits its usage object on every content-block
 * line, and summing without dedup overcounts by roughly the block count per request.
 */
export function readUsageEntries(transcriptPath: string, fromLine = 0): { entries: UsageEntry[]; totalLines: number } {
  if (!fs.existsSync(transcriptPath)) {
    return { entries: [], totalLines: 0 };
  }

  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const seenRequestIds = new Set<string>();
  const entries: UsageEntry[] = [];

  for (let i = fromLine; i < lines.length; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const obj = parsed as {
      type?: string;
      timestamp?: string;
      requestId?: string;
      message?: { model?: string; usage?: Record<string, unknown> };
    };

    if (obj.type !== "assistant" || !obj.message?.usage) continue;

    const usage = obj.message.usage;
    const requestId = obj.requestId ?? null;
    if (requestId) {
      if (seenRequestIds.has(requestId)) continue;
      seenRequestIds.add(requestId);
    }

    const cacheCreationRaw = usage.cache_creation as Record<string, unknown> | undefined;
    const cacheCreation: CacheCreationBreakdown | null = cacheCreationRaw
      ? {
          ephemeral_1h_input_tokens: Number(cacheCreationRaw.ephemeral_1h_input_tokens ?? 0),
          ephemeral_5m_input_tokens: Number(cacheCreationRaw.ephemeral_5m_input_tokens ?? 0)
        }
      : null;

    entries.push({
      model: obj.message?.model ?? "unknown",
      requestId,
      timestamp: obj.timestamp ?? null,
      input_tokens: Number(usage.input_tokens ?? 0),
      output_tokens: Number(usage.output_tokens ?? 0),
      cache_creation_input_tokens: Number(usage.cache_creation_input_tokens ?? 0),
      cache_creation: cacheCreation,
      cache_read_input_tokens: Number(usage.cache_read_input_tokens ?? 0)
    });
  }

  return { entries, totalLines: lines.length };
}

/**
 * Locate subagent transcripts for a session, filtered to those modified after `sinceMs`.
 * Subagent runs (wspec-researcher, wspec-analyst, wspec-phase-validator, ...)
 * write to `<project-dir>/<session-id>/subagents/agent-*.jsonl`, a sibling of the parent
 * transcript file `<project-dir>/<session-id>.jsonl`.
 */
export function findSubagentTranscripts(transcriptPath: string, sinceMs: number): string[] {
  const dir = path.dirname(transcriptPath);
  const base = path.basename(transcriptPath, ".jsonl");
  const subagentsDir = path.join(dir, base, "subagents");

  if (!fs.existsSync(subagentsDir)) {
    return [];
  }

  const out: string[] = [];
  for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(subagentsDir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs > sinceMs) {
        out.push(full);
      }
    } catch {
      // Vanished between readdir and stat — skip.
    }
  }
  return out;
}

/** Cost for one model's token totals, using the exact 5m/1h cache-write split when available. */
function costForModel(model: string, totals: TokenTotals, entries: UsageEntry[]): ModelCostBreakdown {
  const normalized = normalizeModelId(model);
  const price = MODEL_PRICING[normalized];

  if (!price) {
    return { tokens: totals, cost_usd: 0, priced: false };
  }

  const inputRate = price.input / 1_000_000;
  const outputRate = price.output / 1_000_000;

  let cacheWriteCost = 0;
  let sawBreakdown = false;
  for (const entry of entries) {
    if (entry.cache_creation) {
      sawBreakdown = true;
      cacheWriteCost +=
        entry.cache_creation.ephemeral_5m_input_tokens * inputRate * CACHE_WRITE_5M_MULTIPLIER +
        entry.cache_creation.ephemeral_1h_input_tokens * inputRate * CACHE_WRITE_1H_MULTIPLIER;
    }
  }
  // Fallback: no per-entry breakdown available anywhere — assume the default 5m TTL.
  if (!sawBreakdown) {
    cacheWriteCost = totals.cache_creation_input_tokens * inputRate * CACHE_WRITE_5M_MULTIPLIER;
  }

  const cost =
    totals.input_tokens * inputRate +
    totals.output_tokens * outputRate +
    cacheWriteCost +
    totals.cache_read_input_tokens * inputRate * CACHE_READ_MULTIPLIER;

  return { tokens: totals, cost_usd: cost, priced: true };
}

/** Aggregate a flat list of usage entries into per-model totals and an overall cost. */
export function computeCost(entries: UsageEntry[]): CostSummary {
  const byModelEntries = new Map<string, UsageEntry[]>();
  for (const entry of entries) {
    const list = byModelEntries.get(entry.model) ?? [];
    list.push(entry);
    byModelEntries.set(entry.model, list);
  }

  const byModel: Record<string, ModelCostBreakdown> = {};
  let totalUsd = 0;

  for (const [model, modelEntries] of byModelEntries) {
    const totals = modelEntries.reduce((acc, e) => addTotals(acc, {
      input_tokens: e.input_tokens,
      output_tokens: e.output_tokens,
      cache_creation_input_tokens: e.cache_creation_input_tokens,
      cache_read_input_tokens: e.cache_read_input_tokens
    }), emptyTotals());

    const breakdown = costForModel(model, totals, modelEntries);
    byModel[model] = breakdown;
    totalUsd += breakdown.cost_usd;
  }

  return { total_usd: totalUsd, by_model: byModel };
}

function cursorPath(repoRoot: string): string {
  return path.join(repoRoot, "wspec", "usage-cursor.json");
}

export function loadCursor(repoRoot: string): UsageCursorFile {
  const file = cursorPath(repoRoot);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as UsageCursorFile;
  } catch {
    return {};
  }
}

export function saveCursor(repoRoot: string, cursor: UsageCursorFile): void {
  const file = cursorPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
}

function usageLedgerPath(repoRoot: string, changeId: string): string {
  return path.join(repoRoot, "wspec", "changes", changeId, "usage.json");
}

/** Read a usage.json ledger from an arbitrary change-folder directory (active `changes/<id>/` or
 * an already-archived `archive/YYYY-MM-DD-<id>/`) — used by archiveChange, which reads the ledger
 * from its post-move location. */
export function loadUsageLedgerFromDir(changeDir: string): UsageLedger {
  const file = path.join(changeDir, "usage.json");
  if (!fs.existsSync(file)) {
    return { schema_version: "1.0", segments: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as UsageLedger;
    if (!Array.isArray(parsed.segments)) {
      return { schema_version: "1.0", segments: [] };
    }
    return parsed;
  } catch {
    return { schema_version: "1.0", segments: [] };
  }
}

export function loadUsageLedger(repoRoot: string, changeId: string): UsageLedger {
  return loadUsageLedgerFromDir(path.join(repoRoot, "wspec", "changes", changeId));
}

export function appendUsageSegment(repoRoot: string, changeId: string, segment: UsageSegment): UsageLedger {
  const changeDir = path.join(repoRoot, "wspec", "changes", changeId);
  const ledger = loadUsageLedger(repoRoot, changeId);
  ledger.segments.push(segment);

  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(usageLedgerPath(repoRoot, changeId), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  return ledger;
}

/** Roll a ledger's segments up into overall token/cost totals (computed on the fly — never stored,
 * so it can't drift from the segments array). */
export function rollupLedger(ledger: UsageLedger): { tokens: TokenTotals; cost_usd: number; by_model: Record<string, ModelCostBreakdown> } {
  let tokens = emptyTotals();
  let cost = 0;
  const byModel: Record<string, ModelCostBreakdown> = {};

  for (const segment of ledger.segments) {
    tokens = addTotals(tokens, segment.tokens);
    cost += segment.cost_usd;
    for (const [model, breakdown] of Object.entries(segment.by_model)) {
      const existing = byModel[model];
      if (existing) {
        byModel[model] = {
          tokens: addTotals(existing.tokens, breakdown.tokens),
          cost_usd: existing.cost_usd + breakdown.cost_usd,
          priced: existing.priced && breakdown.priced
        };
      } else {
        byModel[model] = { ...breakdown };
      }
    }
  }

  return { tokens, cost_usd: cost, by_model: byModel };
}

/** Small shape suitable for embedding in wspec/state.json per active change. */
export function rollupForState(ledger: UsageLedger): { tokens: TokenTotals; cost_usd: number } {
  const { tokens, cost_usd } = rollupLedger(ledger);
  return { tokens, cost_usd };
}

function usageLogPath(repoRoot: string): string {
  return path.join(repoRoot, "wspec", "usage-log.jsonl");
}

export interface UsageLogEntry {
  id: string;
  title: string | null;
  archived_at: string;
  tokens: TokenTotals;
  cost_usd: number;
  by_model: Record<string, ModelCostBreakdown>;
  segment_count: number;
}

/** Append-only repo-level rollup — one line per finalized change, for "what does a change here
 * typically cost" over time. Best-effort: never throws (mirrors writeStateBestEffort's contract). */
export function appendUsageLogLine(repoRoot: string, entry: UsageLogEntry): void {
  try {
    const file = usageLogPath(repoRoot);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Best-effort; a rollup failure must never fail the archive it's attached to.
  }
}

export function readUsageLog(repoRoot: string): UsageLogEntry[] {
  const file = usageLogPath(repoRoot);
  if (!fs.existsSync(file)) return [];

  const out: UsageLogEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as UsageLogEntry);
    } catch {
      // Skip malformed lines rather than failing the whole read.
    }
  }
  return out;
}
