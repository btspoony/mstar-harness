# Comment cleanup

This pass is a triage of an existing comment corpus, not a new policy: every comment is read, classified, and either deleted or kept because its claim resolves at HEAD — the anchor is what justifies the survivor — and the gate that judges the result is the comment gate that already ships — `comments.md` — so the pass adds no rule and changes no threshold.

## Classes

Information preservation comes before any class judgement: a comment carrying something that exists nowhere else at HEAD — a rationale, a tracked defect, a public-contract obligation — is never deleted on a `Stale` or `Tautology` match alone, and leaves only once that information has a home. A comment matching several classes resolves by the heaviest surviving action — Decision Record > Excuse > Stale > Tautology — unless the unique information already lives elsewhere at HEAD; the class name is a reading aid, while the vocabulary the gate and review already use is the failure-mode column, so a finding is reported as `Substitute`, `License` or `Drift`, never as a second taxonomy.

**Scope.** `comments.md` § MUST governs `non-documentation` comments; its documented exemption is the doc block a caller reads at the declaration, so that block is not this pass's deletion target — a docstring that is factually stale is corrected, not deleted.

| Class | Our failure mode | Test | Action |
|---|---|---|---|
| Tautology | Substitute | The comment restates what the code, its signature or its types already say | Delete |
| Excuse | License | The comment, or a bare label on it (`simplify:`, `temporary`, `TODO`), is read as permission to repeat a hacky implementation, so the pattern spreads | An Excuse is a confirmed defect, so it is captured per `mstar-project-governance` § Issue capture whether or not the fix lands in this change — capture is not the deferred branch of a correction, and that section owns the capture rule, the verb and the judgement. Once the capture succeeds, correct the code here when the correction fits this change, otherwise leave the fix to the captured issue; either way the excusing comment is deleted once its fix's home exists, and a failed capture keeps it. Any issue is cited in the PR body or the plan, never as an in-comment `issue <n>` pointer: local IDs are `I-…` and the lint pointer does not match them |
| Stale | Drift | The comment points at a path, symbol, option or behaviour that no longer exists at HEAD, or contradicts what the edited line now does | Delete; correct it only when the contract moved and the code is right |
| Decision Record | MAY History / contract pointer | A choice among real alternatives whose rationale no code, test or existing doc reconstructs, and which a future contributor must confront before reintroducing the bypass | Move the rationale into `{ADR_DIR}/{bucket}/{class}/yyyy-mm-dd-topic.md` per `mstar-doc-corpus/references/adr.md`, then leave one contract pointer line or delete the comment |

The tie-break is by cause, not by wording: a comment that is both stale and licensing (`// temporary: keep in sync with the old parser`) is an Excuse, because fixing the drift would still leave the licence behind.

A Decision Record is the one class that does not end in deletion by default, and all three admission conditions in `adr.md` § When a record is required must hold — a decision among real alternatives, a rationale that has no other home, and a lifetime beyond the change that produced it; a mechanical edit, a local rationale the code or tests already show, and an already recorded decision are exempt, and the record's class is one of `feature/`, `bug-fix/`, `simplification/`, `architecture/`, `process/`, `testing/` only.

Every surviving comment must carry a machine-resolvable anchor declared under `comments.md` § MUST — a bounded marker, a contract pointer that resolves at HEAD, `@generated`, or a ticket-opening `TODO` with a tracking reference; a comment with no such anchor is a deletion target, not a keeper, and it is never kept by adding or rewriting a `note:`/`why:` prefix. The pass never adds a prefix: a corrected comment is the only case where it touches comment text, and the corrected text must itself carry a resolvable anchor. A comment whose content is false, stale or excusing is deleted once the class pass has cleared it, with any information that exists nowhere else at HEAD given a home first; a class match alone authorizes no deletion, and rewording it is not a fix. A `TODO`/`FIXME` that opens the comment content with a tracking reference (`// TODO(#123): …`, `# FIXME(plans/<file>): …`) is a valid shape and survives as a keep; only the ownerless one is an Excuse and is deleted.

## Order of operations

1. **Write the home first.** Copy the rationale into the ADR, or capture the defect per `mstar-project-governance` § Issue capture — an Excuse is a confirmed defect, so the capture stands whether or not the fix lands in this change, and that section owns the capture rule and judges capture; capture is never the deferred branch of a correction. The record is written in this change (or an earlier one) and lands with the change — the ADR header is `# ADR: <title>` plus `Status: <state> — <why>`. An `implemented/` record written by the same change is valid and needs no `proposed/` ancestor; `proposed/` is only for a not-yet-implemented decision that must outlive the current plan or iteration (→ `adr.md` § Proposed or implemented); an already recorded decision is updated or superseded, never duplicated.
2. **Delete second.** Delete the comment once its class action allows it, and never before information that exists nowhere else at HEAD has a home: when the class was Excuse, correct the code in this change when the correction fits it and otherwise leave the fix to the captured issue, and delete the excusing comment once the correction has landed here or the captured issue exists; a failed capture keeps the comment. Carry the captured-issue citation for whatever the change does not fix in the PR body or plan, not in the comment.
3. **Verify third.** `mstar lint <file> --diff-base <ref>` — one target per run — must report the changed lines clean before the batch is called done.

- **Never** delete a Decision Record whose home does not yet exist: the rationale is lost the moment the line goes, and HEAD cannot recover it.
- **Never** edit inside an `@generated` block — the generator owns it, and the edit is undone or silently made inconsistent on the next run; a real defect there is reported against the generator, not patched in place.

## Batch and ratchet

One bounded batch per PR — one subsystem or one path — because a diff that touches the whole repository cannot be reviewed line by line and its ratchet result is unreadable; a stale corpus this size is a series of passes, not one.

A batch edits the comments inside its chosen path or subsystem and needs no prior diff to start: it may begin on a clean branch, and the ratchet runs afterwards on the batch's own changed lines. Comments outside the selected scope are not swept in — the rest of the corpus is the next batch's work, not a side effect of this one. The existing natural-language corpus (`note:`, `why:`, `invariant:`, `safety:` — comments whose claim resolves nowhere) is this pass's deletion backlog, worked one batch per PR: a batch may leave the rest of it standing, but its own diff adds no prefix, and its report states the measured `unclassified comments: <n>` remaining count as progress — no separate backlog file or tracker is introduced, since issue capture already owns durable tracking.

The corpus is advisory, the change is not: `mstar lint <file> --diff-base <ref>` fails every comment the change adds or modifies that carries no shape, so a new comment arrives in a declared shape or does not arrive at all — and because the ratchet reads the changed lines, no bulk rewrite is implied. A newly created code file must be visible in the diff — tracked, or intent-to-add — before a clean ratchet result is accepted; otherwise the file is skipped and the result proves nothing about it.

## Measurement

Before the pass, record the whole-tree bound gate on the same checkout. This repository measures with its two canonical commands — `mstar lint packages --type code` and `mstar lint scripts --type code` — reading the `unclassified comments: <n>` count each prints on stderr; after the pass, run the same two commands again. Another project measures its own configured code roots, or the selected target (`mstar lint <dir> --type code`). A scope the linter cannot count is reported `unmeasured` with the reason instead of a fabricated figure, and the close-out never requires a number it cannot read.

The walked roots are the whole measurable surface: the gate reads code files selected by extension, hash-dialect `.py`/`.sh`/`.rb` included, so a Markdown document or a code file outside them never appears in the count and stays a review-only finding. `mstar lint` takes one target, so a narrower batch is measured per file or per directory — `mstar lint <file> --diff-base <ref>` for the ratchet, `mstar lint <dir> --type code` for a subtree.

The per-root difference between the two runs is the `unclassified-comment net change`, reported per root and summed, each number quoted with the command and the commit it was taken on; the PR states them side by side rather than one net figure. The number mixes deletions with reclassification, so it is not a deletion count.

Never estimate the saving from the diff size or from a sample of files — the counter is the measurement, and a claimed number that was not read off a run is a defect in the report.

This repository's CI holds a per-root floor (the values live in `.github/workflows/ci.yml`); the floor detects a detector or collector regression, not a cleanup target. A genuine cleanup that pushes a root below its floor lowers that floor in the same change and records the new baseline in `comments.md` § Gate steps and range; otherwise CI reports the cleanup as a collapse.

## Why no blanket ban

A repo-wide ban on comments also deletes what this repository depends on: the `see` pointer that keeps one rule in one place, the bounded `simplify:`/`shortcut:` marker that records a ceiling, and the `@generated` warning that prevents an edit.

The equivalent already ships — the bound gate fails an unbounded marker anywhere in the corpus, and the ratchet fails an unclassified comment on any changed line — so this pass adds no lint rule and needs none.

## Non-goals

- Rewording or reflowing a comment until it passes the gate while the false, stale or excusing content stays; that converts a finding into a survivor.
- Touching another repository's comment policy, or the vocabulary and shapes `comments.md` owns; this pass consumes both.
- Changing the gate thresholds or the ratchet's range, or lowering a per-root floor other than when a genuine cleanup has pushed a root below it.
