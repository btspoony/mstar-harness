# Architecture: system overview

## Scope

This page describes the monorepo's current package layout and the fixed layer chain a harness operation travels. It states which component owns which responsibility and where authority sits; the rationale behind those choices lives in `docs/adr/`, and the details of the state authority live in [store-authority.md](store-authority.md).

## Current state

### Repository layout

The monorepo root carries the shared TypeScript packages, the host plugins built on them, and the agent-facing content:

- `packages/engine/` — `@mstar-harness/engine`, the deterministic workflow-enforcement library: `.mstarc` and path resolution, the SQLite store and its migrations, execution authority, catalog, issues (including the `issue-sync/` subtree), roadmap and milestones, projection, and the workflow gates. Host state and gate path glue live here too.
- `packages/commands/` — `@mstar-harness/commands`, the canonical command contracts (definitions, payload schemas, effects, envelopes) shared by every surface.
- `packages/cli/` — `@mstar-harness/cli`, publishing the `mstar` / `mstar-harness` binaries: installer bootstrap (`global-cli.ts`), the command adapter that projects command contracts onto the engine (`command-adapter.ts`), and the stdio MCP server (`mcp/server.ts`, `mcp/stdio.ts`).
- Host plugins — `packages/dsh/` (`@mstar-harness/dsh`), `packages/omp/` (`@mstar-harness/omp`), `packages/opencode/` (`@mstar-harness/opencode`), `packages/opencode-v2/` (`@mstar-harness/opencode-v2`), `packages/ui/` (`@mstar-harness/ui`), `packages/judgment/` (`@mstar-harness/judgment`).
- `skills/` — runtime skills (`mstar-*` topics plus `grill-me`, `pm`), with role behavior in `skills/mstar-roles/references/`.
- `agents/` and `codex/agents/` — per-host agent shells (`.md` role shells; Codex `.toml` definitions).
- `commands/` — the seven user-facing slash commands (`iteration-start`, `iteration-drive`, `iteration-loop`, `codebase-audit`, `amazing-e2e-check`, `amazing-pr-review`, `amazing-test-audit`), indexed by `docs/commands.md`.
- `docs/` — human documentation: `commands.md`, `runtime-reference.md`, `judgment.md`, and the tracked corpora `docs/adr/`, `docs/knowledge/`, `docs/specs/`.

### Layers and data flow

A harness operation travels through fixed layers, each with one responsibility:

1. **Host surface.** A host (CLI, MCP client, or plugin hook) receives a user or agent action. Slash commands boot the `project-manager` role in-session; CLI verbs (`mstar workflow register`, `mstar catalog list`, `mstar plan show`, …) and MCP tools carry the same `@mstar-harness/commands` contracts — CLI and MCP are two projections of one contract set (`docs/commands.md`, `packages/cli/src/mcp/`).
2. **Command contracts.** `packages/commands` defines the verb families, payload field schemas, and effect envelopes; `packages/cli/src/command-adapter.ts` maps a contract invocation onto engine domain calls. Contracts are the only shape hosts and clients program against.
3. **Engine.** `packages/engine` implements the programmatic rules: path resolution and `.mstarc` reading, the SQLite store and migrations, execution authority, catalog registration and import, issues, roadmap and milestones, projections, and the workflow gates (dispatch, SDD, iteration, lint, status, worktree, PR review, QC review).
4. **State authority.** All durable execution, catalog, issue, roadmap, and projection state lands in `{HARNESS_DIR}/store.db` on the control checkout (see [store-authority.md](store-authority.md)). Feature worktrees never hold a store.
5. **Host gates.** Before any host-mediated write lands, the authority route classifies the target against the store, the retired project register, and the legacy fall-through (`host-gate-paths.ts`, imported by every host gate). Enforcing hosts (`dsh`, `omp`, the ZCode hook, and `opencode-v2`) hard-refuse direct store writes; the OpenCode v1 `tool.execute.before` surface is warn-only by documented contract.
6. **Agent content.** Skills, role references, and agent shells encode the judgment half — review verdicts, dispatch discipline, prose rules. They consume the engine through the documented engine-check commands but remain self-sufficient when the engine is absent.

### Process boundaries

- **Three-domain write model** (`CONCEPTS.md`): process SSOT lives on the control worktree's filesystem and `store.db`; tracked results (knowledge, specs, ADR, contract homes) follow Git branches; product source changes happen only in feature worktrees. A linked worktree never bootstraps a second process SSOT.
- **Engine vs skills.** The engine implements the machine-checkable subset (schemas, state machines, path conventions, gates); skills remain the semantic authority for both halves and cite the engine through engine-check callouts rather than depending on it at load time.
- **Store vs documents.** Registry-shaped facts (identity, paths, kinds, lifecycle, execution state) live in store rows; document bodies live in files. README tables are prose, never registries.

## Invariants

- **One contract set, two projections.** CLI verbs and MCP tools never diverge: both project `@mstar-harness/commands`, and a new operation lands in the contract package before any surface exposes it.
- **A single state authority.** Durable execution, catalog, issue, roadmap, milestone, and projection state exists only in the control checkout's store; no second writer, file mirror, or worktree-local store is authoritative.
- **Hosts never write the store directly.** Every host-mediated write passes the shared gate path glue, which classifies the target before any document judgment.
- **Engine and skills stay separable.** The engine owns what a program can check; skills own what requires judgment, and neither becomes a hard load-time dependency of the other.
- **Registry-shaped facts belong to rows.** Any fact used to look something up (identity, path, kind, lifecycle, state) is a store row; prose tables are navigation.

## Where it lives

| Concern | Location |
| --- | --- |
| Execution state | `execution_*` tables in the ACTIVE `store.db` (see [store-authority.md](store-authority.md)) |
| Issue, catalog, roadmap, milestone, projection authority | The corresponding table domains in the same store |
| Path and layout resolution | `packages/engine/src/path.ts`, configured by `.mstarc` |
| Command contracts and their projections | `packages/commands`, `packages/cli/src/command-adapter.ts`, `packages/cli/src/mcp/` |
| Host write gates | `packages/engine/src/host-gate-paths.ts` plus each host's gate module |
| Behavioral contracts | `docs/adr/` for decisions, `docs/specs/` for current state, `docs/knowledge/` for methodology |

This repository's `.mstarc` pins `harness_dir=.mstar`, `specs_dir=docs/specs`, `adr_dir=docs/adr`, and `knowledge_dir=docs/knowledge`, so those directories are used as declared and the candidate chains are skipped.

## Change obligations

- **New package, host plugin, skill family, or slash command** → update the repository layout in the same PR and, for a new command, `docs/commands.md`.
- **New layer, projection, or gate in the request path** → add it to the data-flow list at its actual position and state its responsibility.
- **New authority location or resolver** → update the authority table and the `.mstarc` pin statement here; a resolver precedence change also updates [document-corpus.md](document-corpus.md).
- **Rationale for a structural decision** → an ADR under `docs/adr/`, linked from here; this page states only the resulting structure.
