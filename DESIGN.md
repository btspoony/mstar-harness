---
version: 1.0.0
name: "Morning Star Unified Design System"
description: "One design system for the Morning Star harness: the standalone dashboard and the DeepSeek Harness panel render the same tokens, type ramp, density and status treatments. One name set, two value sets — light and dark are declared under the same names, never as a second file."

colors:
  # Surface roles. bg-canvas is the page ground; bg-surface is a panel or table;
  # bg-inset is a chip, track or code block; bg-hover / bg-selected are row states.
  accent: "#2d6be5"
  accent-soft: "#eaf0fd"
  bg-canvas: "#f6f7f8"
  bg-hover: "#f5f6f7"
  bg-inset: "#f1f2f4"
  bg-selected: "#edf3fe"
  bg-surface: "#ffffff"
  # Border roles. hairline separates; border-strong is a control boundary (>=3:1).
  border-hairline: "#e3e5e9"
  border-strong: "#8b8f96"
  # Text roles. primary = titles/values, secondary = labels, muted = timestamps.
  # All three clear 4.5:1 on both bg-surface and bg-canvas.
  text-primary: "#191c20"
  text-secondary: "#565d67"
  text-muted: "#6d727b"
  # Status tones, ordered by lightness so greyscale keeps them apart.
  danger: "#b7271f"
  warning: "#96590a"
  success: "#197f4f"
  neutral: "#747b8a"
  purple: "#693da2"

typography:
  page-title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans SC, Arial, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.01em
  screen-title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans SC, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: -0.01em
  emphasis:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans SC, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: 0
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans SC, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0
  meta:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans SC, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0
  mono-meta:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: -0.01em

spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  12: 48px

rounded:
  xs: 2px
  sm: 4px
  md: 6px
  full: 9999px
---

# Morning Star Unified Design System

One product, one implementation, two hosts. This document is the **single token
authority** for both the standalone dashboard (`mstar dashboard`) and the DeepSeek
Harness panel. `packages/ui/src/styles/tokens.css` is its only CSS implementation and
`packages/ui/src/styles/base.css` its only element layer; a token that exists in one and
not the other is a defect, and `packages/ui/src/styles/tokens.test.ts` fails on it.

The register is a **restrained developer tool** — the company of Linear, Vercel and
Raycast internals. Compact rows, strong typographic hierarchy, almost no decoration,
tables and lists doing the work, colour reserved for status. Not a marketing page and not
a spacious card dashboard.

## One name set, two value sets

The light values are the frontmatter above. The dark values live **in the same file** —
`tokens.css` declares the same names in a `[data-ms-theme="dark"]` block — and there is
deliberately **no `DESIGN.dark.md`**. Two files would let the two value sets drift apart
name by name, which is exactly the failure this system exists to prevent; the parity
guarantee is a test (`dark redeclares exactly the colour roles and no non-colour token`)
instead of a convention two files must remember.

The scheme reaches the tree as an **attribute, never a media query**. A host sets
`data-ms-theme="light|dark"` on the product wrapper from whatever it resolved — the dsh
host passes its own `ctx.theme`, the dashboard passes its stored preference or the OS
preference. There is no `"system"` value and no `prefers-color-scheme` rule anywhere in
the package: a component never asks which theme it is in, and a host that offers "follow
the OS" resolves it itself before setting the attribute.

No `--ms-*` value may alias a host token (`--dsw-*` or any other). The token sheet is the
same file in both builds; the only thing that differs is who computed the attribute.

## Colour roles

Every role is a **role**, not a shade: a component asks for the meaning it wants. Contrast
figures below are measured, not estimated — WCAG 2.x relative-luminance ratio against the
ground named in the last column.

| Role | Light | Dark | Means | Contrast |
| --- | --- | --- | --- | --- |
| `bg-canvas` | `#f6f7f8` | `#0c0e11` | The page ground | — |
| `bg-surface` | `#ffffff` | `#14171b` | A panel, table or popover body | — |
| `bg-inset` | `#f1f2f4` | `#1a1e23` | Chips, progress tracks, code blocks | — |
| `bg-hover` | `#f5f6f7` | `#1c2127` | Row hover | — |
| `bg-selected` | `#edf3fe` | `#182338` | Selected row, applied filter | — |
| `border-hairline` | `#e3e5e9` | `#242930` | A separator, never a boundary | 1.26:1 light / 1.23:1 dark — decorative only |
| `border-strong` | `#8b8f96` | `#5a6573` | A control or input boundary | **3.03:1 / 3.26:1** on `bg-canvas` |
| `text-primary` | `#191c20` | `#e7eaee` | Titles and values | **17.10:1 / 14.90:1** on `bg-surface` |
| `text-secondary` | `#565d67` | `#a4acb7` | Labels, secondary values | **6.65:1 / 7.84:1** |
| `text-muted` | `#6d727b` | `#7c8491` | Timestamps and field labels | **4.84:1 / 4.77:1** on surface, **4.51:1 / 5.12:1** on canvas |
| `accent` | `#2d6be5` | `#7aa2ff` | Links, focus ring, active navigation | **4.50:1 / 7.77:1** on `bg-canvas` |
| `accent-soft` | `#eaf0fd` | `#1a2740` | Chart area, quiet active row | — |
| `success` | `#197f4f` | `#4ec289` | Resolved, done, delivered | **5.01:1 / 8.05:1** on `bg-surface` |
| `warning` | `#96590a` | `#e8ae61` | Stale, violations, `high` | **5.63:1 / 9.12:1** |
| `danger` | `#b7271f` | `#e47a72` | `critical`, failures | **6.32:1 / 6.27:1** |
| `neutral` | `#747b8a` | `#878f9a` | `open`, `Todo`, inactive | **4.25:1 / 5.50:1** |
| `purple` | `#693da2` | `#bb91e8` | Terminal lifecycle | **7.53:1 / 7.13:1** |

Rules:

- **Every colour role clears the contrast its job needs.** Text roles clear 4.5:1 against
  both `bg-surface` and `bg-canvas`; `border-strong` clears the 3:1 a control boundary
  needs; the five status tones clear 3:1 as non-text graphics. `border-hairline` is the
  one deliberate exception and is a **separator only** — nothing may be identified on
  screen by a hairline alone.
- **`accent` is not success.** Blue is links, focus and selection. Green means resolved;
  amber means stale or violated; red means failed or `critical`; purple is reserved for
  terminal lifecycle. A status never borrows the accent colour.
- **No component writes a colour literal.** A hex value outside `tokens.css` fails the
  token contract test.

## Type ramp

Six steps, no more. The base is **13/20** — smaller than a web page and larger than a
terminal, because this is a dense surface read at arm's length.

| Step | Size / line | Weight | Used for |
| --- | --- | --- | --- |
| `page-title` | 20 / 28 | 600 | The one page title a host shell shows |
| `screen-title` | 16 / 24 | 600 | A destination's title, a record's title |
| `emphasis` | 14 / 20 | 500 | The single emphasis step above base — a section lead, a highlighted value |
| `body` | 13 / 20 | 400 | Row titles, field values, prose |
| `meta` | 12 / 16 | 400–500 | Column headers, field labels, chips |
| `mono-meta` | 11 / 16 | 400 | Timestamps, ids, paths, enum values |

- Sans for copy, mono for identifiers. **Numerals are tabular** in every column that can
  align: counts, progress fractions, timestamps.
- Prose never goes below 13px. Mono never goes above 12px inside a row.
- No step exists "for a bigger screen": the container gets narrower, the ramp does not
  grow.

## Spacing, row heights, borders, radius

The rhythm is **4px**, and the whole layout is a multiple of it.

| Token | Value | Used for |
| --- | --- | --- |
| `space-1` | 4px | Dot gap, inline gap |
| `space-2` | 8px | Inside a control group |
| `space-3` | 12px | Panel padding and the gap between panels |
| `space-4` | 16px | Between blocks and between columns |
| `space-6` | 24px | A detail column's gutter |
| `space-8` | 32px | A section break |
| `space-12` | 48px | Page top rhythm |
| `row-h` | 32px | A table row |
| `row-h-sm` | 28px | A dense side list |
| `header-h` | 44px | A host navigation bar |
| `radius-xs` | 2px | Chips, badges |
| `radius-sm` | 4px | Inputs, buttons |
| `radius-md` | 6px | Panels |
| `radius-full` | 9999px | Dots, progress tracks |

- **One hairline separates groups.** No nested cards, no card shadows, no elevation scale:
  hierarchy comes from type, spacing and borders. The only shadow in the system is the
  focus layer.
- No row grows to fit a badge. Metadata goes on the second line of the same cell (§
  Container width) or it does not belong in the row.
- Focus is `2px solid var(--ms-accent)` with a `2px` offset, and is **never** removed.

## Status treatments

**The dot is not the signal — the label is.** Every status renders as a 6px dot, the
literal enum text (`open`, `resolved`, `InProgress`, `Done`, `running`, `phase-2-execute`),
and a weight: `critical` and `high` carry 500, everything else 400. No filled pill, no
tinted row background, no coloured border. Colour is a secondary cue.

`StatusDot` takes the label as a **required** prop, so a dot-only usage does not
type-check. Enum values are never translated; they are identifier text.

### Rule 1 — tone luminance separation

The five tones must stay distinguishable **in greyscale**: a printed report, a screenshot
in a review, a projector, a colour-blind reader. Every tone therefore sits in its own
lightness band, with a minimum gap of **3.0 L\*** (CIE L\*) between neighbours. Re-ordering a
value or adding a tone means re-checking the gaps, not just the hue.

**The palette moves to fit the floor; the floor is never lowered to fit the palette** (compass
D24). The frozen prototype palette did not clear it — its tightest pair, `purple` 36.92 /
`danger` 39.69, measures 2.76 L\* — so both tones were re-spaced to `purple` 35.9 and `danger`
40.6, giving a minimum gap of **3.1** across the light set and **3.9** in dark. The gap that
originally motivated the rule is still recorded so a future re-tune recognises the failure
mode: the prototype's `warning`/`success` pair sat **0.7 L\*** apart, indistinguishable in
greyscale. `tokens.test.ts` enforces the floor, and asserts this document quotes the same
number.

| Tone | Light | L\* | Dark | L\* |
| --- | --- | ---: | --- | ---: |
| `purple` (terminal) | `#693da2` | 35.9 | `#bb91e8` | 67.0 |
| `danger` | `#b7271f` | 40.6 | `#e47a72` | 63.0 |
| `warning` | `#96590a` | 43.7 | `#e8ae61` | 75.0 |
| `success` | `#197f4f` | 46.9 | `#4ec289` | 70.9 |
| `neutral` | `#747b8a` | 51.5 | `#878f9a` | 59.1 |

Light order: purple < danger < warning < success < neutral, gaps **4.7 / 3.1 / 3.2 / 4.6**.
Dark order: neutral < danger < purple < success < warning, gaps **3.9 / 4.0 / 3.9 / 4.1**.
The order differs between themes on purpose — each theme is tuned against its own ground —
so the **gap** is the invariant, never the order.

### Rule 2 — forced colors

In forced-colors mode every background is replaced by the system palette and five coloured
dots become five identical dots. `base.css` restores the second channel by giving each tone
a distinct **shape** under `@media (forced-colors: active)`:

| Tone | Shape |
| --- | --- |
| `danger` | Filled circle |
| `warning` | Hollow circle (2px ring) |
| `success` | Filled square |
| `neutral` | Hollow square |
| `purple` | Filled diamond |

Shape survives greyscale, print, high-contrast mode and a colour-blind reader. With Rule 1
and the always-present label, status has three independent channels and depends on none of
them being colour.

## Status versus the four absence states

Colour and tone say *how bad a record is*; they must never be borrowed to say *why there
is nothing to show*. Each absence state owns a **copy family and a structural mark**, and a
generic "no data" treatment is a defect:

| State | Tone | Structural mark |
| --- | --- | --- |
| `not-applicable` | none — `text-muted` | Heading stays; the body is one sentence naming the undetermined subject |
| `absent` | none — `text-muted` | Heading + absence line + a pointer to where the concept does exist. No zeroed counters, no empty grid |
| `empty` | none — `text-secondary` | Heading + one explanatory line + the point-of-entry hint |
| `unavailable` | `warning` | The panel keeps its place and its neighbours, and carries the read's own reason verbatim |
| `populated` | the record's own tone | Normal rendering |

`unavailable` is **per member, not per page**: one failed member degrades that member only.
An undetermined value is never rendered as `0` — `0` means "the read succeeded and there is
nothing", and a dash with a reason means "not known".

## Container width

**Product layout responds to the width a view is given, never to the viewport.** The
viewport describes the window chrome; a screen describes its column. Every page body and
every host pane declares `container: pane / inline-size` (the `.ms-container` hook in
`base.css`), and components write `@container pane (…)` against it.

A container query condition cannot read a custom property, so the breakpoints are
**documented constants**, stated here and written literally in `tokens.css` and in the
rules that use them. The token contract test proves the two lists agree.

| Constant | Value | What changes below it |
| --- | --- | --- |
| `reflow-2col` | **900px** | Two-column detail and overview compositions fold to one column |
| `reflow-table` | **620px** | Table columns collapse into a two-line row: primary cell on line 1, secondary facts as inline meta on line 2. Filters wrap to full-width fields |
| `reflow-stack` | **480px** | Chrome stacks, navigation wraps, panel heads stack |
| `table-floor` | **300px** | Below this a table scrolls inside its own labelled container, never the page |
| `chart-floor` | **220px** | Below this the chart is omitted; its tabular alternative stands alone |

- The dashboard's product area is the 1440px case; the dsh right Sidebar is the same
  components at **720px** (its push default) and **400px** (dragged narrow). Same tree,
  different container, no second implementation.
- A component that cannot degrade below a floor **states the floor** rather than squeezing
  into illegibility: a truncated cell always exposes its full text (hover `title`, plus a
  focus-reachable affordance for keyboard), and a table below its floor scrolls inside its
  labelled container.
- Breakpoints are inherited: a new component reuses these five constants or it is a
  review defect.

## Token surface and how to change it

The `--ms-*` custom properties are the whole contract; `packages/ui/src/index.ts` exports
the scheme attribute, the tone vocabulary and the container name so no host re-types a
string.

Adding, renaming or removing a token is a **four-part change**, because each part is a
check the others cannot make:

1. `DESIGN.md` frontmatter (this document is the authority) — `colors` / `typography` /
   `spacing` / `rounded`.
2. `packages/ui/src/styles/tokens.css` — the same name in `:root` and, if it is a colour,
   in `[data-ms-theme="dark"]` under the same name.
3. A consumer, or an entry in `CONSUMED_BY_LATER_TASK` in `tokens.test.ts` naming the task
   that will consume it. A token nobody consumes and nobody claims is deleted, not kept
   "for later".
4. `bun test packages/ui` — parity, consumption, **the Rule 1 tone-gap guard**, no bare
   colour literal, no `prefers-color-scheme`, the forced-colors block, and `DESIGN.md` ↔
   `tokens.css` name-set equality.

## Predecessors — what this supersedes

This document replaces the dashboard-only token set that stood here before it (a light-only
palette with a Level-1 completeness marker) and **retires** `packages/dsh/DESIGN.md` and
`packages/dsh/DESIGN.dark.md`. The panel's design contract was a second, competing token
set that mapped host aliases one by one; both files were deleted rather than reduced to a
pointer, because a `DESIGN.md` carrying a token frontmatter *is* a competing set and one
without it fails this repository's own design-document lint. The panel's remaining
host-specific obligation — resolving `--ms-*` through the host's own theme — belongs to the
dsh adapter plan, not to a design document.

The confirmed prototype (the iteration's prototype record, screen `Design tokens`) is the
visual source of this system. Three values
were corrected here for a measured reason rather than a preference: `text-muted`,
`border-strong` and `accent` were raised to clear 4.5:1 (text) and 3:1 (control boundary) on
their documented grounds, and the light `success`/`warning`, light `danger`/`purple` and the
dark tones were re-spaced for Rule 1 (the prototype's tightest pair sat at 2.76 L\* against a
3.0 floor; the delivered minimum is 3.1 light / 3.9 dark). The prototype's spacing rhythm, type
ramp, row heights, radius scale, dot-based status treatment and container breakpoints are
adopted unchanged.

## Known tooling limitation — checklist key names

The repository's design-document completeness checker (`mstar-design-md` →
`completenessLevel`) scores a frontmatter by looking for fixed **legacy key names**
(`background-100`, `gray-1000`, `blue-700`, `red-700`, `amber-700`, `copy-13`, `heading-20`, …).
This system names roles, not shades, so the checker reports the colour and type items as
missing even though the role set is complete — the frontmatter token validation itself
passes. The equivalence is recorded here rather than satisfied by adding alias keys, because
a second naming system in the same frontmatter is precisely the competing-token defect this
document removes.

| Checklist key it looks for | Role that carries it here |
| --- | --- |
| `background-100` | `bg-surface` |
| `gray-1000` / `gray-900` | `text-primary` / `text-secondary` |
| `blue-700` (accent scale) | `accent` |
| `red-700` / `amber-700` | `danger` / `warning` |
| `green-700` | `success` |
| `copy-13` / `copy-14` | `body` / `emphasis` |
| `heading-20` / `heading-28` | `screen-title` / `page-title` |

A future change to the checker should teach it the role vocabulary; until then the gate that
runs on every write (`validateDesignTokenFrontmatter`) is green, and the completeness score
is a known false negative for this document.

## Accessibility floor

- Body text 4.5:1, control boundaries 3:1, status graphics 3:1 — measured in both themes
  (tables above).
- Status never depends on colour alone: label text, weight, and a distinct shape under
  forced colors.
- Focus is visible on every focusable element and is never suppressed.
- `prefers-reduced-motion` removes motion; the product ships almost none to begin with.
- No remote font, no CDN, no network request from any component: the asset budget is zero.
