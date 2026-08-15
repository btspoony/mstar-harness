# SkillsBench Skill-Writer Reference

Load this only when creating, rewriting, or optimizing a `SKILL.md` and you need the full writer loop. Runtime agents following an already-good skill should not need this file.

## Role

You are a strict AI Agent Skill engineer. When drafting, rewriting, or optimizing **any** `SKILL.md` (any domain, any repo), obey all six principles below. Any violation lowers agent performance.

## Six Principles (refined)

### 1. Start from real expert process, not model improvisation

- Extract the domain expert’s real steps, decision criteria, constraints, API pitfalls, and failure-recovery paths first.
- Treat the model as editor / implementer only.
- Accept candidate edits only after an evaluation gate (held-out prompts, pressure scenarios, or concrete before/after checks).
- Never ship a one-shot model-generated skill as the final version.

### 2. Keep the skill compact and procedural

`SKILL.md` body must stay short. Prefer compact / standard length; long docs rarely help and often hurt.

The body must answer **only** these five questions:

| # | Question | Typical section |
|---|----------|-----------------|
| a | When should this skill load? | description + Scope |
| b | In what order, with which decision points? | Workflow / Decision Rules |
| c | Which constraints / invariants must never be violated? | Scope / hard rules |
| d | What does correct look like? | Evidence / success criteria |
| e | Which extra resources to open when the main path is not enough? | References |

Use progressive disclosure: core path in body; examples, long tables, host variants, schemas → `references/` and load on demand.

Delete or relocate anything that does not serve a–e.

### 3. Load only the 1–3 skills the task truly needs

- Minimize routing. More than ~3 skills dilutes context and lowers pass rate.
- Write descriptions specific enough for precise matching; include exclusions when over-trigger risk is high.
- Do not activate unrelated skills “just in case”.

### 4. Test each model + harness combination independently

- File portability ≠ behavior portability.
- Validate on the actual model and host in use (direct chat / omp / Cursor / Codex / Claude Code / …):
  - trigger accuracy
  - execution correctness
  - token cost
  - regressions against prior wording

### 5. Encode only gaps the base model cannot reliably fill

Prefer encoding:

- internal conventions and SSOT ownership
- regulated or safety-critical procedures
- fragile APIs and host-specific resolution rules
- professional judgment and recurring failure modes

Do **not** restate generic knowledge the model already has — that wastes tokens and adds noise.

### 6. Treat every skill edit as a controlled experiment

- Require paired evaluation: with-skill vs without-skill, or before vs after with observable criteria.
- Accept only when success rate and trajectory quality improve on held-out / pressure cases.
- Record failure reasons, token cost, latency, and regressions.
- Reject “feels better” judgments.

## Writer workflow

1. **Collect expert path** — steps, branches, invariants, pitfalls, recovery (P1).
2. **Gap filter** — keep only what the base model misses or mis-orders (P5).
3. **Draft description** — third person; explicit trigger + exclusion; no workflow summary (P3).
4. **Draft compact body** — answer the five questions; move bulk to `references/` (P2).
5. **Wire progressive disclosure** — body names exactly which reference to open when.
6. **Pressure / paired check** — 2–3 prompts that fail without the skill; confirm improvement (P4, P6).
7. **Ship note** — list deletions/compressions (P2/P5) and how P6 was verified.

## Authoring devices

Small, composable techniques for specific authoring problems; each maps onto one or two
principles above. Pull one in when it fits — do not encode all six into every skill.

1. **Calibrated examples file** (serves P2/P5) — keep one small reference of real cases
   distilled into annotated judgments; readers identify the governing principle, not text
   templates, and it is written back when a new rule settles. In this harness: the Q1–Q8
   worked judgments in `mstar-compound` `references/compound-workflow.md`; this iteration's
   fold-B overcorrection checklist (device 3) is a softer second instance.

2. **Recall batteries** (serves P5) — for audit/hunt skills: over-matching probes that
   force a semantic judgment, plus a documented list of known false-positive families; a
   zero-hit pattern proves nothing until you have seen it match. In this harness: the recon
   hints `mstar-audit` fans out to scout subagents — scoping facts, domain risk hints, and
   decided-tradeoff "don't report" pointers.

3. **Overcorrection traps** (adjacent to P6) — a short section per skill naming the failure
   modes of over-applying its own rules, so the skill guards its own bias. In this harness:
   the overcorrection-traps row in `mstar-compound` `references/compound-workflow.md`
   (obligation↛endorsement flips, hypotheticals stay marked, delete clauses, not sentences).

4. **Required-explicit-input** (adjacent to P3) — when the required scope or answers are
   missing, report and stop; never infer a repo-wide default. In this harness: `mstar-audit`
   asks which findings to turn into plans — "do not write 30 plans nobody asked for" —
   instead of inferring the scope itself.

5. **Questions ≠ write authority** (serves P6) — interaction and calibration gates never
   change edit authority; only the evaluation does. In this harness: `grill-me` interviews
   without editing, and `mstar-sdd` keeps the per-task reviewer's report separate from the
   implementer's application.

6. **Invocation boundary** (adjacent to P3) — declare expensive workflows user-invocable
   only; never put them in a skill load order. In this harness: the `/iteration-*` lifecycle
   lives in `commands/`; `mstar-harness-core` keeps command-layer references out of the
   `mstar-*` load matrix.

## Output template

```markdown
### Description
<third-person trigger + exclusions>

### Body
<compact SKILL.md answering the five questions>

### Changelog vs prior / draft
- Removed / compressed: ...
- Why this serves P2 and P5: ...
- How P6 was verified: ...
- Trigger narrowness (P3): ...
```

## Layout mapping (optional, this harness)

When authoring inside the Morning Star harness repo, map concerns as follows. Outside this repo, ignore this table and use the local project’s entry docs.

| Writer concern | Home in this harness |
|----------------|----------------------|
| Global load / conflict | `mstar-harness-core` |
| Skill authoring rules | this skill (`mstar-skill-authoring`) |
| Host path resolution | `mstar-host` |
| Repo maintenance (rename/index) | root `AGENTS.md` |
| Runtime vs maintenance split | runtime rules in skills; maintenance in `AGENTS.md` |

Default body skeleton and review checklist live in the parent `SKILL.md`; do not duplicate them here unless this reference is read in isolation.

## Anti-patterns

- Pasting a long tutorial into `SKILL.md` “for completeness”
- Description that narrates the whole procedure
- Encoding style preferences with no failure mode
- Copying another skill’s rule into a new skill instead of extending SSOT
- Accepting edits after a single cherry-picked happy-path demo
- Bundling multiple domains into one body instead of splitting references
- Framing a general authoring skill as if it only applied to one product’s skill tree