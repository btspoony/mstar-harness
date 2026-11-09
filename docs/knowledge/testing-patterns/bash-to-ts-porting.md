---
module: engine-script-ports
date: 2026-08-08
problem_type: testing_pattern
category: testing-patterns
severity: high
plan_id: 20260808-slice2-sdd-iteration
applies_when:
  - porting bash scripts to a typed language (TS) while keeping output identical
  - retiring legacy shell tooling after a port
  - replacing a shell "oracle" with frozen golden fixtures
tags: [bash-port, byte-parity, golden-fixture, jq, awk, intentional-divergence, fail-closed]
---

# Bash-to-TS porting: byte parity before deletion, golden fixtures after

## Context

The v2.0.0 iteration ported four bash scripts (`sdd-workspace`, `task-brief`, `review-package`, `tech-debt-rollup.sh`) into `@mstar-harness/engine` TypeScript modules. The contract was **byte parity**: the TS output had to match the bash output exactly on the same inputs. The scripts were deleted only in the closing slice, after parity was proven and the TS surface became the documented default. Two classes of traps dominated the work: **shell semantics that look obvious but aren't** (jq, awk), and **ordering decisions** (fail-closed before override; parity before deletion).

## Guidance

### 1. Mirror the actual bash semantics, not the apparent intent

Read the shell source line by line and port the *behavior*, including the quirks. Verified traps from the port:

- **jq `//` (alternative operator) treats `false` as falsy.** `lifecycle // "open"` defaults `undefined`, `null`, AND `false` to `"open"`; `0` stays `0` (truthy in jq). A TS port using `??` diverges on `false` and `0`.
- **jq object `+` merge: the right operand wins per key.** `$canon + $legacy` keeps the legacy value for conflicting plan keys. Port the precedence exactly.
- **jq `-c` output is key-order-sensitive.** Bash `compare_field` string-compares `jq -c` output, so a stored summary with scrambled key order DRIFTS even when deep-equal. A TS port that compares structurally will silently pass what bash flagged.
- **awk fence toggling.** Heading extraction (e.g. `## Task N` briefs) must toggle an `in-fence` state on lines starting with ``` — fenced headings inside code blocks are *not* headings, and number boundaries (Task 2 ≠ Task 10 prefix) need explicit guards.

### 2. Byte-parity tests BEFORE deletion

While the bash script still exists, run both implementations on the same fixture and byte-diff the output (or diff against captured bash output). Parity is the deletion precondition — "looks equivalent" is not evidence.

### 3. Golden fixtures AFTER deletion

Once the bash oracle is gone, freeze its output as golden fixtures checked into the test tree (e.g. `task-1-brief.golden.md`, `rollup.*.golden.txt`), with a comment attesting provenance ("captured from the former bash oracle, byte-proven in slice 2"). Cover edge cases as separate goldens: multi-plan, conflict, drift, zero-results, false-lifecycle. A reviewer should be able to re-derive the golden from the deleted script's state machine — keep the fixture small and the provenance chain explicit (slice/commit reference), or the goldens become unverifiable artifacts.

### 4. Intentional divergences must be pinned, not silent

The port is allowed to *harden* behavior, but only when the divergence is deliberate and documented. Example from the port: the bash `sdd-workspace` probed `status.json` first, so a linked feature worktree with a stray `.mstar/status.json` resolved and created a second SDD tree under the feature checkout. The TS port refuses that case (fail-closed) — a correct hardening, but a **divergence**. Pin it with a dedicated test ("stray status.json in a linked worktree") and a comment explaining the divergence and why bash's behavior was the hazard.

### 5. Fail-closed-first ordering

When a port introduces guards (worktree checks, override resolution), order them so the *safety* guard runs before any probe that could mis-resolve:

1. fail-closed guard first (linked worktree without a control root → refuse; nothing may bypass it),
2. explicit override next (env var / CLI arg),
3. only then the default probe.

A probe-first ordering re-introduces exactly the bug the guard exists to prevent.

### 6. Keep the bash fallback until the port is the documented default

Do not delete the scripts in the same slice as the port. Ship the TS port as an addition, prove parity across real usage, then remove bash in a later close slice with a zero-references grep (path-scoped so CLI verb names like `mstar sdd task-brief` are not false matches).

## Why This Matters

- Shell quirks are silent: `false` vs `null`, key order, fence state — each one produces output that *looks* right and fails only on the edge case. Byte parity is the only check that catches all of them at once.
- Deleting the oracle without goldens loses the ability to ever verify the port again; goldens without provenance can't be trusted by reviewers.
- Unpinned divergences become mysteries: a future maintainer "fixes" the divergence back to bash behavior and re-introduces the hazard.
- Fail-closed-first is what makes the port *safer* than the original in worktree setups — that property is the entire point of porting the script into the engine.

## When to Apply

- Any bash-to-TS (or bash-to-anything) port where output compatibility matters.
- Retiring shell tooling from a repo — especially when other docs/commands reference the scripts.
- Adding a hardened port that intentionally changes failure behavior (fail-closed, stricter validation) relative to the original.

## Examples

### Before

```ts
// Port of: lifecycle // "open"
const lifecycle = row.lifecycle ?? "open"; // WRONG: false stays false in jq
```

```ts
// Port of: echo "$plan" | jq -r '.residual_findings // empty'
// naive text scan treats a fenced "## Task 2:" as a heading
```

Both compile, both pass happy-path tests, both diverge on edge inputs.

### After

```ts
// Mirrors jq `//`: undefined, null AND false default to "open"; 0 stays 0.
function isOpenResidual(r: { lifecycle?: unknown }): boolean {
  const lc = r.lifecycle;
  return lc === undefined || lc === null || lc === false || lc === "open";
}
```

```ts
// awk fence-toggling parity: brief extraction ignores fenced headings and
// exact-number boundaries ("## Task 2" inside a fence, "Task 2" vs "Task 10").
if (line.startsWith("```")) inFence = !inFence;
if (!inFence && /^#{2,6} Task (\d+)/.test(line) && Number(m[1]) === target) { ... }
```

Plus: byte-parity test against bash while it lived; `task-1-brief.golden.md` + `rollup.*.golden.txt` after deletion; dedicated pinned tests for the intentional divergences (fail-closed on linked worktree, exit-2 usage contract); path-scoped zero-reference grep before the scripts were deleted.
