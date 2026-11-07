# DESIGN.md Normative Spec

Normative contract for a `DESIGN.md`: file format, frontmatter token schema, section meaning, token naming, dual-theme rules, and the completeness levels. These are the rules `validateDesignTokenFrontmatter`, `assertLightDarkParity` and `completenessLevel` enforce; the itemized audit lives in `references/completeness-checklist.md`, the working shape in `templates/DESIGN.md.template`.

## 1. File format

- Markdown in the project root, UTF-8 encoded, opening with a `---`-fenced YAML frontmatter block. A file without that block fails validation.
- The **YAML frontmatter** is the single source of truth for token values; tools and agents MUST parse it for token resolution.
- The **Markdown body** (everything after the closing delimiter) documents intent, rules and usage; it never restates a token value.
- Multi-theme: `DESIGN.md` (light/default) plus `DESIGN.dark.md` (dark variant, same token names).

## 1.5. YAML frontmatter — token store

The frontmatter is a YAML map. `colors`, `typography`, `spacing` and `rounded` are required and each must be a non-empty map — a scalar value or an empty group fails. `components` is optional below Level 2, but must be a map whenever present.

| Field | Contract |
|-------|----------|
| `version` | Format version string; current value `0.1.0`. |
| `name`, `description` | Concrete strings; the description notes the light/dark relationship. |
| `colors` | Flat map of token names to values (§2.2). No sub-grouping by family. |
| `typography` | Map of token names to the five-property object below. |
| `spacing` | Map of `base` plus numeric multiplier keys to px lengths. |
| `rounded` | Map of semantic keys to px lengths. |
| `components` | Map of variant names to property maps; values are literals or `{path}` refs (§6). |

**Typography shape.** Every typography token has exactly the five properties `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing` — a missing or an extra property fails validation — and `fontFamily` / `fontSize` must be non-empty.

**Spacing keys.** `base` declares the base unit (typically `4px` or `8px`); every other key is a numeric multiplier on it. Any key that is neither `base` nor numeric fails, and every value must be a px length.

**Rounded values.** px lengths only: `sm: 6px`, `md: 12px`, `lg: 16px`, `full: 9999px`.

**Placeholders.** A `"[...]"` value is a template placeholder, never a concrete token: validation reports it and no completeness item counts it. Deferred Level 2+ keys stay YAML-commented and tagged `# LEVEL2_PLACEHOLDER:` (§5).

**Frontmatter vs body.** Token values, color hexes, typography specs, spacing steps and component variants live in the frontmatter. Elevation, motion, breakpoints and voice rules are body-only — they have no frontmatter field.

## 2. Section definitions

Each section below maps to one body heading. The order shown is recommended; a project may omit a section that does not yet apply. Where the frontmatter holds a value, the body documents intent and does not repeat the number.

### 2.1 Overview

The design system's name, core aesthetic principles, primary audience, and a statement of which file carries the opposite theme.

### 2.2 Colors

**Values.** sRGB hex — `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — or `oklch(...)`. A wide-gamut equivalent takes a `*-p3` suffix key. Alpha tokens use 8-digit hex. Any other format fails validation.

**Scale intent.** A color scale has ten steps, `100`–`1000`, with fixed meaning:

| Step | Intent |
|------|--------|
| `100` / `200` / `300` | default / hover / active background |
| `400` / `500` / `600` | default / hover / active border |
| `700` / `800` | solid fill / solid fill hover |
| `900` / `1000` | secondary text and icons / primary text and icons |

**Families.** Names encode the family (`{namespace}-{step}`, §3):

- **Background** (`background-*`): page and card surfaces.
- **Solid** (`gray-*`): text and opaque fills; **alpha** (`gray-alpha-*`): translucent overlays, borders and dividers that layer over any surface.
- **Accent** (`blue`, `red`, `amber`, `green`, `teal`, `purple`, `pink`): carries meaning — success, error, warning, links, focus. A scale may carry fewer steps than ten when the design needs fewer.

### 2.3 Typography

- **Roles:** `heading-*` for titles and section headings, `label-*` for single-line scannable text (navigation, form labels, table headers), `copy-*` for multi-line body text with a taller line height, `button-*` for medium-weight button labels, and a `-mono` suffix for code and data.
- **Naming:** a token name encodes its intended font size — `copy-14` is body copy at about 14px.
- **Numbers:** use tabular figures where numbers must align.

### 2.4 Spacing & Layout

- Base unit 4px or 8px, declared as `spacing.base`; the scale is `4, 8, 12, 16, 24, 32, 40, 64, 96` on a 4px base (or the 8px equivalent).
- Three-step rhythm: small inside a group, medium between groups, large between sections.
- Card padding: 24px default, 16px compact, 32px hero.
- Content has a max-width with responsive side padding.
- Breakpoints are body-only: give each a name and an explicit pixel value.

### 2.5 Elevation & Depth

- Use tonal surfaces first and shadows second; keep shadows subtle.
- Define one shadow value per elevation level — card, popover, modal.
- Pair each elevation with its matching border radius.

### 2.6 Motion

- Motion clarifies a change; it never decorates.
- 0ms — instant — is often the right default; when motion is used, keep it short and physical: roughly 150ms for a state change, 200ms for a popover, 300ms for a modal.
- Honor `prefers-reduced-motion`.
- No looping or attention-grabbing animation.

### 2.7 Shapes

- Keep radii tight and consistent; one radius family per view, never mixing rounded and sharp corners.

| Context | Radius |
|---------|--------|
| Surface, input, button | 6px |
| Menu, modal, popover | 12px |
| Fullscreen | 16px |
| Pill, avatar | 9999px |

### 2.8 Components

- Each variant declares `backgroundColor`, `textColor`, `typography`, `rounded`, `height`, plus `padding` and `borderColor` where applicable; values are `{path}` references (§6) or literals.
- Size variants — default 40px, small 32px, large 48px — override typography, padding and height only.
- State mapping: hover steps the foreground scale up one step, active up two; borders move `400 → 500 → 600`.
- Focus ring: a two-layer box-shadow — surface gap plus accent ring.
- Disabled: `100` fill, `700` text, `not-allowed` cursor.
- The body documents the state rules (hover / active / disabled / focus) behind these tokens.

### 2.9 Voice & Content

- Title Case for labels, buttons, titles and tabs; sentence case for body, helper text and toasts.
- Actions are verb plus noun — `Deploy Project`, never `Confirm`.
- Errors state what happened plus what to do next.
- Toasts name the specific thing that changed, drop the trailing period, and never say `successfully`.
- Empty states describe the first action.
- In-progress states are a present participle plus the ellipsis character — `Deploying…`.
- Use numerals, curly quotes and the ellipsis character.

## 3. Token naming conventions

- **Color:** `{namespace}-{step}`, where `namespace` is `background`, `gray`, `gray-alpha`, `blue`, `red`, `amber`, `green`, `teal`, `purple` or `pink`, and `step` is `100`–`1000` with the intent fixed in §2.2.
- **Typography:** `{role}-{size}`, where `role` is `heading`, `label`, `copy` or `button` and `size` is the approximate pixel size; a mono variant appends `-mono`.
- **Breakpoints:** lowercase short names — `sm`, `md`, `lg`, `xl`, `2xl`.

## 4. Light/Dark dual-theme rules

Dual theme means the **same token names with different values** in two separate files: `DESIGN.md` (light or default) and `DESIGN.dark.md` (dark). Both files carry the frontmatter block of §1.5; a missing block in either fails the parity check.

1. Token names are identical across both files.
2. Only the values differ — a light `background-100: #ffffff` becomes dark `background-100: #111111`.
3. Both files define the same active token set across all five groups (`colors`, `typography`, `spacing`, `rounded`, `components`); no token may exist in only one file.
4. `DESIGN.md` is always the SSOT for token names; `DESIGN.dark.md` copies the structure.
5. A token with no dark-mode role (a light-only accent, say) still appears in `DESIGN.dark.md` with a sensible dark-equivalent value.
6. The `DESIGN.md` Overview names the `DESIGN.dark.md` path.

The dark file MUST be named `DESIGN.dark.md` — not `design-dark.md` or `DESIGN_DARK.md`.

## 5. Upgrade placeholders

A section not yet filled carries an HTML-comment marker instead of silently empty content: `<!-- LEVEL2_PLACEHOLDER: <what is deferred and when to revisit> -->`, likewise `LEVEL3_PLACEHOLDER` (the template ships real instances). An agent reading one understands that:

- the section is intentionally deferred, not accidentally empty;
- the marker states what is missing and when to revisit it;
- an audit detects the marker and recommends the level it would unlock.

## 6. Mapping to implementation

| DESIGN.md | Implementation |
|-----------|----------------|
| Frontmatter `colors:` | CSS custom properties (`--color-gray-100`) or a theme object |
| Frontmatter `typography:` | CSS classes or a Tailwind prose config |
| Frontmatter `spacing:` / `rounded:` | CSS custom properties or Tailwind spacing / radius config |
| Frontmatter `components:` | Component prop defaults or CSS classes |
| Body breakpoints | CSS media queries or Tailwind screens |
| Body elevation | `box-shadow` or a Tailwind shadow config |
| Body motion | `transition` or animation-library config |
| Body voice rules | Linter rules or prompt context for generated copy |

A `{path}` reference in `components:` (`"{colors.gray-1000}"`, `"{typography.button-14}"`, `"{rounded.sm}"`) MUST trace back to an active key in the same file's frontmatter — `{colors.gray-1000}` → `colors.gray-1000` → `"#171717"`. Only `colors`, `typography` and `rounded` are referenceable groups, and an unresolved reference fails validation.

Resolving references is the consuming agent's job, not DESIGN.md's: the document stays implementation-agnostic.

## 7. Completeness levels

A DESIGN.md is at **Level N** when every item at Level N and below passes. Only concrete frontmatter values count — a commented-out key, a `"[...]"` placeholder, or a value missing its required properties is not a pass. `completeness-checklist.md` § Level 1–3 is the normative item list and holds the exact thresholds; this section defines what each level certifies.

- **Level 1 — MVP**: the minimum that lets an agent build UI without inventing color, type or spacing — a frontmatter declaring `version`, `name` and `description`; a palette (a background, primary and secondary text, one accent, plus error and warning); at least one complete `copy-*` and one complete `heading-*` typography token; a spacing scale on `base`; a small radius; and the breakpoints stated in the body.
- **Level 2 — Standard**: consistent reusable components — the full background, solid, alpha and accent scales; the full typography role set; the complete spacing and radius scales; Button (primary, secondary, small) and Input component tokens; and, in the body, four breakpoints plus the component states and the spacing rhythm.
- **Level 3 — Production**: a complete design system — a component library (Card, Modal, Tooltip, Menu/Dropdown), `DESIGN.dark.md` at full token parity, and Elevation, Motion, Shapes and Voice & Content documented in the body.

**Verdict vocabulary.** The audit reports `BELOW_MVP` (Level 1 items missing), `MVP`, `Standard` or `Production`.

**Body confirmation.** Level 3 is dominated by body and dual-theme items, which no frontmatter scan can certify: an audit that passes no body checklist tops out at Level 2.

**Upgrade path.** A `LEVEL2_PLACEHOLDER` / `LEVEL3_PLACEHOLDER` marker (§5) is an intentional deferral, not a defect; the audit names the level each marker would unlock.
