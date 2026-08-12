# Cursor host reference

Load when **`mstar-host`** detection resolves **cursor** (CreatePlan / SwitchMode, Task + `subagent_type`, or Cursor `/pm` flow).

Parallel PM dispatch: **`parallel-dispatch.md`** (Task tool uses same turn model).

## Cursor-only context

- Skill root: load by skill **name**; filesystem fallback → `mstar-host` § Resolve loaded skill root (`~/.cursor/plugins/local/morning-star-harness/skills/<name>/` or project `.cursor/plugins/morning-star-harness/skills/<name>/`). Never app-cwd `skills/<name>/`.
- Role prompts: `mstar-roles`; **`/pm`** or **`pm` skill** → general PM orchestration (per-plan dispatch, gates, QC) without an iteration command. Host **`commands/`** for formal iteration Phase 1–5 (semantics → **`mstar-iteration`**).
- Routing-eval: `.cursor/skills/mstar-routing-eval/` — regression tooling only; not runtime load order.

## Plan mode × harness dual-write

When **Plan mode** is active, **CreatePlan is session UX**; SSOT is **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`) — `{PLAN_DIR}/<plan-id>-<name>.md`, `{HARNESS_DIR}/status.json`.

Before first **CreatePlan**: Read `mstar-plan-conventions`, `mstar-plan-artifacts`, Prepare gates from `mstar-phase-gates` when not hotfix. Full procedure: **`cursor-plan-mode-bridge.md`**.

**Bootstrap CreatePlan todos (prefix, before implement):**

| Todo ID | Purpose |
|---------|---------|
| `harness-init` | Init `{HARNESS_DIR}`, `{PLAN_DIR}`, process-artifact gitignore set (`plans/`, `iterations/`, `sdd/`, `status.json`, …), `archived/residuals/`, `status.json` |
| `spec-register` | Register `plan_id` in `status.json.plans[]` + spec stub if applicable |
| `mirror-plan` | Write SSOT main plan under `{PLAN_DIR}/` |

Each **implement todo**: per–task-ID **git commit** on Working branch → SSOT `- [x]` → optional `status.json` sync → `git log -1 --oneline` evidence.

Before **SwitchMode → Agent**: mirror plan exists; `status.json` lists `plan_id`; bootstrap todos done. **Never** use only the Cursor plan URI as **Plan Path**.

After **Build**: treat the run as plan resume, not `/pm` replay. Reload `mstar-harness-core` + this Cursor reference, resume Morning Star plans as `project-manager` orchestration, and dispatch implementation through Task unless the user explicitly overrides the harness.

**`mstar-iteration` Phase 1 in Plan mode**: CreatePlan **once** (blank scaffold); then **feedback-driven** in-place updates on that same plan file; deferred interview only after user signals feedback-close **and** gaps remain; **do not** run Review & Edit / commit / integration branch until **Build**. Detail → **`cursor-plan-mode-bridge.md`** § `mstar-iteration` Phase 1 in Plan mode.

Enforcement: `rules/mstar-cursor-plan-mode.mdc` when plugin active.

## `/pm` precedence

1. User explicit instructions
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and `mstar-*` skills
4. `mstar-host` + this reference

## Task tool (QC: SDD → N=3)

- **`Execution mode: sdd`**: **N=3** Tasks (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) + branch review-package path (N rules → `parallel-dispatch.md`).
- **`inline`**: **N=1** per `parallel-dispatch.md`.
- SDD implement/reviewer: **serial** — implementer Task per task id with `subagent_type` matching the implementer role when listed; task reviewer = new Task with `subagent_type: "code-reviewer"` (Cursor L2 review; not qc-specialist*) when listed, else generic fallback per C5 — no `resume` for reviewers. See **`mstar-sdd`**.

## SDD sticky implementer (Cursor Task resume)

When Assignment has **`SDD implementer session: sticky`** (`mstar-sdd/references/sticky-implementer-session.md`):

| Turn | Task tool |
|------|-----------|
| **First task** (or after `fresh` reset) | `subagent_type: <Execute as>` + `implementer-prompt.md` body; capture returned **agent id** → `{SDD_DIR}/implementer-session.json` → `host_agent_id` |
| **Task 2+** | `resume: <host_agent_id>` + `implementer-continuation-prompt.md` body (new brief path + report path only) |

**Rules:**

- **1 implement dispatch ⇒ 1 Task** per task id (resume counts as the implement dispatch for that task).
- **Task reviewer**: always **new** Task — **no** `resume` for reviewers.
- After each task reviewer passes, PM updates `progress.md` and `implementer-session.json` `last_task`.
- If `resume` fails or agent id missing → reset to **`fresh`** for that task; log reason in Status Update.

## Dispatch execution（canonical）

Cursor PM dispatch = **`Task`** with `subagent_type` matching the Assignment `Execute as` role. Flat JSON field shape → **Task invoke schema (Cursor)** below.

- **1 Assignment ⇒ 1 Task**; parallel batches ⇒ **N Tasks in one message** → **`parallel-dispatch.md`** (`mstar-dispatch-gates`).
- Paste-only: Assignment Markdown **does not** start work; PM thread **must not** implement, review, or edit specialist deliverables by loading another role reference in the same session (`Acting as role: …` is **not** dispatch) → **`parallel-dispatch.md`** § Paste-only failure.
- No callable `Task` / subagent for required work → **`Blocked`** — report to user; do not substitute in-thread execution.
- **Only exception:** user explicitly overrides harness dispatch for this turn (document the override).
- Concurrent writers / QC cwd alignment → **`mstar-branch-worktree`** (not a separate “mode”).
- Implement subagents: recipient is already `Execute as`; **no** recursive Task with same `subagent_type`. Assignment wins (`Delegation: forbidden` unless stated).

## Task invoke schema (Cursor)

Cursor’s live **Task** tool expects a **flat** JSON argument object. `prompt` and `subagent_type` are **sibling fields** — not nested, not stringified. Official behavior docs cover subagents/parallel/resume; the flat field shape below is Morning Star’s operational SSOT for Cursor (live-tool contract).

### Canonical flat shape

```json
{
  "description": "3-5 word UI title",
  "prompt": "<full Assignment Markdown body>",
  "subagent_type": "<Execute as role id or built-in>",
  "model": "<optional host slug>",
  "run_in_background": false
}
```

### Required vs optional fields

| Field | Required | Notes |
|-------|----------|-------|
| `prompt` | yes | Full Assignment Markdown string (IDENTITY, gates, Plan Path, Working branch, …) |
| `subagent_type` | yes | Must equal Assignment `Execute as` (Morning Star role id when using custom agents) |
| `description` | recommended | Short UI title only (3–5 words); never the Assignment body |
| `model` | optional | Host slug from Assignment **Model tier** mapping |
| `run_in_background` | optional | Default false unless PM intentionally backgrounds |
| `resume` | sticky continue only | Omit on fresh dispatch; see sticky section |

### Must-have example (single dispatch)

```text
Task(
  description: "Implement auth middleware",
  prompt: "<full Assignment body>",
  subagent_type: "fullstack-dev",
  model: "<optional>",
  run_in_background: false
)
```

Rules:

- `subagent_type` **=** Assignment `Execute as` — never OpenCode’s `subagent` key.
- `prompt` = plain Markdown Assignment text, **not** a JSON object string of the whole call.
- `description` = UI title only; do not put the Assignment there.

### Parallel batch (N Tasks, one message)

When `N ≥ 2`, emit **N** separate Task tool calls in **one** assistant message (`parallel-dispatch.md`). Each call is still a flat object with its own `prompt` + `subagent_type`.

### Anti-patterns (do not send)

| Anti-pattern | Correct |
|--------------|---------|
| Args as one stringified JSON blob | Flat sibling fields on the Task tool |
| Field name `subagent` (OpenCode) | `subagent_type` |
| `CallMcpTool` / MCP wrap for Task | Native Task tool only |
| Missing `subagent_type` | Always set; match `Execute as` |
| Assignment JSON stuffed only into `prompt`, no top-level `subagent_type` | Both `prompt` and `subagent_type` present |
| Nested `{ "arguments": { ... } }` Task payload | Flat object at tool-call top level |
| Treating paste-only `## Assignment` as dispatch | Must emit Task call(s) |

### Self-check before send

1. Tool name is **Task** (not MCP, not OpenCode `task`+`subagent`).
2. Top-level keys include **`prompt`** and **`subagent_type`** (siblings).
3. `subagent_type` equals Assignment `Execute as`.
4. `prompt` is Markdown Assignment text, not stringified JSON of the whole call.
5. If sticky continue: `resume` + continuation prompt per sticky section; else omit `resume`.
6. If `N ≥ 2`: this message contains **exactly N** Task calls (`parallel-dispatch.md`).

### Sticky / resume (pointer)

First vs resume field set → **SDD sticky implementer (Cursor Task resume)** above. Do not restate those tables here.

- Fresh: `subagent_type` + full implementer prompt; capture agent id.
- Continue: `resume: <host_agent_id>` + continuation prompt; still flat sibling fields.
- Reviewers: never `resume`.

## Clarify

- No `question` tool: structured Markdown or Cursor UI.
- “Question asked” ≠ clarify done; high-impact ambiguity → `Blocked` or escalation.

## Execution Discipline

Implementation roles use `mstar-coding-behavior` for RCA, test-first checks, review feedback, and completion evidence. Plan checkpoints remain in `mstar-phase-gates`; external skill plugins are not required.

## Gotchas

- Single-seat and tri-review need identical `plan_id` and review scope fields.
- Task parallelism does not relax branch/worktree isolation.

## Model tier (SDD + QC)

Map Assignment **`Model tier`** to Task `model` (host-specific slugs):

| Tier | Typical use |
|------|-------------|
| `fast` | Transcription tasks; 1–2 file mechanical edits |
| `standard` | SDD prose implementer; task reviewer floor; plan QC tri seats |
| `capable` | Large branch QC diff; integration judgment |

**Turn count beats token price** — reviewers and prose implementers use `standard` floor minimum. See `mstar-sdd` SKILL.

## Project rules

Project `AGENTS.md` / `CLAUDE.md` upward from cwd override global harness defaults when they conflict with Cursor-side rules; user instructions win.
