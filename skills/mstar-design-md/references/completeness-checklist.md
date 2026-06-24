# DESIGN.md Completeness Checklist

Three-level progressive checklist for evaluating whether a `DESIGN.md` is sufficient to drive agent UI generation. Each level builds on the previous level's requirements.

## How to use

1. Read `DESIGN.md` (and `DESIGN.dark.md` if exists)
2. Check each item in the target level (and all lower levels)
3. An item is **complete** only when concrete values exist — placeholder comments do not count
4. A `DESIGN.md` is at **Level N** when all items in Level N and below are complete
5. Record the result in a comment at the top of DESIGN.md:

```
<!-- COMPLETENESS_LEVEL: N — last audited YYYY-MM-DD -->
```

## Level 1 — MVP (prevents guesswork)

The minimum bar for an agent to produce UI without hallucinating colors and typography. Sufficient for early-stage projects, prototypes, and CLI tools with minimal UI.

### Checklist

- [ ] **Overview** — design system name and aesthetic principles stated
- [ ] **Colors — Background** — at least one surface color (`background-100`)
- [ ] **Colors — Text** — at least one text color (`gray-1000` or equivalent)
- [ ] **Colors — Accent** — at least one accent color for links/actions (`blue*` or brand equivalent)
- [ ] **Colors — Semantic** — at least one error color (`red*`) and warning color (`amber*`)
- [ ] **Typography — Body** — at least one body text token with font family, size, weight, line height
- [ ] **Typography — Heading** — at least one heading token
- [ ] **Spacing** — base unit declared (4px or 8px) and at least 5 scale steps
- [ ] **Breakpoints** — at least 2 responsive breakpoints defined

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

- **All 9 items checked → Level 1 complete**
- **Missing items → below Level 1 (insufficient for agent UI generation)**

## Level 2 — Standard (consistent components)

Sufficient for building a consistent, polished UI with reusable components. The expected level for production codebases with a frontend.

Prerequisite: Level 1 complete.

### Checklist

- All Level 1 items complete
- [ ] **Colors — Full background scale** — `background-100` through at least `background-300`
- [ ] **Colors — Full gray solid scale** — `gray-100` through `gray-1000` (10 steps)
- [ ] **Colors — Gray alpha scale** — at least `gray-alpha-100` through `gray-alpha-600`
- [ ] **Colors — All accent scales** — `blue`, `red`, `amber`, `green`, `teal`, `purple`, `pink` with at least `700`/`800`/`900`/`1000` steps each
- [ ] **Typography — Headings** — at least 3 heading levels (e.g., `heading-32`, `heading-24`, `heading-20`)
- [ ] **Typography — Labels** — at least one label token
- [ ] **Typography — Buttons** — at least one button typography token
- [ ] **Spacing** — full 9-step scale (4, 8, 12, 16, 24, 32, 40, 64, 96px) and three-step rhythm documented
- [ ] **Breakpoints** — at least 4 breakpoints
- [ ] **Components — Button** — at least primary and secondary variants with size variants (default 40px, small 32px), plus hover/active/disabled/focus states
- [ ] **Components — Input** — at least default variant with size variants, plus hover/active/disabled/focus/error states

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
- [ ] **DESIGN.dark.md exists** — dark theme file with same token names, dark-appropriate values
- [ ] **Dark theme covers all tokens** — every token in DESIGN.md has a corresponding entry in DESIGN.dark.md
- [ ] **Elevation — Shadows** — at least 3 elevation levels (card, popover, modal) with explicit `box-shadow` values
- [ ] **Motion — Easing** — easing curve declared
- [ ] **Motion — Durations** — at least state change, popover, modal durations
- [ ] **Motion — Reduced motion** — `prefers-reduced-motion` rule declared
- [ ] **Shapes — Border radius** — at least 4 radius tokens (surface/input, menu/modal, fullscreen, pill)
- [ ] **Components — Full library** — at least Card, Modal, Tooltip, Menu/Dropdown tokens
- [ ] **Voice & Content** — writing rules documented: casing conventions, action naming, error format, toast format, empty state format

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
