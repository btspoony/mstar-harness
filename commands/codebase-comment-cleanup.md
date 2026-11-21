---
name: codebase-comment-cleanup
description: "Triage every code comment into delete / ADR / issue / keep-with-shape, ratcheted per PR. Use standalone on a stale comment corpus; never edits without the comment gate."
agent: project-manager
input: "[path|subsystem] [dry-run]"
---

# Comment Cleanup

Triage a comment corpus into four outcomes: a tautology or a stale comment is deleted, an Excuse is corrected in the change or its defect captured per `mstar-project-governance` § Issue capture before the comment is deleted, a decision record moves to its ADR and leaves at most one contract pointer, and everything else must take a declared shape or go. No Decision Record is deleted before its ADR exists, and no Excuse is deleted before its defect is captured per that section or the code is corrected in the change; the per-PR ratchet is the shipped `--diff-base` gate, not a new comment-ban rule.

**Procedure SSOT** → `mstar-coding-behavior` → `references/comments.md` (failure modes, MUST/MUST NOT shapes, gate) + `references/comment-cleanup.md` (classification, batching, close-out).

## Boot

- PM: `mstar-harness-core` + this entry's routing; `mstar-conventions` (path symbols) and `mstar-host` (invoke capability) when the pass writes an ADR or dispatches a seat.
- Execution / QC seats: `mstar-coding-behavior` → `references/comments.md` + `references/comment-cleanup.md`; `mstar-doc-corpus` → `references/adr.md` when a Decision Record is promoted.

## Execute

Execute **`mstar-coding-behavior` → `references/comment-cleanup.md`** end to end. Input tokens: a `path|subsystem` narrows the pass, and no token means the whole codebase. `dry-run` is a read-only exit: publish the triage report plus an optional measured baseline, then stop — no edits, no development dispatch, no issue or ADR writes, and no claimed net-change figure. Otherwise PM dispatches a development seat in batches; independent QC checks every deletion against the four classes, and PM Acceptance closes the pass. A Decision Record moves into `{ADR_DIR}` only when all three admission conditions hold.

## Close-out

Report the measured `unclassified-comment net change`: `mstar lint packages --type code` and `mstar lint scripts --type code` before and after, per root and summed, each number with the command and commit it was read on. Never estimate. Those two roots are this repository's canonical counts; another project measures its own code roots with the same command. A scope the linter cannot count — no code extension, an unreadable path — is reported `unmeasured` with the reason, never as a number and never as a blocker inferred from nothing.
