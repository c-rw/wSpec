# Third-Party Notices

wSpec is licensed under the MIT License (see `LICENSE`). It began as an amalgamation of two
other MIT-licensed projects — [GitHub Spec Kit](https://github.com/github/spec-kit) and
[Fission-AI OpenSpec](https://github.com/Fission-AI/OpenSpec) — and a handful of files still
carry text or logic derived from them. This file reproduces both projects' license notices, as
their licenses require, and lists exactly which wSpec files are derived and how.

Everything not listed in the derived-files table below — the MCP server, the installers, the git
and Claude Code hooks, the override/validation/cost-tracking systems, the subagent layer, and the
command prose — is original to wSpec.

---

## Spec Kit

MIT License

Copyright GitHub, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/github/spec-kit

---

## OpenSpec

MIT License

Copyright (c) 2024 OpenSpec Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/Fission-AI/OpenSpec

---

## Derived files

wSpec's own git history contains an early commit that vendored both projects' source wholesale
(templates, agent prompts, PowerShell/bash scripts). That vendored code was later removed as
wSpec's own implementation replaced it; the table below covers what still carries meaningful
overlap with the originals in the current tree.

| wSpec file | Derived from | What carried over |
| --- | --- | --- |
| `wspec/templates/spec-template.md` | Spec Kit `templates/spec-template.md` | Section structure (User Scenarios/Stories, Edge Cases, Functional Requirements, Key Entities, Success Criteria, Assumptions), the Given/When/Then acceptance-criteria format, the `FR-NNN`/`SC-NNN` numbering convention, and the `[NEEDS CLARIFICATION: ...]` marker convention |
| `wspec/templates/tasks-template.md` | Spec Kit `templates/tasks-template.md` | Phased task-list structure, the `[P]` parallelizable-task marker, the `🎯 MVP` phase marker, and the per-phase validation checkpoint pattern |
| `wspec/mcp/src/lib/branch.ts` | Spec Kit `scripts/powershell/create-new-feature.ps1` | The branch-numbering algorithm (scan branches + directories for the highest `NNN-` prefix), the stop-word list used to derive a short name from a free-text description, and the `BRANCH_NAME`/`FEATURE_NUM`/`HAS_GIT` output shape — reimplemented in TypeScript with wSpec-specific extensions (existing-branch handling, `WSPEC_OVERRIDE_REASON` override) |
| `wspec/config.yaml` | OpenSpec `openspec/config.yaml` | The `context:`/`rules:` optional-override comment scaffold and its example wording |

Everything else in those files — the MUST/MUST NOT principles format, the analysis/design/
research/proposal templates, the adversarial attack pass, the MCP tool surface, the git and
Claude Code hook wiring, the override and cost-tracking systems, and all slash-command prose — is
original to wSpec.
