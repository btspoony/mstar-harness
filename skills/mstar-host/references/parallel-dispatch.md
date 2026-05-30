# Parallel dispatch (OpenCode + Cursor)

Shared PM dispatch contract for **any** host that uses subagent / Task / named-role invoke. Process SSOT also in `mstar-dispatch-gates`.

## Paste-only failure

Printing `## Assignment` in the main thread **without** matching host invocations is **not** delegation; downstream work **does not start**. Parallel dispatch makes this worse (N Assignments printed, zero invokes).

## Prerequisite vs dispatch turn

- **Prerequisite turn** (optional): `bash` / `read` / `glob` / `grep` to collect facts (`merge-base`, `Review range`, `git rev-parse`, paths). **Do not** emit **any** batch dispatch in this message unless `N = 1` and that single call *is* the dispatch.
- **Dispatch turn** (when `N ≥ 2`): the **first** message that emits **any** dispatch for the batch must contain **all `N`** invocations. If not ready for all `N`, emit **zero** dispatches — finish prep, then one message with **`N`** calls.

## Mandatory order (dispatch turn)

1. Finalize all `N` Assignment payloads (after any prerequisite turn).
2. Count distinct `Execute as` sessions (`N`).
3. Issue **`N` host invocations first** (subagent / Task / `@agent-id`), each with one Assignment body. For parallel work, **all `N` tool calls in one assistant message** when the host allows.
4. Optionally post a short **Status Update** after invocations (audit trail only — does not replace step 3).

## Hard rules

- **Emit zero until batch-ready**: if `N ≥ 2` and only one invoke is possible now, **do not** send that one; complete payloads, then **`N` in one message**.
- Do not end the dispatch turn until **`N` invocations emitted**, or mark `Blocked` / `dispatch incomplete`.
- Dual-track implement: **`N = 2` ⇒ two invocations in one message** when parallel is required.
- Status Update on dispatch turns: **`Subagent invokes issued: N`** (must match Assignment count). If Assignments were written but `N = 0` → **`dispatch failed — paste-only`**; fix next message.

## QC tri-review

- Launch `qc-specialist`, `qc-specialist-2`, `qc-specialist-3` in **one** dispatch turn (**3** invocations, one message).
- Do not claim parallel QC unless all three were issued in that turn.
- Post-dispatch: verify three distinct agent IDs and intended model mapping; on mismatch → invalid dispatch, re-dispatch before consolidation.

## Self-check before send

1. Required assignments this turn? (`N`)
2. Prerequisite-only message? → **zero** batch dispatches unless `N = 1`.
3. Dispatch message contains **exactly `N`** invocation calls?
4. QC tri-review → **exactly 3** in one dispatch message?
5. Previous message was prerequisite-only → this message must include **all `N`** (not “QC1 first”).
