# CONCEPTS.md

Project-specific vocabulary for the Morning Star harness. Terms here carry precise meaning in this codebase; skills and knowledge docs cite them without redefinition. General programming vocabulary lives elsewhere.

## Harness workflow

### Programmatic split
The partition of `mstar-*` skill content into **programmatic** rules (deterministic, machine-checkable: schemas, state machines, path conventions, pass/fail gates) and **judgment** behavior (tone, identity, review verdicts, conversation) — the programmatic subset is implemented by the shared TS engine while skills remain the semantic SSOT for both halves.

An **Engine check callout** is the advisory blockquote (`> **Engine check (when available):** …`) a skill uses to point at the checkable surface. It is never a load-order dependency: the skill body states every rule in prose and works fully with the engine absent. Engine rules trace to cited skill sections, and a drift lint keeps callouts and exports in sync.

### Harness root
The directory that owns a project's harness process artifacts (status registry, plans, iterations, knowledge) and anchors all harness path resolution. Discovery probes the conventional names in order and takes the first existing candidate; a repo whose harness root uses any other name must supply an explicit override, which wins over probing. Resolution fails closed: a linked worktree without a control root never resolves or creates harness trees under the feature checkout.

### Enforcement flag
An opt-in declaration that escalates engine validators from warn-only to blocking gates for one dispatch or one iteration. Scope is strict: an Assignment flag is read from the header region only (body examples never count), and a compass flag counts only while the iteration is `active` or `locked` — a completed iteration can never keep the repo hardened. Rollback is always unsetting the flag, and the flag is inert when the engine is absent.

### Review seat layers (L1–L4)
The four verification layers of a plan's review chain: **L1** implementer (writes code + runs evidence), **L2** task reviewer (named role `code-reviewer` by default — spec + quality for one task, diff-first, fresh per task), **L3** plan QC (named `qc-specialist` / `-2` / `-3` tri seats — whole-branch diff/logic/risk lenses, never runs suites), **L4** QA (`qa-engineer` — acceptance + residual verification). Layers are roles, not people: a seat never executes another layer's work, and L2/L3 reviewer seats are structurally read-only via their agent-shell permission profiles.
