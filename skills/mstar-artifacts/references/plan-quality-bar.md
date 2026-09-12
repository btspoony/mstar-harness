# Plan Quality Bar

The standard every implementation plan must meet before it is locked and dispatched. Applies to `{PLAN_DIR}` main plans, SDD task-briefs derived from them, and audit-generated plans. Extends the Plan 质量门 in **`mstar-phase-gates`** and the `plan.main.md` template.

## Core principle: write for a zero-context executor

SDD implementers start with a fresh session — they have not seen the Prepare conversation, the spec, or other tasks. Audit plans may be executed sessions or days later by a different model. If a plan references "the pattern discussed above" or "as agreed in clarify", it is broken.

The plan is the spec. Everything the executor needs must be in the file or reachable from a file path it names.

## Quality checklist

Before a plan is locked, verify every item:

### 1. Self-contained context

- Every task names **exact file paths** (create / modify / test), not "the relevant module".
- **Current-state excerpts** — when a task modifies existing code, include the code as it exists today (short, with `file:line` markers), enough that the executor can confirm it is looking at the right thing.
- **Conventions to follow** — name the repo pattern (error handling, naming, layering) and point to one exemplar file: "Error handling follows the Result pattern — see `src/lib/result.ts` and its use in `src/users/api.ts:40-60`. Match it."
- **Interfaces** — consumed and produced signatures are listed verbatim, not paraphrased.

### 2. Verification gates

Each verification step names the changed behavior, exact scoped command and expected result, or reusable evidence with its applicability. Use only checks needed for this change; discovering a repository command does not make it a gate. Scope authority → `mstar-harness-core` § 定向执行与验证边界.

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

## Relationship to existing plan elements

| This quality bar | Existing mstar element |
|------------------|----------------------|
| Self-contained context | `plan.main.md` Global Constraints + per-task Files/Interfaces |
| Verification gates | `plan.main.md` per-step "Run: `cmd`" lines |
| Hard boundaries | `plan.main.md` per-task Files (Create/Modify) — extended with explicit Out-of-scope |
| STOP conditions | New — not previously formalized |
| Drift check | SDD `BASE_SHA` — generalized to all plans |
| Done criteria | `plan.main.md` per-step checkboxes — elevated to machine-checkable |

## When to apply

| Plan source | Applies |
|-------------|---------|
| PM/architect Prepare | Full bar before `plan(locked)` |
| SDD task-brief (extracted from plan) | Inherits from plan; `mstar sdd task-brief` carries excerpts forward |
| Audit-generated plan (`mstar-audit`) | Full bar — audit plans are the most context-isolated |
| Hotfix (`inline`) | Relaxed — see `mstar-phase-gates` hotfix exception |

## Attribution

The self-containment, verification-gate, STOP-condition, and drift-check concepts are adapted from the [improve](https://github.com/shadcn/improve) skill (MIT, © shadcn), integrated into Morning Star's plan-artifact conventions.
