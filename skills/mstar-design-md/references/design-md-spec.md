# DESIGN.md Normative Spec

This document defines the normative structure, token naming conventions, and rules for a properly formed `DESIGN.md` file. It is the single source of truth for what each section means and how tokens should be defined.

## 1. File format

- Markdown (`.md`) with YAML frontmatter in project root
- UTF-8 encoding
- **YAML frontmatter** (`---` delimited block at top) contains structured, machine-readable token values
- **Markdown body** (everything after the `---` closing delimiter) contains human/agent-readable documentation, usage rules, and design intent
- Multi-theme: `DESIGN.md` (light/default) + `DESIGN.dark.md` (dark variant, same token names)

## 1.5. YAML Frontmatter — Structured Token Store

The YAML frontmatter is the **single source of truth** for token values. The Markdown body is supplementary documentation. Tools and agents MUST parse the frontmatter for token resolution; the body prose explains intent and rules.

### Version field

```yaml
version: alpha
```

Format version identifier. Current value: `alpha`.

### Name and description

```yaml
name: "[Design System Name]"
description: "[Brief description, noting light/dark theme relationship]"
```

### Colors (`colors:`)

Flat map of token names to hex (or `oklch()` for P3) values. All scales are flat — not nested:

```yaml
colors:
  background-100: "#ffffff"
  gray-1000: "#171717"
  blue-700: "#006bff"
  blue-700-p3: "oklch(57.61% 0.2508 258.23)"
```

- Color token names follow the `{namespace}-{step}` convention (see §3)
- `*-p3` variants are optional wide-gamut equivalents in `oklch()` for Display P3 screens
- Alpha tokens use `#rrggbbaa` hex-with-alpha format (8 hex digits)
- All tokens are at the top level of `colors:` — no sub-grouping by family

### Typography (`typography:`)

Map of tokens to structured sub-objects:

```yaml
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
```

Each typography token sub-object contains exactly five properties: `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`. Typography token names follow the `{role}-{size}` convention (see §3).

### Spacing (`spacing:`)

Flat map of numeric keys to pixel values:

```yaml
spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  10: 40px
  16: 64px
  24: 96px
```

- `base` declares the base unit (typically `4px` or `8px`)
- Numeric keys are multipliers on the base unit

### Border radius (`rounded:`)

Flat map of semantic keys to pixel values:

```yaml
rounded:
  sm: 6px
  md: 12px
  lg: 16px
  full: 9999px
```

### Components (`components:`)

Map of component variant names to structured sub-objects. Values reference other frontmatter keys using `{path}` syntax:

```yaml
components:
  button-primary:
    backgroundColor: "{colors.gray-1000}"
    textColor: "{colors.background-100}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 40px
```

- `{colors.X}` resolves to the value of `colors.X` in the same file's frontmatter
- `{typography.X}` resolves to the typography object (not a single value — consumers use the full object)
- `{rounded.X}` resolves to the border-radius value
- Direct values (like `"#ffffff"` or `40px`) are literal and do not reference other keys

### Completeness level in frontmatter

The frontmatter always contains the full key structure for every level. Level 2+ keys that are not yet filled are YAML-commented out with `# LEVEL2_PLACEHOLDER:` comments. The audit workflow (see `completeness-checklist.md`) checks which keys are active (uncommented) vs. placeholder (commented or containing `[LEVEL` / placeholder values).

### Frontmatter vs. body contract

| Aspect | Frontmatter (YAML) | Body (Markdown) |
|--------|-------------------|-----------------|
| Token values | **SSOT** — parse here | Descriptive prose referencing tokens |
| Color hex values | All active tokens here | Explanation of scale intent, usage rules |
| Typography specs | Exact CSS properties | Role descriptions, intent encoding |
| Spacing scale | Exact pixel values | Rhythm rules, usage patterns |
| Component tokens | Variants with references | State rules, size descriptions, focus patterns |
| Elevation | N/A (body-only) | box-shadow values per element |
| Motion | N/A (body-only) | Duration and easing tables |
| Voice rules | N/A (body-only) | Copy conventions and examples |

## 2. Section definitions

Each section below maps to one heading in `DESIGN.md`. Sections are ordered as shown in Vercel Geist (recommended), but projects may omit sections not yet relevant. Where a section has corresponding YAML frontmatter fields, the frontmatter holds the canonical values and the body provides documentation.

### 2.1 Overview

**Purpose:** Declare the design system's identity — a short statement that grounds all downstream decisions.

**What to include:**
- Name of the design system
- Core aesthetic principles (e.g., minimal, high-contrast, playful)
- Primary audience (developer tools, consumer app, dashboard, etc.)
- Note whether this is a light theme, dark theme, or references another file for the opposite theme

**Example (minimal):**

```
# Acme Design

Acme Design is a minimal, high-contrast design system for our developer dashboard.
Prioritize readability and signal state through color and iconography, not decoration.

This is the Light theme. The Dark theme lives at `/DESIGN.dark.md`.
```

**Level relevance:** Level 1+

### 2.2 Colors

**Purpose:** Define every color used in the UI, organized into scales.

**SSOT:** All concrete color values live in the frontmatter `colors:` map. The body prose below explains scale conventions and usage intent.

**Conventions:**
- Each color scale has 10 steps (`100`–`1000`), encoding intent:
  - `100`: default background
  - `200`: hover background
  - `300`: active background
  - `400`: default border
  - `500`: hover border
  - `600`: active border
  - `700`: solid fill
  - `800`: solid fill hover
  - `900`: secondary text/icons
  - `1000`: primary text/icons
- **Background scales** (`background-100`, `background-200`): page/card surfaces
- **Alpha scales** (`gray-alpha-*`): translucent overlays, borders, dividers — layer over any background; use `#rrggbbaa` hex-with-alpha or `rgba()` notation
- **Solid scales** (`gray-*`): text, opaque fills — hold contrast on any surface
- **Accent scales** (`blue`, `red`, `amber`, `green`, `teal`, `purple`, `pink`): carry meaning — success, error, warning, links, focus
- Accent scales may use fewer steps if not all needed

**Values:** sRGB hex (`#ffffff`), optionally with wide-gamut equivalents in `oklch()` as `*-p3` suffix keys.

**Example frontmatter:**

```yaml
colors:
  background-100: "#ffffff"
  background-200: "#f5f5f5"
  gray-100: "#f5f5f5"
  gray-700: "#333333"
  gray-1000: "#111111"
  blue-700: "#0066ff"
  red-700: "#e60000"
```

**Level relevance:** Level 1+ requires at least background, text (gray-900/1000), and one accent (blue-700, red-700, amber-700) active in frontmatter. Level 2+ requires all color scales uncommented and filled.

### 2.3 Typography

**Purpose:** Define font families, sizes, weights, line heights, and letter spacing for every text role.

**SSOT:** All concrete typography values live in the frontmatter `typography:` map. The body prose explains role semantics and usage intent.

**Conventions:**
- **Heading tokens** (`heading-72` through `heading-14`): title pages and section headings
- **Label tokens** (`label-20` through `label-12`): single-line scannable text — navigation, form labels, table headers
- **Copy tokens** (`copy-24` through `copy-13`): multi-line body text with taller line height
- **Button tokens** (`button-16` through `button-12`): medium-weight labels for buttons
- **Mono tokens**: same metrics with monospace font for code/data
- Each token carries: `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`
- Token name encodes intended font size (e.g., `copy-14` ≈ 14px body copy)
- Use tabular figures for numbers that need alignment

**Example frontmatter (minimal):**

```yaml
typography:
  heading-32:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  copy-16:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
```

**Level relevance:** Level 1+ requires at least one copy and one heading token active in frontmatter. Level 2+ requires heading, label, copy, and button typography tokens.

### 2.4 Spacing & Layout

**Purpose:** Define the spatial grid and responsive breakpoints.

**SSOT:** Spacing scale values live in the frontmatter `spacing:` map. Border radius values live in `rounded:`. Breakpoints are documented in the body.

**Conventions:**
- Base unit: 4px or 8px (declared as `spacing.base` in frontmatter)
- Scale: `4, 8, 12, 16, 24, 32, 40, 64, 96` (on 4px) or equivalent on 8px
- Three-step rhythm: small inside group → medium between groups → large between sections
- Card padding: 24px default, 16px compact, 32px hero
- Content max-width with responsive side padding
- Breakpoints: provide explicit pixel values and names

**Example frontmatter:**

```yaml
spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  10: 40px
  16: 64px
  24: 96px

rounded:
  sm: 6px
  md: 12px
  lg: 16px
  full: 9999px
```

**Level relevance:** Level 1+ requires `spacing.base` and at least 5 scale steps in frontmatter, plus at least 2 breakpoints in body.

### 2.5 Elevation & Depth

**Purpose:** Define shadow values for layered UI elements.

**Conventions:**
- Use tonal surfaces first, shadows second — keep shadows subtle
- Define shadow values per elevation level: cards, popovers, modals
- Pair each elevation with a matching border radius

**Example:**

```
## Elevation

### Shadows
| Level | Value |
|-------|-------|
| Card | 0 2px 2px rgba(0,0,0,0.04) |
| Popover | 0 1px 1px rgba(0,0,0,0.02), 0 4px 8px -4px rgba(0,0,0,0.04), 0 16px 24px -8px rgba(0,0,0,0.06) |
| Modal | 0 1px 1px rgba(0,0,0,0.02), 0 8px 16px -4px rgba(0,0,0,0.04), 0 24px 32px -8px rgba(0,0,0,0.06) |
```

**Level relevance:** Level 3 only.

### 2.6 Motion

**Purpose:** Define animation durations and easing curves.

**Conventions:**
- Motion clarifies change, never decorates
- Default: 0ms (instant) is often the best choice
- When needed: short, physical easing — roughly 150ms state, 200ms popover, 300ms modal
- Honor `prefers-reduced-motion`
- No looping or attention-grabbing animations

**Example:**

```
## Motion

### Easing
Default: cubic-bezier(0.175, 0.885, 0.32, 1.1)

### Durations
| Context | Duration |
|---------|----------|
| State change | 150ms |
| Popover/Tooltip | 200ms |
| Modal/Overlay | 300ms |
```

**Level relevance:** Level 3 only.

### 2.7 Shapes

**Purpose:** Define border radius values.

**Conventions:**
- Keep radii tight and consistent
- One radius family per view, never mix rounded and sharp corners
- Common values: 6px (surfaces), 12px (menus/modals), 16px (fullscreen), 9999px (pills)

**Example:**

```
## Shapes

### Border Radius
| Context | Value |
|---------|-------|
| Surface, Input, Button | 6px |
| Menu, Modal, Popover | 12px |
| Fullscreen | 16px |
| Pill, Avatar | 9999px |
```

**Level relevance:** Level 3 only.

### 2.8 Components

**Purpose:** Define ready-to-use token values for common components.

**SSOT:** Component variant tokens live in the frontmatter `components:` map. Values reference other frontmatter keys using `{colors.X}`, `{typography.X}`, `{rounded.X}` syntax. The body prose documents state rules (hover/active/disabled/focus) and size variants.

**Conventions:**
- Each component variant gets: `backgroundColor`, `textColor`, `typography`, `rounded`, `height` (and `padding`, `borderColor` where applicable)
- Size variants: default (40px), small (32px), large (48px) — override only typography/padding/height
- State mappings: hover steps foreground up one, active steps up two; border from 400→500→600
- Focus ring: two-layer box-shadow (surface gap + accent ring)
- Disabled: 100 fill + 700 text + not-allowed cursor

**Example frontmatter:**

```yaml
components:
  button-primary:
    backgroundColor: "{colors.gray-1000}"
    textColor: "{colors.background-100}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 40px
  button-secondary:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 40px
  input:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.label-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 40px
```

**Level relevance:** Level 2+ requires at least Button (primary, secondary) and Input tokens in frontmatter. Level 3 requires full component library.

### 2.9 Voice & Content

**Purpose:** Define content writing rules for the UI.

**Conventions:**
- Title Case for labels, buttons, titles, tabs
- Sentence case for body, helper text, toasts
- Verb + Noun for actions (`Deploy Project`, never `Confirm`)
- Errors: what happened + what to do
- Toasts: specific thing + no trailing period + no `successfully`
- Empty states: describe the first action
- In-progress: present participle + ellipsis (`Deploying…`)
- Use numerals, curly quotes, the ellipsis character

**Example:**

```
## Voice & Content

- Use Title Case for labels, buttons, titles, and tabs
- Sentence case for body, helper text, and toasts
- Name actions with a verb and a noun: `Deploy Project`, `Delete Member`
- Write errors as what happened plus what to do next
- Toasts name the specific thing that changed, drop the trailing period
- Empty states point to the first action: `No deployments yet. Push to your Git repository to create one.`
```

**Level relevance:** Level 3 only.

## 3. Token naming conventions

### Color tokens

```
{namespace}-{step}
```

- `namespace`: `background`, `gray`, `gray-alpha`, `blue`, `red`, `amber`, `green`, `teal`, `purple`, `pink`
- `step`: `100`–`1000` (10-step scale encoding intent as defined in §2.2)

### Typography tokens

```
{role}-{size}
```

- `role`: `heading`, `label`, `copy`, `button`
- `size`: approximate font size in pixels
- Mono variant: `{role}-{size}-mono`

### Breakpoint tokens

Lowercase short names: `sm`, `md`, `lg`, `xl`, `2xl`

## 4. Light/Dark dual-theme rules

### Contract

Dual theme uses **same token names with different values** in two separate files:

- `DESIGN.md` — light (or default) theme
- `DESIGN.dark.md` — dark theme

### Rules

1. **Token names are identical** across both files
2. **Only the values differ** — a light `background-100: #ffffff` becomes dark `background-100: #111111`
3. **Both files define the same token set** — no token can exist in only one file
4. **DESIGN.md is always the SSOT for token names** — DESIGN.dark.md copies the structure
5. If a token isn't relevant to dark mode (e.g., a light-only accent), include it in DESIGN.dark.md anyway with a sensible dark-equivalent value
6. Add `DESIGN.dark.md` path reference in DESIGN.md Overview

### Naming

Dark theme file must be named `DESIGN.dark.md` (not `design-dark.md` or `DESIGN_DARK.md`).

## 5. Upgrade placeholders

Sections not yet filled should use HTML comment markers:

```
<!-- LEVEL2_PLACEHOLDER: Complete the 10-step color scales and add alpha scale when the design matures. See `references/completeness-checklist.md` § Level 2. -->
```

```
<!-- LEVEL3_PLACEHOLDER: Add Elevation, Motion, Shapes, Voice & Content, and full Component library when ready for production design system. See `references/completeness-checklist.md` § Level 3. -->
```

Agents encountering these placeholders understand that:
- The section is intentionally deferred, not accidentally empty
- The placeholder describes what's missing and when to revisit
- An upgrade workflow can detect these markers and recommend progression

## 6. Mapping to implementation

DESIGN.md tokens should map to implementation as follows:

| DESIGN.md | Implementation |
|-----------|---------------|
| Frontmatter `colors:` | CSS custom properties (`--color-gray-100`) or theme object |
| Frontmatter `typography:` | CSS classes or Tailwind prose config |
| Frontmatter `spacing:` | CSS custom properties or Tailwind spacing config |
| Frontmatter `rounded:` | CSS custom properties or Tailwind radius config |
| Body breakpoints | CSS media queries or Tailwind screens |
| Frontmatter `components:` | Component prop defaults or CSS classes |
| Body elevation | `box-shadow` or Tailwind shadow config |
| Body motion | `transition` or animation library config |
| Body voice rules | Linter rules or prompt context for copy generation |

**Frontmatter references** in `components:` (e.g., `"{colors.gray-1000}"`) MUST be resolved by tracing the `{path}` back to the frontmatter key. For example, `"{colors.gray-1000}"` → `colors.gray-1000` → `"#171717"`.

The agent consuming DESIGN.md is responsible for frontmatter parsing and reference resolution, not DESIGN.md itself. DESIGN.md stays implementation-agnostic.
