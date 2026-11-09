---
module: packages/engine dist build (published bundle)
date: 2026-10-16
problem_type: architecture_pattern
category: architecture-patterns
severity: high
applies_when:
  - "A bundled dist must load where import.meta.url is undefined (workerd/edge, or a browser-platform bundler that strips import.meta)"
  - "Choosing the build guard for a published artifact whose failure mode is 'does not start', not 'returns wrong data'"
plan_id: 20261016-engine-esm-dist-interop
tags:
  - engine
  - bundler
  - cjs-interop
  - workerd
  - build-guard
  - dist
---

# A bundled dist for Node still has to start on non-Node runtimes (bun CJS interop)

## Problem

`@mstar-harness/engine@4.0.0`'s published `dist/engine.js` was built with `bun build src/index.ts --target node`. It contained the module-scope preamble

```js
var __require = /* @__PURE__ */ createRequire(import.meta.url);
```

plus `__commonJS(…)` wrappers whose bodies called `__require("tty")` / `__require("util")` **while the module graph initialized**. A Cloudflare Worker that imported the engine root barrel died during startup (`createRequire` received `undefined`), so every deploy of that consumer was blocked — not one code path, but the whole Worker. `3.11.2` was clean because it had no CommonJS node in its graph.

Two independent causes, either one sufficient:

1. **Any CommonJS package left in the bundle.** The engine's only CJS node was `debug@4.4.3`, reached transitively (`mdast-util-from-markdown` / `micromark-extension-gfm` → `micromark@4.0.2` → `debug`), arriving through micromark's `development` export condition. `--external debug` and `NODE_ENV=production` remove the wrappers but **still emit the preamble**; bun 1.4.0 ignores `--conditions`.
2. **A literal `import("node:sqlite")` in our own ESM source.** Bundling a literal dynamic import of a `node:` builtin emits the same banner. Four acquisition sites (`store-db.ts`, `store-activation.ts`, `execution-recovery.ts` ×2) were affected; ablation showed each conversion was load-bearing.

## Decision (pattern)

- Remove every CommonJS node from the graph instead of guarding the preamble: bun 1.4.0's `Bun.build` has **no `alias` option**, so an `onResolve` plugin redirects the CJS package to an engine-owned ESM stand-in (`packages/engine/scripts/build.ts` + `scripts/debug-esm.ts`). The stand-in is inert (`enabled: false`) and implements only the member surface its consumer touches — not a reimplementation of the dependency.
- Acquire Node-only drivers through a **function-scoped** `createRequire(import.meta.url)("node:sqlite")`, never a module-scope binding and never a literal dynamic import of the builtin. The lazy contract is observable: instrumenting `Module._load` during `import(dist/engine.js)` shows `node:sqlite` is not loaded at import.
- Guard the **property**, not the call shape: after writing each artifact, the build copies it with every `import.meta.url` forced to `undefined` and `import()`s it. A throw is a violation; a missing artifact or an unrunnable probe is a failure, never a skip. That is what a non-Node bundler does to `import.meta`, and `createRequire(undefined)` throws identically under Node and Bun.
- A text rule ("`createRequire(import.meta.url)` that is not immediately invoked") is **insufficient and measured false-positive**: bun hoists a module-scope binding into an indented `__esm(…)` init body (so a column-0 scan misses it), while a legitimate function-scoped bind-first form matches it. Property check, not regex.

## Where this bites again

- Any host/plugin bundle that must load where `import.meta.url` is undefined (workerd, some edge runtimes, `import.meta` stripped by a browser-platform bundler). Node-only bundles (the CLI, host plugins running under Node) do not fail at startup, but the same banner still means a builtin `require` at init.
- `wrangler deploy --dry-run` does **not** reproduce this class: it skips module evaluation. A dry run is not a gate for "does it start".
- Verification is artifact-level: counts plus the probe run inside the engine build, which CI executes (`bun run engine:build`) before the engine tests. Real Workers startup stays externally verified by the consumer's `wrangler dev`; a checkout without `workerd` cannot close that gap and must record it unverified rather than claiming it.

## Process lessons

- An issue report that fixes only the first throw can leave the same defect one frame later: the reporter's shim experiment moved the failure to the call site, and our own second site (`store-db.ts`) would have thrown next after a `debug`-only fix. Treat "no init-time require **at all**" as the target, and ablate each candidate change to see whether it is load-bearing.
- Measured candidate tables beat prose: `--external debug` / `NODE_ENV=production` looked like fixes and left the banner; a shared table (candidate × `__require(` × `__commonJS(` × init-time `createRequire`) settled it and is what a read-only QC seat could review without re-running anything.
