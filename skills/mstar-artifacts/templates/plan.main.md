# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `mstar-sdd` (recommended) or inline execution. Steps use checkbox (`- [ ]`) syntax.

**Goal:** [One sentence]

**Architecture:** [2–3 sentences]

**Tech Stack:** [Key technologies]

**Execution:** mstar-sdd | inline

**Main worktree branch**: [recorded residency of the primary checkout (main worktree) — PM observes and records before the lifecycle writes, then passes it unchanged in writable Assignments; never invented at check time, and never `branch.base` (that is a creation/merge anchor, not a residency fact)]

## Global Constraints

[Project requirements — version floors, naming, exact values — copied verbatim from spec. Every task includes them. Verification scope follows `mstar-harness-core` § 定向执行与验证边界: only changed behavior and direct contracts; no local full suites without explicit user permission. Never assign real-browser/device/installed-deployment E2E evidence as a task or a gate of a development plan; each layer proves itself with its own unit/integration tests. Real-environment verification lives only in a separately requested `mstar-e2e` workflow, whose named scenarios are that workflow's own plan rows.]

## Engine lifecycle

Who advances this plan row's engine state, and what records each transition:

- **Scoped sequence** — one engine verb per transition; never a hand-edited snapshot: `bind --coordinator` → `prepare` → `bind` → `progress` → `handoff` → `accept` → `integration-start` → Git merge → `integration-accept` → `complete`.
- **Evidence order** — `compound` disposition, PR identity and merge evidence are recorded **after** the row is `Done`; the engine refuses those writes while any plan row is not `Done`. The delivery tail runs on a completed row, never ahead of it.
- **Snapshot declares no integration anchors** → the row cannot reach `Done` today: stop at a submitted/accepted handoff, report the blockage to the coordinator, and never fabricate a terminal state (`Done`, `completed`, PR identity, merge record).

Semantics and failure behavior → `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`; PM step sequence → `mstar-roles/references/project-manager/plan-management.md`.

---

### Task 1: [Component Name]

**Effort (agent-oriented):** [XS–XL band per `mstar-conventions/references/effort-estimation.md` — a size estimate, not a round ceiling]

**Split point:** [where the task splits if it cannot close its Files and gates in one round — capacity criterion → `mstar-artifacts/references/plan-quality-bar.md` item 7 (Task shape / session fit)]

**Files:**
- Create: `exact/path/to/file`
- Modify: `exact/path/existing.py`
- Test: `tests/path/test.py` + exact affected case (executable changes only)
- Out of scope: [excluded files/behavior]

**Interfaces:**
- Consumes: [signatures from earlier tasks]
- Produces: [what later tasks rely on]

Use the executable path below only for executable behavior. For non-executable documentation/policy, replace Steps 1–4 with the scoped-check alternative; do not invent tests.

- [ ] **Step 1: Write the failing unit test**

```python
# complete test code
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pytest tests/path/test.py -k exact_case -v` (replace with the actual affected selector)

- [ ] **Step 3: Minimal implementation**

- [ ] **Step 4: Run the same affected test — expect PASS**

Reuse unaffected evidence with its original range and applicability; do not repeat checks merely because HEAD changed.

- [ ] **Step 5: Commit**

### Scoped-check alternative (non-executable docs/policy)

- [ ] Read the changed text and its directly referenced contract/target.
- [ ] Apply only the assigned text change.
- [ ] Run the named scoped check, e.g. `rg -n 'expected-reference' docs/changed.md`, against actual changed files; record expected and observed results. For policy, include the triggering scenario and before/after expected action.
- [ ] Record `Verification mode: scoped-check` with the complete fields from `mstar-sdd/references/file-handoffs.md` § Verification evidence; no fabricated test files or outputs.
- [ ] Commit only the assigned files. Stop when these criteria are evidenced.

## Plan self-review (PM before locked)

1. **Spec coverage:** every spec requirement maps to a task
2. **Placeholder check:** task-owned paths/checks are concrete; executable tests have a real case, docs/policy have scoped evidence
3. **Type consistency:** names match across tasks
4. **Capacity (task shape / session fit):** every task closes its declared Files and verification gates in one implementer round — effort band declared, split point named, budget pressure never shortens verification (`mstar-artifacts/references/plan-quality-bar.md` item 7)

## SDD runtime (ephemeral)

When using `mstar-sdd`, artifacts live under `{SDD_DIR}` (see `mstar-conventions`). Do not duplicate briefs/reports in this file.
