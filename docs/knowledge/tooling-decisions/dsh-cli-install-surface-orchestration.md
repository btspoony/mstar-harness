---
module: packages/cli
date: 2026-08-17
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: 20260817-cli-dsh-install
applies_when:
  - orchestrating dsh plugin installs from another tool
  - probing a dsh deployment's installed plugin state
  - touching the CLI install surface for dsh
tags:
  - dsh
  - cli
  - install
  - two-command-contract
  - pnpm
  - dump-config
---

# dsh CLI install-surface orchestration (two-command contract, probe facts, fail-loud)

## Context

`@mstar-harness/dsh` installs as a dsh plugin via the **two-command contract** (roadmap §8.3, `architecture-patterns/dsh-plugin-dependency-activation.md` F2/F4): `dsh plugin --profile web add @mstar-harness/dsh` **then** `dsh plugin --profile web add dsh-llm-fallbacks`. Folding a fallbacks row into the mstar bundle patch is falsified (duplicate loader entry id boot failure / dual plugin instance). The CLI needed a one-shot surface (`init --target dsh`) that automates the contract without violating it.

## Guidance

- **Orchestrate two independent subprocess calls** — one per `dsh plugin --profile web add <spec>`, mstar first, fallbacks second (reconcile append order keeps fallbacks after `dsh-base`/llm-retry). Never write to any `cordis.patch.yml`.
- **Probe installed state via `dsh --profile web --dump-config`** (compose-and-print, does not boot). Parse loader entry lines (`# == <pkg>` → `- id: <id> / name: <pkg>`). Verified surface (dsh 0.2.2-rc.1, re-probed 2026-11-09): for the top-level form `--profile` **precedes** the flags it qualifies; `dsh plugin` carries its own `--profile <name>` option (so `dsh plugin --profile web add <spec>` — the shape the CLI adapter emits — is valid, and `dsh plugin` without `--profile` errors `required option '--profile <name>' not specified`); `dsh plugin` forwards verbatim to pnpm; there is **no** native `dsh plugin list` subcommand (`list` is pnpm's).
- **Idempotency**: skip a row already present (probe first); duplicate `add` is a pnpm no-op (`Already up to date`, exit 0) — double insurance. A `disabled: true` row still counts as installed.
- **fail-loud on missing `dsh` bin** — deliberate deviation from the omp adapter's note-and-continue (omp's clone/link side effects can still complete; dsh has no completable work without the bin). Throw with an install hint, exit non-zero.
- **dry-run = pure preview**: no probe, no fail on missing bin, always previews the full add list.
- **pnpm `minimumReleaseAge` gate**: a freshly published version is excluded from **range** resolution for ~24h, so `add @mstar-harness/dsh` may resolve an older major (e.g. 2.2.0 without the seeds surface) right after publish. A **pinned** explicit version (`add @mstar-harness/dsh@2.3.0`) bypasses the gate. Document the window for fresh installs; the default path converges after it passes.
- **ASCII literals** in CLI src (this repo's `lint:ascii-literals` gate) — messages must be ASCII.

## Why This Matters

The two-command contract is load-bearing (folding breaks boot or splits fallback state). The probe surface is the executable drift gate — if `--dump-config` output shape drifts, the adapter must degrade loudly (warning + still add), never silently mis-report. Fresh-publish age-gate explains "installed but wrong version" observations that otherwise look like mechanism bugs.

## When to Apply

- Adding/verifying any install path for a dsh plugin.
- Reading a deployment's installed plugin state programmatically.
- Debugging "installed version ≠ expected" right after an npm publish.

## Examples

### Probe shape (dsh 0.1.0-rc.6; row shape re-confirmed on 0.2.2-rc.1)

```
$ dsh --profile web --dump-config   # compose-and-print, no boot
# == @mstar-harness/dsh
- id: mstar
  name: '@mstar-harness/dsh'
# == dsh-llm-fallbacks
- id: llm-fallbacks
  name: dsh-llm-fallbacks
```

### Orchestration order

```
dsh plugin --profile web add @mstar-harness/dsh       # 1st
dsh plugin --profile web add dsh-llm-fallbacks        # 2nd (skip if --no-fallbacks)
```

Cross-links: `architecture-patterns/dsh-plugin-dependency-activation.md` (fold falsification, reconcile semantics) · `conventions/dsh-plugin-authoring.md` (bundle distribution).
