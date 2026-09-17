# Changelog

All notable changes to the `@mstar-harness/omp` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [3.10.1] - 2026-09-17

### Changed

- Version alignment with harness **3.10.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.1**.

## [3.10.0] - 2026-09-16

### Changed

- A reused coordinator session can arm `@slow` for a later workflow after the previous model-handoff binding is terminal; the post-await concurrent-arm check no longer treats every historic record as an active binding.
- The Phase-1 fire path re-reads the session ledger after every await and refuses to invoke `setModel` when an observation handler already terminalized the pending record.
- Phase-2 native-delivery suppression samples settled job ids at `agent_end` before marking them consumed, so a tool-using coordinator turn does not emit a duplicate `triggerTurn` follow-up after the host already delivered the completion.
- Added the opt-in **coordinator model handoff** to `@mstar-harness/omp`: a new extension entry (`extensions/model-handoff.js`, published through manifest `omp.extensions`, engine inlined, its single host import resolved by the running host) plus native plugin settings `modelHandoff` (off by default) and `handoffTarget` (`@default` \| `@smol`). A **new** Morning Star iteration start in the bound coordinator session arms `@slow` before substantive Prepare, and a complete Phase 1 — specialist returns, locked Prepare, distinct matching integration checkout, verified required push — switches that one session to the saved target once. Ordinary chat, leaf and plan-scoped sessions stay inert; no role mapping, goal objective or workflow state is written, and a manual model change while the switch waits cancels it for that session only.
- Pinned the package's OMP host contract: optional peer and development dependency `@oh-my-pi/pi-coding-agent@18.2.1`, Bun floor `>=1.3.14`, and a `bundle-smoke` case that unpacks the published tarball and drives it through the host's own plugin discovery, extension loader and custom-tool loader in a disposable host root with no engine package installed. It replaces the previous source-text bundle assertions (emitted symbol, no bare engine import) with that runtime behaviour.
- Documented the native `/settings` → Plugins path, persistence and its user-scope limitation (a project-only install has no native settings row), supported entries and modes, coordinator binding, full-Phase-1 readiness, cancellation, replay and failure semantics in the OMP host reference and the package README.
- **Phase-2 native-delivery silence**: the reminder pass now consumes exactly the terminal job ids the decision sampled, instead of re-reading the async-job snapshot after the decision. A job that settles while the settings read is awaited can no longer be marked consumed without ever taking part in native-delivery suppression, which previously allowed a redundant reminder for an already-delivered completion.
- Added a `phase2Seams.readSettings` test seam and regressions covering settlement inside the settings-await window (no double reminder, no silent swallow) and the unchanged bounded reminder for a non-delivered change.
- Added opt-in **Phase-2 plan instances** to `@mstar-harness/omp`: a new extension entry (`extensions/phase2-orchestration.js`, published through manifest `omp.extensions`, engine inlined, its one host import resolved by the running host) plus native plugin settings `phase2PlanInstances` (off by default; gates **extra primary launches only**) and user-configurable `maxPlanInstances` (positive safe integer, default 2, minimum 1, no ceiling of 2; a malformed present value fails visibly and authorizes no launch). A Phase-2-only coordinator session gets at most one bounded advisory per **changed** opportunity observation — the observation key is recorded before the message, identical unchanged state never re-fires, there is no timer or polling, and native completion delivery stays authoritative.
- Added the `mstar_phase2` bookkeeping tool with its local transport-intent journal (`<workflow dir>/omp-launches.json`, version 1): `bind` (the coordinator's first Phase-2 host action), `checkpoint` (acknowledges the shared rescheduling checkpoint against the sample taken then, with the frozen five reasons), and `reserve-launch` / `record-launch` — strict `reserved → starting → created → submitting → submitted` transitions, each persisted **before** its pane / OMP-start / prompt side effect, with occupancy counted once per plan id as owned pending intents ∪ active plan primaries against the latest cap, and `refused` / `uncertain` never blindly retried. Compiled code admits and records only: it never spawns, merges, rewrites workflow state or releases leases.
- Documented the native `/settings` → Plugins path (with its user-scope limitation — a project-only install has no native settings row), the launch-only opt-in, capacity semantics, the explicit bind/checkpoint/intent call sequence and the optional skill-driven Herdr/tmux transport in the OMP host reference, the package README and the scoped-plan PM transport note: prerequisite gating (skill actually present and read + CLI + matching managed environment; tmux stays unavailable while no tmux skill exists), non-focus pane creation at the prepared worktree, verbatim returned opaque targets, one absolute `/iteration-drive --assignment` submission with no coordinator credentials, and terminal handling of `agent_not_ready`, a timeout or a stalled submission. Transport evidence is explicitly marked simulated, not native E2E.

- Version alignment with harness **3.10.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.0**.

## [3.9.4] - 2026-09-15

### Changed

- Version alignment with harness **3.9.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.4**.

## [3.9.3] - 2026-09-15

### Changed

- Version alignment with harness **3.9.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.3**.

## [3.9.2] - 2026-09-14

### Changed

- Version alignment with harness **3.9.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.2**.

## [3.9.1] - 2026-09-14

### Changed

- Version alignment with harness **3.9.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.1**.

## [3.9.0] - 2026-09-13

### Changed

- Unify active lifecycle branch checks across hosts, retain parallel track ownership, bound SDD Git probes, and preserve integration-cwd workflow selection.

- Version alignment with harness **3.9.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.0**.

## [3.8.3] - 2026-09-12

### Changed

- Version alignment with harness **3.8.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.3**.

## [3.8.2] - 2026-09-12

### Changed

- **dsh docs**: the package README now documents the recommended `workflowNames` allowlist for the native read-only fan-out path on dsh — `mstar-qc-tri` (plan QC tri), `mstar-audit-fanout` (large-repo `/codebase-audit`), `mstar-pr-seats` (`/amazing-pr-review deep`) — with the production-overlay note in the same place: with the shipped empty allowlist every name is *unknown*, which the default `workflowGate: 'warn'` turns into one survivable `workflow.name.unknown` advisory; a deployment that also wants unknown names vetoed sets `workflowGate: 'hard'` in the profile layer. No default changed — `workflowGate` stays `'warn'` and `workflowNames` stays unset (operator overlays, never mstar defaults).
- **dsh read-only fan-out (docs)**: `skills/mstar-host/references/dsh.md` gains the **Read-only fan-out via the `workflow` tool** section and `references/dsh-workflow-scripts.md` ships the copy-pasteable `script` + `meta` templates for the three names; `commands/codebase-audit.md` and `commands/amazing-pr-review.md` carry the dsh-conditional sentence (slash → native `workflow` tool → conversation `workflow-run` node, other hosts unchanged), and `skills/mstar-sdd/SKILL.md` notes the plan QC tri MAY run through the qc-tri script while per-task implementers stay serial `subagent`.

- Version alignment with harness **3.8.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.2**.

## [3.8.1] - 2026-09-11

### Changed

- Version alignment with harness **3.8.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.1**.

## [3.8.0] - 2026-09-10

### Changed

- Version alignment with harness **3.8.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.0**.

## [3.7.3] - 2026-09-10

### Changed

- Version alignment with harness **3.7.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.3**.

## [3.7.2] - 2026-09-09

### Changed

- Moved the `mode: primary` **`project-manager`** agent shell out of the shared `agents/` subagent surface into `packages/opencode/agents/` (OpenCode-only). Host plugin surfaces (ZCode / omp / Claude-plugin manifests) no longer register PM as a subagent — PM entry stays via the `pm` skill; OpenCode bundling merges the shell into `harness-agents/`.
- Updated omp/dsh mirror contracts and host docs to match.

- Version alignment with harness **3.7.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.2**.

## [3.7.1] - 2026-09-09

### Changed

- **ZCode coordination-write gate**: new engine-backed PreToolUse (`Write|Edit`) process hook `hooks/mstar-write-gate.mjs` — hard-enforced repos block writes to harness coordination documents (status.json, workflow snapshots, project registers) with exit 2 plus an actionable stderr reason (stdout stays empty); soft-mode and non-harness writes pass silently; disable per session with `MSTAR_WRITE_GATE=off`.
- **Edits validate the reconstructed post-edit result (ZCode host)**: deterministic Edits (`old_string` + `new_string` with a unique match, or `replace_all`) are validated against the reconstructed content instead of the pre-edit on-disk state — a deterministic corrupting edit now blocks under hard enforcement; ambiguous or non-reconstructible edits keep the pre-edit fallback.
- **Oversized coordination docs are now a violation on the ZCode host**: content or on-disk targets beyond the 2 MiB validation budget yield `status.oversized` (hard-mode block naming the escape hatch instead of a silent pass; omp keeps the default silent pass).
- **omp hook lazy loaders removed (versioned divergence)**: the engine is inlined at build, so a stale engine dist now fails the omp build instead of silently degrading; Gate-1 block/pass decisions and reason strings are unchanged (golden fixture matrix).

- Version alignment with harness **3.7.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.1**.

## [3.7.0] - 2026-09-08

### Changed

- Version alignment with harness **3.7.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.0**.

## [3.6.3] - 2026-09-06

### Changed

- Version alignment with harness **3.6.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.3**.

## [3.6.2] - 2026-09-05

### Changed

- Version alignment with harness **3.6.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.2**.

## [3.6.1] - 2026-09-03

### Changed

- Version alignment with harness **3.6.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.1**.

## [3.6.0] - 2026-09-03

### Changed

- Version alignment with harness **3.6.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0**.

## [3.6.0-alpha.4] - 2026-09-03

### Changed

- Initial `@mstar-harness/omp` package: the omp hook + six `mstar_*` tools (moved from the repo root) bundled with the engine **inlined**, plus `skills/`/`commands/`/`agents/` mirrors — `omp plugin install @mstar-harness/omp` works without any local build.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.4**.
