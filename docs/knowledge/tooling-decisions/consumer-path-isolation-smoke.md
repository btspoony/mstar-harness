---
module: cli bundle distribution + smoke evidence
date: 2026-09-18
problem_type: tooling_decision
category: tooling-decisions
severity: low
plan_id: <plan-id>
last_updated: 2026-11-09
applies_when:
  - proving a bundled CLI runs with no dependency on a package it normally resolves from
  - reviewing a "consumer needs no X" claim that rests on bundle inlining
tags:
  - bundle-smoke
  - consumer-path
  - module-resolution
  - negative-control
  - esm
---

# Proving a bundled CLI is usable where a package it normally resolves from is absent

## Context

`mstar iteration register` (plan `<plan-id>`) must register an iteration from a consumer checkout **with no engine import**: the built CLI bundle inlines its dependencies (68 modules / 1.28 MB when measured; 4.5 MB at 4.3.0), so at runtime nothing should resolve outside the single file. But bundling makes "the consumer needs no `@mstar-harness/engine`" a claim that must be **actively proven**, not asserted — a naive verification can pass while ambient resolution is silently supplying the package. The command still exists (`mstar iteration register`, `iteration.register`, write effect). Evidence recorded in `{HARNESS_DIR}/sdd/<plan-id>/task-2-consumer-smoke.md`.

## Guidance

**Why the naive construction fails.** Copying the bundle to an arbitrary temp dir does not exclude resolution routes:

- ancestor `node_modules` above the fixture (e.g. `/tmp/...` still walks up, and a checkout-adjacent fixture resolves the workspace);
- ambient env: `NODE_PATH`, `NODE_OPTIONS`, inherited `MSTAR_*` / `INIT_CWD` variables;
- module-format resolution: a `.js` file in a directory without `"type": "module"` is parsed as CJS — an ESM bundle then dies with `SyntaxError: Cannot use import statement outside a module` (hit on the first run; **not** a CLI defect);
- a symlink instead of a real copy keeps the file's real path inside the checkout, so ancestor resolution follows the checkout, not the fixture.

**The construction that holds** (each element maps to a failure mode above):

1. **Real file copy**, never a symlink (`cp`, not `ln -s`).
2. Into a **realpath-resolved OS temp dir outside the checkout and its worktrees**.
3. `cwd`, `HOME` and XDG config/cache roots **inside the fixture**.
4. **Minimal environment**: `env -i HOME=… PATH=…` — no `NODE_PATH`/`NODE_OPTIONS`/`MSTAR_*`/`INIT_CWD` leakage.
5. **Absolute interpreter path** (`/…/node`), so `PATH` resolution cannot substitute another runtime.
6. Module mode handled explicitly: rename the ESM bundle to `.mjs` (recorded remedy; a fixture-local `package.json` with `"type": "module"` is the alternative) — do not let format be incidental.
7. An explicit **negative control**: from the fixture, probe `require.resolve('@mstar-harness/engine', { paths: [<fixture>, <bundle-dir>] })` and record that it fails with `MODULE_NOT_FOUND`; support with a `find` over fixture and bundle dirs for `package.json` / `*.ts` / `node_modules` (observed: 0 matches). The control proves absence of resolvable source, not just that the happy path happened to work.

**Record verbatim, or it does not count.** The first-pass smoke record was rejected in review as non-reproducible: it abbreviated the invocations and omitted the negative control. The fix was mechanical: every command line recorded copy-pasteable verbatim (build, copy, all `env -i node …` invocations with observed output and exit codes), plus the negative control's own command and result. A smoke artefact a peer cannot re-run is an assertion, not evidence.

## Why This Matters

A bundle inlines its dependencies at build time, so a successful run in a sloppy fixture proves nothing about the consumer path — the package may have been resolved from an ancestor or ambient route the run never noticed. Only isolation plus a failing negative control together establish "no engine resolvable, CLI still works". The isolated smoke also pins module-format behaviour (the `.mjs` rename) that a repo-internal test never encounters, because inside the repo the `package.json` always supplies the module type.

## When to Apply

- Any "bundled artefact needs no X" claim: prove it with an isolated copy + sanitized environment + negative control, and record verbatim command lines.
- Boundary: this is a **disposable, once-built smoke artefact kept as evidence**, not a permanent test that rebuilds the bundle on every run — a test suite that builds inside `test()` is a different (and usually wrong) tradeoff; the build stays an explicit, integration-owned step and the smoke runs once per round against that build.

## Examples

### Before (naive, non-proving)

```sh
cp dist/mstar-harness.js /tmp/whatever/
node /tmp/whatever/mstar-harness.js iteration register …
# passes — but ancestor node_modules / NODE_PATH / CJS-parse failures are unexcluded
```

### After (isolated, with control)

```sh
SMOKE=$(mktemp -d /tmp/mstar-t2-smoke-XXXX)
cp packages/cli/dist/mstar-harness.js "$SMOKE/mstar-harness.mjs"   # real copy + ESM rename
cd /tmp/mstar-t2-fixture-6zjv
env -i HOME="$HOME" PATH="$PATH" /abs/path/node "$SMOKE/mstar-harness.mjs" iteration register …   # EXIT=0
node -e "try { require.resolve('@mstar-harness/engine', { paths: ['$PWD','$SMOKE'] }) } catch (e) { console.log('RESOLVE FAILED (expected):', e.code) }"
# → RESOLVE FAILED (expected): MODULE_NOT_FOUND
```

Full verbatim transcript: `{HARNESS_DIR}/sdd/<plan-id>/task-2-consumer-smoke.md`.
