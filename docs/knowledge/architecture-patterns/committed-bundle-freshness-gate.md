---
title: Committed bundles with CI freshness gate for checkout-root plugins
category: architecture-patterns
status: active
tags: [packaging, ci, freshness-gate, config-only-targets]
created: 2026-09-26
last_updated: 2026-11-09
source: iter-20260926-v4-phase5
---

# Committed bundles with CI freshness gate for checkout-root plugins

## Problem

Hosts whose plugin root IS the repo checkout (zcode, and by convention cursor/codex/kimi in this repo) have no plugin build step: a config referencing a build output that lives only in a gitignored tree resolves to a nonexistent file after install. Conversely, tracking build outputs without a freshness gate lets them drift silently from sources. (The original instance was `packages/mcp/dist/plugins/<target>/`; `packages/mcp` and its per-host bundles were deleted in favor of the `mstar mcp` CLI subcommand — `29c97f16` — so `mcp/bundles/` and `mcp:build` no longer exist. The pattern and its lessons below survive on the `hooks/` artifact and on the generated dashboard assets.)

## Decision

Commit generated bundles into the plugin-root-visible path, mark them `@generated`, and enforce a CI freshness gate that rebuilds and byte-diffs the committed tree. The live instances in this repo: `hooks/*.mjs` (engine inlined by `scripts/build-zcode-hooks.ts`; gate `bun run engine:build && bun run hooks:build && git diff --exit-code -- hooks/`, `.github/workflows/ci.yml`) and `packages/commands/src/dashboard/assets.generated.ts` (gate `git diff --exit-code -- packages/commands/src/dashboard/assets.generated.ts`). Configs reference the committed path via the host's documented plugin-root variable. A package-internal build tree stays gitignored. A recorded source/output digest pair is NOT a substitute for the rebuild-and-diff gate (`tooling-decisions/generated-artifact-engine-resolution-identity.md`).

## Process lessons (same iteration)

1. **Registry union regressions recurred three times** (C6b dropped pr-review, C6c dropped process, C6d dropped judgment) because per-task scoped proofs never exercised the composition. Fix: every family round's proof must include the registry/definitions test (whole-directory preferred), not just its own file.
2. **Smoke must not self-substitute host variables**: the first packaging smoke expanded `${ZCODE_PLUGIN_ROOT}` itself against a synthetic root, hiding the missing-bundle failure. Assemble the layout the manifest declares, assert the resolved executable exists, then launch.
3. **Environment isolation claims need implementation receipts**: "PATH excludes mstar" was asserted before the smoke actually constructed a sanitized PATH (temp bin dir with only node/bun symlinks + a pre-spawn `mstar` non-resolution assertion).
