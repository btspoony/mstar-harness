---
module: @mstar-harness/dsh
date: 2026-08-11
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: high
plan_id: "<plan-id>"
tags:
  - "dsh"
  - "manifest"
  - "dsh-client"
  - "upstream"
  - "contract-test"
  - "regression-prevention"
---

# dsh client manifest field rename: `dshClient` → `dsh.client` (upstream contract, no fallback)

## Context

The MStar workflow panel (`@mstar-harness/dsh` web client half) disappeared from the dsh web GUI after the upstream dsh source tree moved to snapshot `staging-20260810T165245Z`. Root-cause chain (real-machine evidence, 2026-08-11): upstream `packages/client/modules/src/index.ts` `parseDshClient` / `resolveMeta` now read the **nested `pkg.dsh.client`** declaration with **no legacy `pkg.dshClient` fallback**; our manifest still declared the old top-level `dshClient` key, so client-modules discovery parsed the declaration as `undefined` → the package was judged "not a web client module" → the boot manifest (`window.__DSH_BOOT__.entries`) contained no `@mstar-harness/dsh` row → the panel entry never loaded. The server side (catalog rows, `/plugins/<id>/client.js` route, `dist/client.js`) was intact — the only break was the manifest field.

This doc records the fix decision (migrate + contract test + boot-manifest verification method) so a future upstream field rename fails loudly in-loop instead of silently shipping a missing panel.

## Symptoms

- 「MStar 工作流」panel absent from the running web app after restarting with the migrated upstream snapshot; no console error (silent drop).
- Boot-manifest check fails: `window.__DSH_BOOT__.entries` (or `curl -s http://127.0.0.1:3080/ | grep -o '"id":"@mstar-harness/dsh"'`) lacks the row.
- All static checks green: full `bun test` pass, tsc clean, `bun run build` exit 0 — nothing in-loop signals the defect.

## Root Cause

- Upstream contract (staging-20260810T165245Z, `packages/client/modules/src/index.ts`): `resolveMeta` reads `pkg.dsh` → `parseDshClient(pkgName, pkg.dsh.client)`; `parseDshClient` returns `undefined` when the value is `undefined` (missing key is silent — no fallback to a top-level `dshClient`; a non-object value or a non-string `platform` is a loud throw). `decl === undefined || decl.platform !== 'web'` → `pkgMeta = null` → package never becomes a client row.
- Our `packages/dsh/package.json` still declared top-level `"dshClient": { inject, platform }` → `pkg.dsh` was `undefined` → not a client module.
- `ClientModuleHostService` writes only packages declaring `dsh.client` into `window.__DSH_BOOT__.entries` → the boot graph lacks the entry → the panel entry never loads.

## Solution

1. **Manifest migration** (plan `<plan-id>` T1, commit `0fcb4803`): remove the top-level `dshClient` key; add nested `"dsh": { "bundle": { "patch": … }, "client": { "inject": […原样…], "platform": "web" } }`. `dsh.bundle.patch` (cordis patch path) and `exports["./client"]` (→ `dist/client.js`) stay untouched.
2. **Contract regression test** (`packages/dsh/tests/manifest-contract.spec.ts`, 6 cases / 12 expect()): `dsh.client.platform === 'web'`; `inject` is an exact string array and every row is a declared peerDependency; the legacy top-level `dshClient` key is REMOVED; `dsh.bundle.patch` unchanged; `exports["./client"]` resolves to an existing build artifact. Any future upstream rename or manifest regression → this test fails first, before runtime symptoms.
3. **Doc sync** (T3): `packages/dsh/README.md` / `README.zh.md` / `bundle/README.md` + `skills/mstar-host/references/dsh.md` (source + mirrored copy via `bundle-assets`, byte-identical) `dshClient` wording → `dsh.client`, including the discovery-mechanism description; changelog fragment (`.changes/unreleased/dsh-upstream-client-manifest.md`).

## What Didn't Work / Investigation path

Before the migration, the panel was missing with zero in-loop signal. The useful negative results (each eliminates a layer — do them in this order when the panel is missing again):

- Full `bun test` 516 pass / tsc clean / rebuild exit 0 → the defect is NOT in code, tests, or build.
- Server route intact → `/plugins/@mstar-harness/dsh/client.js` served the complete dist file; the break is only the discovery marker.
- Stale installed copy in the web profile (`<profile>/node_modules/@mstar-harness/dsh/package.json` still carrying top-level `dshClient`) reproduces the same symptom → reinstall the migrated bundle (`dsh plugin --profile web add <abs packages/dsh 路径>`).
- Loader-table compatibility (external ids ⊆ host `PLATFORM_MODULES`, no cordis/@deepseek-ai runtime requires in the client bundle) → ruled out loader-side causes.

## Why This Works

Upstream discovery reads exactly one contract shape (`pkg.dsh.client` + `exports["./client"]`); the migration aligns the manifest to it, and the contract test pins the shape byte-level (legacy key absent), so the failure mode moves from "silent panel disappearance in the user's GUI" to "loud in-loop test failure at test/CI time".

## Prevention

- **Contract test** (`manifest-contract.spec.ts`) is the first line of defense: it runs with the full `bun test` suite; a rename anywhere upstream (or a regression in our manifest) trips it before any runtime symptom.
- **Boot-manifest verification method** for the user-restart acceptance track (choose either):
  - A — curl (fast): `curl -s http://127.0.0.1:3080/ | grep -o '"id":"@mstar-harness/dsh"'` must hit.
  - B — devtools: evaluate `window.__DSH_BOOT__.entries`; the `@mstar-harness/dsh` row's `inject` array must match `dsh.client.inject` verbatim.
  - Miss → check in order: installed copy's manifest (still `dshClient` = stale snapshot → reinstall), the workspace engine/`dist/client.js` build freshness (upstream `resolveMeta` reads the file — the link-farm-era `bun run dsh:link` step was removed with the rc.5 registry switch), `exports["./client"]` declaration, then a FULL `dsh web` process restart (the boot graph builds at startup — a running process does not rescan).
- **Generalized lesson**: manifest/packaging fields of the host contract are upstream-renameable; any plugin that relies on host-read manifest fields needs a contract test plus a runtime-visible verification method — "it worked yesterday" is not a contract.

## When to Apply

- Any upstream dsh baseline move (snapshot change) touching client-modules discovery or other host-read manifest fields — re-audit the pinned contract facts in `architecture-patterns/dsh-client-plugin-mechanism.md`.
- Any change to the `packages/dsh/package.json` manifest shape (`dsh.*` keys, `exports["./client"]`).
- Any other dsh client plugin authoring a manifest for the web profile.

## Examples

- Evidence (2026-08-11 state): migration commit `0fcb4803`; `packages/dsh/tests/manifest-contract.spec.ts` has since grown to 6 cases / 12 expect(); full-suite 516 pass / 0 fail at that commit; rebuilt `dist/client.js` sha1 `7b5831c24d03…` (467,726 B) with `dsh.client` manifest. The current manifest still carries `dsh.client` (`platform: "web"` + 5-row `inject`) and no `dshClient` key.
- Verification guide: `{HARNESS_DIR}/iterations/iter-<plan-id>/guides/upstream-dsh-adapter.md` (per-plan evidence record with the full reproduce/verify command list; this doc is the durable knowledge).
