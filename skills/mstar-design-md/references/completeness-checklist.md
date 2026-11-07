# DESIGN.md Completeness Checklist

Itemized audit for a `DESIGN.md`: check every item at the target level and below. The level definitions and the pass rule live in `references/design-md-spec.md` §7; this file holds only the items.

## How to use

1. Read `DESIGN.md` (and `DESIGN.dark.md` if it exists)
2. **Parse the YAML frontmatter** for structured token values — the frontmatter is the SSOT for colors, typography, spacing, rounded and components
3. Review the Markdown body for documented rules, rhythm and usage intent
4. Check each item in the target level and in all lower levels
5. An item is **complete** only when a concrete value exists in the frontmatter (an uncommented key whose value is not a `"[...]"` placeholder) — YAML comments and `[LEVEL*]` placeholder values do not count
6. Record the result in a comment at the top of DESIGN.md:

```
<!-- COMPLETENESS_LEVEL: N — last audited YYYY-MM-DD -->
```

## Level 1 — MVP

Definition and gate → `references/design-md-spec.md` §7.

### Checklist

- [ ] **Frontmatter exists** — YAML frontmatter block with `---` delimiters present and parseable
- [ ] **Frontmatter `version`** — `version: 0.1.0` declared
- [ ] **Frontmatter `name` and `description`** — design system name and description filled (non-placeholder)
- [ ] **Overview** — design system name and aesthetic principles stated in body
- [ ] **Colors — Background** — frontmatter has `colors.background-100` with a concrete hex value
- [ ] **Colors — Text** — frontmatter has `colors.gray-1000` and `colors.gray-900` with concrete hex values
- [ ] **Colors — Accent** — frontmatter has `colors.blue-700` (or brand equivalent) with a concrete hex value
- [ ] **Colors — Semantic** — frontmatter has `colors.red-700` (error) and `colors.amber-700` (warning) with concrete hex values
- [ ] **Typography — Body** — frontmatter has at least one `typography.copy-*` token with all five properties filled
- [ ] **Typography — Heading** — frontmatter has at least one `typography.heading-*` token with all five properties filled
- [ ] **Spacing** — frontmatter has `spacing.base` declared and at least 5 numbered steps with pixel values
- [ ] **Rounded** — frontmatter has `rounded.sm` with a concrete pixel value
- [ ] **Breakpoints** — at least 2 responsive breakpoints documented in body

## Level 2 — Standard

Definition and gate → `references/design-md-spec.md` §7.

### Checklist

- All Level 1 items complete
- [ ] **Colors — Full background scale** — frontmatter has `colors.background-100`, `background-200`, `background-300` active (uncommented, filled)
- [ ] **Colors — Full gray solid scale** — frontmatter has `colors.gray-100` through `gray-1000` (10 steps) all active
- [ ] **Colors — Gray alpha scale** — frontmatter has `colors.gray-alpha-100` through at least `gray-alpha-600` all active
- [ ] **Colors — All accent scales** — frontmatter has `blue`, `red`, `amber`, `green`, `teal`, `purple`, `pink` scales, each with at least `700`/`800`/`900`/`1000` steps active
- [ ] **Typography — Headings** — frontmatter has at least 3 heading levels active (e.g., `heading-32`, `heading-24`, `heading-20`)
- [ ] **Typography — Labels** — frontmatter has at least one `label-*` token active
- [ ] **Typography — Buttons** — frontmatter has at least one `button-*` token active
- [ ] **Spacing** — frontmatter `spacing:` has the full 9-step scale active; three-step rhythm documented in body
- [ ] **Rounded** — frontmatter `rounded:` has `sm`, `md`, `lg`, `full` all active
- [ ] **Breakpoints** — at least 4 breakpoints documented in body
- [ ] **Components — Button** — frontmatter `components:` has `button-primary` and `button-secondary` with all properties filled, plus a `button-small` size variant; body documents hover/active/disabled/focus states
- [ ] **Components — Input** — frontmatter `components:` has `input` with all properties filled; body documents states

## Level 3 — Production

Definition and gate → `references/design-md-spec.md` §7.

### Checklist

- All Level 1 and Level 2 items complete
- [ ] **DESIGN.dark.md exists** — dark theme file with `---` YAML frontmatter present, same key structure as DESIGN.md
- [ ] **Dark theme frontmatter parity** — every token in DESIGN.md frontmatter (`colors`, `typography`, `spacing`, `rounded`, `components`) has a corresponding active entry in DESIGN.dark.md frontmatter with dark-appropriate values
- [ ] **Elevation — Shadows** — at least 3 elevation levels (card, popover, modal) with explicit `box-shadow` values in body
- [ ] **Motion — Easing** — easing curve declared in body
- [ ] **Motion — Durations** — at least state change, popover and modal durations in body
- [ ] **Motion — Reduced motion** — `prefers-reduced-motion` rule declared in body
- [ ] **Components — Full library** — frontmatter `components:` has at least Card, Modal, Tooltip, Menu/Dropdown variants
- [ ] **Voice & Content** — writing rules documented in body: casing conventions, action naming, error format, toast format, empty state format

## Verdict

The audit reports one of four values, matching the engine's `CompletenessLevel`:

| Reported | When |
|----------|------|
| `BELOW_MVP` | one or more Level 1 items missing |
| `MVP` | Level 1 complete, Level 2 incomplete |
| `Standard` | Level 1 and 2 complete, Level 3 incomplete or body-unconfirmed |
| `Production` | Levels 1–3 complete, body items included |

A `Standard` file missing a few Level 2 items is still usable — expect component-level inconsistencies until they land.

## Audit workflow

### When auditing an existing DESIGN.md

1. Load the DESIGN.md file
2. Start at the Level 1 checklist — check each item against actual content
3. If Level 1 complete, proceed to Level 2, then Level 3
4. Record the level as `<!-- COMPLETENESS_LEVEL: N -->` at the top of DESIGN.md
5. For each incomplete item, note what is missing and which level it belongs to
6. Check for `LEVEL2_PLACEHOLDER` / `LEVEL3_PLACEHOLDER` markers — if present and the project is ready for the upgrade, recommend activation

### When creating a new DESIGN.md

1. Decide the target level with PM/architect: prototype / early project → Level 1, production frontend → Level 2, full design system → Level 3
2. Copy the template from `templates/DESIGN.md.template`
3. Fill all items in the target level
4. Run this checklist to confirm the level
5. Leave higher-level placeholders as they are

### When upgrading a DESIGN.md

1. Read the current DESIGN.md and note the level tag
2. Identify which items of the next level are missing
3. For each missing item, either fill it with concrete values or leave its `LEVEL*_PLACEHOLDER` marker
4. Re-audit and update the level tag

## Upgrade trigger conditions

Agents encountering a DESIGN.md with placeholders evaluate these conditions:

| Condition | Action |
|-----------|--------|
| `LEVEL2_PLACEHOLDER` found AND plan includes component work | Recommend completing the Level 2 sections |
| `LEVEL3_PLACEHOLDER` found AND plan includes dark mode | Recommend creating DESIGN.dark.md |
| `LEVEL3_PLACEHOLDER` found AND plan targets production release | Recommend completing Level 3 |
| `COMPLETENESS_LEVEL: 1` AND project has >3 UI views | Recommend upgrading to Level 2 |
| `COMPLETENESS_LEVEL: 2` AND project has a dark mode requirement | Recommend upgrading to Level 3 |
