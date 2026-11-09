---
module: dsh-plugin-ecosystem
date: 2026-08-14
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-11-09
severity: high
tags:
  - dsh
  - plugin-dependency
  - pnpm
  - bundle-activation
  - loader-probe
related_components:
  - packages/dsh
  - dsh-llm-fallbacks
  - dsh-advisor
  - deepseek-harness apps/cli
applies_when:
  - a dsh plugin needs to consume another ecosystem plugin library API
  - deciding whether installing package A auto-activates plugin B
  - probing whether another plugin is mounted at runtime
  - designing single-command multi-plugin installs
---

## Context

dsh (DeepSeek Harness) plugins are plain npm packages; "a plugin depends on another plugin" has no dedicated field — but **installing** a dependency and **activating** it as a profile bundle layer are two different mechanisms with different visibility rules. Falsified approaches cost real debugging time (a boot-crashing composition and a silently-inert `link:` dep were both discovered empirically). Complements `conventions/dsh-plugin-authoring.md` (single-plugin shape); this doc covers the composition layer.

## Guidance

**1. Dependency ≠ activation.** `dsh plugin --profile <p> add <pkg>` forwards to pnpm, then reconciles `dsh.profile.bundles` against **direct profile dependencies only** (`apps/cli/src/plugin.ts` `reconcilePlugins` — that file is in the dsh-private `apps/cli` tree, not this repo: no vendored copy or local probe replaces it; iterates `Object.keys(manifest.dependencies)`; a dep whose package declares `dsh.bundle.patch` joins the layer list, appended in dependency order). A **transitive** dependency — even a bundle-declaring plugin — is never reconciled and never activates.

**2. Transitive-install reality (pnpm 11, `nodeLinker: hoisted`, profile layout).**

| Spec inside the depended-on package | Lands in profile `node_modules` | Activates |
|---|---|---|
| `link:` sibling (and ALL deps of a `link:` package) | **No — silently nothing** | No |
| Registry range, pulled transitively | **Yes — hoisted top-level** | **No** |

⇒ Declaring `"dsh-llm-fallbacks": "^x.y.z"` in `packages/dsh` `dependencies` gives **library availability** (runtime import resolves via the hoisted install) but the user still runs a second `dsh plugin add dsh-llm-fallbacks` for activation. `link:` specs inside a depended-on package are inert for profile installs AND publish-hostile — never ship one.

**3. NEVER fold another plugin's row into your `cordis.patch.yml`.** Layer composition concatenates patch lists without dedup; `insert` is an unconditional push (`vendor/include/src/index.ts` `applyEntryPatches` — no insert-if-absent exists). With the folded plugin also installed independently:

- Same entry `id` → `EntryGroup.update()` throws `duplicate loader entry id` → **whole dsh session fails to boot** (recovery only via `dsh plugin remove`, which skips the loader tree). `applyEntryPatches` lives in dsh-private `vendor/include/src/index.ts` — outside this repo, so the rule is stated from observed behaviour, not from a local file to re-read.
- Different `id`, same package `name` → the plugin module's `apply()` runs twice (separate fibers/contexts): duplicated listeners, per-context state split (WeakMap-keyed stores become independent state machines), doubled events; user-layer id-targeted config overrides hit whichever row indexed first.

Single-command multi-activation is an upstream feature gap (reconcile dedup or insert-if-absent semantics) — record as an upstream suggestion; do not patch around it locally.

**4. Probe "is that plugin mounted" via the loader, not resolvability.** Once you depend on the package, `import.meta.resolve` is always true — meaningless. The meaningful signal is the loader entry (the pattern of dsh's own plugin-inventory):

```ts
function pluginMounted(ctx: Context, moduleName: string): boolean {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name !== moduleName) continue // match module specifier, NOT id (id is patch-row-local)
    if (entry.options.group) continue                // skip structural group rows
    if (entry.disabled) return false                 // effective disable (cascades parent groups)
    return entry.fiber !== undefined                 // live root fiber
  }
  return false
}
```

- Match by `entry.options.name` (the specifier the loader imports); `id` is user-overridable.
- Probe at **decision points** (tool calls, fs intents), never at plugin `apply()` — the loader mounts entries concurrently and your row may run before the probe target's fiber settles. Point-in-time reads, no cache (plugin-inventory philosophy: "Loader remains the sole lifecycle authority").
- Declare `inject: ['loader']` so the service is guaranteed before apply.
- Anti-pattern: reading another plugin's module-level internals (WeakMap stores etc.) across plugins — same-module-instance resolution via hoisting is an accident, not a contract. Cross-plugin runtime state belongs in a named cordis service.

**5. CLI operand semantics** (thin pnpm forwarder): `add <path>` anchors relative specs to the invoking cwd; `remove` matches by **installed package name** only (never a path); a bare name without a verb is a usage error; re-adding a listed dep is a no-op.

## Why This Matters

The two failure modes are both silent-until-late: an inert `link:` dep surfaces as a runtime import failure in a foreign profile, and a folded row surfaces as a boot crash for exactly the users who already installed the other plugin. The reconcile-only-direct-deps rule means every "install one get both" shortcut is either inert or dangerous; the only clean contract today is documented multi-command install.

## When to Apply

- Adding any ecosystem-plugin dependency to a dsh plugin package (use a registry range; mark the build `--external`; document the second `add` command).
- Evaluating any "auto-activate my dependency" design (start from §1/§3 — the answer is "not possible safely today").
- Adding runtime capability detection (§4 probe shape).
