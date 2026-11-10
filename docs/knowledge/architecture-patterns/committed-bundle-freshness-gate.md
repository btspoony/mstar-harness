---
title: Committed bundles with CI freshness gate for checkout-root plugins
category: architecture-patterns
status: active
tags: [packaging, ci, freshness-gate, config-only-targets]
created: 2026-09-26
last_updated: 2026-11-10
source: iter-<plan-id>
---

# Committed bundles with CI freshness gate for checkout-root plugins

## Problem

Hosts whose plugin root IS the repo checkout (zcode, and by convention cursor/codex/kimi in this repo) have no plugin build step: a config referencing a build output that lives only in a gitignored tree resolves to a nonexistent file after install. Conversely, tracking build outputs without a freshness gate lets them drift silently from sources. (The original instance was `packages/mcp/dist/plugins/<target>/`; `packages/mcp` and its per-host bundles were deleted in favor of the `mstar mcp` CLI subcommand — `29c97f16` — so `mcp/bundles/` and `mcp:build` no longer exist. The pattern and its lessons below survive on the `hooks/` artifact and on the generated dashboard assets.)

## Decision

Commit generated bundles into the plugin-root-visible path, mark them `@generated`, and enforce a CI freshness gate that rebuilds and byte-diffs the committed tree. The live instances in this repo: `hooks/*.mjs` (engine inlined by `scripts/build-zcode-hooks.ts`; gate `bun run engine:build && bun run hooks:build && git diff --exit-code -- hooks/`, `.github/workflows/ci.yml`) and `packages/commands/src/dashboard/assets.generated.ts` (gate `git diff --exit-code -- packages/commands/src/dashboard/assets.generated.ts`). Configs reference the committed path via the host's documented plugin-root variable. A package-internal build tree stays gitignored. Both gates run as **advisory** (`continue-on-error`) because the byte diff depends on the exact bun/bundler version that produced the bundle (1.4.0 and 1.4.4 emit different text for identical sources), so it reported drift for changes that never touched behaviour; a stale bundle stays covered by the hooks behaviour tests and review. A recorded source/output digest pair is NOT a substitute for the rebuild-and-diff gate (`tooling-decisions/generated-artifact-engine-resolution-identity.md`).

## Process lessons (same iteration)

1. **Registry union regressions recurred three times** (C6b dropped pr-review, C6c dropped process, C6d dropped judgment) because per-task scoped proofs never exercised the composition. Fix: every family round's proof must include the registry/definitions test (whole-directory preferred), not just its own file.
2. **Smoke must not self-substitute host variables**: the first packaging smoke expanded `${ZCODE_PLUGIN_ROOT}` itself against a synthetic root, hiding the missing-bundle failure. Assemble the layout the manifest declares, assert the resolved executable exists, then launch.
3. **Environment isolation claims need implementation receipts**: "PATH excludes mstar" was asserted before the smoke actually constructed a sanitized PATH (temp bin dir with only node/bun symlinks + a pre-spawn `mstar` non-resolution assertion).

## Version-pinned rebuild runbook

The advisory gate's tolerance is not a licence to rebuild with whatever `bun` is on `PATH`: the packaging manifests record per-consumer digests of build outputs, so a rebuild under the wrong bundler rewrites the recorded digests to the wrong artifact and the producer's `--check` then vouches for it. The sequence that reproduces the committed state:

1. **Invoke the pinned binary directly.** `bunx bun@1.4.0 run hooks:build` does not pin anything: `bun run` re-execs `bun` from `PATH`, so the script body still runs under the local version. Run the cached binary itself (for example `~/.bun/install/cache/@oven/bun-darwin-aarch64@1.4.0@@@1/bin/bun run hooks:build`) and confirm which prelude the output carries — 1.4.0 emits `var __defProp`/`__exportSetter`, 1.4.4 emits `var __esm = (fn, res, err)`.
2. **Rebuild the inlined dependency under the same version.** `scripts/build-zcode-hooks.ts` transpiles only the hook; it inlines the gitignored `packages/engine/dist/engine.js`. A hooks-only rebuild inherits whatever engine the last local build left there, so rebuild `engine` first and then `hooks`.
3. **Regenerate the manifests through the producer, never by hand.** Recorded digests must describe the artifacts that are actually committed. Check the result with the producer's `--check`; treat "it moved 18 of 70 digests" as the expected outcome of a genuine toolchain correction, not as churn to revert. A manifest that records a stale artifact's digest is worse than a missing gate, because it makes every later `--check` pass.
