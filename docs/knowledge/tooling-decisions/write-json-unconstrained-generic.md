---
module: packages/engine/src/core.ts
date: 2026-08-22
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: medium
applies_when:
  - "Typing an engine persistence boundary whose doc types lack an index signature"
  - "Removing `as unknown as Record<string, unknown>` casts at writeJson call sites"
plan_id: 20260822-engine-cleanup
tags:
  - writeJson
  - generics
  - persistence-boundary
  - type-casts
  - engine
---

# Unconstrained `writeJson<T>` removes persist casts without a Record bound

## Context

Engine core persisted docs through `writeJson(filePath, value: Record<string, unknown>)`, forcing every call site with a typed doc (`StatusV2Doc`, `WorkflowSnapshot`, register `data`) to cast `as unknown as Record<string, unknown>` — 6 sites across `status.ts` (2), `migrate.ts` (2), `workflow.ts` (1), `audit.ts` (1). Each cast bypassed the static type check at the persistence boundary; a future doc-shape change that dropped a field would be silently accepted.

The audit-2026-08-21 f4 finding listed the cast sites but the residual scope predated `promoteAuditPlans` — the true count was **6**, including `audit.ts:649` (architect confirmed; the register was not rewritten, closure evidence was the four-file grep).

## Guidance

```ts
// packages/engine/src/core.ts — unconstrained generic
export function writeJson<T>(filePath: string, value: T): void {
  // body unchanged: JSON.stringify + atomic temp+rename
}

// call sites pass typed docs directly, no cast
writeJson(statusPath, doc as StatusV2Doc);      // registerWorkflowEntryLocked
writeJson(filePath, plan.register.data);        // ProjectRegisterDoc
writeJson(statusPath, plan.rootV2.data);        // StatusV2Doc
writeJson(snapshotPath, snapshot);              // WorkflowSnapshot
```

Do **not** write `T extends Record<string, unknown>` — `StatusV2Doc` / `WorkflowSnapshot` have no index signature, so a `Record` bound would force the casts right back. The constraint is unnecessary: the write path only needs `JSON.stringify`-able values.

## Why This Matters

- **Compiler-enforced**: a field dropped from a doc type is now a type error at the call site instead of silent `Record` acceptance.
- **Backward compatible**: existing call sites passing object literals infer cleanly; `EMPTY_STATUS_TEMPLATE` (`Record<string, unknown>`) still compiles without a cast.
- **Narrow scope**: `validate*` input surfaces intentionally keep `Record<string, unknown>` (they accept the untyped shape from hooks); the fix is only the write boundary. Don't refactor beyond it.

## When to Apply

- Adding a new persistence call in engine modules.
- Cleaning up any remaining `as unknown as Record<string, unknown>` casts.

## Verification

- `grep -rn "writeJson(.*as unknown as Record<string, unknown>" packages/engine/src` → zero matches: every call site passes its typed doc directly (`execution-recovery.ts:2122`, `store-activation.ts:1764`, `store.ts:242`). The pattern still appears elsewhere in the engine for `assertExactKeys`/`isPlainObject` inputs, which this decision deliberately leaves alone.
- Engine suite `841 pass / 0 fail`; `bun run typecheck` clean; drift-lint OK.

## Examples

### Before

```ts
writeJson(statusPath, doc as unknown as Record<string, unknown>);
```

### After

```ts
writeJson(statusPath, doc); // doc: StatusV2Doc
```
