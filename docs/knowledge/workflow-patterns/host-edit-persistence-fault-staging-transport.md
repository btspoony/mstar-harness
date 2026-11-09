---
module: host file-edit transport during plan execution (worktree authoring, control root, staging transport)
date: 2026-10-10
problem_type: workflow_issue
category: workflow-patterns
severity: medium
applies_when:
  - "An edit to a tracked file reports success but the change is not observable on disk"
  - "A repo-relative write may resolve against a different checkout than the assigned worktree"
  - "Choosing an authoring transport for a round that must produce tracked-file changes"
plan_id: 20261009-issue428-coordination-residuals
tags:
  - host-fault
  - edit-persistence
  - staging-copy
  - verify-before-trust
  - worktree
  - transport
related_components:
  - host adapters
  - worktree lifecycle
---

# A host edit channel that acknowledges but does not persist: verify every tracked-file write

## Context

During one plan, several implementer rounds hit the same fault: an `edit` on a tracked file returned success while the file on disk was unchanged — `git status`/`git diff` stayed empty and a content probe for the inserted marker found nothing. In one round the acknowledged edit surfaced in the **control root** (the primary checkout) instead, as a modification to a tracked test file, while the assigned worktree stayed clean. Generating a patch file and applying it in the worktree was not a way out either: `git apply` rejected the generated patches as corrupt. The fault recurred across unrelated rounds (a fix round, a writer-deletion round, a host-plugin round, a rules round, a fixture round and an async-port round) and was always silent — no error envelope, no partial write, no cleanup hint.

## Guidance

1. **Treat an acknowledged write as unproven until the file on disk says otherwise.** Before running a test, a build or a commit, confirm the change for the exact path: `git status --short` / `git diff --stat` for that file, or a cheap content probe (grep the inserted marker, compare the byte count). One verification command per write is the price of never losing a round to a phantom edit.

2. **Write whole files by absolute path, from the assigned checkout.** Compose the complete file content and write it to the target's absolute path; first prove the identity of the checkout (`pwd` and `git rev-parse --show-toplevel` must both resolve to the assigned worktree). A repo-relative write issued while the host's cwd is the control root lands in the wrong checkout — that is how the stray primary-checkout modification appears.

3. **Switch to a staging-copy transport when the channel proves unreliable.** Author the complete files into a scratch directory that is out of git's way (the repo's untracked `.tmp/<task>/` convention), including a per-file manifest of the intended changes. A seat with a working write channel copies the staged files into the worktree; the author then **re-reads every transported file** (content or diff) before treating it as the artifact under validation. Transport each round's files as a unit so the manifest and the worktree cannot drift apart.

4. **Handle a suspected phantom as an incident, not as noise.** Two checks: does the control root carry a stray modification? Archive the content out of the way (into the scratch directory) and restore the primary checkout from HEAD — never leave the shared control root dirty and never count the stray edit as progress. And is the assigned worktree free of unrelated changes? A leaf that finds a phantom landing should restore its own stray artifact and report it, not adopt it.

5. **Report the fault on the host's own report channel and keep the receipt.** The fault is evidence about the transport, not about the code under change: file it through the host's reporting surface and record the fault/recovery receipt in the round report, naming which writes were verified and which were transported. This is what lets the next round start from the workaround instead of re-diagnosing the fault.

6. **Never let the fault change the validation standard.** A missing edit must not be "fixed" by weakening an assertion, re-running until green, or committing an empty diff as progress. When the channel fails, change the transport (2)/(3) — not the acceptance bar.

## Why This Matters

The failure is silent in the worst direction: a round can report a completed change with zero bytes written, and its "green" came from a suite that never saw the edit. The stray-edit variant is worse still — it reaches into the shared control root that holds the harness store and the plan session's own state, where another seat's concurrent work can be corrupted and where a later reader cannot tell whose change it is. Both costs are paid in one verification command per write, versus a lost round, a bogus validation, or a dirty shared checkout.

## When to Apply

- Whenever an edit's effect is not observable after the tool call — verify before doing anything else.
- When authoring tracked files in a linked worktree while a separate control root (with its own checkout) exists for the harness.
- When choosing a transport for a round that must land tracked-file changes and the host's edit channel has already failed once.
- When a generated patch fails to apply in a supposedly identical tree — treat it as a transport symptom and re-author the file rather than fighting the patch.

## Examples

### Before

`edit` the file (acknowledged, success returned) → run the scoped suite → commit — with nothing on disk. The suite passes because it never saw the change, and the round's evidence describes a tree state that does not exist.

### After

`write` the complete file to the absolute path of the assigned worktree → `git diff --stat -- <path>` shows the expected file and line delta → run the scoped suite → commit. When even that write does not persist: author into `.tmp/<task>/` with a manifest, have a second seat copy the files in, re-read each one, then validate and commit.

## Source

Plan `20261009-issue428-coordination-residuals` — per-round fault/recovery receipts in the plan's review bundle (the acknowledged-but-empty edits, the control-root stray modification, the corrupt generated patches, and the staging-copy transports that landed the rounds). Related: `workflow-patterns/subagent-write-blocked-payload-contract.md` (the read-only-sandbox variant: a seat that cannot write returns its deliverable in the payload), `best-practices/host-tool-call-revision-idempotency.md` (the adjacent host-channel discipline: revisions must be re-entrant and marker-guarded).
