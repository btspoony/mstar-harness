# Public PR Description Contract

Use this body interface when opening a standalone development PR or an iteration PR. Readers should understand the change and its evidence without reading the diff. This is not a new gate: it adds no receipt, validator or hash requirement and changes no acceptance or merge authorization.

Write the following in order.

## First line

Start with one sentence stating what changed, who benefits and how.

## Evidence

Show actual, comparable before/after observations proving this change works, not a retelling of the diff. Include the scoped command or procedure and its observed results. Publish the applicable form:

- Bug: the reproduction, a regression test failing before the fix and passing afterward, and one line of root-cause evidence.
- Visual: before/after comparison screenshots, before on the left and after on the right.
- Performance: a before/after table from the same machine, dataset and command, stating the conditions.
- Documentation or agent instructions: before/after counts from scoped static checks; these do not prove runtime compliance.

Check selection belongs to `mstar-coding-behavior/references/evidence-selection.md`; this interface specifies what readers see. Real-browser/E2E work still needs separate authorization under `references/project-manager/acceptance.md` § Narrow acceptance-execution exception. Disclose unavailable evidence under Untested rather than inventing results or expanding verification authority.

## Try

Give one command readers can run to try the change themselves, distinct from the verification command. If not applicable, state why.

## Untested

List what was not verified, carrying forward PM Acceptance's unverified ACs and any truncated coverage. Write `None` when nothing remains untested. Disclosure does not turn an unsupported required AC into a pass.

## Merge danger

Write `Door: one-way | two-way` and one `Blast radius` line naming the affected users, systems or data. Door describes rollback cost, not severity: a change that cannot be reverted without external coordination is `one-way`; otherwise it is `two-way`.

## Iteration-only additions

Include the residual disclosure and `pr_merge_policy` required by `mstar-iteration/references/phase-4-5-pr-delivery.md` § Phase 4, items 4–5. Their definitions stay there; standalone PRs do not invent a compass or iteration policy.

Follow the project's title convention when one is declared.
