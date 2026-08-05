# Host role-binding core (C5/C5b)

Shared role-binding contract for hosts where picking an invoke type alone does **not** fully replace Morning Star Assignment IDENTITY + skill load (Kimi, ZCode, omp).

Cursor / OpenCode / Codex select roles through agent config or role-id `subagent_type` / `subagent` and do **not** use this file for agent selection — follow those host references instead. Read this file from the active host reference when that host points here.

## Host classes

| Host | Invoke-type selection (C5) | Prompt role binding (C5b) |
|------|----------------------------|---------------------------|
| **Kimi / ZCode** | Built-in types only (`coder` / `explore` / `plan`, …). Morning Star role ids are **never** valid invoke types. | **Required** |
| **omp** | Prefer live-schema **`agent: "<Execute as role-id>"`** when listed (discovered from `agents/*.md`). Fall back to host generics (`task` / `scout` / …) only when the role is absent. | **Required** (skill load + IDENTITY even when `agent` already matches the role) |

## C5 — invoke type selection

- **Never invent** agent / subagent names. The **live tool schema** (plus the active host reference C5 table) is SSOT every session.
- **Kimi / ZCode:** Morning Star role ids (`product-manager`, `fullstack-dev`, `qc-specialist`, …) are **not** valid invoke types — map via the host reference table, then rely on C5b.
- **omp:** Morning Star **subagent** role ids **are** valid when the live `task` schema lists them. Set **`agent`** to the Assignment **`Execute as`** role id whenever present. Using generic `agent: "task"` while that role agent is listed is incorrect. Details → **`omp.md`** § Role agents (C5).

## C5b — role binding in prompt (required)

Every dispatch on these hosts **must** carry the played Morning Star role in the **Assignment** and in the **invoke prompt**:

1. **`Execute as: <role-id>`** in Assignment (harness routing SSOT).
2. **`Act as <role-id>`** (or equivalent) at the top of the invoke prompt.
3. **Skill load list** — instruct the subagent to read `mstar-roles` → `references/<role-id>.md` (or shared reference + parameters) and topic skills per that reference.
4. **`subagent_type` / `agent`** — pick per **Host classes** / active host C5 rules (not “always generic worker”).

Paste-only Assignment **without** an invoke call is **not** dispatch.

On **omp**, C5b remains required even when `agent` already equals `<role-id>`: the agent markdown shell routes identity, but Morning Star process skills still need an explicit load list in the Assignment body.

## Invocation rules

- **1 Assignment ⇒ 1 invoke**: one invoke call carrying the full Assignment body per assignee.
- **Parallel batch N**: **N** invocations in **one** assistant message (mechanics → **`parallel-dispatch.md`**).
- **No invoke call** → **Not dispatched** — paste-only / `dispatch incomplete`.
- **Anti-recursion NEVER**: leaf executors are already `Execute as` — **no** recursive invoke of the same role; Assignment wins (`Delegation: forbidden` unless stated). **Never** multiple implementer invokes in one message for the same plan (SDD serial → **`parallel-dispatch.md`** § SDD implement).

## Assignment / prompt template

```markdown
## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Working branch**: feat/example
**Plan Path**: .mstar/plans/20260717-example.md

**IDENTITY:** You ARE `fullstack-dev`. Act as `fullstack-dev` for this task.

Load: `mstar-harness-core` → `mstar-host` → `<host>.md` → `mstar-roles` → `references/fullstack-dev-shared.md` → topic skills per that reference.

<task body>
```

The active host reference shows the matching invoke shape (same turn). For omp, that shape uses `agent: "fullstack-dev"` when the live schema lists it — not `agent: "task"`.
