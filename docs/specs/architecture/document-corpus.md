# Architecture: document corpora and boundaries

## Scope

This page describes the tracked document corpora the harness maintains, what each one owns, how their directories resolve, and where registration lives. Path symbols (`{HARNESS_DIR}`, `{SPECS_DIR}`, `{KNOWLEDGE_DIR}`, `{ADR_DIR}`, `{ITERATION_DIR}`, `{PLAN_DIR}`, `{SDD_DIR}`, `{REVIEW_DIR}`, `{PROJECT_DIR}`, `{WORKFLOW_DIR}`) are resolved by `packages/engine/src/path.ts` and summarized in `skills/mstar-conventions/SKILL.md`. Process state itself is described in [store-authority.md](store-authority.md).

## Current state

### The three tracked corpora

| Corpus | Default (this repo) | Owns | Never holds |
| --- | --- | --- | --- |
| Knowledge `{KNOWLEDGE_DIR}` | `docs/knowledge/` (via `.mstarc`) | Reusable agent engineering experience and methodology: patterns, lessons, implementation SSOT crystallized at iteration-close | Current-state descriptions of the system |
| Specs `{SPECS_DIR}` | `docs/specs/` (via `.mstarc`) | Accurate description of the present state: architecture, contracts, current paths/commands; updated in place | Experience writeups, decision rationale, per-iteration drafts |
| ADR `{ADR_DIR}` | `docs/adr/` (via `.mstarc`) | Decision records among real alternatives: `proposed/`, `implemented/`, `rejected/`, `archived/` buckets; contract in `mstar-doc-corpus/references/adr.md`, this repo's tree and gate in `docs/adr/README.md` | Behavior descriptions without a decision |

Routing between them: methodology → knowledge; "how it works today" → specs; "we chose X over Y and why" → an ADR. A spec may link an ADR for the rationale behind a stated behavior; it does not restate it.

### Process-local artifacts (not tracked)

The remaining harness directories are process artifacts, gitignored, with the store as their registry or state authority:

- `{PLAN_DIR}` (`{HARNESS_DIR}/plans/`) — authored main-plan Markdown and durable gate summaries; not state authority (the plan row in `execution_plans` is).
- `{ITERATION_DIR}` (`{HARNESS_DIR}/iterations/`) — per-iteration packages (`<iteration-id>/delivery-compass.md`, `guides/`, `specs/`); promoted at iteration-close.
- `{SDD_DIR}` (`{HARNESS_DIR}/sdd/<plan-id>/`) — SDD runtime scratch and the review bundle (`review/qc1.md`…`qc3.md`, `qc-consolidated.md`); ephemeral process evidence.
- `{WORKFLOW_DIR}` (`{HARNESS_DIR}/workflows/`) — retained workflow bodies, the append-only `notes.jsonl` ledger, workflow-owned `reports/`.
- `{REVIEW_DIR}` (`{HARNESS_DIR}/reviews/`) — review run trees for codebase audits and PR/branch/diff reviews (`mstar audit scaffold` writes; `mstar pr-review report-path` resolves).
- `{PROJECT_DIR}` (`{HARNESS_DIR}/projects/`) — project files including `<id>/references/` research corpora bound to one project.
- `{HARNESS_DIR}/store.db` — the state authority itself (see [store-authority.md](store-authority.md)).

### Path resolution chains

Resolved by engine functions; each chain stops at the first non-empty candidate (empty directories count as absent):

- `{SPECS_DIR}` (`resolveSpecsDir`): `.mstarc` `specs_dir` (authoritative, skips the chain) → `{HARNESS_DIR}/specs/` → `<repo-root>/.agents/specs/` → `docs/specs/` → repo-root `specs/` → legacy `designs/` directories (read-only).
- `{KNOWLEDGE_DIR}` (`resolveKnowledgeDir`): `.mstarc` `knowledge_dir` → `{HARNESS_DIR}/knowledge/` → `.agents/knowledge/` → fallback create.
- `{ADR_DIR}` (`resolveAdrDir`): `.mstarc` `adr_dir` → `{HARNESS_DIR}/adr/` → `.agents/adr/` → `docs/adr/`.
- `{HARNESS_DIR}` itself: explicit override → `.mstarc` `harness_dir` → `.mstar` → `.agents/` → legacy `plans/` probes; probes never cross the workspace root.

This repository's `.mstarc` declares all three keys — `specs_dir=docs/specs`, `knowledge_dir=docs/knowledge`, `adr_dir=docs/adr` — so each resolution takes the declared value and skips its chain. `mstar path resolve` prints the resolved directories for all three corpora.

### Git tracking policy

Principle: process stays local; results are shared. Under the default layout, tracked results are `{HARNESS_DIR}/AGENTS.md`, `{KNOWLEDGE_DIR}/**`, `{SPECS_DIR}/**`, and `{ADR_DIR}/**`; everything else under `{HARNESS_DIR}` (plans, iterations, sdd, workflows, projects, reviews, archived, `store.db`, `status.json`) is gitignored. Cross-clone handoff is therefore knowledge + specs + ADR + AGENTS layering; a finding that must cross clones is promoted into a tracked corpus or captured as a store issue. In this repository the corpora resolve outside `{HARNESS_DIR}` (to `docs/`), so they follow normal branch tracking directly; `mstar path check` verifies the landed reality against Git, not directory names, and reports a gitignored result directory as a `path.result-ignored` warning (exit `0`) rather than a finding.

### Catalog registration

The registry for documents is the store's catalog domain (`catalog_entities`, `catalog_links`, `catalog_execution_bindings`; see [store-authority.md](store-authority.md)):

- Queries go through `mstar catalog list` / `mstar catalog show`; registration through `mstar catalog register` / `mstar catalog link` or reviewed `mstar catalog discover` + `mstar catalog import`.
- README files in any corpus (including this one) are prose navigation only — no table in them is a registry, and no document owes a README row.
- Catalog rows carry identity, path, kind, description, membership, relations, and lifecycle (`active` / `archived` / `superseded`); a revision is frozen into a plan's `execution_inputs` when registered as a plan input, so catalog edits never silently relocate an active plan.
- Because `store.db` is process-local, tracked bodies alone cannot rebuild catalog history; transport is `catalog export` + reviewed `import`.

## Invariants

- **Disjoint ownership.** Each long-lived fact has one home: methodology in knowledge, current state in specs, decision rationale in an ADR. A page never assumes another layer's job.
- **Latest-only specs.** A spec describes the present; no version suffix, date prefix, or history directory is created for it.
- **Process local, results shared.** Tracked corpora are the cross-clone handoff; store, plans, iterations, and review trees stay local.
- **README is navigation.** No README table is a registry, and no document owes a README row for its existence.
- **Declared config wins.** A `.mstarc` directory key is authoritative and skips the candidate chain for that corpus.
- **The catalog is the only document registry**, and it lives in the store; file layout alone never registers a document.

## Where it lives

- Resolvers: `resolveSpecsDir`, `resolveKnowledgeDir`, `resolveAdrDir`, and `resolveHarnessDir` in `packages/engine/src/path.ts`; path symbols are summarized in `skills/mstar-conventions/SKILL.md`.
- Declared overrides: `.mstarc` `[config]` (`harness_dir`, `specs_dir`, `knowledge_dir`, `adr_dir`, plus the process-directory keys).
- Git reality check: `mstar path check`; the harness root is gitignored in this repository's `.gitignore`.
- Registration: catalog tables in `{HARNESS_DIR}/store.db` and the `mstar catalog` verb family.
- ADR contract: `mstar-doc-corpus/references/adr.md`; this repository's tree and gate: `docs/adr/README.md`, with records filed under `docs/adr/{bucket}/{class}/`.

## Change obligations

- **New, moved, or retired corpus** → update the corpora table, both resolution lists it belongs to, the `.mstarc` pin statement, and the tracking policy in the same PR.
- **New directory key in `.mstarc`** → add it to the resolution description and to `skills/mstar-conventions/SKILL.md`.
- **Change to a resolution chain or probe order** → update the affected chain here and in [store-authority.md](store-authority.md) when the harness root itself moves.
- **Change to catalog schema or verbs** → update catalog registration and [store-authority.md](store-authority.md).
- **Change to the ADR bucket set or record contract** → update this table and `docs/adr/README.md` together.
