# Host role-binding core (C5/C5b)

Shared role-binding contract for **Kimi / ZCode** — hosts where picking `subagent_type` / `agent` alone cannot carry Assignment IDENTITY + skill load, so the prompt binding (C5b) is always required. On **Kimi**, Morning Star role ids are **never** valid invoke types. On **ZCode** (current versions), role ids **are** registered from `agents/*.md` — prefer the bare role id per `zcode.md` C5, with `general-purpose` as universal fallback.

Other hosts follow their own `references/<host>.md` and do **not** use this file for agent selection. Read this file only when the active host reference is Kimi or ZCode.

## C5 — invoke type selection (Kimi / ZCode)

| Host | Invoke-type selection (C5) | Prompt role binding (C5b) |
|------|----------------------------|---------------------------|
| **Kimi** | Built-in types only (`coder` / `explore` / `plan`, …). Morning Star role ids are **never** valid invoke types. | **Required** |
| **ZCode** | Registered role agents (`agents/*.md`) preferred — **bare role id** (e.g. `fullstack-dev`); `general-purpose` is the universal fallback. The plugin-qualified form (`morning-star-harness:<role-id>`) can fall back to the default prompt — avoid it. | **Required** |

- **Never invent** agent / subagent names. The **live tool schema** (plus the active host reference C5 table) is SSOT every session.
- On **Kimi**, Morning Star role ids (`product-manager`, `fullstack-dev`, `qc-specialist`, …) are **not** valid invoke types — map via the host reference table (`coder` / `explore` / `plan`, …), then rely on C5b. On **ZCode**, use the bare role id when the live schema exposes it; fall back to `general-purpose` when it does not.

## C5b — role binding in prompt (required)

Every dispatch on Kimi / ZCode **must** carry the played Morning Star role in the **Assignment** and in the **invoke prompt**:

1. **`Execute as: <role-id>`** in Assignment (harness routing SSOT).
2. **`Act as <role-id>`** (or equivalent) at the top of the invoke prompt.
3. **Skill load list** — instruct the subagent to read `mstar-roles` → `references/<role-id>.md` (or shared reference + parameters) and topic skills per that reference.
4. **`subagent_type`** — per the host C5 table: ZCode prefers the bare Morning Star role id (fallback `general-purpose`); Kimi uses the live built-in set only.

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

The active host reference shows the matching invoke shape (same turn) — e.g. Kimi `Agent` with `subagent_type: "coder"` plus this C5b body, or ZCode `Agent` with the bare role id per its C5 table.
