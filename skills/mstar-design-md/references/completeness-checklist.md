# DESIGN.md Completeness Checklist

Three-level progressive checklist for evaluating whether a `DESIGN.md` is sufficient to drive agent UI generation. Each level builds on the previous level's requirements.

## How to use

1. Read `DESIGN.md` (and `DESIGN.dark.md` if exists)
2. **Parse the YAML frontmatter** for structured token values — the frontmatter is the SSOT for colors, typography, spacing, rounded, and components
3. Review the Markdown body for documented rules, rhythm, and usage intent
4. Check each item in the target level (and all lower levels)
5. An item is **complete** only when concrete values exist in the frontmatter (uncommented keys with non-placeholder values) — YAML comments and `[LEVEL*]` placeholder values do not count
6. A `DESIGN.md` is at **Level N** when all items in Level N and below are complete
7. Record the result in a comment at the top of DESIGN.md:

```
<!-- COMPLETENESS_LEVEL: N — last audited YYYY-MM-DD -->
```

## Level 1 — MVP (prevents guesswork)

The minimum bar for an agent to produce UI without hallucinating colors and typography. Sufficient for early-stage projects, prototypes, and CLI tools with minimal UI.

### Checklist

- [ ] **Frontmatter exists** — YAML frontmatter block with `---` delimiters present and parseable
- [ ] **Frontmatter `version`** — `version: alpha` declared
- [ ] **Frontmatter `name` and `description`** — design system name and description filled (non-placeholder)
- [ ] **Overview** — design system name and aesthetic principles stated in body
- [ ] **Colors — Background** — frontmatter has `colors.background-100` with a concrete hex value (not `"[LEVEL*]"` placeholder)
- [ ] **Colors — Text** — frontmatter has `colors.gray-1000` and `colors.gray-900` with concrete hex values
- [ ] **Colors — Accent** — frontmatter has `colors.blue-700` (or brand equivalent) with a concrete hex value
- [ ] **Colors — Semantic** — frontmatter has `colors.red-700` (error) and `colors.amber-700` (warning) with concrete hex values
- [ ] **Typography — Body** — frontmatter has at least one `typography.copy-*` token with all five properties filled
- [ ] **Typography — Heading** — frontmatter has at least one `typography.heading-*` token with all five properties filled
- [ ] **Spacing** — frontmatter has `spacing.base` declared and at least 5 numbered steps with pixel values
- [ ] **Rounded** — frontmatter has `rounded.sm` with a concrete pixel value
- [ ] **Breakpoints** — at least 2 responsive breakpoints documented in body

### What an agent CAN do at Level 1

- Style a basic page with correct brand colors
- Choose readable typography
- Apply consistent spacing
- Make a responsive layout that works on mobile and desktop
- Signal errors with the correct color

### What an agent CANNOT do at Level 1

- Build a consistent component library (no component tokens)
- Apply elevation/shadow correctly (will guess)
- Use motion responsibly (will guess)
- Generate dark mode (no DESIGN.dark.md)
- Apply voice rules to copy text

### Verdict

- **All 13 items checked → Level 1 complete**
- **Missing items → below Level 1 (insufficient for agent UI generation)**

## Level 2 — Standard (consistent components)

Sufficient for building a consistent, polished UI with reusable components. The expected level for production codebases with a frontend.

Prerequisite: Level 1 complete.

### Checklist

- All Level 1 items complete
- [ ] **Colors — Full background scale** — frontmatter has `colors.background-100`, `background-200`, `background-300` active (uncommented, filled)
- [ ] **Colors — Full gray solid scale** — frontmatter has `colors.gray-100` through `gray-1000` (10 steps) all active
- [ ] **Colors — Gray alpha scale** — frontmatter has `colors.gray-alpha-100` through at least `gray-alpha-600` all active
- [ ] **Colors — All accent scales** — frontmatter has `blue`, `red`, `amber`, `green`, `teal`, `purple`, `pink` scales, each with at least `700`/`800`/`900`/`1000` steps active
- [ ] **Typography — Headings** — frontmatter has at least 3 heading levels active (e.g., `heading-32`, `heading-24`, `heading-20`)
- [ ] **Typography — Labels** — frontmatter has at least one `label-*` token active
- [ ] **Typography — Buttons** — frontmatter has at least one `button-*` token active
- [ ] **Spacing** — frontmatter `spacing:` has full 9-step scale active; three-step rhythm documented in body
- [ ] **Rounded** — frontmatter `rounded:` has `sm`, `md`, `lg`, `full` all active
- [ ] **Breakpoints** — at least 4 breakpoints documented in body
- [ ] **Components — Button** — frontmatter `components:` has `button-primary` and `button-secondary` with all properties filled, plus `button-small` size variant; body documents hover/active/disabled/focus states
- [ ] **Components — Input** — frontmatter `components:` has `input` with all properties filled; body documents states

### What an agent CAN do at Level 2

- Everything from Level 1
- Build a consistent Button component with all states
- Build a consistent Input component with all states
- Use the full color scale for nuanced visual hierarchy
- Apply correct typography to every text role
- Use translucent overlays and borders (alpha scale)
- Pick the right accent color for each semantic purpose

### What an agent CANNOT do at Level 2

- Generate dark mode (no DESIGN.dark.md)
- Apply elevation/shadows with confidence (may guess)
- Use motion consistently (may guess)
- Enforce voice rules on copy text
- Know the correct border radius for each component type

### Verdict

- **All 11 items checked (on top of Level 1) → Level 2 complete**
- **1–3 items missing → Level 2 partial; useable but expect component inconsistencies**
- **4+ items missing → below Level 2; recommend completing Level 1 only deploy**

## Level 3 — Production (complete design system)

Full design system ready for production at scale. Includes dual theme, motion, and voice.

Prerequisite: Level 2 complete.

### Checklist

- All Level 1 and Level 2 items complete
- [ ] **DESIGN.dark.md exists** — dark theme file with `---` YAML frontmatter present, same key structure as DESIGN.md
- [ ] **Dark theme frontmatter parity** — every token in DESIGN.md frontmatter (`colors`, `typography`, `spacing`, `rounded`, `components`) has a corresponding active entry in DESIGN.dark.md frontmatter with dark-appropriate values
- [ ] **Elevation — Shadows** — at least 3 elevation levels (card, popover, modal) with explicit `box-shadow` values in body
- [ ] **Motion — Easing** — easing curve declared in body
- [ ] **Motion — Durations** — at least state change, popover, modal durations in body
- [ ] **Motion — Reduced motion** — `prefers-reduced-motion` rule declared in body
- [ ] **Components — Full library** — frontmatter `components:` has at least Card, Modal, Tooltip, Menu/Dropdown variants
- [ ] **Voice & Content** — writing rules documented in body: casing conventions, action naming, error format, toast format, empty state format

### What an agent CAN do at Level 3

- Everything from Levels 1 and 2
- Generate dark-mode-compatible UI
- Apply elevation correctly for every UI layer
- Animate state changes consistently
- Apply correct border radius per element type
- Write correct microcopy (button labels, errors, toasts, empty states)
- Build a full component library (Card, Modal, Tooltip, Menu)

### Verdict

- **All 9 items checked → Level 3 complete (production-ready)**
- **DESIGN.dark.md missing but rest complete → Level 2+ (partial Level 3, no dark mode)**

## Audit workflow

### When auditing existing DESIGN.md

1. Load the DESIGN.md file
2. Start at Level 1 checklist — check each item against actual content
3. If Level 1 complete, proceed to Level 2
4. If Level 2 complete, proceed to Level 3
5. Record the level as `<!-- COMPLETENESS_LEVEL: N -->` at top of DESIGN.md
6. For each incomplete item, note what's missing and which level it belongs to
7. Check for `LEVEL2_PLACEHOLDER` / `LEVEL3_PLACEHOLDER` markers — if present and the project is ready for upgrade, recommend activation

### When creating new DESIGN.md

1. Decide target level with PM/architect:
   - Prototype / early project → Level 1
   - Production frontend → Level 2
   - Full design system → Level 3
2. Copy the template from `templates/DESIGN.md.template`
3. Fill all items in the target level
4. Run this checklist to confirm
5. Leave higher-level placeholders as-is

### When upgrading DESIGN.md

1. Read current DESIGN.md and note the level tag
2. Identify which items in the next level are missing
3. For each missing item, either:
   - Fill with concrete values if known
   - Leave the `LEVEL*_PLACEHOLDER` marker if deferred
4. Re-audit and update the level tag

## Upgrade trigger conditions

Agents encountering a DESIGN.md with placeholders should evaluate these conditions:

| Condition | Action |
|-----------|--------|
| `LEVEL2_PLACEHOLDER` found AND plan includes component work | Recommend completing the Level 2 sections |
| `LEVEL3_PLACEHOLDER` found AND plan includes dark mode | Recommend creating DESIGN.dark.md |
| `LEVEL3_PLACEHOLDER` found AND plan targets production release | Recommend completing Level 3 |
| `COMPLETENESS_LEVEL: 1` AND project has >3 UI views | Recommend upgrading to Level 2 |
| `COMPLETENESS_LEVEL: 2` AND project has dark mode requirement | Recommend upgrading to Level 3 |
