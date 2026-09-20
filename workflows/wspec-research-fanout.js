export const meta = {
  name: 'wspec-research-fanout',
  description: "Fan out wspec-researcher across a wSpec change's fixed research angles in parallel, and merge the results into one research dossier.",
  whenToUse: "Called by /wspec:propose Phase 1.3 (and reusable from /wspec:research) instead of dispatching wspec-researcher inline one angle at a time, since 'merge all angles into one dossier' is a genuine barrier -- there is no per-angle multi-stage chain here, just N independent single-shot agents whose combined output is one document.",
  phases: [{ title: 'Research' }],
}

// args shape: { idea: string, repoScanSummary?: object|null, gaps?: array, referenceUrls?: array }
// See workflows/README.md for the exact contract and an invocation example.

const idea = args.idea
const repoScanSummary = args.repoScanSummary ?? null
const gaps = args.gaps ?? []
const referenceUrls = args.referenceUrls ?? []

const baseContext =
  `Baseline signals already resolved (do not re-derive): ${JSON.stringify(repoScanSummary)}\n` +
  `Unresolved gaps to focus on: ${JSON.stringify(gaps)}`

// Angle-specific asks only -- wspec-researcher's own persona (agents/wspec-researcher.md)
// already carries the markdown return-contract, so it isn't restated here.
const angles = [
  {
    label: 'internal-prior-art',
    prompt:
      `Read-only research for a new wSpec change. The user wants: ${idea}.\n\n${baseContext}\n\n` +
      'Return concise findings on: (a) related capability specs in wspec/specs/, (b) relevant ' +
      'archived changes in wspec/archive/, (c) implementation patterns and conventions in the ' +
      'repo. Cite file paths. Note likely overlap and conflicts.',
  },
  {
    label: 'risks-constraints-edge-cases',
    prompt:
      `Read-only risk scan for this idea: ${idea}.\n\n${baseContext}\n\n` +
      'Return concrete technical and workflow blockers, security/privacy concerns, edge cases, ' +
      'and where they appear in the repo. Include confidence per risk.',
  },
  {
    label: 'testing-and-conventions',
    prompt:
      `Read-only scan for test patterns, validation style, naming conventions, and repo ` +
      `constraints relevant to this idea: ${idea}.\n\n${baseContext}\n\n` +
      'Return concise implementation guidance.',
  },
]

if (referenceUrls.length > 0) {
  angles.push({
    label: 'external-references',
    prompt:
      `Fetch and summarize ONLY these URLs (do not browse anywhere else): ${JSON.stringify(referenceUrls)}. ` +
      'Return concise findings per URL. Do not browse beyond what was explicitly given.',
  })
}

phase('Research')
log(`Fanning out ${angles.length} research angle(s) via wspec-researcher...`)

// Must be the fully namespaced form -- unlike the Agent/Task tool, which falls back to an
// unambiguous bare name, the Workflow tool's agentType looks up the exact registered name.
const results = await parallel(
  angles.map((a) => () => agent(a.prompt, { agentType: 'wspec:wspec-researcher', label: a.label }))
)

const failedCount = results.filter((r) => !r).length
if (failedCount > 0) {
  log(`${failedCount} of ${angles.length} research angle(s) did not return a result -- see the merged dossier below.`)
}

const dossier = angles
  .map((a, i) => (results[i] ? String(results[i]) : `_(${a.label}: no result -- skipped, interrupted, or a terminal API error)_`))
  .join('\n\n')

return { dossier, angleCount: angles.length, failedCount }
