/**
 * Shared content fixtures for the command-owner CLI suites. Moved verbatim
 * from slice4-cli.test.ts during the command-owner test split: design/skill fixtures are shared with project-root
 * cases, knowledge fixtures with compound/project-root cases. Fixture bytes
 * must stay out of the spawn module. Test-only module, no imports.
 */

/** Full Level 1 design frontmatter (same shape as the engine's FM_LEVEL1
 * fixture — audits as MVP; tokens pass). */
export const DESIGN_LEVEL1 = `---
version: 0.1.0
name: "Acme Design"
description: "Acme Design is a minimal, high-contrast design system. This is the Light theme."
colors:
  background-100: "#ffffff"
  gray-1000: "#171717"
  gray-900: "#666666"
  blue-700: "#0066ff"
  red-700: "#e60000"
  amber-700: "#ffaa00"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  heading-32:
    fontFamily: Geist Sans
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
rounded:
  sm: 6px
---
`;

/** Valid skill fixture: lowercase-hyphen name, third-person trigger
 * description, all five body questions answered. */
export const SKILL_GOOD = `---
name: sample-skill
description: Validates harness fixtures during CLI smoke tests.
---

## Load Order

Read this skill when running smoke fixtures.

## Workflow

Create fixtures, run the CLI, assert exit codes.

## Decision Rules

Never mutate the control worktree.

## Evidence

A green CLI run is the success criterion.

## References

Open the engine tests when a fixture drifts.
`;

/** Skill body fixture: concrete ephemeral citations (task artifact +
 * sdd deeplink) inside an otherwise five-question-complete skill. */
export const SKILL_EPHEMERAL = `---
name: sample-skill
description: Validates harness fixtures during CLI smoke tests.
---

## Load Order

Read this skill when running smoke fixtures.

## Workflow

Create fixtures, run the CLI, assert exit codes. See task-3-report for the
prior run.

## Decision Rules

Never mutate the control worktree. Check .mstar/sdd/20260815-x/ before edits.

## Evidence

A green CLI run is the success criterion.

## References

Open the engine tests when a fixture drifts.
`;

/** Skill body fixture: placeholder citation forms only — the
 * discrimination contract (zero false positives) requires these to pass. */
export const SKILL_PLACEHOLDERS = `---
name: sample-skill
description: Validates harness fixtures during CLI smoke tests.
---

## Load Order

Read this skill when running smoke fixtures.

## Workflow

Create fixtures, run the CLI, assert exit codes. task-N-report and
{SDD_DIR}/task-N-report.md are templates; .mstar/sdd/<plan-id>/ is a
deeplink template too.

## Decision Rules

Never mutate the control worktree.

## Evidence

A green CLI run is the success criterion.

## References

Open the engine tests when a fixture drifts.
`;

/** Knowledge-track doc that passes validateSchemaYaml. */
export const KNOWLEDGE_GOOD = `---
module: engine
date: 2026-08-01
problem_type: best_practice
category: best-practices
severity: medium
---
`;
