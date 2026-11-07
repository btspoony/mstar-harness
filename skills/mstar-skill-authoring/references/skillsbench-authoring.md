# SkillsBench Skill-Writer Reference

Load this only when creating, rewriting, or optimizing a `SKILL.md` and you need the full writer loop. Runtime agents following an already-good skill should not need this file.

## Role

You are a strict AI Agent Skill engineer. The six principles and the five-question body contract are owned by the parent `SKILL.md` — this reference carries the writer loop, the authoring devices and the anti-patterns, and states no principle of its own.

## Writer workflow

1. **Collect expert path** — steps, branches, invariants, pitfalls, recovery (P1).
2. **Gap filter** — keep only what the base model misses or mis-orders (P5).
3. **Draft description** — third person; explicit trigger + exclusion; no workflow summary (P3).
4. **Draft compact body** — answer the five questions; move bulk to `references/` (P2).
5. **Wire progressive disclosure** — body names exactly which reference to open when.
6. **Pressure / paired check** — 2–3 prompts that fail without the skill; confirm improvement (P4, P6).
7. **Ship note** — deletions and compressions, and how P6 was verified, per the parent `SKILL.md`「完成时主动说明」.

## Pressure / paired check

The scenario file step 6 evaluates:

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "a real task that tempts the agent to violate the target rule",
      "expected_output": "what compliant behavior looks like",
      "files": []
    }
  ]
}
```

## Authoring devices

Small, composable techniques for specific authoring problems; each maps onto one or two principles in the parent `SKILL.md`. Pull one in when it fits — do not encode all six into every skill.

1. **Calibrated examples file** (serves P2/P5) — keep one small reference of real cases distilled into annotated judgments; readers identify the governing principle, not text templates, and it is written back when a new rule settles. In this harness: the Q1–Q8 worked judgments in `mstar-knowledge` `references/compound-workflow.md`.

2. **Recall batteries** (serves P5) — for audit/hunt skills: over-matching probes that force a semantic judgment, plus a documented list of known false-positive families; a zero-hit pattern proves nothing until you have seen it match. In this harness: the recon hints `mstar-audit` fans out to scout subagents — scoping facts, domain risk hints, and decided-tradeoff "don't report" pointers.

3. **Overcorrection traps** (adjacent to P6) — a short section per skill naming the failure modes of over-applying its own rules, so the skill guards its own bias. In this harness: the overcorrection-traps row in `mstar-knowledge` `references/compound-workflow.md` (obligation↛endorsement flips, hypotheticals stay marked, delete clauses, not sentences).

4. **Required-explicit-input** (adjacent to P3) — when the required scope or answers are missing, report and stop; never infer a repo-wide default. In this harness: `mstar-audit` asks which findings to turn into plans — "do not write 30 plans nobody asked for" — instead of inferring the scope itself.

5. **Questions ≠ write authority** (serves P6) — interaction and calibration gates never change edit authority; only the evaluation does. In this harness: `grill-me` interviews without editing, and `mstar-sdd` keeps the per-task reviewer's report separate from the implementer's application.

6. **Invocation boundary** (adjacent to P3) — declare expensive workflows user-invocable only; never put them in a skill load order. In this harness: the `/iteration-*` lifecycle lives in `commands/`; `mstar-harness-core` keeps command-layer references out of the `mstar-*` load matrix.

## Layout mapping (optional, this harness)

When authoring inside the Morning Star harness repo, map concerns as follows. Outside this repo, ignore this table and use the local project’s entry docs.

| Writer concern | Home in this harness |
|----------------|----------------------|
| Global load / conflict | `mstar-harness-core` |
| Skill authoring rules | this skill (`mstar-skill-authoring`) |
| Host path resolution | `mstar-host` |
| Repo maintenance (rename/index) | root `AGENTS.md` |
| Runtime vs maintenance split | runtime rules in skills; maintenance in `AGENTS.md` |

The body skeleton, heading order and review checklist live in the parent `SKILL.md`.

## Anti-patterns

- Pasting a long tutorial into `SKILL.md` “for completeness”
- Description that narrates the whole procedure
- Encoding style preferences with no failure mode
- Copying another skill’s rule into a new skill instead of extending SSOT
- Accepting edits after a single cherry-picked happy-path demo
- Bundling multiple domains into one body instead of splitting references
- Framing a general authoring skill as if it only applied to one product’s skill tree
