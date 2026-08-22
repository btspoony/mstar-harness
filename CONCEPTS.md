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

### Workflow lifecycle
An orchestrated flow (single-plan or iteration) treated as a first-class runtime entity: running state, phase machine, leases/execution policy and logs are contained in one lifecycle directory (`workflows/<id>/snapshot.json` + per-workflow jsonl); the global status table keeps only active lifecycle entries and removes them at terminal state. One lifecycle may be shared by multiple concurrent sessions; terminal state is the natural archive (no compaction ceremony). Not a *session*: a session is one agent conversation and is shorter than a lifecycle.

### Closure-verification plan
A plan whose residual's fix may already have landed — grep the current checkout (CLI surface, docs, skill callouts) before planning a re-implementation; if the work is done, re-scope to verification-only: smoke the real artifact, confirm no stale import-only callouts, fill the changeset gap if missing, close the residual in place. Prevents re-implementing a command that already exists.

## Agent canvas (dsh panel)

### Emphasis
The time-dimension opacity tier of an agent card in the agent canvas: `current` (the iteration's current phase's expected roles — full chrome strength), `next` (later-phase roles — mid transparency), `off` (already-passed or stage-less on-demand/general roles — low transparency), `null` (no active iteration — no override). Orthogonal to the spatial `bucket` and `zone` dimensions.

Emphasis fades card chrome only, by alpha-mixing toward the layer background — never whole-card `opacity`; the status point and the running ring/glow stay full-opacity (highest-priority rule). A settled entity shows the green done frame + ✓ only when `emphasis ≠ 'off'` — the completed state never appears on an off-tier role.

### Standoff
The arrow-tip retreat point of a canvas edge: the path ends 10px outside the target port, along the local tangent, so the arrowhead tip lands outside the card border instead of embedding into it (part of the H1 rule below).

### Line rules (H1/H2)
The user-finalized hard rules for every retained canvas line: **H1** — the arrow axis must align with the line's local tangent at the anchor (`orient="auto"`); **H2** — a line's render area (stroke + arrowhead) must never intersect any text bbox. Conflicts are resolved by rerouting anchors/ports — standoff retreat → side-gap routing → tangent alignment → inter-column empty bands — never by letting the line cross text.

### SDD sub-bucket
The implementor / reviewer partition of the `sdd-implement` canvas column — a layout dimension **orthogonal to expectedness**: the implementor sub-bucket also holds the on-demand ops-engineer / prompt-engineer roles, which stay outside the expected-role union (their event-log unexpected badge is unchanged). The supervise line (implementor ↔ reviewer) is the mstar-sdd mutual-supervision contract. Related: Review seat layers (L1–L4).
