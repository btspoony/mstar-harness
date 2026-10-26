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

**A recorded exception, per scheme — this is a rule change, not a test detail.**

The tone values are the prototype's, verbatim. Under those values some adjacent pairs sit
below the 3 L* floor of Rule 1, and the floor is therefore **not** met for those pairs:

| Scheme | Pair | Measured gap |
| --- | --- | --- |
| light | `danger` ↔ `purple` | 2.76 L* |
| light | `success` ↔ `warning` | 0.66 L* |
| dark | `danger` ↔ `purple` | 1.01 L* |
| dark | `purple` ↔ `success` | 2.19 L* |
| dark | `success` ↔ `warning` | 2.64 L* |

The trade is deliberate: the prototype is the acceptance criterion for this interface, so
its colours win where the two disagree. What Rule 1 still guarantees: a pair that is *not*
on this list may never drift under the floor, a listed pair may not get worse than the
value above, and a listed pair that stops being crowded fails the test as a stale record.
The reader's channel for the listed pairs is **hue** — `purple` is the only violet in the
set, and the status word is always spelled out beside the dot — never lightness alone.
Anyone changing a tone value has to update this table in the same change.

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
`base.css`), and components write `@container (…)` against it — **unnamed**.

The name is deliberately absent from the query. A CSS-module bundler rewrites a named
query's prelude into a per-module hash (`@container pane_8f31a`), while the single
declaration stays in the global sheet as `pane`; nothing then matches and every narrow rule
in the product is silently dead. That is not a hypothetical: it is why the 400–900px pane
rendered the wide layout squeezed through two review rounds. `build-web.test.ts` asserts the
emitted artifact contains no named container query, and the component-layer test asserts no
module writes one.

A container query condition cannot read a custom property, so the breakpoints are
**documented constants**, stated here and written literally in `tokens.css` and in the
rules that use them. The token contract test proves the two lists agree.

| Constant | Value | What changes below it |
| --- | --- | --- |
| `reflow-2col` | **900px** | Two-column detail compositions fold to one column; the overview's `1.85fr : 1fr` grid folds into the sidebar's single run, and the wide-only list columns (the milestone) appear above it |
| `reflow-table` | **620px** | Table columns collapse into a two-line row: primary cell on line 1, secondary facts as inline meta on line 2. Filters wrap to full-width fields |
| `reflow-stack` | **480px** | Chrome stacks, navigation wraps, panel heads stack |
| `table-floor` | **300px** | Below this a table scrolls inside its own labelled container, never the page |
| `chart-floor` | **220px** | Below this the chart is omitted; its tabular alternative stands alone |

- The dashboard's product area is the 1440px case; the dsh right Sidebar is the same
  components at **720px** (its push default) and **400px** (dragged narrow). Same tree,
  different container, no second implementation.
- **The pane's head band is inset, and shared.** `.ms-pane-head` is the surface + closing
  hairline (`design-v1.html:482`) plus the prototype's nav inset `padding-inline: 12px`
  (`design-v1.html:487`). The dsh pane inherits both. The dashboard's window header mounts the
  same class and overrides the padding with its own 20px gutter — the prototype's window header
  is `0 20px` while its pane nav is `0 12px`, so neither host invents its edge. The host's own
  tab strip stays the pane's top edge; the band starts below it.

### Narrow list treatment (the prototype is silent here)

The prototype defines **one** narrow-table precedent — `WorkflowDetail` hiding columns 2
and 5 below 619px — and no narrow treatment at all for the four list screens. Silence is not
a licence to ship the wide table squeezed, so the product chooses:

**Priority columns below the floor, declared widths from the prototype, and a scroll floor as
the net.** The **column order is the prototype's too** (`design-v1.html:1199-1207`): ID, Title,
Project, Kind, Severity, Disposition, Last activity. A product-only fact sits next to the fact it
belongs to (the milestone follows the project) and never displaces the prototype's sequence;
`Workflows` (`:1548-1553`), `Iterations` (`:1664-1669`) and `Projects` (`:1757-1762`) follow their
own prototype tables the same way. Concretely, every list table declares a px width for all but one column; that one
flexible column (the title) takes the rest, and the widths are **the prototype's own values
copied verbatim** (`design-v1.html:1196-1198`): id 86, title flexible, project 128, kind 112,
severity 100, disposition 104, last activity 116. Workflows is 282/flex/200/150/140/190
(`:1542`), Iterations 250/flex/190/96/130/64 (`:1659`), Projects 310/flex/110/210/90
(`:1752`). They are declared on a `<colgroup>`, which is the element `table-layout: fixed`
actually reads — a width on each `<th>` reproduces the same thing only when the browser
agrees, and a cell that drills two levels deep does not.

| Band (container) | What the list does |
| --- | --- |
| **≥ 900px** | All columns, including the wide-only milestone column. Declared widths; the flexible title column gets the remainder (measured at 1900: 786px of title in an 1398px table, no scroll). |
| **620–899px** | The prototype's seven columns — the *wide-only* milestone column is hidden by rule (`@container (max-width: 899px)`), and the table keeps a floor of `declared widths + 88px` for the flexible column. Below `reflow-table` the collapse is the prototype's own mechanism: the table carries `data-narrow-cols="2"` (or `3`), and `@container` hides `:nth-child(n+3)` on both the header and the body, while the facts the hidden columns carried move into `.row-meta` **inside the record's first cell**. That is one record in one `<tr>`, not a spanning second row — the prototype never adds one, and neither does the product. The prototype's sidebar at 720px shows seven columns and no milestone (`design-v1.html:2551`), and the eighth column is exactly what pushed the table past its card. Measured at 720: table 678px in a 678px card, every column whole, title 146px — the widest column on the Issues list. Where a list's own declared widths still exceed the floor, the **card body scrolls sideways** rather than squeezing: at 620 the Issues table scrolls, and every column stays reachable.
  The floor is `declared + 88`, not `+ 96`, because the **dsh seat scrolls with `overflow-y: auto`**:
  on a classic-scrollbar platform the vertical bar takes ~15px of a 720px pane, so a card holds
  663px, not the 678px a macOS gate measures. The iterations set is 568px, so 96 would put its
  floor at 664px — one pixel past the cliff, and that card would scroll at the approved width on
  platforms nobody here runs. At 88 the floor is 656px, seven pixels under the classic-scrollbar
  card; the 720px rendering is unchanged, because the table is `inline-size: 100%` and the floor
  only decides when scrolling begins. |
| **480–619px** | Secondary columns are hidden **by rule** (`display: none`), not by overflow, and each yielded fact reappears on the row's second line. Id, title and the screen's one status column keep their declared widths; the flexible title takes the rest (measured at 420 and 619: narrowest cell 80–112px, zero truncated cells, no sideways scroll). |
| **≤ 299px** | The collapsed table keeps the documented 300px floor and scrolls inside its own card. The card is narrower than the summary's four facts, so the summary line overflows its own box instead of reading as one measured line; the facts are all painted, the line keeps the title's baseline, and the page itself never scrolls sideways. |

Two rules make this hold, and both are the defects that shipped:

1. **Widths are declared, never inferred.** `table-layout: fixed` splits an undeclared
   column set evenly — eight columns of ~90px each gave `I-…`, `d…` and `● runningplan…`.
2. **No positional column widths.** Collapsing with "first column 20%, second 80%" put the
   *third* primary column at zero width, which is how a status word lost its own box.
3. **A wide-only column is not a hidden fact.** `wide: true` on a `DataTableColumn` hides the
   column below 900px of container and restates nothing on the second line, so it is only for a
   fact the record's own screen also carries — an issue's milestone is on the issue. The
   milestone is the only wide-only column, and it is what keeps the 720px table seven columns
   instead of eight.

A hidden column costs no width: the `<colgroup>` is gone, so a `display: none` cell no longer
leaves a column's share behind it.

The collapsed record's second line is a **row of its own spanning the primary columns**, not a
second line inside the first cell. Inside that cell it only ever had the cell's width — 68px of
an 80px id column, which rendered `critical · op…` — while a spanning row gives the facts the
row's width and leaves both the header and the column policy untouched (the span is the primary
count: a span over the hidden columns re-opens them under `table-layout: fixed`). Its facts wrap
rather than truncate, so a fact is never cut in half.

**What that trade costs, and where it stops.** The second line is an extra `<tr>`, so a screen
reader announces a five-record list as ten rows, and the spanning cell has no header
association. Its bounds are deliberate and part of the contract:

- **list variant only** — a detail table has no second line and keeps its own row rules;
- **below the collapse floor only** (620px of container) — above it the facts are columns again
  and there is no second row in the DOM tree's rendered form;
- **one spanned cell** across exactly the visible primary columns, never a second grid;
- **non-interactive facts**: the row carries no tab stop and no key handler, so keyboard order
  stays one stop per record. It does carry the row's pointer handler — at the width the product
  lives in this row is roughly half of the record's painted area, and a tap on it must navigate
  like a tap on the row above. A mouse user and a keyboard user reach the same destination by
  the shortest path each has.

The alternative — keeping the facts in the first cell — cannot show them whole, because that
cell is 80px. A cell-sized second line is a truncation dressed as a layout, so the extra row is
the cheaper trade until `DataTable` grows a column-aware second line.

A **screen title never stacks, and never escapes its frame.** CJK breaks between every glyph, so
a squeezed head set a two-glyph title as one glyph per line (measured: a 30.4px, 2-line box at a
400px container). The fix is structural, not a single declaration:

- **The title owns its row below the collapse floor.** The screen head wraps
  (`flex-wrap: wrap`) and the title takes the full row (`flex: 1 1 100%`), the same shape the
  prototype's `.panel-head` takes at narrow widths (`design-v1.html:736`). The title is then
  measured against the whole card rather than the summary's remainder, so a two-glyph title has
  a row to itself and does not stack.
- **The title's floor is zero, not its own string.** A CSS minimum beats a maximum, so a
  `min-inline-size: max-content` floor let a long title (an issue title is a sentence) grow PAST
  the frame — measured 852.1px in a 360px frame — instead of truncating in it. With the row
  above keeping short titles whole, the title needs no content floor: `min-inline-size: 0` plus
  `max-inline-size: 100%` caps the box at the frame, and `nowrap` + `text-overflow: ellipsis`
  truncate what does not fit (a long title measured 360px of box, ellipsized, no page overflow).
- **A title never degrades to an ellipsis-only box.** Because the box is a whole row (240px at
  the floor, 360px at 400px, 580px at 620px), the smallest title box is still a readable
  measure; the gate asserts a floor of 120px on it.

- **The Overview has two forms, and the wide one is two columns.** Above 900px of container it
  is the prototype's grid, `minmax(0, 1.85fr) minmax(0, 1fr)` (`design-v1.html:317-318`, measured
  898/486 at a 1400px content width): active workflow then the issue-flow trend on the left,
  residuals then milestones on the right, the latest iteration across both. Below the floor it is
  the sidebar's single run in the same reading order, where each card is full width (694px in the
  prototype's 720px shell; 680px in the product's, after its own 20px gutters).
  Reading the sidebar presentation alone is how this became one column: the prototype folds
  nothing, and its narrow form is a different *presentation*, not a breakpoint of the same one.
  The ratio is a gate anchor at 1900 and 1280, and the fold is anchored at 720.

- **A workflow's plans are a table, not a progress line.** The Overview's active-workflow card is
  the prototype's summary line (id, type, phase, `Open workflow`), its branch chain, and a
  five-column table — `Plan | Title | Status | Progress | Done` (`design-v1.html:836-932`) — with
  one row per plan. Five columns stay five at 720px: the table scrolls inside its card rather than
  dropping a column, because a workflow's plan list has no second line to move a fact to. Every
  row is exactly `--ms-row-h` tall in both bands.
  `Progress` prints the store's own note. The engine records it as free text
  (`coordination.progress.summary`), so `3/6` is drawn as a fraction with its bar only when the
  note *is* one; prose is shown as prose, and an empty note reads `Records no progress.` rather
  than a bar at an invented percentage. A plan with no recorded status reads the same sentence
  treatment as every other absent value, never a blank cell.

- **The trend is the read's, and it degrades through the shared arms.** The issue-flow card draws
  two cumulative step lines from `overview.issueFlow` — captured solid, retired dashed, so
  greyscale keeps the distinction — with first/middle/last date labels, the legend's two open
  counts, the dated-history gap note, and the same buckets as a `Dated history` table inside a
  disclosure. Nothing is recomputed in the view layer. Fewer than two dated buckets is the empty
  arm; a failed read is the unavailable arm with the store's reason. An empty chart is never
  drawn for either.
- **The residual tally is a compact two-column grid, not a list.** The five severities flow
  two per row — critical/high, medium/low, nit — severity on the left with its tone dot and a
  fixed 88px label measure, count right-aligned (`margin-inline-start: auto`), one hairline per
  row; below the 480px stack floor it is one column (`design-v1.html:2424-2434`). Its heading
  carries the reconciling total in the panel's meta slot — `26 open · all projects` — instead of
  a title line of its own.
- A component that cannot degrade below a floor **states the floor** rather than squeezing
  into illegibility: a truncated cell always exposes its full text (hover `title`, plus a
  focus-reachable affordance for keyboard), and a table below its floor scrolls inside its
  labelled container.
- Breakpoints are inherited: a new component reuses these five constants or it is a
  review defect.

## Focus is the prototype's plan board, not a stack of panels

The session-focus screen follows the prototype's `session-focus-template`: a
`.screen-head` with the title, then one panel whose body carries the bound workflow
(`.wf-summary`, `.branch-line`) and a **`.planboard`** — four or five
`.planboard-col` columns, each with a `.planboard-head` holding the status word and its
count as two elements, and a `.planboard-plan` line per plan (tone dot, id, recorded
progress at the right edge).

The product adds one thing the prototype's board does not show: a plan that records
nothing states that in words (`data-ms-progress-absent`), because a bare dot would read
as "no information" rather than "the store has no note". The prototype's own cell is the
note alone; the absent line is the product's answer to the same question, in the same
slot.

## What IA §8.1 excluded, and why the prototype wins

`IA §8.1` listed three things the views must not return: the catalog-pin **badges**, the
iteration **document inventory**, and the workflow **leases**. Its reasoning was sound —
they are join bookkeeping, and they say nothing about *progress*.

All three are rendered now, because the acceptance criterion for this interface is the
**prototype**, not a progress report:

| Fact | Prototype | State here |
| --- | --- | --- |
| join badges (`catalog-missing`, `catalog-pin-conflict`) | `Join badges` column on the workflow list | **rendered** |
| document inventory | `Documents` card on the iteration detail | **rendered** |
| workflow leases | `Leases` card on the workflow detail | **rendered** |

Leases turned out not to need an engine change after all — the projection already reads
`projection_leases` and attaches them to **plans** (`plan.leases`). The prototype's card is
keyed `Plan | Lease kind | Holder | Worktree path | Expires`, which is exactly the shape a
per-plan collection has. The earlier claim that this needed `WorkflowDTO` to grow a field
was wrong: the data was there, one level down.

Where the DTOs did carry the data, the §8.1 exclusion was recorded in a comment and
enforced by a negative test. Both had to change together — and the new comments say why
the exclusion no longer describes this screen, rather than deleting the reasoning.

## ProjectDetail: the shape, and the two blocks that are deliberately absent

The screen is the prototype's, in its order:

```
.detail-head        title, meta (id · lifecycle · Revision N · N open issues), the
                    description, then the roadmap's presence and the catalog path
.subtabs            Roadmap / Issues / Iterations, each with its count
.detail-top         Catalog identity  |  Roadmap authority
.panel              the milestone board, one row per milestone
.detail-grid        Direction + stored markdown  |  Stored facts
```

Each milestone row carries four tallies (`N open`, `N resolved`, `N retired without
resolution`, `N total`), each with its own `data-ms-count` hook so a test can pin the
number rather than the label. The issues it owns render as compact id chips, toned by
disposition, with the settled ones folded into `+N <disposition>`.

**Two things the prototype does not have, and this screen does not either** — both
measured on the prototype's own project-detail section, not inferred:

| Claim | Prototype evidence |
| --- | --- |
| no goals block | `section[data-screen="project-detail"] li` count = **0** |
| goals stated once | `Stored facts` rows are exactly `Frontmatter status`, `Created at`, `Residuals ref`, `Goals = 1 / 3 checked`, `Sections` |
| no empty frames | `.panel` elements with empty text = **0** |
| two disclosures | `details` summaries = `["Direction", "Stored markdown"]` |

A goals list here would answer the same question twice, at greater length; the stored
markdown disclosure already carries the full text.

**One thing this screen has that the prototype cannot**: truncation. The prototype's
milestone name is plain text in static HTML with nothing to ellipsis. Ours must fit
arbitrary names, so the name ellipses on its own flex-item box rather than wrapping an
inline-block — see the baseline section above for why that choice cost nothing.

**The reverted attempt worth remembering**: the feature container was `<div class="chip">`
— an 18px inline badge wrapped around a whole section. Removing the class made the layout
*worse*, because the badge had been accidentally constraining a list with no container of
its own. A wrong class that is load-bearing is the signature of a section that needs
rewriting rather than patching, which is what eventually happened.

## A baseline offset is not a defect until you measure the prototype's

The milestone board's head is a flex line whose parts carry different type sizes: the name
at 13px, the status at 12px, the id and date at 10-11px. Their `top` values therefore differ
even when the line is perfectly aligned — a 13px ascender starts higher than a 10px one.

Measured `top` spread across that line:

| | spread |
| --- | --- |
| the prototype | **9px** |
| this implementation | **2px** |

The 2px was briefly treated as a bug and "fixed" twice — once by dropping
`vertical-align: bottom` (which made it 7px, worse), once by moving the ellipsis off an
inline-block child onto the flex item itself (no change: 2px either way). Neither attempt
was wrong to try; what was wrong was reading the number as a defect **before** measuring
the prototype's own. A mixed-size text line is supposed to have a spread.

The lesson is the same one the crowded-pairs table encodes: a measurement only means
something against the prototype's measurement of the same thing.

## A probe that selects the wrong element proves nothing

`document.querySelector('[data-screen="project-detail"]')` matches **two** elements in the
prototype: the nav button that switches screens, and the `<section>` holding the screen. The
button comes first, so a probe written that way counts panels, list items and disclosures on
a button — and gets `0` for each, every time.

That mistake survived several rounds. It was caught only when `heads: []` contradicted a
screenshot taken in an earlier round that plainly showed `Catalog identity` and
`Roadmap authority`.

The working form:

```js
[...document.querySelectorAll('[data-screen="x"]')].find((e) => e.tagName === "SECTION")
```

Two habits follow from it:

- **A zero is a claim.** `0` panels is either a fact about the screen or a fact about the
  probe, and the probe is the likelier author of a surprise. Cross-check against something
  independent — a screenshot, a count from the source — before recording it.
- **Prefer a selector that cannot match the wrong thing.** `tagName === "SECTION"`, or an
  attribute only the screen carries, beats relying on document order.

Measured with the correct selector, the prototype's screens are:

| Screen | Panel titles |
| --- | --- |
| overview | Active workflow, Issue flow trend, Open residual issues, Milestones, Latest iteration |
| issues | Issue flow trend, Filters |
| projects | Catalog projects |
| workflow-detail | Execution, Catalog identity, Plans, Leases |
| iteration-detail | Catalog identity, Execution, Compass, Plans, Documents |
| project-detail | Catalog identity, Roadmap authority, Milestone board, Stored facts |
| workflows, iterations, issue-detail | *(none — these screens have no titled panels)* |

## The iteration gate track is gone, because the prototype has none

This screen used to render a five-step gate track — four labels plus a fifth that is never
marked — on the reasoning that the delivery position needs a body. The prototype's
iteration detail has **no gate at all**: measured `gateEls: 0`, `hasGate: false`.

The position is not lost. It appears where the prototype puts it, in the header's action
chip (`step 2 of 5`), which is also the only place the record states it.

This is worth recording because keeping the track was a *choice* — the screen had the data
and the track was already built. The acceptance criterion here is the prototype, and an
addition nobody asked for is a divergence however defensible it looks.

## The prototype's numbers can live in its JavaScript

The flow chart's height looked like a rendering bug for four rounds. Measured: 339px in
the overview's card, 540px across the issues screen — the same component, the same class,
two answers. Those two numbers are both *correct* for `height: auto` on a
`viewBox="0 0 100 40"` SVG: the height is 40% of the width, and the two containers differ.

The prototype has one height at every width, and the reason is not in its CSS:

```js
// design-v1.html:3229
var compact = el.dataset.flowChart === "compact";
var height = compact ? 88 : 132;
```

Two fixed heights, written by the script that draws the chart. Reading the rendered DOM
could not find them, because the DOM only ever shows the result — `height="88"` on an svg
that had already been sized.

So the rule now lives where the number does:

```css
.ms-container .chart-svg { height: 88px; }
.ms-container .chart-svg.is-full { height: 132px; }
```

**What to take from it**: when a prototype measurement cannot be reproduced, the missing
fact is often in the prototype's own JavaScript rather than its stylesheet — its data,
its heights, its series lengths. Grep the `<script>` before concluding the CSS is wrong.

## The identity line, and the one fact that arrives at runtime

The prototype's overview ends with `.identity-line`, a hairline-topped mono row:

```
@mstar-harness/dsh  v4.0.9  ·  {HARNESS_DIR}  ·  projection current
```

All four are stated now, and each arrives by the route its nature demands:

| Fact | How it arrives | Why that route |
| --- | --- | --- |
| `@mstar-harness/cli` | `build-web.ts` reads `packages/cli/package.json` | a build-time constant |
| `v4.0.9` | the same manifest | hard-coding it would go stale on the next release |
| the harness root | `<html data-harness-dir="…">` from `server.ts` | a **runtime** decision: it is whatever directory the server was started on |
| `projection current` | the read envelope | it is a fact about the read |

Each host names **itself**: the dsh panel prints `@mstar-harness/dsh`, the standalone
dashboard prints `@mstar-harness/cli`. The prototype had one bundle and could name it; this
repository has two, and printing the other one's name would be a false statement about
which code is running.

**Two silent failures on the way here**, both worth recognising again:

1. **The inline script.** The first version injected
   `<script>window.__MSTAR_HARNESS_DIR__=…</script>`. It was in the HTML and the bundle
   read it; the browser saw `undefined`. The server sends `script-src 'self'`, so an inline
   assignment is blocked with no error at all. A data attribute has no such rule.
2. **`replace` with an absent needle.** `dashboardHtml.replace("<html ", …)` returns the
   input unchanged when the prefix is missing — a page with no directory and no error. The
   handler now refuses with `shell-marker-missing` instead, because a silent no-op one layer
   up is exactly how the first failure shipped.

## Where this implementation still differs from the prototype

One table, so the remaining distance can be read at once. Everything here is a known,
reasoned gap — not undiscovered work.

| # | Prototype | Here | Why | Reversible by |
| --- | --- | --- | --- | --- |
| 1 | `.identity-line` states `plugin · vX · {HARNESS_DIR} · projection` | **all four, per host** | the dsh panel and the dashboard each name their own package | closed |
| 2 | milestone name is plain text | name ellipses on its own box | the prototype has nothing to truncate; ours must fit arbitrary names | not worth reversing — an ellipsis is the honest form of an unbounded string |
| 3 | overview / issues trend drawn at two heights | same (88 / 132) | — | closed |
| 4 | a scope chip with a removable × | same chip, no × when the host passes no callback | the prototype has a control; ours states a fact | passing `onClearScope` from a host |

Rows 1 and 2 are the same missing fact: the build embeds no version. Fixing both means one
change in `build-web.ts`, not two patches — and that is why they are listed rather than
patched separately.

**What is deliberately *not* in this table**: everything that has been made to match.
The screens named here — Issues, Workflows, Iterations, Projects, the three details and
Overview — were each compared against the prototype's own DOM, not against a memory of it,
and the comparisons closed. A table of past fixes would grow without bound; this table is
only the open set.

## Verification coverage, stated

Two hosts mount these screens: the dashboard (`packages/cli/web`) and the dsh pane
(`packages/dsh/src/client/panel`). They share the components but **each owns its own
wiring**, and a shared component does not prove a host passed it what it needs.

| Evidence | Dashboard | dsh pane |
| --- | --- | --- |
| Renders in a browser, measured | yes — every screen, both widths | **no** |
| A filter change actually filters | yes — measured to 0 rows | **not measured** |
| Builds and typechecks | yes | yes |

This gap is real and was the source of two shipped defects: the workflow filter was
rendered but dead in **both** hosts for two rounds, and the iteration filter was dead in
the dsh pane after the dashboard was fixed. A control that renders is not a control that
works, and only a browser settles which one you have.

Until someone exercises the dsh pane, treat its list filters and its row activation as
**unverified**, not as working.

## An inline element ignores every overflow rule

`TruncatedText` renders a `<span class="trunc">`, and the prototype's rule for it is
`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. **None of those apply to
an inline element.** The rule was present, the class was on the element, and the text
still ran past its container.

It surfaced three times before it was fixed at the source, each time as a separate bug:

| Where | Measured | Symptom |
| --- | --- | --- |
| a field value in `<dd>` | 213px of content in a 180px cell | spilled out of the cell |
| a roadmap goal title at 720px | 1700px wide | the page scrolled sideways |
| a milestone name at 375px | 585px wide | the page scrolled sideways |

The first two were "fixed" at their call sites first (`dd > .trunc { display: block }`,
a flex rule on the goal row) — true at those two places and nowhere else. The source fix
is one rule:

```css
.ms-container .trunc { display: inline-block; max-width: 100%; vertical-align: bottom; }
```

The call-site patches were then deleted; a rule that only works because a second rule
happens to hold is debt, not a fix.

**The check that catches this class of bug**: `document.body.scrollWidth >
document.body.clientWidth`, at 1440 / 720 / 375, on every screen. `scrollWidth >
clientWidth` on a `<dd>` of *plain text* is not a symptom — that is what an ellipsis
looks like from the inside. The symptom is a **child element wider than its parent**, or
the page itself scrolling.

## A class that exists is not a class that belongs there

Three defects in this interface had the same shape: the class name was real, defined, and
in the right sheet — and on the wrong element.

| Wrong | Effect | Right |
| --- | --- | --- |
| `<section class="fields">` wrapping a `dl.fields` | the two-column grid landed on the section, so the title took column one and every field stacked in column two | `section.sec` + `h3.sec-title` + `dl.fields` |
| `<tr class="row">` | the generic `.row` sets `display: flex`, which turned the table row into a flex container and every cell into a `block` 20px wide | `tr.is-link`, the prototype's own interactive-row class |
| `<h1>` outside a `.screen-head` | `.screen-head h1` carries 16/24/600; a bare `h1` fell back to the document heading | `div.screen-head > h1` |

The lesson is mechanical: when a component's class list looks right, check the *element*
it lands on. A grid or flex class on a container whose child is the intended grid is the
same defect as a missing class, and it is harder to see because nothing is undefined.
Every screen's title lives in `.screen-head`, every fact block is a `.sec`, and a table
row never takes a display mode from a generic list class.

One place deliberately keeps a different element: `.milestone-block-id` is a `<div>`, where
the prototype uses a `<span>`. Its parent `.milestone-block` sets no `display`, so the
prototype's `<span>` is inline and a long iteration id runs past the card instead of
wrapping. The element differs; the rendered type, colour and spacing do not.

## Two layout contracts that break the page when confused

**A table row is a table row.** `<tr>` may not carry a class whose rule declares a
display mode: `.row { display: flex }` applied to `<tr class="row">` turns the row into a
flex container, every cell collapses to `display: block` at its own minimum width, and the
whole table renders as a column of two-character stubs. That is not a width problem and no
column measurement reveals it — the cells were `20px` wide while the declared shares were
`12% / 18% / 15%`. The prototype's interactive row class is `.is-link`, which sets only
`cursor` and the focus ring. The generic `.row` therefore carries `:not(tr)` and the table
never opts into it.

**A proportional column set leaves the flexible column its share.** Each list declares its
fixed columns as a percentage of the table and exactly one column with no width, which
takes what remains. The percentages must therefore add up to **less than 100%** — the
screens currently reserve 16–21% for the title. A set that sums to 100% gives the
flexible column zero and every title renders as `d…`, which is exactly the failure this
paragraph exists to prevent: the columns were all "declared correctly" and the layout was
still unreadable.

Both are container-driven, so both are verified at **720** and **1440**, not at one width:
the narrow band must show fewer columns (the wide-only one is hidden by rule) with every
remaining column readable, and the wide band must show the full set.

## Where the component styles come from

The product's component styles are **the approved prototype's own stylesheet**, generated
into `packages/ui/src/styles/product.css` and shipped whole. Generation does two mechanical
things and changes no value: every selector is scoped under `.ms-container` so the sheet
cannot leak into a host that reuses a class name, and the container queries lose their name
(Bundler renaming makes a named query dead — see § Container width). The token blocks and
the `html`/`body` resets are **excluded**, because the package owns those in `tokens.css`
and `base.css`; shipping a second copy breaks the page.

This is the design decision, not a shortcut. Hand-translating the prototype screen by screen
produced three rounds of "close but not the same": column widths that were plausible rather
than the declared ones, a second line as a spanning row, a title one step too large. The
sheet is the only artefact that cannot drift from itself, so the implementation renders the
prototype's own class names (`.panel`, `.panel-head`, `.table`, `.table-wrap`, `colgroup`,
`.row-meta`, `.status tone-*`, `.nav-btn`, `.filters`, `.filter-field`, `.search`, `.gate-*`,
`.res-*`, `.wf-*`, `.chart-*`) against it.

Consequence for edits: a surface is changed by changing the prototype and regenerating the
sheet, not by adding a rule here. When a product-only surface has no prototype counterpart
(the absence block, the pager, the generic `.row`), `base.css` carries a minimal rule in the
prototype's own vocabulary and says so.

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
