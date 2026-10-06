# ZCode Plan Mode × Harness Dual-Write Bridge

> **Load order**: Read **`mstar-harness-core`** first, then **`mstar-host`** and **`references/zcode.md`**, then **`references/_shared/plan-mode-bridge-core.md`** (shared contract) + this bridge. When Plan mode is active, also read **`mstar-conventions`** and **`mstar-artifacts`**. Path symbols `{HARNESS_DIR}`, `{PLAN_DIR}`, `{SPECS_DIR}` are defined in `mstar-conventions`. On conflict, **`mstar-harness-core`** wins.

**Shared contract** (dual-write SSOT rule + priority, bootstrap init, Build resume contract, bootstrap todos, implement done-gate, Phase 1 gate, shared anti-patterns) → **`references/_shared/plan-mode-bridge-core.md`**. This bridge covers ZCode plan-UX specifics only.

ZCode **Plan mode** (`EnterPlanMode` / `ExitPlanMode`) uses read-only exploration for design and a plan approval gate before implementation; the session todo list is a **session UX mirror** — **NEVER** cite only a session todo list path in Assignment **Plan Path**, **Context Loaded**, or Completion Report when `{PLAN_DIR}/<plan-id>-<name>.md` should exist.

## When this applies

- ZCode **Plan mode** is active (`EnterPlanMode` succeeded).
- Morning Star plugin is installed (`.zcode-plugin/plugin.json` skills loaded) or **`/morning-star-harness:pm`** / **`pm` skill** is in use.

## Plan mode workflow (dual-write)

| Step | ZCode session | Harness SSOT |
|------|---------------|--------------|
| Enter | `EnterPlanMode` — explore read-only | Ensure `{HARNESS_DIR}` exists; register store-backed workflow/plan rows through public producer when known (file state only pre-activation) |
| Design | Draft plan content; surface via `ExitPlanMode` plan text | Mirror main plan to `{PLAN_DIR}/<plan-id>-<name>.md` with task checkboxes |
| Clarify | `AskUserQuestion` for blocking ambiguity only | Record decisions in plan / spec when durable |
| Exit | `ExitPlanMode` — user approves plan to implement | SSOT plan locked; store-backed plan row updated through public plan verbs |
| Implement | Agent mode resumes | Per-task commits, Working branch, dispatch per `mstar-dispatch-gates` |

`TodoWrite` and ZCode UI todos are **session progress only** — sync meaningful state to SSOT plan checkboxes and the store-backed plan row via public plan verbs (snapshot files only pre-activation) when coordination requires it.

## ExitPlanMode gate

Host plan approval (`ExitPlanMode`) is **not** Morning Star **Done** (gate → core). Implementation still follows phase gates, per-task commits, QC, and QA per the SSOT plan.

## `mstar-iteration` Phase 1

For iteration Phase 1, the shared core overrides early formal dual-write: one session carrier → §1.2.5 package prototype feedback/current-design approval → §1.3 drafts → selected product/architect Review & Edit → mandatory writer last. Design approval is not `ExitPlanMode` implementation permission. If Plan mode disallows package writes or needed invoke, retain pending steps in the carrier and use normal **`ExitPlanMode`** to resume **prototype preparation only**, not product implementation or approval of an unseen design. Reload `mstar-harness-core` + **`zcode.md`** and resume PM orchestration on the same paths; formal Review / integration still obey host approval. Autonomous opt-in retains a prototype without routine human sign-off.

## Enforcement

Conflict with harness invariants → **`mstar-harness-core`** wins. Full Cursor CreatePlan bridge detail lives in `cursor-plan-mode-bridge.md` when hosts differ; ZCode uses this lighter Enter/Exit bridge only.
