---
module: mstar-workflow/dsh
date: 2026-08-08
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: "20260808-dsh-package-core"
status: superseded
superseded_by: registry peer resolution (dsh 0.0.1-rc.5+, CHANGELOG.md `dsh plugin` entry); live peer contract now `packages/dsh/tests/peer-deps.spec.ts`
last_updated: 2026-11-09
tags:
  - link-farm
  - peer-stubs
  - bun
  - file-links
  - dsh
  - dev-time
---

# Dev-time link-farm strategy for external dsh consumers (dsh-advisor pattern)

> **SUPERSEDED (2026-08-20)** — this document records the peer-stubs → link-farm
> history only. Since `0.0.1-rc.5` the `@deepseek-ai/dsh-*` seams resolve from the
> public npm registry (bun auto-installs peers; no root `.npmrc`, no
> `peerDependenciesMeta.optional` workaround). `scripts/setup-dsh-links.ts` and the
> `dsh:link` / `dsh:link:check` scripts were removed; CI runs the dsh suite
> unconditionally (the source-tree availability gate is gone). The bun-specific
> runtime shims below (native-code normalization, post-execute delegation, client
> bundle loader) are still current and independent of the link-farm mechanism.

## Context

Building a dsh plugin OUTSIDE the dsh-private workspace (in the mstar-workflow mirror). dsh seam packages are `private:true 0.0.1`, published only to a private mirror registry; runtime resolution must come from the host app via peerDependencies. Dev-time (typecheck + real-composition tests + build) still needs the seam types and, for composition tests, minimal runtimes.

## Solution (historical — link-farm era, 2026-08-10)

Dev-time the REAL `@deepseek-ai/dsh-*` packages are linked from a local dsh source tree by a **link farm** (`packages/dsh/scripts/setup-dsh-links.ts`, ported from the dsh-advisor link-farm script):

- Source-root resolution: `$DSH_SOURCE_DIR` → $DSH_HOME/source/current → `~/.dsh/source/current` (the standard DSH_HOME location).
- Every `@deepseek-ai/*` package declared under the tree's two-level `packages/**` (and vendor/) is symlinked by its declared name into the repo-root `node_modules/@deepseek-ai/` — bin-declaring packages are skipped (their bins would be linked into `.bin`, writing into the shared dsh tree). Idempotent: entries already resolving to the correct target are untouched; `--check` mode verifies without writing.
- `peerDependencies` stay declared (the host provides them at runtime) and are marked **optional** (`peerDependenciesMeta`) — bun 1.2 hard-resolves every non-optional peer manifest (verified in bun source: `install_peer = true` is hardcoded in the peer-resolution phase; `install.peer = false` only affects lockfile saving), so private peers would 404 on the npm registry. Optional peers are skipped by the resolver.
- **cordis shim**: the tree's vendored cordis is shimmed into `node_modules/cordis` whenever a source tree resolves. Module identity drives the `Context`/`Events` augmentations the real packages declare: their d.ts files resolve `cordis` from the TREE, and the shim points at the vendored files so `import 'cordis'` resolves to the SAME module. With the npm cordis copy the real packages' augmentations silently fail to merge (ctx.tools/ctx.commands/fs/write-intent … missing at typecheck).
- Wired into `prepare` (`setup-dsh-links.ts && build`), standalone as `bun run dsh:link` (re-run after `$DSH_HOME`/`$DSH_SOURCE_DIR` changes) and `bun run dsh:link:check`.
- Failure semantics: locally (non-CI) a missing source tree HARD-FAILS with a `set DSH_SOURCE_DIR=...` hint; under a `CI` env var it warns and skips (exit 0) — at the time, CI did not run dsh (dsh steps were gated by source-tree availability in `.github/workflows/ci.yml`). Both the gate and the gate's reason are gone: CI now runs `bun run --cwd packages/dsh test` + `typecheck:tests` unconditionally (`.github/workflows/ci.yml:911,917`), and the install e2e specs self-skip without a `dsh` bin on PATH.

## Bun-specific runtime compatibility (still current, independent of the link farm)

The REAL packages are built for Node/V8 + the dsh web loader; under bun the tests need three small compatibility measures, and only the first and third remain test-harness code:

- `Function.prototype.toString` native-code normalization (`packages/dsh/tests/harness.ts:80`): the real packages' lossless-JSON guards (`snapshotJsonValue`, schema validation) detect intrinsic prototypes by comparing against V8's exact `function Object() { [native code] }`; JavaScriptCore (bun) prints newlines, so every plain object would be rejected.
- tools/post-execute delegation (the `SETTLE_SEAM` listener in `packages/dsh/src/gates/agent-flow.ts:2021,2176` — SHIPPED code, not a test shim): the real registry ALWAYS dispatches the seam; a listener that returns without calling `next()` bails the waterfall and breaks every tool call — the defensive settle listener delegates via `next()` on every path.
- Browser client bundles: the real client packages' `/client` subpaths are window.__ModuleLoader__ browser bundles, not Node ESM — `packages/dsh/tests/client-bundles.ts` installs a minimal loader, captures the factories, and executes them with a `require` shim (plus navigator/localStorage stubs).

## What Didn't Work (history)

- `file:` links to dsh-private package dirs FAIL under bun: transitive pnpm `workspace:^` deps unresolvable, peers 404 on registry; bun does not treat file: deps as peer satisfiers.
- tsconfig `paths` to external dsh-private source: not applied outside the project root + TS6059.
- Vendored fork of dsh-private loader/include: source-only, no built lib/, needs dsh-private's pnpm build infra.
- Committed **peer-stubs** (`packages/dsh/peer-stubs/*`, removed 2026-08-10): hand-written stand-ins pinned to a dsh-private snapshot. They worked hermetically but (a) drifted from the real API (`ctx.tools.lookup` vs `get`, loose result validation, lenient error shapes), (b) duplicated the real type surface, and (c) required re-sync whenever the dsh-private baseline moved. Superseded by the link farm — every developer now resolves the SAME real tree.

## Why This Works

- Real-composition Loader tests boot the plugin + engine + cordis + the REAL seam packages together — no stand-in drift; the suite runs green against the linked tree (skills-mount mirror cases included).
- Build externalization (--external cordis / @deepseek-ai/dsh-skill-local / @deepseek-ai/dsh-tools / @deepseek-ai/dsh-llm) keeps the published artifact clean — the published `dist` output imports the real seams at runtime, never the dev-time links.
- The peer contract stays declared; the host app provides the seams at runtime.

## When to Apply

- **Not for dev-time peer resolution any more.** Since `0.0.1-rc.5` the seams resolve from the public npm registry; the current baseline is `packages/dsh/tests/peer-deps.spec.ts` (registry peer contract) and the lock-regeneration checklist in `tooling-decisions/dsh-peer-corridor-lock-regen-and-phantom-deps.md`.
- Read the historical sections only to understand *why* the shapes below exist — e.g. why `peerDependenciesMeta.optional` was once attractive and is now forbidden (its absence is a live assertion in `peer-deps.spec.ts`).
- P3-style e2e that needs real `dsh plugin --profile add` — run with isolated DSH_HOME=/tmp/... and verify reconcile + `--dump-config` (still live advice).

## Examples

- `mstar sdd task-brief` extraction: plan files use `### Task N:` — the engine brief extractor matches it (verified).
- schemastery fork-only APIs (`.optional()`) absent on npm — plain `z.string()` suffices; object keys optional by default.
- cordis rc.7 Service self-registers via reflect.provide — construction only, no ctx.provide (double-registration throws).
- bun 1.2 peer-resolution: peerDependenciesMeta.optional is the ONLY in-manifest knob that keeps private peers out of the registry fetch (verified against bun 1.2.17 source: `install_peer` hardcoded true in the peer phase).
