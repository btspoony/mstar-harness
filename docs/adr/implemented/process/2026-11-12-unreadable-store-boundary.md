# ADR: A store that cannot be inventoried is preserved as evidence and rebuilt on a fresh control root

Status: implemented — no online recovery path exists for a store no reader can inventory, and inventing one would trade evidence for silent data loss.
Date: 2026-11-12
Scope: the `store.corrupt` refusal on the `project` and `status` family surfaces; the `store execution restore-preview`/`restore` boundary.

## Problem

`store.corrupt` is the code a store emits for two very different situations. One is a *reader-version* mismatch: the row is intact and a different build reads it (see `2026-11-08-harness-operational-traps.md`). The other is a store that cannot be inventoried — a file no reader can open (a torn copy, a zero-length file, a directory where `store.db` should be), or a store that opens but fails its own verification, whether on a malformed authority row or on a failed integrity check. The refusal text treated both as "restore a backup": it offered `mstar store restore` and told the operator to re-initialize a fresh harness.

Both halves were wrong for the second case. `store.execution.restore-preview` and `store.execution.restore` build their inventory from the **live** store: the preview compares a backup image against what the live store currently holds row by row. A store that cannot be inventoried has no comparison to make, so there is no online restore to run — the advertised verb refuses in turn. And "restore a backup" is the one instruction that destroys the evidence: the store's bytes are the only record of what the authority held, whether for a later salvage attempt or for a report. An operator who follows the text loses the case it was describing.

The remaining question the text never answered: with authority unreachable, what does an operator actually do? A rebuild has to avoid two further hazards — writing a fresh store over the unreadable one, and relocating it so far from the repository that the `.mstarc`-declared corpus paths stop resolving.

## Decision

The unreadable-store boundary is by design, and both refusal surfaces state it:

- **The bytes are preserved, untouched.** The text never instructs deleting or renaming `store.db`, never changes global configuration, and never mentions `mstar store restore`. It names the boundary — a store that cannot be inventoried is not restorable online, because preview and restore both need a successful inventory of the live store — and makes `store execution restore-preview` the operation that settles whether the live store can still be inventoried at all. Preserving the bytes is the accepted answer either way.
- **Continuation happens on a fresh harness inside the existing repository.** The prescribed location is the repository's ignored `.mstar` child (for example `<repo>/.mstar/recovered-control`), so the original store is untouched and the existing `.mstarc` corpus paths still resolve.
- **Bootstrap runs through the public interface, in one published sequence,** with the explicit override on every operation: `MSTAR_HARNESS_DIR=<fresh-absolute-harness> mstar harness scaffold <existing-repo-root>` (the scaffold takes the **repository root**, not the harness directory) → `mstar store init --harness <fresh-absolute-harness>` → `mstar catalog discover --harness <fresh-absolute-harness>` and any reviewed `mstar catalog import --harness <fresh-absolute-harness>`.
- **The rebuild recovers no authority.** The text says plainly that the fresh root holds no original authority, issues or execution history; the preserved bytes stay unverified evidence, never "recovered" and never "permanently lost".

No new verb and no product mechanism was added: the whole answer is composed from catalogued commands, so the refusal lint can prove every advertised route exists.

## Alternatives considered

**Keep "restore a backup" and let the operator discover preview refuses.** Rejected: the text then names a route that cannot run on the very store it describes, and the fallback it implies — delete the unreadable file and re-run — destroys the only evidence of what the authority held.

**Give the store an online recovery verb for an unreadable file.** Rejected: recovery from nothing is fabrication. The inventory the restore path is built on cannot be produced, so any such verb would either report success over an empty store (silent data loss reported as a successful restore) or refuse — a new verb that always refuses is a worse refusal surface than the existing one.

**Preserve the bytes but describe the rebuild free-form ("re-initialize a fresh harness").** Rejected: the previous text did exactly this, and an operator following it lands on the default `<repo>/.mstar` — the directory holding the unreadable store — where scaffold and `store init` collide with the evidence. The exact `MSTAR_HARNESS_DIR` + `--harness` forms are what keep the rebuild off the original bytes.

**Put a fresh control root outside the repository.** Rejected as the prescribed location: it resolves the collision but breaks `.mstarc` corpus paths, which are declared relative to the repository. The ignored `.mstar` child satisfies both constraints at once.

## Consequences

- **No history recovery, and that limitation is the answer.** An operator continuing after an unreadable store starts from an empty authority and re-registers what they need. The text states this instead of implying the rebuild restores prior state.
- **Salvage stays an unverified later effort.** The bytes remain where they are for a future attempt; the project claims neither that salvage succeeds nor that the data is gone.
- **Two surfaces must stay in step.** `project.ts` (`RECOVERY["store.corrupt"]`) and `status.ts` (`authorityRecoveryHint`) carry the same statement in their own voice; a change to the boundary belongs on both.
- **The text is long, and that is deliberate.** The refusal is the only place an operator meets this boundary, and the ADR is not where they look mid-failure; the operational command forms live in the text, the why lives here.
- **The boundary is covered behaviourally.** `packages/cli/test/unreadable-store-recovery.test.ts` proves, in one isolated fixture, that the refusal keeps its code and names supported verbs, that the published sequence bootstraps a usable harness, and that the corrupt bytes are byte-identical afterwards. No test pins the sentences.
