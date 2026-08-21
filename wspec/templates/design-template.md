# Design: [TITLE]

**Change**: `[NNN-kebab-name]`
**Created**: [DATE]

## Overview

[Technical approach summary. 2-4 paragraphs covering the core approach, major components, and primary data flows.]

## Technical Context

- **Language/Version**: [e.g., TypeScript 5.4, Python 3.12 — or NEEDS CLARIFICATION]
- **Primary Dependencies**: [libraries, frameworks — or NEEDS CLARIFICATION]
- **Storage**: [database/filesystem — or N/A]
- **Testing**: [test framework, e.g., Jest, pytest — or NEEDS CLARIFICATION]
- **Target Platform**: [e.g., Node.js 20+, Browser, Linux server]
- **Project Type**: [library / cli / web-service / mobile-app / desktop-app]
- **Performance Goals**: [latency, throughput targets — or N/A]
- **Constraints**: [memory, startup time, offline requirements — or N/A]

## Architecture

<!--
  Describe or diagram the key components and how they interact.
  ASCII diagrams are encouraged.

  Example:
  ┌──────────┐      ┌──────────┐      ┌──────────┐
  │  Client  │─────▶│   API    │─────▶│    DB    │
  └──────────┘      └──────────┘      └──────────┘
-->

[Architecture description or diagram]

## Quality Attribute Scenarios

<!--
  For each quality attribute that matters to this feature, write one scenario.
  Format: [Stimulus] -> [Response] -> [Response Measure]
  Remove attributes that are not relevant; add only those that drive real decisions.
-->

- **Performance**: Under [N concurrent users / requests per second], [endpoint/operation] responds in [target latency] at the [p95/p99] percentile.
- **Availability**: When [dependency] is unavailable, the feature [degrades gracefully / returns cached data / surfaces a clear error] within [time].
- **Security**: When [untrusted input / unauthorized actor] attempts [action], the system [rejects / logs / rate-limits] and does not [leak data / execute code].
- **Modifiability**: Adding a new [variant/provider/rule] requires changes to [N files / 1 module] only.

## Data Model

<!--
  Key entities, attributes, relationships, and state transitions.
  Technology-agnostic at this level; concrete schema goes in implementation.

  Identify aggregate roots — the entry point through which external code accesses
  a cluster of related entities. Mark consistency boundaries: what changes together
  in a single transaction, and what lives outside that boundary.
-->

- **[Entity / Aggregate Root]**: [fields, validations, relationships; mark if aggregate root]
- **[Entity]**: [lifecycle/state transitions if applicable]
- **Consistency Boundary**: [What can change in a single transaction vs. what is eventually consistent]

## Interface Contracts

<!--
  Public surfaces: APIs, CLI commands, events, UI contracts.
  Skip if purely internal.
-->

[Contracts description or link to contracts/ subdirectory]

## Key Decisions

| Decision | Choice    | Rationale | Alternatives Considered      |
| -------- | --------- | --------- | ---------------------------- |
| [topic]  | [choice]  | [why]     | [what else was evaluated]    |

## Research Notes

<!--
  Findings from research on unknowns. Captures what was evaluated and why something was chosen.
  Links to external resources are welcome.
-->

- **[Topic]**: [Finding — decision — rationale]

## File / Module Structure

```text
[Directory tree for the files this change touches or creates]
```

## Operational Readiness

<!--
  Only include if this change is deployed or monitored in production.
  Remove if purely internal/library.
-->

- **Logging**: [What events are logged, at what level (info/warn/error), and where]
- **Metrics**: [What counters, gauges, or histograms are emitted]
- **Alerting**: [What conditions should page on-call; which dashboard to watch]
- **Rollback path**: [How to safely disable or revert this feature if it misbehaves]
- **Feature flag**: [Is a flag needed for safe rollout? If so, name it here]

## Principles Check

<!--
  Verify each principle from wspec/principles.md is satisfied.
  Note any justified exceptions.

  Default SOLID checklist (remove if project uses a different quality framework):
-->

- [ ] **SRP** (Single Responsibility): Each class/module has one reason to change
- [ ] **OCP** (Open/Closed): New behavior added by extension, not by modifying existing code
- [ ] **LSP** (Liskov Substitution): Subtypes are substitutable for their base types
- [ ] **ISP** (Interface Segregation): No client is forced to depend on methods it does not use
- [ ] **DIP** (Dependency Inversion): High-level modules depend on abstractions, not concretions

- [ ] [Principle I from wspec/principles.md]: [How satisfied or exception rationale]
- [ ] [Principle II from wspec/principles.md]: [How satisfied or exception rationale]
