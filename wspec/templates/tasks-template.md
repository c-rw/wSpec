---
description: "wSpec task list template"
---

<!--
  Derived from templates/tasks-template.md in GitHub Spec Kit
  (https://github.com/github/spec-kit), MIT licensed.
  See THIRD-PARTY-NOTICES.md. Modified for wSpec.
-->

# Tasks: [TITLE]

**Change**: `[NNN-kebab-name]`
**Created**: [DATE]

**Prerequisites**: proposal.md ✓, spec.md ✓, design.md ✓

## Format

```text
- [ ] T### [P?] [US#?] [size?] [test-level?] Description — file/path/hint
      Seam: [optional — how to safely intercept existing behavior]
```

- **[P]**: Parallelizable (touches different files, no dependency on incomplete sibling tasks)
- **[US#]**: User scenario this task serves (maps to spec.md scenarios)
- **[size]**: Optional effort signal — S (< 1 hour), M (half-day), L (full day), XL (multi-day)
- **[test-level]**: For test tasks — `unit`, `intg`, or `e2e`
- **Seam**: For tasks modifying existing code without tests — name the injection point or override hook to use instead of modifying behavior directly (constructor injection, interface extraction, subclass-and-override, etc.)
- Include exact file paths or module hints in descriptions

---

## Phase 1: Setup

**Purpose**: Project initialization and basic structure.

- [ ] T001 Create project structure per design.md
- [ ] T002 Initialize dependencies
- [ ] T003 [P] Configure tooling (linting, formatting)

---

## Phase 2: Foundational

**Purpose**: Core infrastructure that MUST be complete before any scenario can be implemented.

⚠️ **No scenario work begins until this phase passes validation.**

- [ ] T004 [description — blocking prerequisite]
- [ ] T005 [P] [description — parallelizable foundation work]

**Validation Checkpoint** *(auto-checked by /wspec-implement)*:

- All FRs addressed by this phase are implemented
- No CRITICAL/HIGH analysis findings apply to this phase
- No principles MUST violations

---

## Phase 3: Scenario 1 — [Title] (P1) 🎯 MVP

**Goal**: [What this scenario delivers when complete]

**Independent Test**: [How to verify this scenario in isolation]

### Implementation — Scenario 1

- [ ] T010 [P] [US1] [task description] — src/path/to/file
- [ ] T011 [P] [US1] [task description] — src/path/to/file
- [ ] T012 [US1] [task description, depends on T010] — src/path/to/file
- [ ] T013 [US1] [task description] — src/path/to/file

**Validation Checkpoint** *(auto-checked by /wspec-implement)*:

- Scenario 1 acceptance criteria are met
- Relevant analysis findings are resolved or explicitly deferred
- No principles violations introduced

---

## Phase 4: Scenario 2 — [Title] (P2)

**Goal**: [What this scenario delivers]

**Independent Test**: [How to verify in isolation]

### Implementation — Scenario 2

- [ ] T020 [P] [US2] [task description] — src/path/to/file
- [ ] T021 [US2] [task description] — src/path/to/file

**Validation Checkpoint** *(auto-checked by /wspec-implement)*:

- Scenario 2 acceptance criteria are met
- Relevant analysis findings are resolved or deferred
- No principles violations introduced

---

[Add phases for each additional scenario following the same pattern]

---

## Phase N: Polish & Cross-Cutting

**Purpose**: Improvements that span multiple scenarios.

- [ ] TXXX [P] Documentation updates
- [ ] TXXX Code cleanup and refactoring
- [ ] TXXX Performance tuning
- [ ] TXXX Security hardening

---

## Execution Order

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Setup — blocks all scenarios
- **Phase 3+ (Scenarios)**: Depend on Foundational — can proceed in priority order or in parallel
- **Final Phase (Polish)**: All desired scenarios complete

### Parallel Opportunities

- All [P] tasks within a phase can run simultaneously
- Scenario phases (3+) can run in parallel across team members once Phase 2 is done

## Notes

- Tasks marked [P] touch different files and have no incomplete siblings as dependencies
- [US#] label maps each task to a user scenario for traceability
- Mark tasks complete in place: `- [ ]` → `- [x]` as you work
- Each validation checkpoint is enforced by `/wspec-implement` before the next phase begins
- Size tags are estimates relative to this project — recalibrate after Phase 1 if needed
- Seam notes apply when touching code that has no existing tests; write a characterization test first, then change behavior through the seam
