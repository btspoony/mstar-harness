# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `mstar-sdd` (recommended) or inline execution. Steps use checkbox (`- [ ]`) syntax.

**Goal:** [One sentence]

**Architecture:** [2–3 sentences]

**Tech Stack:** [Key technologies]

**Execution:** mstar-sdd | inline

**Main worktree branch**: [recorded residency of the primary checkout (main worktree) — PM observes and records before the lifecycle writes, then passes it unchanged in writable Assignments; never invented at check time, and never `branch.base` (that is a creation/merge anchor, not a residency fact)]

## Global Constraints

[Project requirements — version floors, naming, exact values — copied verbatim from spec. Every task includes them. Verification scope follows `mstar-harness-core` § 定向执行与验证边界: only changed behavior and direct contracts; no local full suites without explicit user permission. Never assign real-browser/device/installed-deployment E2E evidence as a task or a gate of a development plan; each layer proves itself with its own unit/integration tests. Real-environment verification lives only in a separately requested `mstar-e2e` workflow, whose named scenarios are that workflow's own plan rows.]

Development AC boundary: [For every task, replace any requirement for live API/provider receipts, a named/authenticated host/account, installed plugin/artifact, real browser/device, or deployed-environment proof with isolated fixtures, unit/component/integration checks, or locally built CLI/MCP evidence. Record real-environment behavior as unverified when applicable; only a separately authorized operational/E2E workflow owns real scenarios.]

Edit attribution example (synthetic only): [local ignored record: `2026-01-01T00:00:00Z | editor-seat | unknown | example-iteration | docs/example.md`; use actual local edit time and observable model-or-`unknown` for real work. Plan QC checks the local record, never copies its real entries into this tracked template.]

## Engine lifecycle

Who advances this plan row's engine state, and what records each transition:

- **Route is declared, not inferred** — the engine selects the completion route from the workflow's registered `type` and declared `delivery_kind`, never from integration anchors that happen to be absent. Missing anchors neither choose a route nor waive genuinely missing registration facts.
- **Direct coordinator sequence** — ordinary `prepare` when source/config facts are missing or need correction → `progress` for start/review/block states → `complete` with QC/QA and declared-route evidence. Configuration is revisable during active execution; defaults are mandatory QA and allow-residual cleanup. Every state change uses its public domain verb, never hand-edited execution state. No per-row PM bind, Assignment seal or ceremonial prepare record.
  - **iteration/non-standalone:** perform the real serial merge in the recorded integration checkout, then complete with source/review/QC/QA evidence and actual `integration: {base_sha,result_sha}`. The engine verifies Git and atomically writes Done/completion, retains ownership metadata and releases applicable exclusion. Row Done creates no child PR.
  - **standalone development:** complete from clean registered source checkout/ref and reviewed commit without integration inputs. Workflow stays running for its own compound/PR/verified-merge/close.
  - **standalone report-only:** record fulfilment matching registered completion_policy before Done, then complete with QC/QA. No invented Git, integration, compound-before-PR, PR or merge. Mismatching, empty or missing fulfilment refuses completion; QA pass alone never supplies it. Evidence-backed terminal close remains.
- **Evidence order** — `compound` disposition, and on the iteration/development routes PR identity and merge evidence, are recorded **after** the row is `Done`; the engine refuses those writes while any plan row is not `Done`. The report-only fulfilment is the declared exception: it is recorded **before** the row is marked `Done`. The delivery tail runs on a completed row, never ahead of it.

Semantics, routes, and failure behavior → `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`; PM step sequence → `mstar-roles/references/project-manager/plan-management.md`.

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
