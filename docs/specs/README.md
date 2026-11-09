# Project specification corpus (`docs/specs/`)

## Scope

This corpus describes the **present state** of the Morning Star harness monorepo: its architecture layers, boundaries, contracts, data flow, and current paths and commands. It answers "how does the system work today", never "why this option won among alternatives" (an ADR answers that) and never "what we learned doing it" (knowledge answers that). Every page states the code as it exists and is updated in place when the described surface changes.

The repository separates long-lived writing into three layers by purpose:

| Layer | Location | Holds |
| --- | --- | --- |
| Knowledge | `docs/knowledge/` | Agent engineering experience and methodology — reusable patterns, lessons, how-to. Not a description of current state. |
| Specs | `docs/specs/` (this corpus) | Accurate description of the project's current state: architecture, boundaries, contracts, data flow, current paths and commands. Latest-only. |
| Change history | `docs/adr/` | Architecture decision records — decisions made among real alternatives, their rationale and consequences. Filed by fate (`proposed/`, `implemented/`, `rejected/`, `archived/`) and domain class. |

## Current state

The corpus currently carries three architecture pages:

- [`architecture/overview.md`](architecture/overview.md) — system layers and data flow: repo layout, engine, commands, CLI/MCP, host plugins, skills/agents; where authority lives.
- [`architecture/store-authority.md`](architecture/store-authority.md) — `{HARNESS_DIR}/store.db` as the single state authority: table domains, execution lifecycle, pre-activation fallbacks, read/write refusal surface.
- [`architecture/document-corpus.md`](architecture/document-corpus.md) — the tracked document corpora and their boundaries: knowledge vs specs vs adr, process artifacts, path resolution chains, git tracking policy, catalog registration.

Every page follows the same sections in order — `Scope`, `Current state`, `Invariants`, `Where it lives`, `Change obligations` — and filenames carry no version number, date prefix, or iteration id.

## Invariants

- **Disjoint layers.** An experience writeup belongs in `docs/knowledge/`, a snapshot of how the system currently works belongs here, and "we chose X over Y and why" belongs in `docs/adr/` (contract: `docs/adr/README.md`).
- **Updated in place, no version suffixes.** A spec describes the latest state. Its history lives in Git and, where a change encodes a decision, in an ADR — never in a sibling `-v2` file.
- **Decisions outlive plans → ADR.** A decision whose rationale must survive the plan or PR that produced it goes to `docs/adr/`, not into these pages; a spec states the resulting current behavior and may link the ADR.
- **No plan text.** These pages contain no acceptance criteria, local plan/iteration identifiers, merge references, or `.mstar/` paths.
- **English, tracked.** Documents are English Markdown, Git-tracked.
- **The registry is the store.** The catalog registry of spec documents is `{HARNESS_DIR}/store.db` (`mstar catalog list`); tables in these pages — including this one — are prose navigation, never registries.

## Where it lives

- Bodies: `docs/specs/` at the repository root, with one subdirectory per subject area (`architecture/` today).
- Resolution: `.mstarc` `[config] specs_dir=docs/specs` is authoritative and skips the candidate chain; `mstar path resolve` prints the resolved `specsDir`.
- Registration: catalog rows in `{HARNESS_DIR}/store.db` carry identity, path, kind, description, relations, and lifecycle; registered plan inputs freeze a revision into `execution_inputs`.

## Change obligations

- **Same-PR update duty.** A change that alters a path, name, default, command, or contract described in this corpus updates the affected spec in the same PR. Specs are never left describing a previous state.
- **Adding a page.** Give it a subject directory under `docs/specs/`, use the five sections in order, link it from the index above, and register it in the catalog.
- **Removing a page.** Delete it instead of keeping a history directory; Git holds the history, and an ADR holds any decision worth outliving it.
- **Renaming or moving.** Fix every inbound link in the same change and re-register the catalog row.
