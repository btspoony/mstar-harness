---
module: packages/dsh
date: 2026-10-19
last_updated: 2026-10-19
severity: high
track: bug
root_cause: "cordis scoped dispatch shifts the scopeTarget carrier into the bound thisArg and invokes listeners single-argument, so a parent passed to the emitter never reaches the callback parameter list"
resolution_type: code_fix
problem_type: logic_error
category: logic-errors
symptoms:
  - "the handler's second parameter is undefined at runtime while tests pass"
  - "a feature gated on the emitting agent never fires in production"
tags:
  - cordis
  - scoped-dispatch
  - thisarg
  - event-emission
  - subagent-end
  - test-fidelity
related_components:
  - packages/dsh/src/gates/agent-flow.ts
  - "@deepseek-ai/cordis (dispatch)"
  - "@deepseek-ai/dsh-subagent (createLifecycleEmitter)"
  - "@deepseek-ai/dsh-scope (scopeTarget carrier)"
applies_when:
  - listening to a dsh event that an upstream emitter dispatches with scopeTarget
  - writing tests for a cordis-scoped event listener
  - debugging "the handler's extra argument is always undefined"
plan_id: "<plan-id>"
---

# cordis scoped dispatch: the scope target is `this`, never a callback argument

## Problem

The team-settle listener for `subagent/end` was written as `function (info, parent)` — assuming the
upstream emitter passes the child's direct parent as a second argument. In the installed runtime it
never arrives: `parent` was always `undefined`, a roster gate keyed on it always failed, and an
entire end-buffer feature shipped as dead code while its suite stayed green.

## Symptoms

- The handler's second parameter is `undefined` at runtime, but the same event works in tests.
- A feature gated on "which agent emitted/scope-targets this event" never fires in production.
- Tests pass with a helper that calls `ctx.emit(event, payload, parent)` — the STANDARD cordis
  forwarding, which is exactly the shape the real emitter does NOT use.

## What Didn't Work

- Reading the emitter's call site only: `createActivationObserver.settle` really does pass the
  parent to the emitter — the loss happens one layer down.
- Trusting the local `emit` helper: standard `ctx.emit(event, ...args)` forwards every argument to
  the callback, which is not how the upstream lifecycle emitter dispatches.

## Solution

`@deepseek-ai/dsh-subagent`'s `createLifecycleEmitter` converts the parent into a
`scopeTarget(this, parent)` carrier placed at `dispatchArgs[0]`; cordis `dispatch` then **shifts**
that carrier as the `thisArg`, binds the listeners to it, and invokes each callback with the
remaining arguments only — `(info)`. The parent travels as the **receiver**, not as a parameter:

- Resolve the parent from `this` through the carrier registry (`carrierKeyOf(this)` via the
  `@deepseek-ai/dsh-scope` module-level WeakMap — the same live agent object the roster reads).
- Keep a forwarded second argument as a guarded fast path so a future upstream change cannot break
  the handler; degrade conservatively when the receiver is not a carrier.
- Import the carrier registry from the `dsh-scope` package and keep it a **build external**:
  inlining it forks the WeakMap singleton, and the tests (one module instance) and production
  (another) silently disagree — a second "tests green, production dead".

## Why This Works

The lossy hop is cordis's `args.shift()` of the scope target before `hook.callback.bind(thisArg)`.
Binding means the receiver IS the delivered context; nothing else survives into the argument list.

## Prevention

- Test helpers must drive the REAL dispatch shape: construct the `[carrier, eventName, info]`
  argument list and invoke listeners single-argument, bound to the carrier — not `ctx.emit`.
- Add a revert-detection assertion: temporarily reading the parent from the second argument must
  turn the suite red (it did: 18 pass / 6 fail → restored 24 pass / 0 fail).
- When an upstream emitter's shape is the contract, verify it against the INSTALLED dist (the
  emitter, cordis `dispatch`, and the carrier registry), not against the calling code's intention.
