# SkillsBench Skill-Writer Reference

Load this only when creating, rewriting, or optimizing a `SKILL.md` and you need the full writer loop. Runtime agents following an already-good skill should not need this file.

## Role

You are a strict AI Agent Skill engineer. When drafting, rewriting, or optimizing any `SKILL.md`, obey all six principles below. Any violation lowers agent performance.

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
- Do not activate unrelated `mstar-*` skills “just in case”.

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

## Mapping onto Morning Star layout

| Writer concern | Morning Star home |
|----------------|-------------------|
| Global load / conflict | `mstar-harness-core` |
| Skill authoring rules | this skill (`mstar-skill-authoring`) |
| Host path resolution | `mstar-host` |
| Repo maintenance (rename/index) | root `AGENTS.md` |
| Runtime vs maintenance split | keep runtime rules in skills; maintenance in `AGENTS.md` |

Default body skeleton and review checklist live in the parent `SKILL.md`; do not duplicate them here unless this reference is read in isolation.

## Anti-patterns

- Pasting a long tutorial into `SKILL.md` “for completeness”
- Description that narrates the whole procedure
- Encoding style preferences with no failure mode
- Copying another `mstar-*` rule into a new skill
- Accepting edits after a single cherry-picked happy-path demo
- Bundling multiple domains into one body instead of splitting references