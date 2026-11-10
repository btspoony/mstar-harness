# ADR: Name the PM Acceptance report after its gate

Status: implemented — the owning skill files now default to `pm-acceptance.md` (PR #709), and this record is the separate ADR the prior carrier carve-out required.

Date: 2026-11-11

Scope: `skills/mstar-roles/references/project-manager/acceptance.md` and `skills/mstar-artifacts/references/plan-files-and-reports.md` (default report basename only). No engine, CLI or store change.

## Problem

The PM Acceptance report's documented default file name was `{SDD_DIR}/review/qa.md`. `QA` is not a role, seat or gate: acceptance is the primary project-manager's L4 duty, recorded under the fixed `pm-acceptance` gate, and the corpus already renamed role language (`docs/adr/implemented/process/2026-11-10-skill-corpus-optimization-errata.md` §3). That ADR deliberately kept carrier spellings, including `qa.md`, unless a separate record renamed the transport — this is that record.

The cost is small but real: a reader (agent or human) looking at a plan's review bundle sees `qc1.md`, `qc2.md`, `qc-consolidated.md`, and `qa.md`, and infers a fourth reviewing seat that does not exist. The report is written by the coordinator, not by a QA role, so the file name contradicts the ownership the rest of the bundle encodes. It also invites the "QA gate" phrasing the same errata already removed from live-seat language.

## Decision

The recommended PM Acceptance report basename is `{SDD_DIR}/review/pm-acceptance.md`. The `mstar-artifacts` report table and the `## PM Acceptance Summary` pointer use that name; `acceptance.md` states it as the default, with any explicitly chosen same-directory basename still allowed.

Unchanged, deliberately: the completion payload's `qa: {gate, decision, report}` member, the `--qa-gate` CLI flag, and historical reports already written as `qa.md`. Those are wire and storage carriers — renaming them would need an engine schema/CLI migration for no reader benefit. The gate value stays `pm-acceptance`, and `qa.report` remains an arbitrary path the engine validates by existence and plan-area membership, never by basename, so both names stay valid and no stored evidence moves.

## Alternatives considered

- **Keep `qa.md` as the default.** Lost: the errata's carrier carve-out assumed these names were invisible transport. This one is not — it is the documented name every plan's acceptance report is expected to take, and it names a seat that no longer exists. Naming a report after a retired role is the same defect class the errata fixed in prose.
- **Use `acceptance.md`.** Lost: the bundle already distinguishes plan-level QC (`qc-consolidated.md`) from acceptance, but a bare `acceptance.md` reads as generic and collides with iteration acceptance language. `pm-acceptance.md` matches the gate value the engine stores (`pm-acceptance`), so the file name and the stored gate say the same thing.
- **Rename the wire member `qa` and `--qa-gate` too.** Lost: it is a storage/CLI contract with migration cost, completed rows, fixtures and historical payloads; no reader sees it in the bundle. The transport/history carve-out stays valid for wire names — only the visible default file name moves.
- **Leave the name unprefixed but add a comment explaining `qa.md`.** Lost: a comment is not read by the humans opening the bundle; the file name is.

## Consequences

- Both owning skill files state `pm-acceptance.md` as the default report basename and no longer present `qa.md` as the default; the `## PM Acceptance Summary` pointer example uses the new name.
- No engine, CLI, test, fixture or stored-evidence path changes; historical `qa.md` reports remain valid evidence, and completion records keep whatever absolute path they carried.
- `bun run validation:drift` passes with the edit (skill line budgets included).
- Repositories or agents that followed the old default keep writing `qa.md` until they read the current text. The name was a convention, not a gate input, so no migration is required — but a future errata pass must not re-introduce `qa.md` as the documented default; this record is the place to check first.
