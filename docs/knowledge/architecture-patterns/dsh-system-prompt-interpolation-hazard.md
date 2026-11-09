---
module: dsh-plugin-ecosystem
date: 2026-08-14
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
tags:
  - dsh
  - system-prompt
  - interpolation
  - persona
  - decoration
related_components:
  - packages/dsh
  - deepseek-harness packages/core/system-prompt
applies_when:
  - registering any system-prompt section text that is operator-configured
  - embedding operator-controlled runtime values (paths, ids, prose) into prompt text
  - writing dsh plugins whose prompt sections may contain literal braces
last_updated: 2026-11-09
---

# dsh system-prompt section text: `{{variable}}` interpolation hazard

## Context

While integrating `dsh-llm-fallbacks`-driven role personas into `@mstar-harness/dsh` (plan <plan-id>, QC W-001), a strict renderer constraint surfaced: `ctx.systemPrompt.section({ text })` text is NOT plain text — dsh's prompt renderer applies **strict `{{variable}}` interpolation** at assembly. A section whose text contains a `{{` paired with a later `}}` throws at child prompt assembly, which would break EVERY role-matched dispatch that carries such a persona. The failure mode was found by QC (logic/security seat) reading the system-prompt package, not by tests.

## Guidance

- **Operator-configured prompt text is a hazard boundary.** Any plugin that injects operator-supplied strings into `systemPrompt.section`/`context` text must treat `{{...}}` as a reserved syntax. Validate or document the constraint at the config boundary, not at assembly time.
- **The config-load guard this hazard originally motivated no longer applies to personas.** dsh 0.2.1 moved role identity to agent-preset selection, so `Config.rolePersonas` is gone (and the additive `mstar:role-persona` section with it); persona text is now owned by a preset (`@deepseek-ai/dsh-persona`) and the plugin only chooses the preset id. What remains live is the SAME regex on the mirror-extraction path (`PERSONA_INTERPOLATION_HAZARD` in `_shared.ts`, warned + skipped in `agent-personas.ts` and `fallbacks-seeds.ts`) and, for any future operator-configurable prompt text, the config-load guard as described here — historically the mstar plugin validated `rolePersonas` values at plugin mount: a `{{` paired with a later `}}` rejects the whole Config with a role-key-naming error (vendored-schemastery fork: `z.transform` over the dict + custom `z.ValidationError` — the fork has no `.refine` and its transform callback receives no `options`; a per-value `.pattern` would emit a cryptic regexp error). Omission/empty/normal personas pass through (`.default(undefined)` short-circuits `Schema.resolve` on nullish input — the transform never runs on omitted config).
- **Dynamic fields need runtime screening, not config validation** (round 3, plan <plan-id> QC W-1). N-B1's `mstar:harness-rules` section and `mstar:engine-status` context embed values that cannot be config-rejected because they are *facts read at assembly time*: `harnessDir` paths, `status.json` plan ids, iteration ids, lease `holder`/`planId`, and compass direction prose. Any complete `{{...}}` group inside them throws `assemble()` for root AND every child. The pattern: a `stripInterpolationHazard(s)` helper (break complete groups, keep a lone `{{` verbatim — the renderer treats it as literal prose) applied to every embedded dynamic field before string interpolation, plus hostile-fixture tests (`{{x}}` in a plan id / direction renders; lone `{{` stays literal). Screen at the embedding site; never trust "operators won't type braces in a compass".

## Why This Matters

A plugin that ships persona/prompt injection without this guard is one operator config edit away from breaking every dispatch through that channel — a silent-latent, loud-at-runtime failure that QC caught only because the system-prompt package contract was read. The cost of the guard is one transform + one doc paragraph.

## When to Apply

- Adding any operator-configurable text to system-prompt sections/contexts.
- Any N-B1-style `ctx.systemPrompt` adoption: screen every embedded dynamic field through `stripInterpolationHazard`.
- Reviewing plugins that pass config strings into `ctx.systemPrompt.section()`/`context()`.
