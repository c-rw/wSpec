---
schema: wspec/schemas/analysis-findings.schema.json
machine_readable_authoritative: true
---

# Analysis: [TITLE]

**Change**: `[NNN-kebab-name]`
**Generated**: [DATE]
**Status**: [pass | warnings | issues]

## Summary

[N findings total: X critical, Y high, Z medium, W low. Overall health: GREEN / YELLOW / RED.]

## Findings

The machine-readable YAML section below is the source of truth. Keep this table
in sync with `analysis.findings`.

| ID  | Category     | Severity | Location | Summary                                    | Recommendation            |
| --- | ------------ | -------- | -------- | ------------------------------------------ | ------------------------- |
| A1  | Coverage Gap | HIGH     | spec.md  | FR-003 has no associated task              | Add task in Phase 3       |
| A2  | Ambiguity    | MEDIUM   | spec.md  | "fast" in SC-002 lacks measurable target   | Define p95 latency target |
| A3  | Adversarial  | CRITICAL | spec.md  | Delete path has no auth/ownership check    | Add FR + task before code |

**Severity levels**: CRITICAL · HIGH · MEDIUM · LOW

**Categories**: Coverage Gap · Ambiguity · Duplication · Inconsistency · Underspecification · Principles · SOLID Violation · Security · Architecture Risk · Scope Creep · Adversarial · Boundary

<!-- Adversarial and Boundary findings come from the /wspec-propose Phase 4.55 adversarial attack
     pass (run by wspec-analyst before its cross-artifact scan): edge cases, missing error paths,
     ambiguity exploits, and abuse cases caught before code. -->


---

## Coverage Summary

The machine-readable YAML section below is the source of truth. Keep this table
in sync with `analysis.coverage_gaps`.

| Requirement | Has Task? | Task IDs   | Notes                  |
| ----------- | --------- | ---------- | ---------------------- |
| FR-001      | ✓         | T010, T012 |                        |
| FR-002      | ✗         | —          | No matching task found |
| SC-001      | ✓         | T013       |                        |

### Test Pyramid

<!--
  Flag imbalances: over-reliance on E2E (slow, fragile), or missing unit coverage
  for logic-heavy components. Tasks tagged [e2e] should be the minority.
-->

| Level       | Task Count | Notes                                     |
| ----------- | ---------- | ----------------------------------------- |
| unit        | 0          | [count tasks tagged [unit]]               |
| integration | 0          | [count tasks tagged [intg]]               |
| e2e         | 0          | [count tasks tagged [e2e]]                |
| untagged    | 0          | [tasks with no test-level tag]            |

---

## Principles Alignment

<!-- PASS if no issues; otherwise list each violation -->

- [ ] [Principle I]: PASS / [violation description]
- [ ] [Principle II]: PASS / [violation description]

The machine-readable YAML section below is the source of truth. Keep this list
in sync with `analysis.principles_issues`.

---

## Machine-Readable

<!-- Used by /wspec-implement for per-phase validation. This block is authoritative. -->

```yaml
analysis:
  status: "issues"  # pass | warnings | issues
  total: 0
  critical: 0
  high: 0
  medium: 0
  low: 0
  findings: []
    # - id: "A1"
    #   category: "Coverage Gap"
    #   severity: "HIGH"
    #   location: "spec.md"
    #   summary: "FR-003 has no associated task"
    #   affects_phases: ["Phase 3"]
    #   resolved: false
    #   defer_reason: "Deferred to Phase 4 due to dependency sequencing"
  coverage_gaps: []
    # - requirement: "FR-003"
    #   has_task: false
    #   task_ids: []
  principles_issues: []
    # - principle: "I. Simplicity First"
    #   violation: "design.md proposes Redis before SQLite was evaluated"
    #   severity: "HIGH"
```
