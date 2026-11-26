---
module: plan documents and their consumers (engine, lint, commands)
date: 2026-11-26
problem_type: convention
category: conventions
severity: medium
applies_when:
  - "a plan document declares plan_id, execution, branches, delivery kind or status"
  - "migrating plan fixtures or a template from body labels to front matter"
  - "a consumer compares a plan declaration with a CLI argument or a Git ref"
tags: [frontmatter, plan, registration, residency, fixtures]
---

# Plan declarations live only in front matter

## Context

A plan's machine-read fields used to be body labels (`**plan_id:**`, `**Main worktree branch**:`), matched with a tolerant scanner that accepted two colon spellings and skipped fenced examples. The label scanner is gone: the plan header reader takes the front matter map, and the plan schema validates it. Everything that migrates a plan or a fixture meets three recurring questions.

## Guidance

1. **One source, no fallback.** A plan without front matter refuses; a body label is never a declaration. Keep a body-label fixture only when it asserts the refusal. When a template or guide still shows a body label, change it in the same change — a reader that ignores it makes the guide worse than silent.

2. **Read the raw lexeme, not the typed value.** The parser types `true`, numbers and `null`, but a branch or an id is text. `main_worktree_branch: 5.0` must reach Git as `5.0`; the typed value is `5`. Read the entry's `rawText`, strip at most one quoted pair, and never `String(value)`.

3. **Decide by entry kind before the lexeme.** A bare `key:` and a key with a map/list child both parse; only the kind and the child presence distinguish them. `key:` alone is absent, a key with children is an invalid declaration, and an explicit `[]` or `{}` is invalid too. Folding an invalid shape into "absent" silently re-points residency at the snapshot branch.

4. **Fallback only for absence.** A missing key, an empty scalar, `null` or `~` means "not recorded" and may fall back to the recorded workflow anchor. A present but malformed declaration is a refusal with the file and line; a fallback there would admit a branch the declaration never named.

5. **Migrate fixtures through one per-package renderer.** Twenty-odd copies of the same seven-field string drift the first time a field is added. Put the renderer in the package's test-support location, import it from every migrated test, and keep a local literal only for a deliberately malformed input or an exact diagnostic line.

6. **The registration comparison is the resolver's job.** `workflow.register` compares `--plan-id` with the front matter `plan_id`; the help text should name that comparison and the H1 title comparison it also performs, so an author is not refused by a rule the contract never stated.

## Consequences

- A plan has one declaration form and one reader; a consumer cannot disagree with another.
- Fixtures are cheap to update and a field rename is one edit per package.
- The cost is that the parser's type coercion is no longer a convenience: every consumer that needs text must ask for the raw lexeme.
