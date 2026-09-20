# wSpec dynamic workflows

## `wspec-research-fanout.js`

Runs as `/wspec:wspec-research-fanout` once the plugin is loaded and Dynamic workflows are
turned on for the session (`/config` → Dynamic workflows, or an org policy). Called from
`/wspec:propose` Phase 1.3 in place of dispatching `wspec-researcher` one angle at a time —
merging N independent angles into one dossier is a genuine barrier (no per-angle multi-stage
chain, just single-shot agents whose combined output is one document), which is what a workflow's
`parallel()` is for.

**Args:**

```json
{
  "idea": "restated feature/change idea",
  "repoScanSummary": { "...": "the wspec.repoScan result, or null" },
  "gaps": ["array of repoScanSummary.gaps, or []"],
  "referenceUrls": ["array of user-supplied URLs, or []"]
}
```

**Returns:** `{ dossier: string, angleCount: number, failedCount: number }`. A failed angle (the
subagent returned nothing — interrupted, or a terminal API error after retries) becomes a plain
`_(angle: no result...)_` placeholder in the dossier rather than corrupting the merge; check
`failedCount` if you want to react to that rather than just note it.

**Requires:** `agentType: 'wspec:wspec-researcher'` — the fully namespaced form. Unlike the plain
Agent/Task tool, which falls back to an unambiguous bare name, the Workflow tool's `agentType`
looks up the exact registered name; a bare `wspec-researcher` fails with `agent type ... not
found`.

**If Dynamic workflows aren't available**, `/wspec:propose` falls back to dispatching
`wspec-researcher` inline, one angle at a time — see its Phase 1.3 for that path.
