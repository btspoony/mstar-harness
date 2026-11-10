# ADR: Name the completion carrier after its gate, not a retired seat

Status: implemented — the completion payload member is `acceptance`, the prepare flag is `--acceptance-gate`, and stored rows written as `qa` read through one acknowledgement.
Date: 2026-11-11

Scope: `packages/engine/src/coordination-transitions.ts`, `coordination-write.ts`, `execution-coordination.ts`, `execution-import-rows.ts`, `store-db.ts`, `packages/commands/src/families/plan.ts`, and the skill prose that documents the completion payload.

## Problem

`QA` is not a role, seat, gate or report in this system: acceptance is the primary project-manager's L4 duty under the fixed `pm-acceptance` gate. The corpus already renamed role language (`docs/adr/implemented/process/2026-11-10-skill-corpus-optimization-errata.md` §3), and a prior record moved the visible report name off `qa.md` (`docs/adr/implemented/process/2026-11-11-pm-acceptance-report-basename.md`). The completion payload member was the remaining `qa`-named surface: `qa: {gate, decision, report}`, the `--qa-gate` flag, the `qa.report` evidence label, and the refusal text that names them.

The cost is a reader-facing one. A completion record is the durable statement of who accepted a plan and on what evidence; when its only acceptance member is spelled `qa`, every reader has to learn that the fourth reviewing party it implies does not exist, and the label invites re-introducing a QA seat into routing prose. The evidence label has the same defect in a harder place — a path refusal that reports `qa.report` points the operator at a field the payload documentation no longer describes.

## Decision

The completion payload's acceptance member is `acceptance`: `acceptance: {gate, decision, report}`, with `gate` still fixed to `pm-acceptance`, `decision` to `pass`, and `report` a real existing path. The prepare input is `acceptanceGate`, surfaced as `--acceptance-gate`; the evidence label it emits is `acceptance.report`; refusals and recovery sentences name the new member and flag.

Writes emit `acceptance` only. A previously stored completion row carrying `qa` is accepted by the row validator and read back through exactly one normalization point, so `plan show`, `status validate`, worktree cleanup, projection and export keep serving historical rows unchanged. A new submission carrying `qa` is refused before the generic unexpected-key refusal, so the message names `acceptance` and the recovery. The file-state import path maps a legacy handoff's `qa` member to `acceptance` as it records it, and the two mappers state their preference explicitly: a legacy **file-state handoff** carrying both members maps to `acceptance` (the new member wins, `handoff.acceptance ?? handoff.qa`), while a **stored row** carrying both is malformed and refused by the row validator. That asymmetry is deliberate — an import is a one-time transcription whose input is not governed by the row contract, whereas a stored row is the contract itself and two acceptance members cannot be reconciled.

The stored prepare configuration keeps its `qa_gate` key. That member is the plan's prepared configuration, not the completion carrier: it was never a statement of who accepted what, and renaming it would need a schema migration with no reader benefit.

## Alternatives considered

- **Keep `qa` and add a clarifying comment.** Lost: the comment lives in prose and code, while the carrier is what a completion record and a refusal message actually show. The errata already established that a retired seat named in transport invites its reintroduction; a comment cannot stop a future reader from treating the member as a QA-owned verdict.
- **Write both keys.** Lost: two writable spellings make "which member is authoritative" a per-writer question, and every reader would need the merge rule. The rename's whole point is that one member states the acceptance.
- **Keep the flag as an alias.** Lost: a deprecated `--qa-gate` keeps the retired name on the command line indefinitely, and the help/refusal surface would then document two names for one fixed-value constraint. The engine's contract already refuses retired verbs and flags rather than aliasing them.
- **Migrate stored rows to `acceptance`.** Lost: it rewrites completed history — the evidence bytes a completed row is supposed to preserve — for a spelling change no reader needs, and it needs a schema migration and a store epoch this change does not otherwise touch.
- **Rename only the report file name.** Lost: that is the prior record, and it left the payload, its flag and its evidence label untouched, which is the remaining defect.

## Consequences

- New completions, prepare calls, help text, refusals and evidence labels use `acceptance`; no live skill documents `qa:` or `--qa-gate` as a surface.
- Historical completion rows remain readable without a migration. The acknowledgement is read-only and single: writes never emit `qa`, and there is no alias for a second writer to depend on.
- The prepared configuration's `qa_gate` key stays as it was, so prepared rows need no migration and prepare replay semantics are unchanged. The skills state that it is prepare configuration, not the completion carrier.
- A stored row that carries both members is malformed rather than merged; the normalization point returns nothing for it, so the row validator reports it the same way it reports any other invalid completion.
- Any external script or agent that submits `qa` must switch to `acceptance`; it is refused with a message naming the new member and the exact retry, so the failure is self-describing rather than silent.
