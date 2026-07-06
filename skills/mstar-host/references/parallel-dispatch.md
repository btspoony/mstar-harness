# Parallel dispatch (invoke-capable hosts)

Shared PM dispatch contract for **any** host that uses subagent / Task / named-role invoke (OpenCode, Cursor Task, Codex only when a callable multi-agent / Task tool is actually available). Process SSOT also in `mstar-dispatch-gates`.

If the active host has no callable invoke tool, this reference does not create delegation capability — mark dispatch **`Blocked`** and report to the user. Do not substitute PM-thread or single-session role execution unless the user explicitly overrides harness dispatch for this turn.

## Paste-only failure

Printing `## Assignment` in the main thread **without** matching host invocations is **not** delegation; downstream work **does not start**. Parallel dispatch makes this worse (N Assignments printed, zero invokes).

## Prerequisite vs dispatch turn

- **Prerequisite turn** (optional): `bash` / `read` / `glob` / `grep` to collect facts (`merge-base`, `Review range`, `git rev-parse`, paths). **Do not** emit **any** batch dispatch in this message unless `N = 1` and that single call *is* the dispatch.
- **Dispatch turn** (when `N ≥ 2`): the **first** message that emits **any** dispatch for the batch must contain **all `N`** invocations. If not ready for all `N`, emit **zero** dispatches — finish prep, then one message with **`N`** calls.

## Mandatory order (dispatch turn)

1. Finalize all `N` Assignment payloads (after any prerequisite turn).
2. Count distinct `Execute as` sessions (`N`).
3. Issue **`N` host invocations first** — OpenCode: **N `task` tool** calls with **subagent**; Cursor: **N `Task`** with `subagent_type`; each with one Assignment body. For parallel work, **all `N` tool calls in one assistant message** when the host allows.
4. Optionally post a short **Status Update** after invocations (audit trail only — does not replace step 3).

## Hard rules

- **Emit zero until batch-ready**: if `N ≥ 2` and only one invoke is possible now, **do not** send that one; complete payloads, then **`N` in one message**.
- Do not end the dispatch turn until **`N` invocations emitted**, or mark `Blocked` / `dispatch incomplete`.
- Dual-track implement: **`N = 2` ⇒ two invocations in one message** when parallel is required.
- Status Update on dispatch turns: **`Subagent invokes issued: N`** (must match Assignment count). If Assignments were written but `N = 0` → **`dispatch failed — paste-only`**; fix next message.

## QC tri-review (initial wave)

- Launch `qc-specialist`, `qc-specialist-2`, `qc-specialist-3` in **one** dispatch turn (**N=3** invocations, one message).
- Do not claim parallel QC unless all three were issued in that turn.
- Post-dispatch: verify three distinct agent IDs and intended model mapping; on mismatch → invalid dispatch, re-dispatch before consolidation.

## QC targeted re-review (after fixes)

- Assignment: **`QC re-review: targeted — reviewers: <role-ids>`** → **N** = listed seats only (1–3), **one** dispatch turn with **N** invocations.
- Do **not** default to three invocations after a routine fix round.
- Post-dispatch: verify only **dispatched** seats returned; PM updates same `qc-consolidated.md` (see `mstar-plan-artifacts/references/plan-files-and-reports.md`).

## Self-check before send

1. Required assignments this turn? (`N`)
2. Prerequisite-only message? → **zero** batch dispatches unless `N = 1`.
3. Dispatch message contains **exactly `N`** invocation calls?
4. QC initial tri-review → **exactly 3** in one dispatch message? Targeted re-review → **N** = Assignment reviewer count?
5. Previous message was prerequisite-only → this message must include **all `N`** (not “QC1 first”).
