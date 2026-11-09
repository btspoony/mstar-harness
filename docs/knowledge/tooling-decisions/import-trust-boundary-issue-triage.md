---
module: engine legacy import (execution-minimal-import, host-state-import), projection test seams, store upgrade refusal disclosure, retired filesystem locks
date: 2026-10-13
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: <plan-id>
applies_when:
  - "triage a review finding that asks for directory-descriptor anchoring or another TOCTOU hardening of a local file read"
  - "decide whether an environment-gated production test seam is exploitable or inert"
  - "a refusal message may understate what the command already committed"
  - "an open issue claims a retired lock mechanism still wedges writers"
tags:
  - threat-model
  - toctou
  - trust-boundary
  - test-only-injection
  - refusal-honesty
  - issue-triage
  - lockdir-retirement
---

# Split review findings by what the attacker must already have, not by severity badge

## Context

Four issues came out of the PR #471 review round: GitHub #472/#473/#474 (filed from this
round) and the older #447 "crash-leaked mkdir lockdir permanently wedges
`withStatusWriteLock` writers". They arrive with comparable badges (P1/P2, "high") but
require different amounts of work; one of them is already fixed by the very delivery under
review, and another asks for a platform-dependent hardening whose value does not survive a
threat-model reading. Triage used one test first: **what must the attacker already
possess, and what do they gain?** Facts below are file:line observations at branch
`fix/remove-directory-locks` HEAD `645195ed`; verdicts are analysis.

## Verdicts

| Issue | Attacker prerequisite | Verdict |
|---|---|---|
| #472 (I-000629) ancestor-directory replacement in both legacy importers | write access **inside** the control root (`{HARNESS_DIR}/workflows/`) | finding valid, requested fix (directory-descriptor anchoring) is **over-design** for this deployment; state the boundary instead |
| #473 (I-000626) projection surfaces parse a test-runner env value and write native rows | only a hostile invocation cwd (`Bun` loads its `.env`) plus one ordinary command | **real, fix** — same class as the two seams already deleted in this PR |
| #474 (I-000545) import refusal does not disclose prior schema/authority creation | none (honesty defect) | **real but narrow**, must fix; the general disclosure already exists and only two early-return refusals bypass it |
| #447 / I-000532 mkdir-lockdir wedge | none | **already fixed by this delivery**; the mechanism no longer exists on the branch |

## Round 2 (PR #471 fix-verification review)

All four findings in this table were fixed in `0c9d046c` (see the delivery note below); the
env seams marked pre-existing stayed out of the PR.

The provider's deep round-2 review (`pull/471#pullrequestreview-5500967555`, head
`645195ed`, verdict `blocked` 27%) filed four findings on the changed code plus two
unplanned env seams. Same test applied; none of the six is over-design, and one is a
regression this delivery itself introduced.

| Finding | Verdict | Cheapest correct disposition |
|---|---|---|
| I-000630 non-regular legacy leaf hangs `store upgrade` (must-fix) | real **regression introduced inside this delivery** (commit `8c9b194c` moved the type check after the open) | open the leaf non-blocking, then keep the fstat type refusal + a FIFO regression |
| I-000632 v1 conversion re-reads status by path (should-fix) | real; incomplete hardening, not a regression | convert from the already-verified bytes, or narrow the published guarantee |
| I-000633 upgrade receipt omits the imported source digest (should-fix) | real; engine-API-only exposure | fold the digest into the request hash |
| I-000634 nested-source skip blames the containing directory (nit) | real, wording | describe the refused source without asserting its directory is unsafe |
| I-000631 `store-activation` env-named `copyFileSync` seam | real; **pre-existing**, byte-identical to base line 1820 | same removal as the two seams this PR deleted |
| I-000626 projection env churn | real; pre-existing (above) | same removal, test-owned injection |

**#630 is the instructive one.** The file is new in this PR, and replacing a pre-open
`lstat` type check with a descriptor-bound open moved the type decision *after* the open:
`openSync(O_RDONLY|O_NOFOLLOW)` on a FIFO blocks until a writer appears, so a leftover
special file wedges a shipped maintenance command with no output, no timeout and no
recovery path — a worse outcome than the refusal it replaced, and a direct violation of the
repository's "no hard block without a way out". Cost of the correct fix is one flag plus the
refusal the code already had (`O_NONBLOCK` is a no-op for regular files). The general rule:
**when a change moves a validation from before an acquisition to after it, the acquisition
must stay bounded and non-blocking, and the new failure mode needs its own regression.**

Provenance: the file was introduced with `lstatSync` → type refusal → `readFileSync(path)`
(`636a1da0`, still present at `6b07b231`), and the open-then-`fstat` form arrived with
`8c9b194c` ("no-follow legacy source reads and tail-only crash-window identity recovery") in
this same PR. So the hang is a regression *inside* the delivery under review, not a
pre-existing condition, and it is fixed by restoring the type refusal on a non-blocking open
rather than by reverting the descriptor binding.

**#632 and #633 are claim-versus-code gaps, not boundary failures.** #632 says the published
"read through a no-follow descriptor" guarantee covers the v2 discovery read only, while the
supported v1 route re-acquires status through `readArtifactBytes` → `readFileSync`
(`migrate.ts:517`, `coordination-write.ts:153`); the earlier path-based behaviour means this
is unfinished hardening, so either consume the verified bytes or narrow the sentence. #633
says the retained receipt is bound to the request envelope, not to the input: `requestHash`
covers operation/root/operator/operationId/declarations/acknowledgements but not the
`sourceDigest` computed in the same pass, so an engine API caller reusing one operationId
across changed bytes receives a success-shaped receipt describing imports that never
happened. The public CLI mints a fresh `randomUUID` per invocation and exposes no
`--operation-id`, so reachability is the engine API — the reason this is a should-fix rather
than a must-fix, not a reason to leave a receipt able to vouch for bytes it never saw.

**#631 widens the env-seam class again.** `store-activation.ts:1382-1389` copies an
environment-named file over an environment-named target under `MSTAR_STORE_TEST_RUNNER=1`,
reachable from the shipped `store activate` route when the invocation cwd supplies a `.env`.
It is byte-identical to base (line 1820), so it is pre-existing and not this PR's regression
— but its prerequisite is *weaker* than the ancestor race in #472 (no control-root write at
all), which is exactly why the class must be removed rather than argued about. The comment
claiming the seam is inert because "no shipped CLI/plugin process can reach it" is the same
false premise already disproved twice.

**#472 stays as recorded above, now with a sharper form of the same point.** The header
comment on `readBytes` (`host-state-import.ts:55-59`) asserts that a swapped ancestor "can
never contribute another file's bytes" because the leaf descriptor is verified — true for a
swapped *leaf*, false for a swapped directory, which the open follows into a regular file
that then passes `fstat`. The cheapest correct action is therefore to correct that claim and
keep the accidental-traversal guard, exactly as the #472 verdict says; descriptor anchoring
remains a platform-matrix purchase for a prerequisite that already implies control-root
write access.

## Why #472 is over-design as a fix

Every source both importers read lives under `{HARNESS_DIR}`, the same directory that holds
`store.db` (`store-db.ts:228-231`): `status.json`, `workflows/<id>/snapshot.json`,
`workflows/<id>/sessions/*`, `agent-flow*.jsonl`, `agent-flow-history/chunk-*.jsonl`,
`snapshots/engine-status.json`. So the race the review describes needs a writer who can
rename entries inside the control root — and the same writer already:

- controls the *bytes* of every source the import consumes (they own
  `snapshot.json` / session envelopes by premise, so arbitrary imported rows are already
  theirs without any race);
- sits in a tree where planting hook/plugin bundles or a `.env` yields execution in the
  operator's own context, which is a far stronger primitive than redirecting one read.

What the redirect actually adds is a *read* of a file the writer cannot read, landing the
bytes in `store.db` — a container the same premise says they cannot read. The gain needs a
second capability that the finding does not establish. The leaf guard does not change this
conclusion either way: it protects the final component
(`execution-minimal-import.ts:324-343` (`readSourceBytes`), `host-state-import.ts:78-95` (`readBytes`)) and is worth keeping
because it stops *accidental* following when a legacy tree was relocated by a symlink.

Measured constraints against the requested fix: `packages/engine/package.json:33-36`
declares `bun>=1.4.0` **and** `node>=24.18.0`, no native fs dependency, and the only
platform gate in the tree is Linux/Darwin (`packages/cli/src/command-adapter.ts:874`).
Directory-descriptor path resolution would add a platform matrix plus a native adapter to
harden a rare maintenance read against an attacker who already has write access to the
trusted tree. The probe recorded with I-000629 also shows the obvious `/dev/fd/<fd>/…`
fallback is dead on Darwin BOTH under Bun and Node (`ENOENT`), so "cheap pure-JS anchoring"
does not exist today.

The distinction matters because the alternative — documenting the boundary and refusing
only where the input genuinely comes from outside the control root — costs a paragraph and
no new mechanism, and it is the option that matches the deployment (single-operator harness
whose control root is under the operator's own account).

**Boundary statement this finding should produce**: *the legacy importers assume the control
root is trusted; they defend against accidental symlink traversal, not against a writer
already inside that root.* Where a supported flow imports a tree the operator does not
trust (for example a copied `.mstar` from another checkout), the correct shape is a
staged/re-validated private copy — the repository already has that pattern — rather than
descriptor anchoring.

Note the same code shape weakens the leaf claim: `constants.O_NOFOLLOW ?? 0` silently
degrades to no protection wherever the constant is absent, so the guard's reach must be
described rather than assumed. Unverified: Windows runtime behaviour (no Windows CI).

## Why #473 is not over-design

The gate is `MSTAR_STORE_TEST_RUNNER=1` plus `MSTAR_PROJECTION_DB_CHURN`, and the churn
writes real native rows (`projection.ts:1327-1358`, called from `attemptPublication`
at `:1250-1251`). It is reachable from an ordinary public entry:
`mstar dashboard` / MCP `mstar_dashboard` → `readDashboardView` →
`withStoreRead` (`store-read.ts:542`, `DASHBOARD_VIEWS:415`) → `refreshProjections`
→ `attemptPublication` → `applyDatabaseChurn`. By the #472 test, the prerequisite is
minimal — only an invocation cwd whose `.env` sets the values, which Bun applies before
application code (already established by this repository's own hostile-dotenv test). The
same gate and the same removal method were applied to the catalog-purge and
execution-restore seams in this PR, so leaving the third instance is not a scope decision,
it is the same confirmed class left half-removed. Injected-from-tests keeps the existing
projection churn coverage (`projection.test.ts:434/534/675`).

## Why #474 is real but narrow

`upgradeStoreMinimal` commits stage A before execution import runs: new root →
`initializeStore` writes the schema, activates BOTH authorities and atomically publishes
(`store-db.ts:2364-2368`, `:2418`); existing root → `upgradeStore` only applies pending
migrations (`:2472-2497`). The generic refusal path already appends the honest
"Schema version N was committed …" disclosure (`execution-minimal-import.ts:769`, asserted
at `store-upgrade-minimal.test.ts:2773-2798`). Only two early-return refusals bypass it —
`execution.delivery-declaration-required` and `execution.workflow-skip-unmatched` — and the
latter is exactly the usage/exit-2 path this PR added. So the issue's general title
overstates the gap: the mechanism exists and is tested; the residual is two branches, and
the repair is routing them through the disclosure they already sit next to.

## #447 is already delivered

On the branch, `withStatusWriteLock` and `packages/engine/src/lease.ts` are gone (the
`IntegrationMergeLease` types moved to `workflow.ts:256`, `index.ts:152/172`), the
pre-activation lock route is noted as retired (`migrate.ts:10-16`), and the real mutual
exclusion is documented as SQLite `BEGIN IMMEDIATE` / `store.busy`
(`execution-recovery.test.ts:1154-1158`). Main still carries the lockdir implementation
(`lease.ts:248`, `holder.pid` at `:225-247`), so #447/I-000532 close **when this delivery
merges**, not before. An earlier note in this round that labelled I-000532 an "unchanged
residual" was wrong: the removal it asks for is in this PR.

## Guidance

1. **Classify by prerequisite, not by badge.** "Hostile cwd only" is cheap and reaches
   every user; "write access inside the control root" is already a trusted-tree premise.
   Only the first justifies new mechanism.
2. **Keep cheap accidental-traversal guards; state their reach.** Publish the trust
   assumption next to the guard instead of implying a security boundary, and never let
   `?? 0` degrade a guard silently without that statement.
3. **Do not buy a platform matrix for a rare maintenance read** unless a supported flow
   reads a tree the operator does not trust — then use a staged private copy.
4. **A test seam that writes native state is production code.** Env-gated is not inert
   under Bun; injection belongs in test-owned instrumentation.
5. **Disclosure is per refusal branch.** One generic "already committed" message does not
   cover early-return refusals; add the branch assertion, not a new policy.
6. **A validation moved after an acquisition must keep the acquisition bounded.** Opening
   with a no-follow descriptor is more precise than a pre-open `lstat`, but if the open can
   block (FIFO, device, socket) the "safer" order introduces a hang where the old code
   refused; open non-blocking, refuse by type, and pin the new failure mode with its own
   regression.
7. **A retention receipt must bind the input, not just the request.** If a stored receipt is
   returned before the current input is re-examined, whatever identifies that input (a source
   digest, a revision, a byte hash) belongs in the request identity — otherwise a replay
   check vouches for bytes that were never imported.
8. **Do not widen a published guarantee for free.** When hardening one route, either cover
   the sibling route in the same change or narrow the sentence that names the guarantee; a
   claim that outruns the code is what turns the next review into a finding.
9. **A recovery text must be reachable in the invocation it names.** A retry that the
   operator can only satisfy after another refusal — a cross-phase acknowledgement the
   message does not name, or a workflow the acknowledgement vocabulary never classified —
   is an unreachable step, not a recovery.
10. **A source the code cannot convert belongs in the acknowledged-refusal set, not in an
    abort.** One agent-authored malformed row must not block every healthy sibling source;
    the mechanism already exists, so the defect is classification, not capability.
11. **An enumerated source that disappears is a changed source, not an absent one.** Whether
    a history chunk or a v1 compass, the probe proved the file existed: treating a later
    `ENOENT` as "nothing here" silently changes the result (identities unchecked, plans
    regrouped). Refuse, and say which probe and which read disagreed.
12. **Refusal prose is linted; write it in the grammar the linter reads.** The reachability
    linter treats `<action verb> <token>` as a command path, so "this run created nothing"
    and "workflows this run already committed" each registered "created"/"already" as an
    unregistered verb and turned CI red. Say "this invocation created nothing" and keep every
    `run`/`rerun` followed only by a real command path.

## Round 3 (same head, after the round-2 fixes)

The provider reviewed the fix head `0c9d046c` itself and filed four more findings
(`pull/471#pullrequestreview-5501555365`), captured as I-000635…I-000638. Verdicts:

| Finding | Verdict | Cheapest correct disposition |
|---|---|---|
| I-000635 advertised DSH retry cannot reach DSH after the execution phase committed | real; **incomplete recovery text**, not a dead end | name every acknowledgement the retry needs (execution ids this run imported) in that refusal |
| I-000636 the source digest is a late re-read, not the bytes that built the rows | real; honesty/consistency defect first | accumulate hashes from the descriptor-bound buffers already read, in both routes |
| I-000637 a malformed legacy plan row blocks every other workflow with no acknowledgement | real; "no hard block without a way out" | classify that workflow as a refused, skippable source with an exact loss report |
| I-000638 a non-directory `workflows/` with no registered source aborts the upgrade | real; same rule, narrower | treat a non-source tree like an absent one; keep refusing a registered source beneath it |

Two of these are the same rule that made round 2 instructive, now applied to the *refusal
taxonomy* rather than to an acquisition: a refusal may not leave the operator with an
unreachable step (I-000635, I-000637, I-000638), and the identity a receipt is bound to must
be the identity of the bytes actually consumed (I-000636 — the direct consequence of adding
`sourceDigest` to the request hash one commit earlier, which is exactly why the fix has to
hash what discovery already read rather than re-open the paths).

## Round-2 delivery note

The four round-2 findings were fixed in `0c9d046c6157007e28828ea332618d7f25b38817`
(previous verified head `645195ed`), with the plans in
`{HARNESS_DIR}/plans/audit-2026-10-13-r2/` executed directly rather than re-queued:

- Non-blocking opens in both legacy readers (`O_NONBLOCK` beside `O_NOFOLLOW`), so a FIFO or
  other special file refuses by type and the recovery path terminates. Both FIFO regressions
  are child-process probes with real timeouts, because a blocking open cannot be interrupted
  in-process: the honest way to assert "terminates" is to run the call where a timeout can
  still fire. Load-bearing check: removing the flag fails the Dsh case at 15 s (ETIMEDOUT)
  instead of hanging the suite; restoring it passes.
- The v1 conversion consumes the descriptor-verified register bytes; its regression asserts
  `readFileSync` never receives that path as a string, i.e. no second path acquisition.
- `sourceDigest` joins the upgrade request identity, matching what the Dsh importer already
  did. The existing replay regression was updated to encode the new contract: a genuine
  unchanged replay returns its retained receipt, and the same operation over edited bytes is
  `execution.operation-conflict` instead of a receipt describing bytes never imported.
- The shared acknowledged-skip disposition no longer asserts that the containing directory is
  unsafe; the per-item reason carries the cause, and the nested-source case pins that with a
  negative assertion.

Scoped evidence at this head: 113 pass / 0 fail across the engine import, upgrade and migrate
suites; 13 pass / 0 fail on the commands store surface; engine build + `tsc`, hooks
regeneration with both `node --check` runs, and the CLI/host package builds all clean. The
two env seams (`store-activation` legacy write, projection churn) remain pre-existing and out
of this PR's scope, tracked as `I-000631` and `I-000626`.

## Evidence

- `packages/engine/src/execution-minimal-import.ts` (discovery/refusal/disclosure),
  `host-state-import.ts:78-95`, `store-db.ts:228-231,2323-2519`,
  `projection.ts:1310-1368`, `store-read.ts:542`,
  `packages/commands/src/dashboard/server.ts:220`,
  `packages/engine/src/migrate.ts:10-16`, `execution-recovery.test.ts:1154-1158`,
  `packages/engine/src/index.ts:122-141`, `packages/cli/src/command-adapter.ts:874`.
- Decision inputs recorded in this round: issue capture receipts and the four scoped fact
  sweeps referenced by `{HARNESS_DIR}/sdd/<plan-id>/`, plus the Darwin
  directory-fd probe retained there.
- Review threads that produced #472: `pull/471#discussion_r4255142667`,
  `#discussion_r4255440975`.

## Outcome (2026-10-14, delivery `<plan-id>`)

All seven tracked items are delivered; dispositions below are the applied versions of the
verdicts above, and the two rules at the end were learned while applying them.

| Item | Applied disposition |
|---|---|
| I-000629 ancestor anchoring | Boundary declared, leaf guard kept, guard reach stated (option 0). No anchoring, no ancestor re-verification. |
| I-000626 projection env churn | The env branch and `applyDatabaseChurn` deleted; the movement is a test-owned store write; a built-CLI child in a hostile `.env` cwd proves the invocation environment cannot select it. |
| I-000631 activation/init/migration seams | Whole env-seam family removed (7 sites): projection, activation windows, busy-timeout override, induced init failure, induced migration failure; explicit parameters/hooks replace them and the production default (5000 ms) is unchanged. |
| I-000545 refusal disclosure | Both early-return refusals route through the honesty disclosure the generic path already used; branch assertions added. |
| I-000647 non-regular compass | `--ack-skip-compass <iteration-id...>` added: the compass is not read, its plans convert as standalone rows, the receipt names the skipped iteration and the grouping loss, unmatched ids stay usage/exit 2. |
| I-000648 duplicate v1 plan ids | Stable order (plan id, owner id, row ordinal) keeps the first; every later duplicate becomes a refused, skippable source with its own loss record. |
| I-000655 DSH retry | The retry names the deduplicated union of prior workflow acknowledgements and newly committed ids, plus the DSH selectors already used, the compass acknowledgements and the `--delivery` declarations; a regression parses the advertisement and retries in one invocation. |

**Two rules this delivery added to the ones above.**

13. **An advertised recovery must carry every acknowledgement the invocation still needs —
    prior ones included, not only the new ones.** Two review rounds found the same hole twice:
    first the workflow acknowledgements (a duplicate the operator already acknowledged), then
    the DSH selectors (acknowledged on the same run). Acknowledgements are not persisted, so a
    retry composed only from *this* attempt's refusals drops them and re-refuses before reaching
    the phase that failed. Union the still-required prior acknowledgements with the current
    refusals, in the refusal text and the structured recovery field, and pin it with a regression
    that parses the advertisement back out of the message.
14. **Removing behavior from engine source is not done until the shipped bundles are
    regenerated.** `hooks/session-context.mjs` and `hooks/mstar-write-gate.mjs` inline engine
    code, so a seam deleted in `packages/engine/src` still ships in the hook process until
    `bun run engine:build && bun run hooks:build` runs and the result is committed. The CI
    freshness gate (`git diff --exit-code -- hooks/`) catches it only after a build, so a stale
    committed bundle reads as clean until then.

**Host fact worth reusing.** On this host a subagent's shell and file tools default to the
session's primary checkout, so a RELATIVE path in an edit lands in the primary worktree while an
ABSOLUTE path pointing at the assigned worktree lands correctly. Two implementers corrupted the
primary this way in one delivery. State the absolute-path rule in every writable Assignment and
verify each edit's landing (`git -C <worktree> diff --stat`) rather than trusting the tool's
success message.
