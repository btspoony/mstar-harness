---
module: generated host bundles (ZCode write-gate hook) and cross-package engine resolution
date: 2026-09-23
problem_type: tooling_decision
category: tooling-decisions
severity: high
plan_id: "<plan-id>"
last_updated: 2026-11-13
applies_when:
  - "Regenerating a committed bundle that inlines another workspace package"
  - "Working in a git worktree whose node_modules resolves a sibling checkout"
  - "Reviewing a commit whose only content is a regenerated artifact"
tags:
  - generated-artifact
  - module-resolution
  - worktree
  - schema-generation
  - fail-closed
  - provenance
---

# A generator inlines the dependency it resolves, so pin the resolution to this checkout

## Context

The ZCode write-gate hook is a committed build product: `scripts/build-zcode-hooks.ts` bundles `hooks/src/mstar-write-gate.ts` **plus the engine glue resolved at generation time** into `hooks/mstar-write-gate.mjs` (733 KB at 4.3.0; ~190 KB when the incident was recorded). Nothing at runtime resolves `@mstar-harness/engine` — the engine generation is frozen into the artifact's bytes.

While regenerating the hook inside a feature worktree, that worktree's root `node_modules/@mstar-harness/engine` still pointed at the **primary checkout**, so the generator inlined the primary checkout's engine. That engine understood execution schema generations 1–4 while the store the acceptance fixture builds is written by the current engine at generation 5. The hook therefore refused with the engine's `store.schema-unsupported`, which the gate surfaced as an unreadable authority (`store.authority-unavailable`), and the acceptance case failed with an authority error instead of reaching the behaviour it was testing. The stale bundle's diff against the previously committed bundle was one comment line — it read as a benign path-format change.

The correction: point the worktree's engine dependency at **this** worktree's `packages/engine` and rebuild the generator.

## Guidance

- **Resolve the inlined dependency from the checkout that owns the artifact.** A worktree's `node_modules` must be materialised against that worktree's own packages before any generator runs. Freshness of the foreign checkout does not help — the build is current, it is simply the *wrong* build.
- **Read the bundle's origin comment as a provenance signal.** A bundled origin like `// ../../packages/engine/dist/engine.js` points outside the checkout (a symlinked or hoisted resolution); `// packages/engine/dist/engine.js` points inside it. The comment is generated, so it is cheaper to check than to reason about.
- **A recorded digest pair cannot prove generation provenance.** One digest for the source tree plus one for the generated file only proves each side still matches its own record; neither says the output was compiled from that source. Prove the artifact instead by building it in the same checkout and **executing** the built bundle: a rebuild plus the hooks behaviour tests show that the current source produces a working artifact, and `git diff` over a build output proves nothing extra — it reports the bundler version, not the source. Neither a digest pair nor a byte diff may be used as a freshness gate.
- **Keep the generator deterministic where you can.** A generator that embeds timestamps or absolute paths turns every regeneration into noise, which makes the real provenance question harder to answer.
- **Route the symptom correctly.** A generated hook refusing with an authority/unreadable-store error is not automatically a store defect: a cross-generation engine inlined into the hook fails closed with exactly that shape. Check the inlined generation before the store.
- **Never commit an artifact whose provenance you cannot name.** "Only generated files changed" is a reason to check *which* generator and *which* resolution produced them, not a reason to skip the check.

## Why This Matters

The failure is silent at authoring time and misleading at detection time: the committed bytes are wrong, the diff looks cosmetic, and the first symptom is a fail-closed refusal attributed to a component that is healthy. Because the artifact is committed rather than built on the consumer side, the wrong generation is durable — it survives into the branch and only surfaces where the store is written by the current engine. This is the durable-artifact counterpart of `tooling-decisions/worktree-dependency-dist-isolation.md`: there the consumer measured against a stale build inside one checkout; here the resolution *identity* is wrong, so no amount of rebuilding the local package fixes the artifact.

## When to Apply

- Regenerating any committed bundle that inlines a workspace package: the ZCode hook, host bundles, a CLI `dist` shipped as an artifact.
- Any worktree whose `node_modules/@mstar-harness/*` resolves through a symlink out of the checkout.
- Reviewing a "regenerated file only" commit: check the origin path in the bundle and the resolution that produced it.
- Adding or changing the CI step that guards such an artifact: build it and run the suites that execute it.

## Examples

### Before

Generate the hook in a worktree whose engine dependency points at the primary checkout → the bundle freezes an engine that only understands older schema generations → acceptance fails with `store.authority-unavailable`, and the committed artifact is stale against the current source.

### After

Materialise the worktree's own engine dependency, regenerate, and run the hooks behaviour tests against the built bundle — the executable artifact is the proof, not a byte comparison against the committed copy.

## Source

Iteration `iter-<plan-id>`, plan `<plan-id>` (R3/R17 packaging task). Evidence: the task report's wrong-engine root-cause round and the plan QC consolidated + L4 QA reports in `{SDD_DIR}/review/` for that plan, including the CI step that then guarded the artifact. Related: `tooling-decisions/worktree-dependency-dist-isolation.md`, `tooling-decisions/consumer-path-isolation-smoke.md`, `tooling-decisions/worktree-cleanup-ignored-artifact-gate.md` (archived).
