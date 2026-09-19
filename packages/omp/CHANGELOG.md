# Changelog

All notable changes to the `@mstar-harness/omp` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [3.11.2] - 2026-09-19

### Harness

- Moved the **coordinator model-handoff arm to the direction lock**: a new iteration now arms `@slow` once the direction is locked and **before** the Phase 1 draft is written, instead of after workflow registration — so the arm always takes the unregistered reservation path, which is the expected state for a new iteration (no register row, no snapshot, no compass) and never a reason to defer the call. No arm/fire logic, refusal code, authority derivation or tool schema changed.
- Renamed the shared new-iteration anchor `iteration-entry` → **`direction-lock`** and moved its carrier to the §1.2 tail: the anchor now fires once the direction is locked and before the compass/plans draft is written, and the three Phase 1 entry routes bind it at that boundary — the interactive route in its own step between the lock and the draft, the autonomous and host-Plan routes through their pre-commit checklists.

- Version alignment with harness **3.11.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.2**.

## [3.11.1] - 2026-09-18

### Harness

- **Host session identity now reaches the engine on OMP**: the `@mstar-harness/omp` model-handoff extension revises every `bash` tool call of its session to carry the host session id in `MSTAR_HOST_SESSION_ID` — overwriting any caller-supplied value under that name, `bash` only, nothing injected for a host session with no id, and no engine or harness write, notice or state — and a fresh `mstar plan bind` resolves its identity **`--session-id` → `MSTAR_HOST_SESSION_ID` → the engine-generated id** — the injected variable is the fallback (trimmed; empty or whitespace-only counts as absent) — so the engine session id and the host session id are one identifier for the readiness and start-authority comparisons. The generated default and every comparison are unchanged: an absent or foreign association still refuses (the readiness `binding-invalid` code, the existing start-authority codes), and `--resume` never re-identifies — it refuses `--session-id` as a usage error.
- **`bindPlanSession` adopts a caller-supplied `sessionId`** on both fresh-bind variants (coordinator and plan scope), keeping `randomUUID()` when none is supplied. The id names the session envelope's file, role-scoped at `{WORKFLOW_DIR}/<workflow-id>/sessions/<role>-<session-id>.json` (`<role>` ∈ `coordinator` / `plan-pm`) — so one host session may hold the coordinator envelope and a plan-pm envelope of one workflow under the same shared id — and is therefore validated as a single safe path component (non-empty, no separator, not `.`/`..`, at most 128 characters) and refused with the new, additive `coordination.invalid-session-id` before any write; a re-used id is still refused by the exclusive envelope creation with the existing `coordination.session-mismatch`.
- Updated `skills/mstar-host/references/omp.md` with the anchor-side session-identity association contract.

- Version alignment with harness **3.11.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.1**.

## [3.11.0] - 2026-09-18

### Changed

- Made `mstar_model_handoff {operation:"start"}` reachable for an already-registered, own, not-yet-armed workflow: the extension now selects the reservation or attachment branch from the validated root register itself, while coordinator authority stays derived solely from host/engine facts (`deriveStartAuthority`). A foreign coordinator of the named workflow now refuses with `already-bound` on the attach path; every other refusal code and the unregistered reservation path are byte-identical.
- Aligned all model-handoff coordinator notices with the shared Morning Star title shape: status-bearing titles state the observed workflow id and status from its own snapshot; snapshot-free sites (suspension, start refusal, in-flight navigation refusal) use a fallback title that asserts no workflow status. `mstar:model-handoff-notice` and `mstar:model-handoff` literals are unchanged.
- Documented the producer of the prepared Assignment in the OMP host reference: the `reserve-launch` admission clause and the optional transport section now name **`mstar plan prepare`** as the coordinator step that writes `coordination.prepared` and its pinned `coordination.prepared.assignment_path`, define the transport placeholder as that absolute path, add an ordered summary of the extra-primary route (registered `Todo` row → existing feature worktree → coordinator bound → prepare → `reserve-launch` → the journaled record-before-side-effect transitions and pane/start/submission sequence), and state the admission windows — row admission closes with Phase 1 (earlier once any row starts preparation or execution), while an already-registered eligible row may still be prepared during Phase 2.
- Added the host-agnostic precondition to the scoped-plan PM transport note: a conditional extra-primary launch is available only for a plan row the coordinator has already registered and prepared, and whose feature worktree exists — a row that does not yet exist cannot be launched, because row admission closes with Phase 1.
- Added the **six-item scoped-route dispatch checklist** to the OMP host reference's optional transport section: a fresh target session, a prepared (not merely registered) row, handover content frozen before preparation with only the Assignment hash re-checked at bind (`coordination.assignment-stale`), a single initial submission, readback-confirmed execution with single-key recovery only, and post-bind steering — bounding *exactly once* to the initial command. The trailing-Enter behavior stays a field observation of a transport CLI this repository does not own.
- Named the **supported cross-session dispatch path** in the shared dispatch gates: concurrency across separate primary sessions or terminals has exactly one supported form — the scoped route with a prepared Assignment as a fresh session's first instruction; a coordinator-authored leaf Assignment sent through a terminal prompt is unsupported because it bypasses scoped boot, lease ownership and handoff.
- Reshaped the **OMP diagnostic notices** onto one shared title shape (`packages/omp/src/notices.ts`): a status-bearing title states the observed workflow's `id` and `status` verbatim from a successfully read snapshot, and a fallback title names the observed condition while asserting no workflow status. The Phase-2 adapter now carries the typed observed id/status through its internal probe/sampling/diagnostic path instead of emitting the fixed `Phase-2 observation inactive` prefix, keeps the refusal code in the detail, and preserves the one-diagnostic-per-code-per-generation bound. The notice custom-type literals are declared only in the shared module.

- Version alignment with harness **3.11.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.0**.

## [3.10.3] - 2026-09-17

### Changed

- Version alignment with harness **3.10.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.3**.

## [3.10.2] - 2026-09-17

### Changed

- Version alignment with harness **3.10.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.2**.

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
