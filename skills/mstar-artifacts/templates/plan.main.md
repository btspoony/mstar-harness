# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `mstar-sdd` (recommended) or inline execution. Steps use checkbox (`- [ ]`) syntax.

**Goal:** [One sentence]

**Architecture:** [2–3 sentences]

**Tech Stack:** [Key technologies]

**Execution:** mstar-sdd | inline

**Main worktree branch:** [recorded residency of the primary checkout (main worktree) — PM observes and records before the lifecycle writes, then passes it unchanged in writable Assignments; never invented at check time, and never `branch.base` (that is a creation/merge anchor, not a residency fact)]

## Global Constraints

[Project requirements — version floors, naming, exact values — copied verbatim from spec. Every task includes them. Verification scope follows `mstar-harness-core` § 定向执行与验证边界: only changed behavior and direct contracts; no local full suites without explicit user permission.]

---

### Task 1: [Component Name]

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

## SDD runtime (ephemeral)

When using `mstar-sdd`, artifacts live under `{SDD_DIR}` (see `mstar-conventions`). Do not duplicate briefs/reports in this file.
