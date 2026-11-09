---
module: harness bootstrap fence (engine path predicate + CLI scaffold/doctor adapters + canonical snippet)
date: 2026-09-23
problem_type: convention
category: conventions
severity: high
plan_id: "<plan-id>"
applies_when:
  - "Changing harness bootstrap, doctor or a .gitignore fence in any install adapter"
  - "Deciding whether the harness may rewrite a user-authored ignore file"
  - "Adding a new doctor consumer or scaffolding a fresh harness root"
tags:
  - gitignore
  - byte-preservation
  - authored-file
  - scaffold
  - doctor
  - shared-predicate
---

# A declared harness ignore file is author-owned: preserve bytes, never normalize

## Context

The harness ships a canonical `.gitignore` snippet and used to enforce it by comparing the target file's entry set with the canonical set, then appending, de-duplicating and re-ordering what was missing. That treatment is wrong for any repository that has already declared its ignore policy: it rewrites user-authored bytes (dropping comments, reordering rules, expanding intentional partial declarations) inside an operation the user reads as "install/doctor". The contract now is binary — a file that **declares** the harness root is author-owned and is never written; a file that declares nothing is bootstrapped with the canonical snippet.

## Guidance

- **One shared mechanical predicate, exported once.** `hasHarnessRootDeclaration(content: string): boolean` lives in the engine and is consumed by the validator, the harness fence, the scaffold and every doctor adapter. Callers do not re-derive it: the same question answered in five places is five chances to diverge.
- **Recognition is mechanical, not semantic.** Read the lines without modifying the input; trim only for recognition; ignore blank and comment lines; match `^!?/?\.(?:mstar|agents)(?:\/|$)`. Do **not** interpret escaping, glob semantics, effective ignore precedence or configured custom roots. Both root spellings and negations count, regardless of which layout was detected; `.mstarc` alone is not a declaration.
- **A partial declaration intentionally suppresses completion.** The guarantee is byte preservation, not canonical completeness. A file that declares the harness root partially is still author-owned, and the harness writes nothing — including no "helpful" missing entries.
- **Keep the refusal codes distinct.** Declared → `gitignore.author-declared`; file absent → `gitignore.missing`; undeclared but present → the existing missing-entry diagnostic, which still drives the bootstrap.
- **Bootstrap only what is undeclared.** An undeclared file keeps the existing canonical entries/comments and append behavior; a missing file keeps its existing creation behavior; a custom harness layout keeps its existing skip behavior. The `harness.scaffold` definition (`packages/commands/src/families/local.ts`, `getLocalCommandDefinitions`) checks the predicate inside the existing default-layout fence, records the skip, and writes no bytes.
- **Keep the generic appender generic.** The plugin-entry appender serves unrelated installation rules; the harness no-op belongs in the harness-specific fence, never inside the generic function, or plugin installs lose their own rules.
- **Retire the normalization machinery.** Once the predicate exists, the canonical-entry comparison and its coercion path are unreachable for declared files; delete the algorithm and the tests whose only contract is that algorithm instead of leaving a second door. Tests should assert byte preservation across CRLF, comments, rule order, duplicates, partial and negated declarations and a missing final newline — not success wording.
- **Every consumer moves together.** The doctor and install adapters that computed missing entries are call sites of the same rule, not independent implementations; a new adapter joins the shared predicate in the same stroke.

## Why This Matters

The fence runs on install, scaffold and doctor paths across many repositories, so an over-eager normalizer rewrites files the user owns everywhere, and the diff reads as a helpful cleanup — the failure has no error, no refusal, and no test that notices, because the rewritten file still contains the rules the harness wanted. Byte preservation is also the only guarantee that is safe to apply unattended: it is decidable from the file alone, with no need to understand ignore semantics.

## When to Apply

- Any change to harness bootstrap (`harness scaffold` / `scaffoldHarness`), the gitignore validator, or an install/doctor adapter.
- Adding a new host adapter or doctor consumer that might touch `.gitignore`.
- Reviewing a proposal to normalize, de-duplicate, re-order or "complete" a user-authored file the harness touches.
- Designing a similar agent-owned-file contract: prefer a mechanical declaration predicate plus byte preservation over set comparison plus repair.

## Examples

### Before

Install computes the canonical entry set, appends every missing entry and re-sorts the file — a repository that deliberately declares a partial policy (or writes its rules in a different order, with comments and negation) has its authored bytes rewritten, and the harness reports success.

### After

`hasHarnessRootDeclaration` matches a root line, a leading-slash form or a negation → the validator reports `gitignore.author-declared` and every fence returns without writing; a file with no declaration at all still receives the canonical snippet; a custom-layout scaffold still skips; the generic plugin appender is untouched.

## Source

Iteration `iter-<plan-id>`, plan `<plan-id>` (#248), from the issues-amendment contract's ignore-policy decision (`specs/issues-amendment-contract.md` §2) and its implementation in `packages/engine/src/path.ts` / `packages/engine/src/index.ts`, `packages/cli/src/index.ts` and the `packages/cli/src/adapters/*` doctor consumers. Evidence: the plan QC consolidated report, the retained scoped `verification.md` records and the L4 QA report under `{SDD_DIR}/review/` for that plan (source acceptance; the persisted-findings gate stayed open behind the missing control store, which is a separate operational matter). Related: `workflow-patterns/gitignored-harness-iteration-driving.md` (archived under `{HARNESS_DIR}/archived/knowledge/workflow-patterns/`) (how the harness directory's ignore policy interacts with iteration driving), `tooling-decisions/worktree-cleanup-ignored-artifact-gate.md` (archived).
