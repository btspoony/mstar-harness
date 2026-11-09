---
module: git worktree + cross-package build (engine dist → CLI/dsh/judgment suites)
date: 2026-09-15
last_updated: 2026-09-25
problem_type: tooling_decision
category: tooling-decisions
severity: high
plan_id: 20260915-plan-coordination
applies_when:
  - "Verifying a package that consumes another package's built dist"
  - "Running typecheck or tests in a freshly created (or long-lived) git worktree"
  - "Reading an earlier green run as evidence for a merged-state claim"
  - "A combined batch in an integration worktree goes red right after a fix wave lands"
tags:
  - git-worktree
  - stale-dist
  - false-green
  - false-red
  - cross-package-verification
  - build-freshness
---

# Worktrees do not carry dependencies or dist: rebuild before you measure

## Context

Worktree isolation isolates *tracked bytes*. It does not isolate build inputs:

- `git worktree add` materializes the tracked tree only — no `node_modules`.
- Shared package build output (`packages/*/dist`) is gitignored, so a new checkout has none and a long-lived checkout has whatever was built last.

Cross-package verification is the normal path in this repo: the CLI suite spawns the real CLI entry and resolves `@mstar-harness/engine` through the engine's `dist`. When that `dist` is stale, the consumer is tested against the *previous* contract.

Measured cost of skipping the rebuild, in one iteration: `bun test packages/cli` reported **768 pass / 0 fail** against an engine `dist` built before a contract change. Against a freshly rebuilt engine the same suite — with the same fixture revision — measured **764 pass / 4 fail**, and the four failures had one cause: an evidence key list the engine had tightened, so four integration cases failed at the same setup step. The earlier green was not a weaker measurement of the same thing; it was a green against the old contract. Rebuilding after fixing the fixture produced 768 / 0 against the fresh build, and no other CLI test in that package had been green only against the old `dist` — established by measuring both fixture revisions against one fresh build.

The same iteration also produced the mirror-image mistake in a dispatch brief: it asserted that dependencies and `dist` were already installed and built in a fresh worktree. They were absent; `bun install --frozen-lockfile` installed 414 packages in ~1.6 s. A brief must never assert a worktree's environment state.

A later iteration measured the same mechanism in the **opposite direction**: a combined batch in the integration worktree reported two failures against a `dist` built before that round's fix wave, and rebuilding the packages the batch resolves made the identical run green (564 pass / 0 fail across 12 files). A stale producer build therefore yields false strength *and* false alarm from one cause — the consumer was exercised against code that is not the code under review — and the false alarm is the more expensive of the two when it lands next to a fix wave, because a plausible red is hard to distinguish from the fix having broken something.

## Guidance

1. **Make worktree readiness an executed step, in this order, in *your own* worktree** — and record the observed output in the round report:
   - `test -d node_modules || bun install --frozen-lockfile`
   - `bun run --cwd packages/engine build` — plus **every other package whose `dist` the run path resolves** (the cross-package batches here resolve `engine`, `judgment` and `cli`), not only the package a plan names as the dependency
   - the package typecheck (`bunx tsc --noEmit -p packages/<pkg>/tsconfig.json`) → exit 0
   - only then the selected test selectors
2. **Name the build every number ran against.** Capture the dependency `dist` fingerprint (sha256 + mtime) or state "rebuilt this round from `<commit>`" next to the counts. A suite reported green without the build identity is not evidence.
3. **Treat a green-against-stale-dist run as a pass of the old contract.** An earlier green is reusable as evidence only while the dependency build it exercised is unchanged; once the dependency source moves, the consumers must be re-measured.
4. **Attribute a red in a worktree batch to the build before attributing it to the change.** Rebuild the resolved packages and re-run the same batch before opening a fix: a failure against a `dist` that predates the round measures the old contract, so it names neither the new code nor a real regression. Record the pre-rebuild failure and the post-rebuild result together — a red that disappears on rebuild is evidence about the environment, and reporting only the green hides which run was measured.
5. **Re-measure both ways instead of inferring.** Run the affected package against one fresh build with the pre-fix fixture and with the post-fix fixture; then "the rebuild masked N failures" is a measured count with a named cause, not a hypothesis.
6. **Keep the environment step out of the diff.** `bun.lock` and `package.json` must stay unmodified (`git status --porcelain` empty; `git diff -- <lockfile>` empty). An install that rewrites the lockfile is a repo change to review, not environment setup.
7. **Do not widen the write set to chase what the rebuild exposes.** Report each additional failure with counts and cause to the owning track instead of fixing adjacent packages inside a scoped round.

## Why This Matters

The stale-dist false green is self-concealing: the old build accepts the old input shape, so the suite that *should* break stays green, and the defect survives to the integration or PR boundary where it is far more expensive. It also silently invalidates a whole class of claims — "the merged state measures green", "the consumer contract is unchanged" — because the consumer was never exercised against the new producer.

The same staleness in the false-alarm direction costs a round differently: the failure is real and reproducible, so it reads as the fix having broken a consumer, and the natural response — debug the change or widen the fix — spends effort on code that was never in the failing path. Both directions are removed by the same one-command remedy, which is why the readiness step is unconditional rather than reserved for suspicious runs.

## When to Apply

- Any round that starts in a freshly created worktree, or in a worktree whose dependency sources moved since its last build.
- Any verification where the package under test resolves another package's built output (here: CLI suites → engine `dist`).
- Any merged-state or post-merge re-measurement.
- A combined batch in an integration worktree that fails right after a fix wave lands: rebuild the resolved packages before treating the failure as a regression.
- Any dispatch brief that would otherwise claim the worktree is ready — state the verification step instead.
- When interpreting an earlier green: check which build produced it before reusing it.

## Examples

- *Readiness block that worked:* a plan's global constraint required every implementer round to run `test -d node_modules || bun install --frozen-lockfile` → `bun run --cwd packages/engine build` → package typecheck → selectors in its own worktree, recording exit codes; the round that followed it reported the install (414 packages, ~1.6 s), the build exit 0, typecheck exit 0, and an unmodified lockfile.
- *Fresh-build re-measurement:* the two packages react differently, which is exactly why the rule is per-consumer — the engine package tests its own source, so the stale `dist` cannot move it (its counts changed only when cases were added: `1532` when the cross-package re-measurement ran, `1534` after two hardening fixtures, `1538` at the plan tip), while the CLI package consumes the engine `dist` and moved `768/0` → `764/4` on the pre-fix fixture and back to `768/0` on the post-fix fixture — all measured against one fingerprinted engine `dist`.
- *Cross-package freshness as a plan constraint:* the plan carried a mandatory note that a suite passing against a stale `dist` is not evidence, that the depended-on package must be rebuilt before any CLI run, and that every merged-state claim must be re-measured after a fresh build. Review dispatches repeated the rule ("report green without naming the build it ran against" was listed as a forbidden action).
- *Stale `dist` producing a false alarm:* a combined 12-file batch in the integration worktree reported 2 failures while the worktree's package builds predated that round's fix wave; rebuilding the resolved packages (`engine`, `judgment`, `cli`) made the same batch 564 pass / 0 fail. The integration record keeps both numbers side by side so the pre-rebuild result is read as an environment artifact rather than as a regression the fix wave introduced.

## Consolidation note

`tooling-decisions/skill-eval-baseline-operations.md` carries the same obligation as one operational bullet for the eval runner ("fresh worktrees must `bun install && bun run engine:build` before tests"). The scopes differ — eval-run operations vs. cross-package verification generally — so this doc owns the mechanism, the measured false-green evidence and the reporting rule; a future `mstar-compound-refresh` pass over the tooling-decisions category can decide whether the bullet should be reduced to a pointer here.

## Source

Iteration `iter-20260915-scoped-plan-pm`, plan `20260915-plan-coordination`. Evidence in the plan's SDD bundle: the CLI task report `task-2-report.md` (§Verification round: fixture catch-up — the 768/0 vs 764/4 table, the dist fingerprints, and the masked-failure census) and `task-1-fix2-report.md` (§Verification round: integration-HEAD proof case — the worktree whose `node_modules` and `dist` were absent). The plan's own Cross-package evidence freshness clause records the rule at planning time.

The false-alarm direction comes from iteration `iter-20260925-v4-phase4`, plan `20260925-roadmap-store-authority`: the pre-rebuild failure count, the post-rebuild 564 pass / 0 fail over 12 files, and the rebuilt package set are recorded in that plan's integration progress note and its consolidated review, under `{SDD_DIR}/20260925-roadmap-store-authority/`.
