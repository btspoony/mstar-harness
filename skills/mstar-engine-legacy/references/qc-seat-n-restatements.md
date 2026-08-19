# QC seat N restatements (per-host, archived)

> Engine-absent fallback: the per-host N=3/N=1 restatements that runtime host references (`mstar-host/references/*`) consolidate. Engine-present hosts read `mstar-host` → `parallel-dispatch.md` + `executionModeToN` instead; this file is the consolidated full restatement text.

## Canonical N mapping (any host)

| `Execution mode` | QC seats | N |
| --- | --- | --- |
| `sdd` (multi-task plan, single plan, or iteration Phase 2) | `qc-specialist` / `qc-specialist-2` / `qc-specialist-3` in **one** dispatch turn | **N=3** |
| `inline` (hotfix) / explicit `QC mode: single` override | `qc-specialist` ×1 | **N=1** |
| Targeted re-review (`QC re-review: targeted — reviewers: <ids>`) | the listed seats only | N = listed count (1–3) |

Rules that never change: tri seats dispatch **in one message** with a branch review-package path (`{SDD_DIR}/review/qc1.md`…`qc3.md` + `qc-consolidated.md`); post-dispatch verify three distinct agent ids; `Execution mode: inline` with `QC mode: full tri-review` still launches the three seats; SDD implement/reviewer dispatches stay **serial** (never parallel implementers for the same plan); each invoke must carry the role-binding field set to `Execute as` even at N=1.

## Per-host restatements (full text)

### omp (`task` tool, `agent` field)

- **`Execution mode: sdd`**: **N=3** task entries — prefer `agent: "qc-specialist"`, `"qc-specialist-2"`, `"qc-specialist-3"` when listed; each body still **Act as** the respective QC role + QC skill load. If a seat is missing from the live schema, fall back per C5 (generic + C5b) for that seat only. N rules → `parallel-dispatch.md`.
- **`inline`**: **N=1** per `parallel-dispatch.md`.
- Cannot emit required **N** → **`Blocked`**.
- SDD implement: one implementer `task` entry per task id with `agent` matching the implementer role when listed; task reviewer = new entry with `agent: "code-reviewer"` (omp L2 review; not qc-specialist*) or `agent: "reviewer"`/`"task"` fallback + C5b; serial rule → `parallel-dispatch.md`.

### opencode (`task` tool, `subagent` field)

- Parallel batch **N** = **N task tool calls** in one assistant message when the host allows (`parallel-dispatch.md`); 1 Assignment ⇒ 1 invoke.
- Prepare phase serial roles (`explore → product-manager → architect`) still require a real task-tool call per handoff (**N=1** per dispatch turn) — Assignment Markdown alone does not open subagent sessions.
- SDD task reviewer: new task tool call with `subagent: "code-reviewer"` (OpenCode L2; not qc-specialist*), no sticky resume for reviewers.

### cursor (Task tool, `subagent_type` field)

- **`Execution mode: sdd`**: **N=3** Tasks (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) + branch review-package path (N rules → `parallel-dispatch.md`).
- **`inline`**: **N=1** per `parallel-dispatch.md`.
- SDD implement/reviewer: serial — implementer Task per task id with `subagent_type` matching the implementer role when listed; task reviewer = new Task with `subagent_type: "code-reviewer"` (Cursor L2; not qc-specialist*) when listed, else generic fallback per C5 — no `resume` for reviewers.

### codex (custom-agent / multi-agent tools only)

- QC: N rules → `parallel-dispatch.md` (**`Execution mode: sdd`** → N=3; **`inline`** → N=1) when a callable invoke tool exists. Cannot emit required **N** → **`Blocked`**.
- If no invoke tool is present when dispatch is required → **`Blocked`** — report missing invoke capability; do not substitute single-session role execution in the PM thread unless the user explicitly overrides harness dispatch this turn.

### kimi (`Agent` tool, `subagent_type` ∈ {`coder`,`explore`,`plan`})

- **`Execution mode: sdd`**: **N=3** `Agent` calls (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) — each prompt **Act as** the respective QC role, all `subagent_type: "coder"` (N rules → `parallel-dispatch.md`).
- **`inline`**: **N=1** per `parallel-dispatch.md`. Cannot emit required **N** → **`Blocked`**.
- SDD implement: one implementer `Agent` per task id; task reviewer = new `Agent` with **Act as `code-reviewer`** (Kimi L2; not qc-specialist*), generic fallback `subagent_type: "coder"` per C5 — no sticky resume unless the host adds it later.

### zcode (`Agent` tool, `subagent_type` ∈ {`general-purpose`, …})

- **`Execution mode: sdd`**: **N=3** `Agent` calls (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) — each prompt **Act as** the respective QC role, all `subagent_type: "general-purpose"` (N rules → `parallel-dispatch.md`).
- **`inline`**: **N=1** per `parallel-dispatch.md`. Cannot emit required **N** → **`Blocked`**.
- SDD implement: one implementer `Agent` per task id; task reviewer = new `Agent` with **Act as `code-reviewer`** (ZCode L2; not qc-specialist*), generic fallback `subagent_type: "general-purpose"` per C5 — no sticky resume unless the host adds it later.

### dsh (`subagent` dispatches)

- **`Execution mode: sdd`**: **N=3** `subagent` dispatches — one per QC seat (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`), each body **Act as** the respective QC role + QC skill load. **MUST dispatch all three with `run_in_background: true` in one message** → the seats run CONCURRENTLY (background children; wall ≈ single seat); foreground (no `run_in_background`) runs serially (wall ≈ 3× single seat) and does NOT count as parallel tri. Cannot emit required **N** → **`Blocked`**.
- **`inline`**: **N=1**.
- SDD implement: one implementer `subagent` dispatch per task id; task reviewer = a separate dispatch (SDD review role) — no sticky resume unless the host's continuable-subagent id is available and recorded.
