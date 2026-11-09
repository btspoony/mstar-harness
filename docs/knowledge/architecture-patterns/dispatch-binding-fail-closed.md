---
module: dispatch (engine + host adapters: opencode, dsh)
date: 2026-08-21
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: high
applies_when:
  - "a gate's input is host-provided and may be omitted (role binding, subagent type, tool context)"
  - "adding a host adapter that must propagate the calling agent identity to the engine dispatch gate"
  - "auditing a gate for silent fail-open on missing introspection data"
tags: [anti-recursion, dispatch-gate, fail-closed, host-binding, security]
---

# Dispatch binding must fail closed, never skip

## Context

The anti-recursion red line (`mstar-dispatch-gates` § 承接方反递归红线) forbids a leaf executor from re-invoking its own role. The engine enforces it via `composeDispatchGate` → `antiRecursionPrecheck(subagentType, executeAs)`, which compares the **host-reported calling role** against the Assignment's `Execute as`.

Hosts report a binding through different fields, and the CURRENT contract distinguishes two kinds (issue #156): a **caller** binding names the DISPATCHING agent (`composeDispatchGate`'s `caller` + `callerRequired`), while a **spawn-target** field names the role being spawned (omp `args.subagent`, OpenCode `args.subagent`/`args.subagent_type`). Only dsh carries a caller binding (`Config.dispatchBinding`, `callerRequired: true`, derived by `dispatchCallerOf`); the target-only hosts skip the leg because target == `Execute as` is the compliant pattern, so comparing it would self-flag every correct dispatch. Any binding can be **absent**. HEAD (before `684266a`) treated an empty binding as "no self-recursion" and, worse, `composeDispatchGate` had an `if (agent !== "")` skip so the precheck never ran on an empty/omitted binding. Result: a dispatch with no role binding silently passed the anti-recursion gate — fail **open**.

## Guidance

**An empty/omitted host binding means "the host cannot introspect the calling agent" — there is no defensible pass default. Fail closed: emit a critical violation, never skip the precheck.**

Three coordinated rules:

1. **The precheck is the single decision point.** `antiRecursionPrecheck(binding, executeAs)` trims and lowercases both sides: empty/whitespace binding → critical `dispatch.anti-recursion.empty-binding`; equal to `Execute as` → `dispatch.anti-recursion.self-type`; otherwise ok. Keep the flat `(subagentType: string, executeAs: string) => GateResult` shape — no object API.
2. **The composer runs the precheck whenever a caller could exist, and fails closed when the host contract says it must.** `composeDispatchGate` gates the leg on `caller.trim() !== "" || opts.callerRequired === true`, so a *declared* caller binding that arrives empty is `empty-binding` rather than a clean pass. What must never come back is the old `if (agent !== "")` shape where an empty-but-declared binding silently skipped the leg.

```ts
// Before (fail open)
if (opts.agent !== "") {
  violations.push(...antiRecursionPrecheck(opts.agent, executeAs));
}
// empty/omitted agent → precheck skipped → clean pass

// After (fail closed on a declared-but-empty binding)
const caller = opts.caller ?? "";
if (caller.trim() !== "" || opts.callerRequired === true) {
  violations.push(...antiRecursionPrecheck(caller, parseAssignmentFields(text).executeAs ?? "").violations);
}
// callerRequired (dsh) + empty caller → critical dispatch.anti-recursion.empty-binding
```

3. **A target-only host is not a fail-open hole — it is a scoped absence of the leg.** omp/OpenCode/cursor report the spawn TARGET, which cannot soundly prove non-recursion; the red line there stays prompt-level. Do not "fix" this by feeding the target field into `caller`: that self-flags every compliant dispatch (issue #156).

A **set** binding + **empty `Execute as`** stays `ok` on the anti-recursion leg — missing Execute-as is a field-presence problem (`validateAssignmentFields`), not a host-introspection failure.

## Why This Matters

Fail-open on a safety gate is silent: operators see a clean pass while the documented NEVER red line is bypassed. The `if (agent !== "")` skip *looks* like a harmless optimization (avoid comparing an empty string) but is exactly the fail-open hole. Every host adapter that HAS a caller binding must propagate it into the *same* compose path so the engine — not the adapter — decides; a target-only adapter omits `caller` rather than inventing one.

Consequence that is **intended, not a bug**: a dsh session the gate cannot classify as root reports an empty caller and emits `dispatch.anti-recursion.empty-binding` (advisory in warn mode, deny under hard) on every Assignment-shaped dispatch. That is the contract working — a leaf must not dispatch, and no configuration lifts it. A ROOT session without an explicit `dispatchBinding` is not left empty: `dispatchCallerOf` falls back to the coordinator identity (`ROOT_SESSION_DISPATCH_BINDING`), because a root session in this harness IS the coordinating agent.

## When to Apply

- A gate's decision input is **host-provided** and may be absent or empty.
- The "safe" reading of an absent input is ambiguous (cannot prove the invariant) rather than definitively "not applicable".
- Adding a host adapter: route the CALLER binding through `composeDispatchGate` / `antiRecursionPrecheck` and set `callerRequired`, never a local reimplementation with its own skip logic. A host whose only field is the spawn target omits `caller` deliberately (issue #156).

## Examples

### Engine (`packages/engine/src/dispatch.ts`)

```ts
export function antiRecursionPrecheck(subagentType: string, executeAs: string): GateResult {
  const binding = subagentType.trim().toLowerCase();
  const role = executeAs.trim().toLowerCase();
  if (binding === "") {
    return { ok: false, violations: [violation(
      "critical",
      "dispatch.anti-recursion.empty-binding",
      `empty caller role binding \u2014 the host cannot report which agent is calling, so anti-recursion cannot be proven (a dispatch could silently recurse)`,
      "declare the dispatching agent's own role binding (dsh Config `dispatchBinding`) before dispatching",
    )] };
  }
  if (binding === role) {
    return { ok: false, violations: [violation("critical", "dispatch.anti-recursion.self-type", /* ... */)] };
  }
  return { ok: true, violations: [] };
}
```

### dsh (`packages/dsh/src/gates/dispatch.ts`)

```ts
// dispatchCallerOf: a CHILD (or unreadable) session → '' whatever the config says,
// so the engine's empty-binding fails closed; a ROOT session → explicit
// config.dispatchBinding, else the coordinator identity.
...composeDispatchGate(header, { caller: dispatchCallerOf(config, callerAgent), callerRequired: true, writable }).violations
```

### OpenCode (`packages/opencode/src/mstar.ts`)

No caller leg: `validateDispatchAssignment` (`packages/opencode/src/mstar.ts:1062`) composes the gate without a `caller`, because `args.subagent`/`args.subagent_type` name the spawn TARGET, not the dispatching agent. The field/branch gates and `applyEnforcement` still apply.

## Related

- `architecture-patterns/dsh-workflow-gate-implementation.md` — per-edge fail-open/fail-closed discipline on dsh workflow gates (same theme, different surface: workflow-gate edges vs dispatch anti-recursion binding).
