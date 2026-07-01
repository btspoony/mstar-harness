---
name: mstar-skill-authoring
description: Morning Star skill authoring and maintenance guidance. Read when creating a new skill, making a major skill rewrite, changing trigger descriptions, evaluating whether behavior-shaping skill text works, or reviewing skill structure before release. This is mstar-native and independent of external skill plugins.
---

# Morning Star Skill Authoring

This skill defines how Morning Star authors, reviews, and validates runtime skills. It is for skill work, not ordinary application implementation.

## Load Order

Read `mstar-harness-core` first. For repository maintenance, also follow root `AGENTS.md`.

When changing existing skills, read every topic skill you touch and any referenced files needed to preserve the single source of truth. Do not rewrite adjacent skills for style only.

## Core Practices

This skill defines Morning Star's reusable skill-authoring practices:

- Treat skills as process code that should be tested against pressure scenarios.
- Use frontmatter descriptions as trigger contracts, not process summaries.
- Keep `SKILL.md` concise and move heavy detail into `references/`.
- Prefer concrete trigger symptoms, contexts, and user phrases.
- Verify behavior-changing skill edits with evidence, not wording preference.

It deliberately avoids external path assumptions, external plugin dependencies, and any requirement to run a non-Morning-Star skill as a prerequisite.

## Skill Purpose Test

Create or expand a skill only when all are true:

1. The behavior should be reused across multiple projects, roles, or tasks.
2. The behavior requires judgment or sequencing that is not better enforced by code.
3. The existing Morning Star skill tree does not already contain the same rule.
4. The trigger can be stated clearly enough for agents to know when to read it.

Do not create a skill for:

- One-off project conventions; put those in project `AGENTS.md`.
- Mechanical rules that can be linted or scripted.
- A solved incident narrative with no reusable technique.
- Another copy of a rule already owned by an existing `mstar-*` skill.

## Frontmatter Contract

Required fields:

```yaml
---
name: mstar-example
description: Use when...
---
```

Rules:

- `name` is stable, lowercase, and hyphenated.
- `description` is the trigger contract.
- Start with the situations that should cause the skill to load.
- Include concrete symptoms, contexts, roles, and artifacts.
- Do not summarize the whole workflow in the description.
- Keep descriptions specific enough to avoid loading on unrelated tasks.

Bad description:

```yaml
description: Explains how to write plans with steps, tests, commits, and review gates.
```

Better description:

```yaml
description: Use when a non-trivial task has a spec or requirements and needs a written implementation plan before code changes.
```

Why: descriptions are often visible before the body. If the description summarizes the workflow, agents may follow the summary and skip the full skill.

## Body Structure

Use this default structure unless the skill has a better local pattern:

```markdown
# Skill Title

## Load Order
What must be read first, and what owns conflicts.

## Scope
When this applies and what it does not own.

## Workflow
The shortest reliable execution path.

## Decision Rules
Tables or bullets for common branches.

## Evidence
What proves the skill was followed.

## References
Optional files to read only when needed.
```

Keep `SKILL.md` focused on the main execution path. Move long examples, templates, schemas, and detailed variants into `references/`, `templates/`, or `scripts/`.

## Progressive Disclosure

Use three levels:

1. Frontmatter: trigger only.
2. `SKILL.md`: core execution path.
3. Resources: details loaded only for the relevant variant.

If `SKILL.md` grows large because it covers multiple domains, split by reference file:

```text
skill-name/
  SKILL.md
  references/
    opencode.md
    cursor.md
    codex.md
```

The body must tell the reader exactly which reference to open and when.

## Trigger Quality Checklist

Before committing a skill change:

- Does the description say when to trigger, not merely what the skill contains?
- Does it include common synonyms and role/task contexts?
- Does it avoid overbroad terms that would load it constantly?
- Does the body define conflict ownership?
- Does it point to one source of truth instead of repeating long rules?
- Does it state the expected evidence for behavior-shaping changes?

## Pressure Scenarios

For new skills or major behavior rewrites, write 2-3 pressure prompts that would fail without the skill:

```json
{
  "skill_name": "mstar-example",
  "evals": [
    {
      "id": 1,
      "prompt": "A realistic task that tempts the agent to violate the intended rule.",
      "expected_output": "What compliant behavior looks like.",
      "files": []
    }
  ]
}
```

Good pressure prompts:

- Create the mistake the skill is meant to prevent.
- Mention realistic artifacts and role boundaries.
- Have observable pass/fail criteria.
- Avoid testing trivia from the skill body.

If full eval runs are not practical for the change, record manual evidence: before/after expectation, affected trigger phrase, and one concrete validation step such as search results, link checks, or a dry-run prompt review.

## Maintenance Discipline

- Preserve runtime/maintenance split: skills describe runtime behavior; root `AGENTS.md` describes repository maintenance.
- Keep role shells thin; reusable behavior belongs in topic skills or role references.
- Do not introduce parallel manuals for the same workflow.
- Do not rename or split skills without updating role matrices, README tables, host adapters, and install docs.
- Behavior-shaping wording changes need evidence: evals, regressions, concrete user outcomes, or a documented failure mode.

## Review Template

Use this when reviewing a skill PR:

```markdown
## Skill Review
- Trigger contract:
- SSOT alignment:
- Runtime vs maintenance split:
- Progressive disclosure:
- Evidence for behavior change:
- Stale references checked:
- Verdict: Approve | Request Changes | Needs Discussion
```
