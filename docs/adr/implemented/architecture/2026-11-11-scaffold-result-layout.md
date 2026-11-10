# ADR: Bootstrap produces an ignored process root and tracked result corpora

Status: implemented — shipped with the scaffold bootstrap change (PR #709), which made the recommended layout the default instead of leaving every consumer repository to discover it.

Date: 2026-11-11

Scope: `scaffoldHarness` and the canonical `.gitignore` snippet in `packages/engine/src/path.ts`, the `harness.scaffold` verb in `packages/commands/src/families/local.ts`, and the path-symbol prose that describes the resulting layout.

## Problem

The bootstrap default was the opposite of the layout the harness recommends. The canonical `.mstar/` snippet ignored the process root and then re-included `.mstar/AGENTS.md`, `.mstar/knowledge/**`, `.mstar/specs/**` and `.mstar/adr/**`, while ignoring `.mstarc`. Three costs follow.

Process and results shared one directory tree: anything under `.mstar/` was ambiguous until a reader traced the fence line by line, and a stray tracked file inside an otherwise ignored root is one `git clean -xfd` away from being lost. The layout declaration could not travel with the repository: `.mstarc` was untrackable, so each clone re-derived the same non-obvious defaults, and no reviewer could see the layout a repository had chosen.

Finally, `scaffoldHarness` pre-created `.mstar/knowledge` and `.mstar/specs`. Creating them made them non-empty-shaped defaults, which is precisely the condition that stops the resolver from ever reaching its `.agents/*` rung — so the working alternative existed but was unreachable without hand-editing a `.mstarc` that nobody knew to write. The ADR corpus had the same shape of problem: an empty `{ADR_DIR}` with no buckets, no skeletons and no statement of the record contract forced the first ADR author to re-invent the format from `docs/adr/` in another repository.

## Decision

The bootstrap default is a fully Git-ignored `.mstar/` process root, tracked result corpora under `.agents/{adr,knowledge,specs}`, and a tracked `.mstarc` that declares exactly that layout.

- The `.mstar` snippet is `.mstar/` alone, and `.mstarc` is not ignored. The legacy `.agents/` snippet keeps its default-ignore-then-re-include shape, because there the process root and the results genuinely share one tree.
- `scaffoldHarness` writes `.mstarc` at the harness directory's parent when none is in scope and that parent lies inside the scaffold root: `harness_dir` is the resolved basename, and `knowledge_dir` / `specs_dir` / `adr_dir` are the three `.agents/*` keys. An existing file is never edited, and the destination path itself is guarded (`writeIfAbsent`), so an explicit nested `harnessDir` cannot overwrite an author-owned declaration at its parent.
- The process directories created under the harness directory are `plans/`, `iterations/`, `sdd/`, `reviews/` and `projects/_default/`. The tracked corpora come from the resolvers after the `.mstarc` write, so a repository that re-points a key keeps one creation path.
- The ADR tree is seeded with `README.md` (buckets, classes, filename, lifecycle), `proposed/TEMPLATE.md`, `implemented/TEMPLATE.md` and the four bucket directories. Class directories are created by the first record of that class: 24 empty directories are noise and Git does not track empty directories. The two templates are byte-identical to this repository's `docs/adr/*/TEMPLATE.md`, guarded by a test that reads those files at test time.
- The harness-layer rule file lives at `.agents/AGENTS.md`, the one location that is tracked in both layouts.
- Reruns create and rewrite nothing; present files are reported as skipped.

## Alternatives considered

- **Keep the old re-include fence.** Lost: it keeps process and results in one tree, keeps `.mstarc` untrackable, and makes every reader trace the fence to learn which files are shared. It also keeps the scaffold's pre-created `.mstar/knowledge` and `.mstar/specs` reachable, so the resolver's `.agents/*` rung stays dead code in exactly the repositories that follow the default.
- **Keep results under `.mstar/` and only stop ignoring `.mstarc`.** Lost: a tracked `.mstarc` naming `.mstar/*` corpora contradicts its own ignore fence, and the fence would have to re-include each result path — the first option again with an extra declaration to keep in sync. It also leaves the ADR tree unseeded.
- **Use `docs/` as the default result home.** Lost: `docs/` is the human documentation surface (install, quickstart, contribution), and mixing agent-facing corpora into it charges readers of one with the other. It is a fine choice for a repository that declares it — this repository declares `specs_dir=docs/specs` — but a default is not a place to move a boundary every consumer inherits.
- **Require environment variables instead of `.mstarc`.** Lost: env vars live per host and per shell session, not in the repository, so a clone cannot state its own layout and CI, a fresh checkout and a second developer disagree by default. `.mstarc` already existed, already drives every resolver, and is the only mechanism that can carry the layout with the bytes.
- **Create class directories eagerly for all six classes in four buckets.** Lost: Git does not track empty directories, so they vanish on clone, and the tree reads as a form to fill rather than four buckets that fill as decisions are recorded.

## Consequences

What this commits the project to, and what it costs:

- A fresh scaffold in an empty repository produces an ignored `.mstar/` (plans, iterations, sdd, reviews, projects/_default), the tracked corpora `.agents/{adr,knowledge,specs}`, and a tracked `.mstarc` whose four keys resolve to those corpora; the seeded ADR tree contains `README.md`, both templates and the four bucket directories; `.agents/AGENTS.md` is written at the workspace root; a rerun creates and rewrites nothing. These are the shipped behavior, exercised by the engine and CLI suites and by a fresh-repo smoke.
- Existing repositories keep whatever snippet they already carry: an author-owned `.gitignore` with a harness root declaration is never rewritten. Old layouts therefore persist until the owner edits `.gitignore` and adds a `.mstarc`, and no migration is attempted on their behalf. That is deliberate — silently rewriting a file the owner declared is worse than a stale layout — but it means the new default reaches only new scaffolds and owners who opt in.
- The scaffold writes a `.mstarc` only inside the scaffold root, only when none is in scope, and never over an existing destination. A repository whose harness lives outside its workspace gets no declaration and keeps re-deriving its layout.
- The tracked-result location is a two-part fact (`.mstarc` keys, and the resolver chains when the keys are absent). Prose that states only one of them is wrong for a repository that declares the other; the path-symbol documents state both.
- The embedded ADR skeletons are a second copy of `docs/adr/*/TEMPLATE.md`. The parity test makes a one-sided edit fail CI, so the sync duty is enforced rather than remembered.
