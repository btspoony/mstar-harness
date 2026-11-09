---
title: Stored authority pointers need write-time normalization, a public repair, and event-bound projection
module: command registration and execution projection
date: 2026-10-24
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
source: iter-<plan-id> (plans <plan-id>, <plan-id>)
status: active
tags:
  - authority-anchors
  - path-normalization
  - projection
  - receipts
---

# Stored authority pointers need write-time normalization, a public repair, and event-bound projection

## Lesson

Two seams in this harness share one failure shape: a *derived read* re-derives meaning from a stored anchor, and the two sides disagree about what the anchor means. The damage is silent because both sides succeed.

1. **Registration pointers.** An iteration's `compass_ref` is stored as a harness-relative pointer. Registration accepted a repository-relative spelling (`{HARNESS_DIR}/iterations/<id>/delivery-compass.md`) because containment was checked after lexical joining, which produced a path that looked contained but did not exist. Native Phase-1 readiness joined the same value under the harness root, saw `{HARNESS_DIR}/{HARNESS_DIR}/...`, and refused with a bare `binding-invalid`. No public verb could rewrite the anchor, so a correctly registered workflow became unusable.
2. **Terminal projections.** The projection read the *newest* operation receipt by rowid. A legitimate post-close terminal lease release writes its own receipt without attribution, so after that release the close's `actor_session_id`, `reason` and `holder_live` warning silently disappeared from `status validate` — the exact surface the attribution work existed to provide.

## Practice

1. **Normalize at write time, and prove the document exists.** A stored pointer must be canonicalized and existence-checked against the same base the reader will use. "It resolves inside the root" is not enough when the reader joins under a different root segment; reject a spelling that cannot be read back.
2. **Every stored anchor gets a public, guarded repair.** Create-only registration plus an unrevisable field is a trap: a single bad write permanently blocks the lifecycle and leaves only manual DB edits. The repair belongs in the existing workflow operation transaction, with the normal CAS/epoch/replay/attribution envelope, and must preserve identity, row status and history.
3. **Refusals name the mismatch and the executable next step.** A bare `binding-invalid` forced a 12-minute source investigation; the fixed path reports which fact disagreed (pointer form, missing mirror, changed worktree) and the verb that repairs it.
4. **Bind projections to the semantic event, not to "most recent".** Select the receipt that *produced* the state being projected (the terminal mutation), and skip later maintenance receipts. A "newest row" heuristic silently re-binds attribution whenever an unrelated maintenance write lands.
5. **Regression shape that would have caught both:** register with a wrong-but-plausible pointer and assert the readiness comparison; close with attribution, run the maintenance write, then assert the projection is byte-identical.

## Why this matters

Both bugs are invisible in the happy path and only appear after a *second* write. They also share a recovery property: the read side cannot be fixed by the reader alone, because the anchor is the authority. Fixing registration without a repair verb leaves existing bad rows stranded; fixing the projection without binding it to the event leaves the next maintenance write to re-break it.

## When to apply

- Any field stored once and read by a different subsystem (paths, roots, epochs, identities).
- Any "latest row" or "newest file" query that decides what a record *means*.
- Any refusal a user must resolve: check that a supported verb exists before shipping the refusal.
