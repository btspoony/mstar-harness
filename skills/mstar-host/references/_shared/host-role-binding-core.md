# Host role-binding core (C5/C5b)

Shared role-binding contract for hosts that **cannot bind Morning Star roles via agent config** (Kimi, ZCode, omp). Cursor / OpenCode / Codex bind roles through agent config or `subagent_type` role ids and do **not** use this file. Read from the active host reference when dispatching.

## C5 — built-in invoke types only

- The host ships **built-in subagent types only**; the active host reference's C5 mapping table is the authoritative type list.
- Morning Star role ids (`project-manager`, `fullstack-dev`, `qc-specialist`, …) are **not** valid invoke types on these hosts — never invent agent names.

## C5b — role binding in prompt (required)

Because the host cannot bind roles via agent config, every dispatch **must** carry the played Morning Star role in the **Assignment** and in the **invoke prompt**:

1. **`Execute as: <role-id>`** in Assignment (harness routing SSOT).
2. **`Act as <role-id>`** (or equivalent) at the top of the invoke prompt.
3. **Skill load list** — instruct the subagent to read `mstar-roles` → `references/<role-id>.md` (or shared reference + parameters) and topic skills per that reference.
4. **`subagent_type` / `agent`** — pick from the host's built-in types only (C5 table in the host reference).

Paste-only Assignment **without** an invoke call is **not** dispatch.

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

The active host reference shows the matching invoke shape (same turn).
