import { forgeCli, resolveForge, vcsReady, type Forge } from "./forge.js";
import { runCommand } from "./shell.js";

export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface CreateIssueResult {
  number: number;
  url: string;
  forge: Forge;
}

function resolve(repoRoot: string, forge?: string): { forge: Forge; cli: "gh" | "glab" } {
  const resolvedForge = resolveForge(repoRoot, forge);
  const cli = forgeCli(resolvedForge);
  const ready = vcsReady(cli, repoRoot);
  if (!ready.ok) {
    throw new Error(ready.reason ?? `${cli} unavailable`);
  }
  return { forge: resolvedForge, cli };
}

function run(cli: "gh" | "glab", args: string[], repoRoot: string): string {
  const result = runCommand(cli, args, repoRoot);
  if (result.code !== 0) {
    throw new Error(`${cli} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function lastUrl(text: string): string | null {
  const urls = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line));
  return urls.length > 0 ? urls[urls.length - 1] : null;
}

function numberFromUrl(url: string): number {
  const match = /\/(\d+)\/?$/.exec(url);
  if (!match) {
    throw new Error(`Could not parse issue number from URL: ${url}`);
  }
  return Number.parseInt(match[1], 10);
}

function parseJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Could not parse JSON output for ${context}:\n${text}`);
  }
}

export function ensureLabel(repoRoot: string, label: string, forge?: string): void {
  const { cli } = resolve(repoRoot, forge);

  if (cli === "gh") {
    // --force updates the label in place if it already exists, so this is always idempotent.
    run(cli, ["label", "create", label, "--force"], repoRoot);
    return;
  }

  const result = runCommand(cli, ["label", "create", "--name", label], repoRoot);
  if (result.code !== 0) {
    const message = result.stderr || result.stdout;
    // glab has no --force; swallow "already exists" so capture never fails on a
    // pre-existing label.
    if (/already exist|already been taken/i.test(message)) {
      return;
    }
    throw new Error(`${cli} label create failed: ${message}`);
  }
}

export function createIssue(
  repoRoot: string,
  input: { title: string; body: string; labels?: string[]; forge?: string }
): CreateIssueResult {
  const { forge, cli } = resolve(repoRoot, input.forge);
  const labels = input.labels ?? [];

  const args =
    cli === "gh"
      ? ["issue", "create", "--title", input.title, "--body", input.body, ...labels.flatMap((l) => ["--label", l])]
      : [
          "issue",
          "create",
          "--title",
          input.title,
          "--description",
          input.body,
          "--yes",
          ...labels.flatMap((l) => ["--label", l])
        ];

  const stdout = run(cli, args, repoRoot);
  const url = lastUrl(stdout);
  if (!url) {
    throw new Error(`${cli} issue create did not return a URL:\n${stdout}`);
  }

  return { number: numberFromUrl(url), url, forge };
}

export function listIssues(
  repoRoot: string,
  input: { label?: string; state?: "open" | "closed" | "all"; forge?: string } = {}
): IssueSummary[] {
  const { cli } = resolve(repoRoot, input.forge);
  const state = input.state ?? "open";

  if (cli === "gh") {
    const args = ["issue", "list", "--json", "number,title,url,labels", "--state", state];
    if (input.label) args.push("--label", input.label);
    const stdout = run(cli, args, repoRoot);
    const parsed = parseJson<Array<{ number: number; title: string; url: string; labels: Array<{ name: string }> }>>(
      stdout,
      "gh issue list"
    );
    return parsed.map((entry) => ({
      number: entry.number,
      title: entry.title,
      url: entry.url,
      labels: (entry.labels ?? []).map((l) => l.name)
    }));
  }

  // glab: list-output JSON flag is `-O json` (view uses `-F json` instead — inconsistent
  // across glab subcommands, confirmed against the installed 1.106.0 CLI).
  const args = ["issue", "list", "-O", "json"];
  if (input.label) args.push("--label", input.label);
  if (state === "closed") args.push("--closed");
  if (state === "all") args.push("--all");
  const stdout = run(cli, args, repoRoot);
  const parsed = parseJson<
    Array<{ iid?: number; number?: number; title: string; web_url?: string; url?: string; labels?: unknown }>
  >(stdout, "glab issue list");

  return parsed.map((entry) => {
    const rawLabels = entry.labels;
    const labels = Array.isArray(rawLabels)
      ? rawLabels.map((l) => (typeof l === "string" ? l : (l as { name?: string })?.name ?? String(l)))
      : [];
    return {
      number: entry.iid ?? entry.number ?? 0,
      title: entry.title,
      url: entry.web_url ?? entry.url ?? "",
      labels
    };
  });
}

export function getIssue(repoRoot: string, input: { number: number; forge?: string }): IssueDetail {
  const { cli } = resolve(repoRoot, input.forge);

  if (cli === "gh") {
    const stdout = run(cli, ["issue", "view", String(input.number), "--json", "number,title,body,url"], repoRoot);
    const parsed = parseJson<{ number: number; title: string; body: string; url: string }>(stdout, "gh issue view");
    return parsed;
  }

  const stdout = run(cli, ["issue", "view", String(input.number), "-F", "json"], repoRoot);
  const parsed = parseJson<{ iid?: number; number?: number; title: string; description?: string; web_url?: string; url?: string }>(
    stdout,
    "glab issue view"
  );
  return {
    number: parsed.iid ?? parsed.number ?? input.number,
    title: parsed.title,
    body: parsed.description ?? "",
    url: parsed.web_url ?? parsed.url ?? ""
  };
}

export function commentIssue(repoRoot: string, input: { number: number; body: string; forge?: string }): void {
  const { cli } = resolve(repoRoot, input.forge);
  const args =
    cli === "gh" ? ["issue", "comment", String(input.number), "--body", input.body] : ["issue", "note", String(input.number), "--message", input.body];
  run(cli, args, repoRoot);
}

export function updateIssue(
  repoRoot: string,
  input: { number: number; body?: string; title?: string; forge?: string }
): void {
  if (!input.body && !input.title) {
    throw new Error("updateIssue requires at least one of body or title");
  }
  const { cli } = resolve(repoRoot, input.forge);

  const args = ["issue", cli === "gh" ? "edit" : "update", String(input.number)];
  if (input.body) args.push(cli === "gh" ? "--body" : "--description", input.body);
  if (input.title) args.push("--title", input.title);
  run(cli, args, repoRoot);
}

export function closeIssue(repoRoot: string, input: { number: number; comment?: string; forge?: string }): void {
  const { cli } = resolve(repoRoot, input.forge);
  if (input.comment) {
    commentIssue(repoRoot, { number: input.number, body: input.comment, forge: input.forge });
  }
  run(cli, ["issue", "close", String(input.number)], repoRoot);
}
