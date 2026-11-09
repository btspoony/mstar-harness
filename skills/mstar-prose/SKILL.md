---
name: mstar-prose
description: "Use when prose looks like a leaked reasoning transcript (session/PR vantage, change narration, hedges, planning residue) and needs a HEAD-resolvability check. Not for skill structure/triggers (`mstar-skill-authoring`) or coding behavior."
---

# Prose Resolvability

Write enough to preserve the contract, then remove the reasoning transcript around it. A contract is an obligation, invariant, precondition, postcondition or compatibility promise that a caller, callee, implementer or maintainer relies on. This skill is guidance, not a checklist: the classes name a failure, and the test — not a matched word — decides the case.

## Load Order

Read `mstar-harness-core` before the first pass — lifecycle, authorization and conflict authority. Load this skill for any passage being drafted, reviewed, trimmed or audited, on any surface: Markdown documents, code and test comments, JSDoc, module comments, prompts, descriptions, diagnostics, CLI and UI strings, agent instructions and skill bodies.

Two neighbours own different tests of the same file: `mstar-skill-authoring` judges whether a skill is well formed (name, description shape, five-question body, progressive disclosure), and `mstar-coding-behavior` judges implementation behavior. Whether the prose inside is resolvable at HEAD is this skill's judgment; neither restates it. Durable knowledge documents carry three classes this file does not list — prose date stamps, machine-local paths and bilingual zh/en mixing — owned by `mstar-knowledge/references/compound-workflow.md`; where a knowledge document is in scope both lists apply, and that specific list wins on overlap.

## Scope

Require an explicit `scope` — paths, globs or a named artifact. When it is missing, report the missing input and stop; do not infer a repository-wide sweep or open an interview.

- Generated trees, snapshots, fixture corpora and catalogs are derivatives: change the owning source or generator template, then regenerate. Hand-editing the output is undone by the next regeneration.
- Vendored and third-party trees are never prose targets, even inside a whole-repository scope.
- `docs/adr/implemented/` records are current-state prose, not exempt history: judge them with this skill's test, and let their freshness duty follow from that.

## Workflow

1. Confirm the scope, the write authority and the owning document or source file before judging a passage. Review and audit rounds report findings and edit nothing.
2. Audit read-only first: probe the symptom set — `no longer`, `used to`, `formerly`, `retired`, `is gone`, `the former`, `(decision`, `(audit`, `this PR`, `§` — calibrate each probe against a known positive and a near miss, then judge every hit semantically. A probe is not the definition: also read the densest prose in scope with no pattern in hand.
3. For each candidate, enumerate the propositions it makes — actor and action, condition and ordering, modality, negative guarantee and exception, ownership, side effect, failure, consequence — and keep every factual one.
4. Restate the surviving facts in the present tense from the repository's vantage, then delete the transcript around them; a passage carrying no surviving fact is deleted outright.
5. Route what is durable before closing: rationale that still guides future work goes to an ADR, a work item goes to the issue store, and nothing survives as prose about the session.
6. Re-read the result against the test, then report what was kept, restated, deleted and routed, naming the destination of anything routed.

## Decision Rules

### The one test

**Could a reader at HEAD — no session transcript, no PR thread, no uncommitted draft — resolve every reference and verify every claim?**

No — restate every surviving fact from the repository's vantage and delete the rest. Yes — not leakage, however historical it sounds; resolvability alone still does not clear class 3 on a current-state surface, where a resolvable change story remains change narration.

### Fact-check
A prose claim about an operation, command, default, error or platform difference is admissible only if the operation was run against the current tree; a claim that fails to reproduce is corrected or deleted, never carried from memory or from a neighbouring document, and one whose prerequisite is unavailable is reported with the named verification owner. This rule judges truth — the one test above judges resolvability: a sentence can resolve at HEAD and still state behaviour the tree does not have.

### Leakage classes

Each class takes its vantage from the authoring session instead of the repository.

1. **Dead session citations** — `(decision 7)`, `(audit C2)`, `design §4.7`, phase labels such as `T4`, "the design ledger", an uncommitted plan's section number. Cite the committed owner by path, or restate the clause so it stands alone.
2. **Stack and PR vantage** — "a later PR in this stack", "this PR adds", "the previous commit". State the shipped mechanism or the extension point; owed work becomes an issue reference.
3. **Change narration and version stamps** — "used to", "no longer", "the old X", and indexical stamps such as "v1", "this cut" or "today" set against a past state. State the present behavior; a fixed regression becomes a present-tense counterfactual, never repository history.
4. **Review choreography** — "Rejected in review:", "the reviewer confirmed", round attributions, "v5 of this note". Keep the decision and its reason as plain fact; drop who said it and when.
5. **Reviewer-addressed justification** — "the cast is safe — it simply…", "this is correct because…". A passage arguing its own correctness addresses a reviewer who has left; state the invariant that makes it safe, or delete it when the code already shows it.
6. **Restatement and derivation transcripts** — control-flow narration ("first we X, then Y"), test walkthroughs, proofs of obvious branches, a sentence previewing the next one. Delete; keep only the non-obvious contract or invariant.
7. **Hedges and planning residue** — "probably fine for now", "should be enough", a deferral with no owner or marker. Promote it to a marked `TODO` or state the actual bound; the hedge itself is deleted.
8. **Authoring-language slips** — working-language fragments left untranslated in an otherwise single-language passage, private section separators, draft notes inside a published string. Translate or delete.

### Keep rules

An unaided pass fails in both directions — it deletes durable references and keeps dead ones. These are not leakage; apply them as written.

- **Issue references** — `#1470`, `TODO(name):`, "issue #N owns the follow-up" resolve at HEAD on every surface, READMEs included.
- **Merged-PR citations inside an ADR or a postmortem** — the losing alternative and the cost accepted are that genre's evidence, and the genre exists to hold them.
- **Suppression justifications** — a lint-disable reason, a coverage-ignore reason, an empty-catch explanation are required prose; fix a false reason, never delete one.
- **Counterfactual-present regression pins** — "without X, Y happens" states the present consequence of an absence, not a change to the file.
- **Measured bounds** — "(measured: 512 nests ≈ 0.15 s)" calibrates a constant; the evidence word "measured" is load-bearing.
- **Runtime old and new states** — "the old connection drains before the new one accepts" describes lifecycle ordering, not history.
- **Historical stage names inside an ADR's change-story section** — "the first cut shipped X" is current-state-safe there; an indexical stamp such as "this cut" stays out of every surface.
- **External standards citations** — RFC 9110 §10.1.5, a Figma frame name, an upstream API version resolve outside this repository by design.
- **Project voice and genre forms** — "we" as the project's voice, an `## Alternatives considered` section, a postmortem's incident sequence.

### Routing

Nothing about the session survives as prose. Give each durable residue its owner.

- Rationale that must outlive the change — what was rejected, at what cost, what would reopen it → a record under `docs/adr/`, whose required sections and lifecycle live in its README.
- Work still owed — an unbuilt follow-up, a deferred fix, a limitation found while writing → an issue in the harness issue store.
- Everything else — a trace of the reasoning that produced the passage → deleted.

## Evidence

A finished round returns four things.

- **The scope and the probe calibration** — what was read, which probes were trusted and against what positive; a probe that matched nothing says so instead of reporting zero leakage.
- **The classified passage list** — kept / restated / deleted / routed, with the propositions each restatement preserved and the destination of anything routed.
- **The citation check** — every remaining reference resolves at HEAD, and the diff adds no session artifact, plan id, PR round or uncommitted-draft section number.
- **The authority statement** — an audit round returns findings without edits; edit authority comes from the assignment, not from the skill.

This file is held to the same test whenever it changes: no clause here may cite a session that owned it.

## References

| When | Open |
|------|------|
| calibrating a borderline passage, judging an over-trim, seeing a three-way over-trimmed / over-detailed / balanced example | `references/calibrated-examples.md` |
| the passage is a skill body — structure, trigger contract, five-question body | `mstar-skill-authoring` |
| deciding whether a rationale needs a record, and which bucket and class it takes | `docs/adr/README.md` |
| an owner for a hedge or a deliberate shortcut — the `simplify:` / `temporary` markers | `mstar-coding-behavior` |
