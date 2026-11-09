---
module: MCP published-surface measurement (mcp-fold ceiling)
date: 2026-11-05
problem_type: developer_experience
category: best-practices
severity: low
plan_id: <plan-id>
applies_when:
  - Re-measuring the published MCP surface before changing PUBLISHED_SURFACE_CEILING_CHARS
  - Any probe that imports @mstar-harness/* from the primary checkout to measure built behavior
  - A measurement disagrees with the suite that owns it
tags:
  - mcp
  - published-surface
  - stale-dist
  - measurement
  - worktree
---

# Problem

The published MCP surface is enforced as one exact character count over every folded tool's description plus its input JSON schema, read back from `tools/list` in `packages/cli/test/mcp-fold.test.ts`. Measuring it from the primary checkout with a throwaway probe reported 33,564 while the suite in a feature worktree reported 33,629 — a 65-character gap that was briefly mistaken for the tree's real surface and used to attribute a ceiling change to the wrong field pair.

# What Didn't Work

- Importing the same modules the suite imports (`registerMcpCommands` plus a `Client`/`InMemoryTransport` pair) from the primary checkout. The probe's `@mstar-harness/commands` resolved to `packages/commands/dist`, which predated the change under test, so two published properties were simply absent from the schema. The number looked internally consistent, which is what made it believable.

# Solution

Measure inside the checkout that contains the change (the feature worktree), through the suite's own reduce: `tools.reduce((n, t) => n + JSON.stringify(t.inputSchema).length + (t.description ?? "").length, 0)`. When a throwaway probe and the owning suite disagree, treat the suite as authoritative and rebuild the package outputs (or re-run in the worktree) before trusting the probe.

# Why This Works

`packages/*/dist` is a gitignored build artifact, so a linked worktree and the primary checkout can hold different compiled outputs for the same source commit. The suite runs against the artifact it imports; a probe that imports the same package specifier from a different checkout measures that checkout's build, not the diff under review.

# Prevention

- Derive the number from the test that guards it, not from a parallel reimplementation.
- Per-field contributions are the difference between the full surface and the surface with that property removed — measure each side, never estimate from the property's JSON length.
