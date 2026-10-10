---
title: OpenCode V2 host-presence gate and generation probe
category: tooling-decisions
tags: [opencode, opencode-v2, installer, d14, d15, host-presence]
created: 2026-10-10
source: {ITERATION_ID}
status: active
---

# OpenCode V2 host-presence gate and generation probe

## Context

`mstar init --target opencode` now serves two host generations from one CLI: the V1 package (`@mstar-harness/opencode`, `@opencode-ai/plugin`) and the V2 package (`@mstar-harness/opencode-v2`, `@opencode/plugin` 2.0.26). Six of the seven install targets have a host CLI; zcode has none.

## Guidance

- **Host presence is a real-install precondition (D14)** for `opencode`, `omp`, `dsh`, `cursor` (`cursor-agent`), `codex`, `kimi` (`kimi`): a missing host binary refuses `init` naming the install action for the binary itself plus the rerun command — never a silent config write. **zcode is exempt** (no CLI); its install path is untouched.
- **`--dry-run` is a pure preview (D15)**: it never probes presence or generation for any target, always previews the would-run actions regardless of install state. The dsh pure-preview ruling generalizes; codex's dry-run preview behavior is the target.
- **Generation (OpenCode)**: explicit `--opencode-generation <v1|v2>` wins; otherwise a bounded (~5s abortable) `opencode --version` probe parses `opencode vMAJOR.MINOR.PATCH` (major ≥ 2 → v2). Probe failure (timeout/unparseable) is a typed refusal naming the flag — never a silent v1 fallback. Config markers are only a consistency warning. Dry-run with neither flag nor markers previews with `generation: unresolved`.
- **Recovery executability**: every refusal's recovery must be runnable in exactly the refused state (e.g. kimi's refusal installs the Kimi Code CLI itself, not the TUI `/plugins install` route which needs the CLI).
- **Shared gate**: `ensureHostPresent` + the version probe share one abort-race cutoff (`probe-timeout.ts`) so a SIGTERM-surviving host binary cannot hang init.

## Why This Matters

`install` presupposes the host: writing config for an absent host creates dead configuration, and guessing a generation installs the wrong package. The dry-run preview/promise split keeps previews honest about machine state.

## When to Apply

- Any new install target: add it to the host-presence map only if it has a CLI, with an executable-in-refused-state recovery message.
- Any generation-dependent behavior: resolve through flag → probe (real install) → unresolved annotation (dry-run).

## Examples

- `packages/cli/src/adapters/host-presence.ts` — gate + binary map.
- `packages/cli/src/adapters/opencode-version-probe.ts` — bounded probe.
- `packages/cli/test/host-presence.test.ts` — refusal/preview corpus.

Cross-links: `{ITERATION_DIR}/<iteration-id>/specs/opencode-v2-native-package-contract.md` (full contract, local artifact).
