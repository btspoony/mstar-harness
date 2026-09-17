# Plan Quality Bar

The standard every implementation plan must meet before it is locked and dispatched. Applies to `{PLAN_DIR}` main plans, SDD task-briefs derived from them, and audit-generated plans. Extends the Plan 质量门 in **`mstar-phase-gates`** and the `plan.main.md` template.

## Core principle: write for a zero-context executor

SDD implementers start with a fresh session — they have not seen the Prepare conversation, the spec, or other tasks. Audit plans may be executed sessions or days later by a different model. If a plan references "the pattern discussed above" or "as agreed in clarify", it is broken.

The plan is the spec. Everything the executor needs must be in the file or reachable from a file path it names.

## Prepare-writing bar (Phase 1 editing roles)

The Phase 1 editing roles (`product-manager` → `architect` → `writing-specialist`) carry the mirror-image obligation of the principle above: **they are the ones who write the context carrier.** The PM draft and the compass are the artifact a fresh session reads, and a dispatched Phase 1 role works from disk — never from the PM's conversation. A decision that lives only in that conversation is invisible to the role, which will re-derive it wrong.

So the draft is held to the same self-containment standard as a plan:

- **Context first, depth second.** Locked direction, settled decisions, open questions with owners, non-goal rationale, constraint sources, acceptance seed, branch policy. Coarse detail is legitimate; an *unmarked* hole is not — it has no owner and no place to be discharged.
- **Every unfinished part carries its owner.** The marker grammar is defined once, in `mstar-iteration/references/phase-1-prepare.md` §1.3 (`TODO(owner: …)`); this file cites it and does not restate it.
- **An editing role discharges the markers naming it** in its own edit pass, re-owning to `PM` whatever it cannot close, and reports the count.
- **No marker survives the lock.** Cleared (or explicitly re-owned to `PM` and raised to the user) before compass `status: locked` — never silently dropped.

The unowned-`TBD` ban is unchanged at every stage.

## Quality checklist

Before a plan is locked, verify every item:

### 1. Self-contained context

- Every task names **exact file paths** (create / modify / test), not "the relevant module".
- **Current-state excerpts** — when a task modifies existing code, include the code as it exists today (short, with `file:line` markers), enough that the executor can confirm it is looking at the right thing.
- **Conventions to follow** — name the repo pattern (error handling, naming, layering) and point to one exemplar file: "Error handling follows the Result pattern — see `src/lib/result.ts` and its use in `src/users/api.ts:40-60`. Match it."
- **Interfaces** — consumed and produced signatures are listed verbatim, not paraphrased.

### 2. Verification gates

Each verification step names the changed behavior, exact scoped command and expected result, or reusable evidence with its applicability. Use only checks needed for this change; discovering a repository command does not make it a gate. Scope authority → `mstar-harness-core` § 定向执行与验证边界. Verification gates stay inside the change's own layer: a development plan's task never gates on real-browser, device, or installed-deployment E2E — that verification lives only in a separately requested `mstar-e2e` workflow, whose own scenario rows are its legitimate tasks.

| Pattern | Weak (do not use) | Strong (scope first) |
|---------|-------------------|----------------------|
| Executable bug | "run the tests" | `pytest tests/test_orders.py -k rejects_empty_order -v` → the relevant regression fails before the fix and passes after |
| Documentation | "run all docs checks" | `rg -n 'new-target' docs/setup.md` → the changed reference matches the verified target; record actual output |
| Removal | "scan the source tree" | `rg -n 'oldPattern' src/orders.ts tests/test_orders.py` → no matches in the affected files |

These are examples, not commands to copy into every plan. Resolve actual paths/selectors before locking. No available scoped entry → report the exact gap; do not substitute a package/workspace suite. Non-executable docs/policy use `Verification mode: scoped-check` evidence per `mstar-sdd/references/file-handoffs.md`, with before/after observable criteria for policy changes. Executable changes retain their corresponding unit-test evidence.

### 3. Hard boundaries

Each task lists:

- **In scope** — the only files the executor should modify.
- **Out of scope** — files that look related but must not be touched, with a one-line reason ("deprecated path, scheduled for deletion").

### 4. STOP conditions

Plan-specific escape hatches — not boilerplate. Name the risks particular to this work:

- "If `config.ts` no longer exports `getDb`, STOP — the migration in plan 003 may have landed first."
- "If the test in step 2 fails for a reason other than the missing import, STOP — the assumption that `User.email` is non-nullable may be false."

The executor stops and reports instead of improvising. This is what lets a weaker model execute safely.

### 5. Drift check

Stamp the commit the plan was written against. Before execution, the executor (or PM) runs:

```
git diff --stat <planned-at-sha>..HEAD -- <in-scope-paths>
```

If any in-scope file changed, the executor compares the plan's "current state" excerpts against live code before proceeding. On mismatch → STOP condition.

In SDD, this maps to the `BASE_SHA` recorded before Task 1.

### 6. Done criteria (machine-checkable)

All **selected, change-relevant** criteria must hold. Remove inapplicable example rows rather than creating unnecessary work:

```markdown
## Done criteria

- [ ] Executable bug: `pytest tests/test_orders.py -k rejects_empty_order -v` passes; record the relevant red/green evidence
- [ ] Docs-only alternative: `rg -n 'new-target' docs/setup.md` matches the changed reference and its target resolves; record scoped-check evidence, no test file needed
- [ ] `git diff --check -- <in-scope-files>` exits 0
- [ ] No files outside the in-scope list are modified (`git status --short`)
```

Do not add repository-wide build/test/lint/typecheck gates for insurance. Full suites remain CI-owned unless the user explicitly authorizes a bounded local exception; that exception is not inferred from this template.

"Works correctly" is not a done criterion.

### 7. Task shape / session fit

Each task fits **one focused implementer round** — the round closes the task's declared Files list and verification gates, not a slice of them:

- **Effort (agent-oriented)** — every task cites its band from the existing XS–XL scale (`mstar-conventions/references/effort-estimation.md`). A size estimate and a one-round closure assertion are distinct: a multi-session band never authorizes a multi-round task — split until each task can close its own Files and gates.
- **Named split point** — every task states where it breaks if one-round closure fails, so PM can split without re-deriving the boundary.
- **Split strategies** — apply the review split shapes (`mstar-audit/references/pr-review.md` § Sizing & change shape) to task boundaries, each slice with explicit interfaces and independent proof: stack · by file group · horizontal (shared code first) · vertical (full-stack slices). They shape task boundaries; PR line-count thresholds stay review-owned.
- **Verification is not the shock absorber** — **Budget pressure MUST NOT shorten or waive any assigned scoped verification.** If the round cannot close, stop and report for split/re-dispatch instead of cutting checks.

### 8. Engine lifecycle ownership

**Who advances this row's engine state, at which step, and what evidence records each transition?** The plan answers it explicitly: the scoped verb sequence it will be driven through, the delivery-tail evidence order (`compound` disposition → PR identity → verified merge, recorded **after** the row is `Done`), and — when the snapshot declares no integration anchors — that the row stops at an accepted handoff rather than promising a terminal state it cannot reach. Semantics → `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`; PM step sequence → `mstar-roles/references/project-manager/plan-management.md`.

## Relationship to existing plan elements

| This quality bar | Existing mstar element |
|------------------|----------------------|
| Self-contained context | `plan.main.md` Global Constraints + per-task Files/Interfaces |
| Verification gates | `plan.main.md` per-step "Run: `cmd`" lines |
| Hard boundaries | `plan.main.md` per-task Files (Create/Modify) — extended with explicit Out-of-scope |
| STOP conditions | New — not previously formalized |
| Drift check | SDD `BASE_SHA` — generalized to all plans |
| Done criteria | `plan.main.md` per-step checkboxes — elevated to machine-checkable |
| Task shape / session fit | `plan.main.md` per-task **Effort (agent-oriented)** / **Split point** slots + `mstar-phase-gates` capacity quick-check — one-round Files-plus-gates closure per task |
| Engine lifecycle ownership | `plan.main.md` **Engine lifecycle** block — scoped verb sequence, delivery-tail evidence order, and the no-integration-anchors conditional |

## When to apply

| Plan source | Applies |
|-------------|---------|
| PM/architect Prepare | Full bar before `plan(locked)` |
| SDD task-brief (extracted from plan) | Inherits from plan; `mstar sdd task-brief` carries excerpts forward |
| Audit-generated plan (`mstar-audit`) | Full bar — audit plans are the most context-isolated |
| Hotfix (`inline`) | Relaxed — see `mstar-phase-gates` hotfix exception |

## Attribution

The self-containment, verification-gate, STOP-condition, and drift-check concepts are adapted from the [improve](https://github.com/shadcn/improve) skill (MIT, © shadcn), integrated into Morning Star's plan-artifact conventions.
