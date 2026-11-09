---
module: execution route retirement (staged file transport → ACTIVE store) across engine, commands, CLI and host packages
date: 2026-10-10
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
applies_when:
  - "Planning or reviewing the retirement of a transport, route, or module family whose symbols have callers outside the owning module"
  - "Deciding whether a retired document kind, reader, writer, or guard may survive the cutover"
  - "Sequencing deletion waves across parallel tracks, host packages, or a terminal sweep"
plan_id: <plan-id>
tags:
  - route-retirement
  - caller-inventory
  - deletion-order
  - migration-scoped
  - terminal-sweep
  - dual-transport
related_components:
  - packages/engine
  - packages/commands
  - packages/cli
---

# Retiring a route: delete callers before helpers, and keep the migration path deliberately

## Context

Retiring a transport — here, the staged/pre-activation file execution route, so that the ACTIVE `store.db` execution authority is the only execution route — reads like a set of module-local cleanups: each module deletes the symbols that exist only for the dying route, in the wave that owns that module. The symbols do not cooperate with that attribution. A helper's last caller is routinely owned by someone else: a host package's gate, a CLI family arm removed by another wave, or a replace chain another wave has to retire first. In the plan that retired the dual transport, three helper deletions were re-scoped out of their original module waves before they could land, and the surviving exceptions had to be argued one at a time against the deletion rule.

## Guidance

1. **Inventory callers before assigning deletions — the inventory is a partial order, not a module map.** For every symbol of the dying route, record its live callers and which wave removes each caller. A symbol may be deleted only after its *last* caller; "callerless" describes one tree state, not the symbol. A module wave may delete its own route-specific arms and machinery, but the helper inventory it produces is the input to later waves, not a licence to delete everything the module once exported.

2. **Order the waves caller-first, and keep one terminal sweep.** Consumers and route arms go first (CLI file arms, host-adapter gate calls, the replace chain that still writes retired documents), shared helpers last. Give the sweep its own row whose first step is a **fresh** caller inventory — the caller set only becomes complete once the earlier waves have removed their arms. In this plan the storage-layer file-route veto helpers and the lifecycle scanner (whose last caller was a host-package gate) both landed in the sweep, after two earlier waves had each claimed them and found live callers.

3. **Hand survivors forward explicitly instead of deleting on a local reading.** When a symbol's last caller belongs to a later wave, leave the symbol in place with a marker naming the wave that will delete it, and move it onto that wave's file list. Report a *marker inventory* (deletion set vs marker set) — the next wave then starts from a work list instead of re-deriving the caller graph. Deleting a symbol that looks callerless inside one worktree is how a parallel track or an integration merge reintroduces its caller after the deletion has landed.

4. **Retain exactly the migration path the kept tooling still needs — and prove it is not a second authority.** A route retirement normally keeps its one-time importers (migrate, store upgrade/migrate/activate/retire, backup, execution export/restore). Those importers keep needing engine-internal reads and writes of the retired shapes. Keep precisely those, under all of:
   - a named permanent caller exists (the importer that stages the retired shapes);
   - the symbol is labelled at its home — package-internal (unexported from the package index) where possible; where a consumer outside the package needs it, the export site carries the scope in prose ("the retired route's bytes; read as an import source, never as authority");
   - no domain reader can use it to answer authority questions;
   - the type may keep the retired members, with the surviving scope stated in the owning module (the coordination write layer documents its snapshot writer as migration-only and its runtime file-route replacement as no longer a public operation);
   - the user-facing surface narrows to the surviving kinds and says so (the persist family's kind vocabulary is the surviving pair, an unlisted kind gets a usage error naming them, and the retired findings surface keeps a named refusal with recovery).

5. **Retention does not weaken the rule for authority-capable readers.** A retired reader that can serve authority-shaped answers — and can therefore lie with an empty success — is deleted or unexported, never converted (`store-authority-staged-lifecycle.md`). The per-symbol question is: *could any live domain reader serve this file as authority?* Yes ⇒ delete it with the route. No — the only caller is the kept importer ⇒ it may stay under (4). The screening is by consumer, not by shape: a pure evaluator whose only caller was a deleted CLI arm is deleted with the route even though it never touches authority.

6. **Screen guards by proven consumer chain, not by name.** File-route veto helpers die with the route; a guard whose consumer binds retained file-side artifacts to the live authority generation stays. `assertExecutionSessionCurrent` (over the ACTIVE read guard) survives the route retirement because retained-ledger writes call it to prove the caller's session and store epoch still name the live authority — the same words ("file", "session") appear in both classes, so record the screening decision per candidate rather than pattern-matching on the name.

7. **Close with a token sweep and an explicit allowlist.** The terminal wave greps the retired tokens across packages, skills, commands and READMEs and reports *clean or allowlisted*, where the allowlist is enumerated (migration-history wording, retired-verb stubs, negative assertions that the token is absent). "Zero hits" is not the goal — a negative assertion legitimately contains the token; an unenumerated hit is the defect.

## Why This Matters

Routing a retirement by module ownership produces two expensive failure modes and one silent one. Deleting a helper while a caller lives breaks the merged tree or leaves a hidden file-route path alive behind a caller that still compiles; the plan pays a re-plan, a re-scope and a re-review per occurrence (three here). Deleting the migration path together with the route strands the kept importer: it must then grow a compatibility shim or the writer must be re-added — exactly the backward-compatibility shape the no-compat rule forbids. Converting an authority-capable reader instead of deleting it keeps a reader that answers "no findings" from a register nobody writes any more: an empty success that outlives the route and is far harder to notice than a missing symbol.

## When to Apply

- Any multi-wave retirement of a transport, storage route, or document family whose symbols cross package boundaries.
- Before assigning deletions in a plan: build the caller inventory and derive the wave order from it.
- When a wave reports a symbol "callerless": check the claim against the merged state, not the wave's own worktree.
- When deciding whether a retired kind/reader/writer/guard may survive — run the retention test in (4)/(5).
- At the terminal sweep: re-inventory callers first, then delete, then sweep tokens with an enumerated allowlist.

## Examples

**Migration-scoped retention.** `ArtifactKind` still carries the retired `status`/`snapshot` members because `packages/engine/src/migrate.ts` stages exactly those shapes through the protected-write authorization; the CLI persist family (`packages/commands/src/families/persist.ts`) accepts only the surviving kinds and refuses the retired ones. The engine type is therefore *not* two-member — only the user-facing surface is.

**Deleted with the route.** The file-route session machinery in `packages/engine/src/coordination.ts`, the pure post-merge evaluator (callerless once its CLI file arm died; the ACTIVE evaluator `evaluatePostMergeCloseFromExecutionAuthority` serves the verb), and the storage-layer file-route veto helpers — each removed once its last caller was gone, with the merged tree loadable at every step.

**Survivor marked, then deleted in the sweep.** The lifecycle-branch scanner and the file-route veto helpers both survived two waves as *marked* survivors rather than being deleted on a local reading: the scanner's last live caller was a host package's dispatch gate that only the host wave cuts, and the helpers' remaining calls were semantic uses inside those same host arms. The sweep's caller re-inventory is what finally made them callerless.

**Retained guard, not a vestige.** `withExecutionReadGuard` (and `assertExecutionSessionCurrent` above it) stayed: retained-ledger file commits call it to prove the session and the store epoch still name the live authority generation — an ACTIVE-integrity guard, not a file-route veto.

## Source

Plan `<plan-id>` (standalone development workflow; file-route retirement R1 across engine, commands, CLI, host packages and the skills corpus) — its design annex module rows and the terminal sweep receipt in the plan's review bundle. Related: `architecture-patterns/store-authority-staged-lifecycle.md` (authority-capable retired readers are deleted, not converted), `conventions/skill-thinning-sink-convention.md` (the corpus-side retire/keep inventory discipline), `architecture-patterns/host-write-gate-store-authority-route.md` (the host seams that consumed the now-retired file-route guards).
