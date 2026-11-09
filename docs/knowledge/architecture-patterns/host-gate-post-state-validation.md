---
module: packages/opencode + packages/dsh gates
date: 2026-08-22
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
applies_when:
  - "Adding or fixing a host-plugin gate (tool.execute.before / status-gate / cache) that validates coordination documents"
  - "Designing repair-vs-degraded observability for enforcement gates"
  - "Deciding what a pre-tool hook may read vs what it can compute from tool args"
plan_id: 20260822-gate-fixes
tags:
  - host-gate
  - opencode
  - dsh
  - post-patch-validation
  - repair-escape
  - degraded-advisory
---

# Host gate validation targets the post-state, not the pre-state

## Context

Morning Star runs engine-backed gates on multiple hosts. Three audit-2026-08-21 findings (f8/f9/f12) were one design pattern in three surfaces: a gate validated the **pre-state** of the artifact it guards, so a single operation that corrupted a coordination doc (or a cache that outlived the file) escaped detection until later, or a repair-escape was indistinguishable from a degraded failure.

- **f8** (`packages/opencode/src/mstar.ts`): the `tool.execute.before` `edit` branch validated the on-disk `status.json` **before** the edit applied — an edit that turned a valid doc invalid was only caught by the next write.
- **f9** (`packages/dsh/src/gates/status.ts`): the hard-mode repair-escape allowed writes to an already-invalid doc (legal — veto would deadlock the repair), but the error-envelope degraded advisory hardcoded `hard: false` — a hard-deployment dead control was indistinguishable from a warn-only pass.
- **f12** (`packages/dsh/src/gates/workflow-selection.ts`): `terminalStatusCache` evicted only on cap overflow, never on file deletion — a deleted workflow kept a stale terminal entry.

## Guidance

1. **Validate the post-state you can synthesize, fall back honestly.** For `edit` tools with a literal `{ oldString, newString, replaceAll?: boolean }` contract (one pair per call, not a replacements array, not regex), synthesize the patched text (`text.split(oldString).join(newString)` with `hits === 1 || replaceAll === true`), `JSON.parse`, and validate the **result** via the same engine validator with `{ doc }`. When the edit shape isn't composable (fuzzy-only literal, empty `oldString`, missing `newString`, non-boolean `replaceAll`, read failure), fall back to pre-edit validation and say so in a comment — a naive `String.replace` diverges from the host's fuzzy `replace()` and would silently validate the wrong thing.
   - **Classify before you read**: call `harnessDocKindOfTarget(filePath)` (cheap, loader cached) **before** reading/synthesizing. Non-coordination targets (the overwhelming majority of edits: source, configs, docs) skip the read+parse entirely.
   - **Unparseable patched text is a non-object doc, not a raw string.** Passing the raw string to an engine validator whose overloads accept `string` as a *path* misreports `status.migration-required` for a broken `status.json`. Pass an explicit non-object marker (e.g. `null`) so the validator reports `invalid-doc`/`invalid-json` — the gate still fires, never silent.
2. **Repair escapes and degraded errors must be observably distinct.** A content-blind status gate has three states: hard+valid → silent pass; hard+invalid → allow-as-repair (`repair: true`, loud log) — vetoing would deadlock the very write that repairs the doc; error-envelope throw → allow + `degraded: true`. The degraded advisory must carry the **resolved** enforcement flag (`hard = resolveHard(...)` recomputed inside an inner try/catch — a throwing resolver must not re-enter the envelope) so a hard deployment can distinguish "control is down" from "warn-only". Never conflate `repair` with `degraded`.
3. **Caches must evict on the artifact's disappearance, not just on cap.** Keep stat-first + mtime-compare semantics; on stat failure, on `existsSync` short-circuit, and on a post-walk prune delete the key. Inverting to "cache-hit-then-exists-first" adds a stat per read and changes the fast path; eviction only needs to run where the caller already knows the file went away.

## Why This Matters

Gates are only as strong as the state they validate. A pre-state gate turns "the edit corrupts the doc" into a deferred catch at the next write; an opaque degraded path hides a dead hard gate in production; a stale terminal cache returns authority from a workflow that no longer exists. All three are silent failure surfaces a maintainer cannot debug from logs alone.

## When to Apply

- Extending `tool.execute.before` / status hooks in opencode, dsh, or a future host plugin.
- Designing repair/degraded envelopes for any hard-mode gate.
- Caching file-derived state (mtime, terminal status) with a capacity bound.

## Examples

### f8: post-patch synthesis (opencode)

```ts
// edit branch: classify first (cached loader), skip non-coordination targets
const dirResolvers = await cachedDirResolvers();
if (harnessDocKindOfTarget(filePath) === null) return;
// only now read + synthesize (literal, hits===1 or replaceAll)
const patched = text.split(oldString).join(newString);
let patchedDoc: unknown;
try { patchedDoc = JSON.parse(patched); } catch { patchedDoc = null; } // non-object → invalid-doc, never string-as-path
const gate = await validateStatusWrite(filePath, { doc: patchedDoc });
```

- Before: `validateStatusWrite(filePath)` (pre-edit disk state only); raw string fallthrough misreported `status.migration-required`.
- After: post-patch validation; `null` marker → `status.invalid-doc` on all kinds; regression asserts invalid-doc + hardBlocked, no migration-required.

## Verification

- Regressions: `packages/opencode/test/status-write-hook.test.ts` (ACTIVE-only authority) and `packages/opencode/test/store-cutover.test.ts` (the `edit` branch synthesizes the patched doc from a literal `oldString`/`newString` pair and refuses a retired-target edit); the dsh three-state matrix lives in `packages/dsh/tests/misc-seams.spec.ts` (hard + broken on-disk → allow with `hard: true, repair: true`; valid doc has no `repair`), `packages/dsh/tests/dispatch-gate.spec.ts` (internal failure → `degraded: true`), and `packages/dsh/tests/store-cutover.spec.ts` (authority-class refusal gets neither `repair` nor `degraded`). `packages/dsh/tests/workflow-selection.spec.ts` covers only the retired file-route selection branches; the cache-eviction half (`_terminalStatusCacheHas`, `workflow-selection.ts`) currently has no test caller.
- All three landed in `iter-20260822-residual-cleanup` plan `20260822-gate-fixes` (commits 11156ef, dbbca8b, 9cae4c7, 04ccd84), QC Approve 3/3, QA Pass.
