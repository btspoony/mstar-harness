---
module: packages/commands host-health path resolution (resolveCliPath)
date: 2026-08-16
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: 20260816-audit-002-cli-root-paths
tags:
  - bun
  - init-cwd
  - pwd-rewrite
  - path-resolution
  - workspace-marker
related_components:
  - packages/commands/src/host-health/paths.ts (resolveCliPath, declaresWorkspaces)
  - packages/cli/src/utils.ts (re-export)
  - package.json (cli:dev wrapper)
applies_when:
  - Resolving user-supplied relative paths in repo tooling that runs under bun (bun run, bun run --cwd)
  - Designing env-var precedence chains (MSTAR_CLI_PROJECT_ROOT / INIT_CWD / PWD) in any CLI
---

# bun run cwd/env reality: INIT_CWD never exists, PWD is rewritten — resolve by workspace-marker walk-up

## Context

Plan 002's architect-pass contract resolved CLI relative args via an env chain (`MSTAR_CLI_PROJECT_ROOT` → `INIT_CWD` → `PWD` → engine walk-up) — modeled on npm conventions. The implementer's empirical probe (instrumented CLI + env dump, bun 1.2.17) disproved the middle of the chain:

- **bun never sets `INIT_CWD`** (an npm-run-script convention; absent under `bun run`).
- **`bun run --cwd <pkg>` rewrites `PWD`** to the package dir — so from `packages/cli`, `PWD`-anchored resolution looks for `packages/cli/skills/...` and fails, exactly like bare `path.resolve`.

Net: an env-chain resolver cannot distinguish root-wrapper invocation from nested-package invocation under bun; the plan's proof (b) was unsatisfiable as written. PM amendment superseded the contract before implementation.

## Guidance

- **Never rely on `INIT_CWD` under bun.** It does not exist in any bun invocation shape tested (root wrapper, `--cwd <pkg>`, direct script).
- **`PWD` under `bun run --cwd` is the package dir**, not the invoking shell's cwd. Treat it as untrustworthy for "where did the user run me from".
- **Resolve project root by filesystem markers, not env chains**: explicit env override (`MSTAR_CLI_PROJECT_ROOT`) → walk up from process cwd to the nearest `package.json` declaring `workspaces` (accept **string, array, and object** forms — npm allows all three; array-only acceptance was a real consumer-monorepo bug caught in QC) → nearest `package.json` (single-package project root) → cwd-relative terminal fallback outside any package tree.
- **Absolute user paths pass through unchanged** — resolution applies to relative args only.
- **A caller-supplied workspace wins over env** (`resolveCliPath(userPath, base?)`): a transport serving another directory (an MCP server launched with `--workspace`) passes `base`, and the relative argument is discovered from that checkout. Note the sibling `resolveProjectRoot()` in the same module still carries the legacy `MSTAR_CLI_PROJECT_ROOT || INIT_CWD || PWD` chain (it degrades to `PWD` under bun, since `INIT_CWD` never exists) — that is why the path resolver deliberately does not use it.
- Generic markers, not repo names: shipped CLIs run in consumer repos; a `name === "morning-star"` check would be dead code everywhere else.

## Why This Matters

Documented relative-path commands ("`mstar skill lint skills/mstar-audit`") must work from the directories maintainers actually occupy (`packages/cli` via `cli:dev`). Env-chain designs ported from npm silently break under bun and fail exactly at the proof-invocation level — the wrapper works (it exports the env var), masking the broken nested case until someone runs the non-wrapper form.

## When to Apply

- Any repo tooling (CLI, scripts) that resolves user paths under bun workspaces.
- Reviewing env-precedence contracts: empirically probe each env var under the actual runner before locking the chain (the plan's contract was locked from npm prior art and failed at implementation).
- Related bun quirk (different mechanism): `tooling-decisions/bun-bundle-ascii-literals.md` — same runtime, bundle-literal decoding instead of env semantics.

## Examples

- `packages/commands/src/host-health/paths.ts` `resolveCliPath` + `declaresWorkspaces` (re-exported unchanged through `packages/cli/src/utils.ts`) — 4-tier contract, string-form workspaces regression test (`packages/cli/test/utils.test.ts` "string-form workspaces walk-up").
- Proof pair from plan 002 Done criteria: `bun run cli:dev skill lint skills/mstar-audit` (wrapper env) **and** `bun run --cwd packages/cli dev skill lint skills/mstar-audit` (scrubbed env, walk-up) both find SKILL.md.
