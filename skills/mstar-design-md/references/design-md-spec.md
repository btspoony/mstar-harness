# DESIGN.md Normative Spec

This document defines the normative structure, token naming conventions, and rules for a properly formed `DESIGN.md` file. It is the single source of truth for what each section means and how tokens should be defined.

## 1. File format

- Plain Markdown (`.md`) in project root
- UTF-8 encoding
- Multi-theme: `DESIGN.md` (light/default) + `DESIGN.dark.md` (dark variant, same token names)

## 2. Section definitions

Each section below maps to one heading in `DESIGN.md`. Sections are ordered as shown in Vercel Geist (recommended), but projects may omit sections not yet relevant.

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
- **Alpha scales** (`gray-alpha-*`): translucent overlays, borders, dividers — layer over any background
- **Solid scales** (`gray-*`): text, opaque fills — hold contrast on any surface
- **Accent scales** (`blue`, `red`, `amber`, `green`, `teal`, `purple`, `pink`): carry meaning — success, error, warning, links, focus
- Accent scales may use fewer steps if not all needed

**Values:** sRGB hex (`#ffffff`), optionally with wide-gamut equivalents in `oklch()`.

**Example:**

```
## Colors

### Background
| Token | Value |
|-------|-------|
| background-100 | #ffffff |
| background-200 | #f5f5f5 |

### Gray (solid)
| Token | Value |
|-------|-------|
| gray-100 | #f5f5f5 |
| gray-700 | #333333 |
| gray-1000 | #111111 |

### Accent
| Token | Value |
|-------|-------|
| blue-700 | #0066ff |
| red-700 | #e60000 |
```

**Level relevance:** Level 1+ requires at least background, gray, and one accent. Level 2+ requires full 10-step scales, alpha scale, and all accent colors.

### 2.3 Typography

**Purpose:** Define font families, sizes, weights, line heights, and letter spacing for every text role.

**Conventions:**
- **Heading tokens** (`heading-72` through `heading-14`): title pages and section headings
- **Label tokens** (`label-20` through `label-12`): single-line scannable text — navigation, form labels, table headers
- **Copy tokens** (`copy-24` through `copy-13`): multi-line body text with taller line height
- **Button tokens** (`button-16` through `button-12`): medium-weight labels for buttons
- **Mono tokens**: same metrics with monospace font for code/data
- Each token carries: `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`
- Token name encodes intended font size (e.g., `copy-14` ≈ 14px body copy)
- Use tabular figures for numbers that need alignment

**Example (minimal):**

```
## Typography

### Headings
| Token | Font | Size | Weight | Line | Spacing |
|-------|------|------|--------|------|---------|
| heading-32 | Inter | 32px | 600 | 1.2 | -0.02em |
| heading-20 | Inter | 20px | 600 | 1.3 | -0.01em |

### Body
| Token | Font | Size | Weight | Line | Spacing |
|-------|------|------|--------|------|---------|
| copy-16 | Inter | 16px | 400 | 1.6 | 0 |
| copy-14 | Inter | 14px | 400 | 1.5 | 0 |
```

**Level relevance:** Level 1+ requires at least body text (one copy token) and one heading token. Level 2+ requires full heading/label/copy/button typography scale.

### 2.4 Spacing & Layout

**Purpose:** Define the spatial grid and responsive breakpoints.

**Conventions:**
- Base unit: 4px or 8px (consistent across the system)
- Scale: `4, 8, 12, 16, 24, 32, 40, 64, 96` (on 4px) or equivalent on 8px
- Three-step rhythm: small inside group → medium between groups → large between sections
- Card padding: 24px default, 16px compact, 32px hero
- Content max-width with responsive side padding
- Breakpoints: provide explicit pixel values and names

**Example:**

```
## Layout

### Spacing scale
4px, 8px, 12px, 16px, 24px, 32px, 40px, 64px, 96px

### Rhythm
- 8px: inside a group (label + input, icon + text)
- 16px: between related groups
- 32-40px: between sections

### Breakpoints
| Name | Width |
|------|-------|
| sm | 401px |
| md | 601px |
| lg | 961px |
| xl | 1200px |
```

**Level relevance:** Level 1+ requires spacing scale and at least 2 breakpoints.

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

**Conventions:**
- Each component gets: `backgroundColor`, `textColor`, `rounded`, `height` (and `borderColor` where applicable)
- Size variants: default (40px), small (32px), large (48px)
- State mappings: hover steps foreground up one, active steps up two; border from 400→500→600
- Focus ring: two-layer box-shadow (surface gap + accent ring)
- Disabled: 100 fill + 700 text + not-allowed cursor

**Example:**

```
## Components

### Button
| Variant | Background | Text | Border | Radius | Height |
|---------|-----------|------|--------|--------|--------|
| primary | gray-1000 | background-100 | — | 6px | 40px |
| secondary | background-100 | gray-1000 | gray-alpha-400 | 6px | 40px |
| tertiary | transparent | gray-1000 | — | 6px | 40px |
| error | red-800 | #fff | — | 6px | 40px |

### Input
| Variant | Background | Text | Border | Radius | Height |
|---------|-----------|------|--------|--------|--------|
| default | background-100 | gray-1000 | gray-alpha-400 | 6px | 40px |
```

**Level relevance:** Level 2+ requires at least Button and Input tokens. Level 3 requires full component library.

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
| Color tokens | CSS custom properties (`--color-gray-100`) or theme object |
| Typography tokens | CSS classes or Tailwind prose config |
| Spacing scale | CSS custom properties or Tailwind spacing config |
| Breakpoints | CSS media queries or Tailwind screens |
| Elevation | `box-shadow` or Tailwind shadow config |
| Motion | `transition` or animation library config |
| Shapes | `border-radius` or Tailwind radius config |
| Component tokens | Component prop defaults or CSS classes |
| Voice rules | Linter rules or prompt context for copy generation |

The agent consuming DESIGN.md is responsible for this mapping, not DESIGN.md itself. DESIGN.md stays implementation-agnostic.
