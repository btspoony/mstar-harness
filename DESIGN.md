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

## The measured baseline, and how to re-take it

Structure matching is not pixel matching. The values below were read from **both** sides
with `getComputedStyle` at 1440, on the same selectors, and they agree element for element:

| Element | `font-size` / `color` / `padding` |
| --- | --- |
| `.screen-head h1` | `16px` / `rgb(231, 234, 238)` / `0` |
| `.panel-title` | `12px` / `rgb(164, 172, 183)` / `0` |
| `.panel-meta` | `11px` / `rgb(118, 126, 138)` / `0` |
| `thead th` | `11px` / `rgb(118, 126, 138)` / `0 10px` |
| `tbody td` | `13px` / `rgb(231, 234, 238)` / `0 10px` |
| hairline (any `border-bottom`) | `rgb(36, 41, 48)` |
| table row height | `32px` |
| `.detail-title` | `16px` / `600` / `rgb(231, 234, 238)` |
| `.detail-meta` | `11px` / `400` / `rgb(118, 126, 138)` |
| `.field dt` | `11px` / `400` / `rgb(118, 126, 138)` |
| `.field dd` | `12px` / `400` / `rgb(231, 234, 238)` |
| `.chip` | `11px` / `400` / `rgb(164, 172, 183)` |
| `.breadcrumb` | `11px` / `400` / `rgb(118, 126, 138)` |

Screens checked this way: overview, issues, workflows, iterations, projects —
and the first four rows again on workflow-detail, which is where the detail-level values
(`.detail-title` through `.breadcrumb`) were read. The values are
theme-dependent — these are the **dark** scheme's; `tokens.css` carries both, and the light
values are the prototype's own light block.

**How to re-take it**, because a table of numbers is only useful if it can be refreshed:

```js
// `root` is the screen, never the document: the prototype keeps every screen in the DOM
// with `hidden` on the inactive ones, so a document-wide query answers with whichever
// screen happens to come first. That mistake reported `.panel-title` values for workflows
// and iterations — screens that have none.
const pick = (root, sel) => { const e = root.querySelector(sel); if (!e) return null;
  const c = getComputedStyle(e); return `${c.fontSize}/${c.color}/${c.padding}`; };
const root = [...document.querySelectorAll('[data-screen="issues"]')].find((e) => e.tagName === "SECTION");
JSON.stringify(["h1:.screen-head h1", "pt:.panel-title", "pm:.panel-meta", "th:thead th", "td:tbody td"]
  .map((p) => { const [k, sel] = p.split(":"); return k + "=" + pick(root, sel); }))
```

Run that against the prototype (`file://…/design-v1.html`, click the screen's nav button
first) and against the dashboard, and diff the two strings. A `null` on both sides is a
match: workflows and iterations have no titled panels, and projects has no table.

## `.trunc` has three contexts, and each one exists for a reason

`TruncatedText` renders one span, and the rules around it are not one rule applied three
times — each context was added after a specific measurement:

| Context | Rule | Why it is needed |
| --- | --- | --- |
| default | `display: inline-block; max-width: 100%` | `overflow: hidden` and `text-overflow: ellipsis` do nothing to an inline element |
| inside a `<dd>` | *(covered by the default)* | it overflowed its cell at 213px in a 180px box |
| inside `.detail-title` | `display: block; line-height: inherit` | as an inline-block it sat in the line box with its own height and baseline, so a 16px/24px heading measured **31px** |
| inside `.milestone-block-name` | *(no longer truncates — the name ellipses on its own flex item)* | the inline-block cost 2px against sibling type sizes |

The pattern behind all four rows: **an inline-block is a box, and boxes carry height and
baseline into whatever line they join**. Every one of these came from measuring a specific
element, not from reading the rule.

If `.trunc` gains a fifth context, measure that element's height and baseline against the
prototype's before trusting it.

## The light scheme is identical, and the way to check it is not the browser

The dark values above were read in the browser. The light scheme was verified from the
tokens instead, because both sides drive it differently in the DOM (the prototype toggles
`data-theme`, this product toggles `data-ms-theme`), and forcing the wrong attribute on the
prototype produces a page that *looks* light while keeping some dark rules — which is a
measurement of the wrong thing, not a difference.

| Token | Both sides |
| --- | --- |
| `--ms-bg-canvas` | `#f6f7f8` |
| `--ms-bg-surface` | `#ffffff` |
| `--ms-text-primary` | `#191c20` |
| `--ms-text-muted` | `#858c96` |
| `--ms-border-hairline` | `#e3e5e9` |

`tokens.css` declares these in `:root` (light) and overrides them under
`[data-ms-theme="dark"]` — the same two-block shape the prototype uses, with a different
attribute name.

## Two tables, two type sizes, on purpose

A styles probe that reads `thead th` inside the issues screen can report **10px or 11px**
depending on which table it lands on, and both are correct:

| Table | Header |
| --- | --- |
| `table.table` (the issue list) | `11px`, padding `0 10px` |
| `table.mini-table` (the trend's table alternative, and the compass milestones) | `10px`, padding `3px 8px 3px 0` |

Both come from the prototype's own sheet. The first measurement I took with
`querySelector("thead th")` hit the mini table (its first cell is `Date`) and I read 10px as
a theme-dependent change; the screens carry two tables and the selector was not specific.

**The rule this belongs to**: on a screen with more than one table, a probe must name the
table — `className === "table"` — or it answers a question nobody asked. This is the third
time in this file that an unscoped selector produced a phantom difference (see the screen
map above and `.trunc`'s contexts).

## The 720px column behaviour is not the prototype's, and the cause is unresolved

At 1440 both sides agree exactly on the issues table:

```
colgroup: 86px | flex | 128px | 112px | 100px | 104px | 116px
rendered:  86     752     128     112     100     104     116
```

At 720 they diverge:

| | rendered widths |
| --- | --- |
| the prototype | `83 · 201 · 104 · 83 · 83 · 69 · 69` — every column shrinks |
| this product | `86 · **32** · 128 · 112 · 100 · 104 · 116` — fixed columns hold, the flex column collapses |

What is **known**: both tables are `table-layout: fixed`, and both carry the identical
`<colgroup>` (`86px`, flex, `128px`, `112px`, `100px`, `104px`, `116px`). The table widths at
720 are 694px (prototype) and 678px (ours) — 16px apart, which cannot explain a flex column
of 201 collapsing to 32.

What is **not** known: why the same colgroup and the same layout mode produce proportional
shrinkage on one side and rigid widths on the other. The prototype's own cells must carry a
constraint ours do not, or ours carry one it does not; the next step is a rule-by-rule diff
of `.table` / `.table td` between the two sheets, not another rendered-pixel comparison.

**This entry is deliberately a open question, not a finding.** The numbers above are
measured; the explanation is not.

## The same series is a chart on one screen and a table on the other

The prototype renders the issue-flow series **twice, in two forms**:

| Screen | Panel | Form |
| --- | --- | --- |
| overview | `Issue flow trend` | `svg.chart-svg` — a chart |
| issues | (above the filter panel) | `table.mini-table` — `Date · Captured · Retired · Open difference · Origin` |

This implementation draws the chart on both. The trend *is* present on the issues screen —
the panel renders, titled `问题走势` above `筛选` — so this is not a missing feature; it is
the wrong **form** for that screen.

Why it matters even though the data is the same: the mini table states five numbers per row,
which a 132px sparkline cannot. A screen meant for reading exact counts gets a shape instead.

**Shipped, and the first attempt was wrong**: the prototype draws the chart **and** offers
the same numbers as a table inside a disclosure — `<summary>Dated history (table
alternative)</summary>` around a `table.mini-table`. The first version replaced the chart
with the table, which read as "the prototype shows a table here" from a panel-level count and
was wrong at the element level. `IssueFlowTable` now sits inside a `Collapsible`, below the
chart.

The screen's element counts now equal the prototype's: 2 `svg` (the chart, and the magnifier
inside `.search`), 1 of them `svg.chart-svg`, 2 `table`, 1 `details`.

The lesson is the file's recurring one, in its smallest form: **a count of a thing on a
screen does not say what the thing is**. `tables: 2` was true for both the prototype's shape
and mine, and only ancestry (`details > table` vs a bare table) told them apart.

The flexible-column floor (`min-width: 120px` on the one column without a width) was checked
at 1440, 720 and 375, and again under the light scheme: no horizontal scroll in any of them.
It remains a defect fix rather than parity — the prototype's columns shrink proportionally,
which is still unexplained.



## What a screenshot shows that ninety rounds of numbers did not

Every earlier verification in this file compared one element at a time — computed styles,
child lists, column widths. The first side-by-side screenshot of the overview found ten
differences at once, several of them structural:

| # | The prototype | This implementation |
| --- | --- | --- |
| 1 | **not a difference** — measured, the grid is `898px 486px` with the iteration row full width, which is the prototype's shape. The screenshot's thumbnail made the right column look like a second row. | same |
| 2 | a `screen-head` subtitle: `All projects · 26 open issues · 13:58:04` | title only |
| 3 | the trend chart carries **Y-axis values** (`900`, `850`, `800`) | no Y axis |
| 4 | milestones list with progress bars | an absence panel |
| 5 | latest iteration shows the **five-step gate track** (`Start · Execute · Close · PR delivery · Merge ready`) | an absence panel — and the track itself was deleted on purpose in an earlier round |
| 6 | identity line ends `built 13:56:02 · read 13:58:04` | ends `最新` |
| 7 | footer states `1224 store revision` | no revision |
| 7a | the footer's right half: `Read-only · Make changes with the CLI` | present, in Chinese |
| 8 | a host switcher strip above the app header | none |
| 9 | a `v4.0.9` badge beside the wordmark | none |
| 10 | panels ordered workflow, residuals, milestones, trend, iteration | workflow, trend, residuals, milestones, delivery |

Rows 4 and 5 read as absences here rather than as missing features: the projection resolved
no project, so the panels say so. Under real data they would render — but the two-column
layout, the subtitle, the Y axis, the gate track and the revision are **not** data-dependent.

The gate track is the sharpest case: it was built, then deliberately deleted in an earlier
round as "not in the prototype". The prototype has it, on this screen, and the screenshot
settles it.

**This is why the acceptance criterion is a screenshot, not a checklist.**
## The workflow detail screen, seen side by side for the first time

| # | The prototype | This implementation |
| --- | --- | --- |
| 1 | breadcrumb `Workflows / issue-project-move` | the word `工作流` alone |
| 2 | meta line `plan · running · phase-2-execute · updated …` | `plan · running · 更新于 2026-10-25` — no phase |
| 3 | the two top panels are both `.panel` with a head | `执行` is a panel; the right side is a bare `.field` block with **no border**, then `目录` |
| 4 | `Catalog identity` states six rows (Title, Lifecycle, Revision, Registered, Location, Updated) and the description beneath | **closed**: six rows, and the description is a paragraph under them, not a labelled field |
| 5 | the plan table has six columns, the last being `Pin` | five — **still open** |
| 6 | a `Leases` panel listing two leases | an absence panel: this store holds none (data, not layout) |
| 7 | — | **closed**: the extra `分支基线` block is gone |

Rows 1, 3, 4 and 7 were fixed over rounds 114–118. Two notes from doing it:

- The catalog panel had **seven** rows after the first fix, not six: `documentKind` is a row the
  prototype does not carry. Adding the four missing facts was right; adding them without
  counting the result was not.
- Row 2 (the absent `phase`) is data: `workflow.phase` is `null` in this store. Deriving
  `phase-2-execute` from `status` would be a claim the projection does not make.

Rows 3 and 7 are the same defect twice: the execution panel is a `.panel` while its
neighbour is a bare `.field` grid, so the two halves of one row do not share a frame. The
extra `分支基线` block is content the prototype does not carry at all.

Row 4 is the largest single gap: the catalog panel is the identity of the record being
looked at, and four of its six facts are missing.

**None of this was visible from element counts.** The screen has four `.panel`s either way,
and `heads: ["执行", "目录", "计划", "租约"]` matched the prototype's four names — because I
was counting the wrong thing in the wrong order.

## The branch chain is per screen, and the evidence is a screenshot

The overview's active-workflow row prints `Base main → Source … → Integration … → Target main`.
The workflow detail screen does **not**: the round-113 side-by-side screenshot of the
prototype's detail screen shows the page ending at the leases table, with no chain above the
catalog panel. Both screens carry the same four facts; only one draws them as a chain.

The implementation had the chain on both. Removing it from the detail screen left the four
copy keys (`chainBase`, `chainSource`, `chainIntegration`, `chainTarget`) declared in
`WorkflowDetailCopy` and defined in both locales but read by nothing — `validation:drift`
does not look for unreferenced copy keys, so it stayed green. They are gone now.

**The general form**: deleting markup does not delete its strings, and a green drift check
says nothing about whether a key is still read.

## The iteration detail screen, seen for the first time

| # | The prototype | This implementation |
| --- | --- | --- |
| 1 | breadcrumb `Iterations / <id>` | **closed**: the same two-part crumb the workflow detail gained |
| 2 | `Catalog identity` states six rows (Kind, Lifecycle, Revision, Registered, Location, Updated) and the description beneath | **closed**: six rows, description as a paragraph |
| 3 | `Execution` states Workflow, Status, Phase, Started and an `active registration` chip | **open**: one row (`Workflow`) |
| 4 | the meta line states five facts (id · lifecycle · compass · plans · documents) | two |
| 5 | `Compass`, `Plans`, `Documents` hold rows | empty on every iteration in this store |

**Row 5 is data, and worth stating plainly**: the first pass opened a `superseded` record and
the screen was mostly absence arms, so I re-ran it on an `active` one — and it was still
empty. The store does not link compasses, plans or documents to most iterations. That means
the compass mini-table, the plan table and the document inventory have **never rendered with
data on this machine**, in either the prototype comparison or the tests' fixtures.

Rows 1 and 2 are the same view-model gap the workflow detail had: the catalog row carries
`kind`, `revision`, `registeredAt`, `updatedAt` and `description`, and the view model passed
three of them.

## Four rules the prototype overrode, and where that is written down

The IA spec's §8.1 removed a set of facts from the UI, with reasons. The approved prototype
renders several of them anyway, and the owner's acceptance bar is a pixel-exact match with
that prototype. Rounds 105–121 added them back — footer revision, identity-line
`built`/`read`, the catalog's own `Revision` row on both detail screens — without the spec
saying so, which left the spec and the implementation describing different products.

`specs/information-architecture.md` §8.1 now records the override in place, on **eight**
rows: the identity times and catalog revision, the plan leases, the catalog-pin badges, the
document inventory, the compass milestones, the issue-flow trend, the **issue row's own
revision**, and the version plus `{HARNESS_DIR}`. Each is struck through with the prototype's
own evidence named; the two members the prototype does **not** carry (`catalogRevision`,
`sourceHash`) are stated as still out.

**The issue revision was the last one, and it had been enforced backwards.** The view model
said revisions were not carried, and two tests asserted that absence — so the code, the tests
and §8.1 all agreed with each other and all three disagreed with the prototype's meta line
(`I-000870 · … · open · Revision 4`). A negative test is not evidence that a fact should stay
out; it is evidence that someone once decided so.

That spec lives under `.mstar/`, which this repository gitignores — it is a local planning
artifact, not a tracked document. **A reader of this repository cannot see it.** So the
reconciliation is written here as well, where it is tracked: the prototype, not §8.1, decides
what the UI renders.

**The rule this belongs to**: when the prototype wins an argument the spec already decided,
the spec has to be edited in the same change. Otherwise the next reader implements the old
rule and calls it correct.

## The project detail screen, seen for the first time

| # | The prototype | This implementation |
| --- | --- | --- |
| 1 | breadcrumb `Projects / engine` | present |
| 2 | three tabs (`Roadmap 3 · Issues 14 · Iterations 2`) | present |
| 3 | `Catalog identity` states six rows (Kind, Lifecycle, Revision, Registered, Location, Updated) | **closed**: six rows — but Kind is last where the prototype puts it first |
| 4 | `Roadmap authority` states four rows | present |
| 5 | the description paragraph under the head | the **code** is there; this store's `catalog.description` is `null` |
| 6 | a `Milestone board` panel | absent: this project has zero milestones |
| 7 | `Stored facts` states five rows | present |

**Two rows I first called defects and then measured away**: the description (rendered from
`identity.description`, which is `null` here) and the milestone board (no milestones to
board). Both look identical to a missing feature in a screenshot, and only the data
distinguishes them.

Row 3's ordering is real and still open: the six facts are the right six, in the wrong order.

## The issue detail screen: six panels the spec removed and the prototype kept

This is the largest single divergence found in the whole comparison, and it was invisible
until the screen was seen side by side:

| The prototype | This implementation | §8.1's verdict |
| --- | --- | --- |
| `Source` (kind, identity, location, root cause key, acceptance key) | absent | `IssueOccurrence` rows — not rendered |
| `Occurrences` (one block per event, with its own quote and citation) | absent | not rendered |
| `Disposition history` (a table: From, To, Reason, Actor, Recorded) | absent | not rendered |
| `Relations` (Relation, Issue, Title) | absent | not rendered |
| `Provenance` (Kind, Target, Source hash, Origin, Imported at) | absent | not rendered |
| `Identity keys` (Identity key, Provider) | absent | `externalUrl` / `identityKey` — not rendered |

Every one of the six is a row §8.1 struck out, with a reason. The prototype draws all six.
**The implementation is not missing them by oversight — it removed them on purpose, and the
spec still says so.**

Rounds 122–123 reconciled seven §8.1 rows with the prototype. These six are the remainder,
and unlike those seven this is not a label or a counter: it is six panels, three of them
tables, on the screen a reader opens to understand one issue.

The prototype's layout is also two columns (identity, source, impact, acceptance,
occurrences on the left; disposition history, relations, provenance, identity keys on the
right). This implementation is one column. That follows from the missing panels: a single
column is what is left when six of ten blocks are gone.

**In progress.** Two of the six are rendered now:

| Panel | Shape | State |
| --- | --- | --- |
| `Identity keys` | two rows (Identity key, Provider) | shipped, verified in the browser |
| `Source` | five rows from the newest occurrence | shipped, verified in the browser |
| `Relations` | table (Relation, Issue, Title) | shipped and **verified on data**: the query joins the other end's title, an engine test asserts the joined value equals that issue's own title, and a UI test asserts it reaches the page. No issue in this store has a relation, so the browser shows the panel on fixture data only |
| `Provenance` | table (Kind, Target, Source hash, Origin, Imported at) | shipped |
| `Disposition history` | table (From, To, Reason, Actor, Recorded) plus the prototype's footer note | shipped; this store's issues record no transitions, so it renders on fixture data only |
| `Occurrences` | one block per event, with its quote, location and citations | shipped; verified in the browser |

The data was never missing: `store-read.ts` returns `occurrences`, `transitions`,
`relations`, `provenance`, `provider` and `identityKey` on the issue detail. The gap was the
view model, which forwarded sixteen of them and stopped.

**All six are rendered.** The screen now states: 影响, 验收标准, 出现记录, 溯源, 来源, 标识键.

**The layout is still one column**, and that is now the largest remaining difference. The
prototype's own structure is three children: `div.breadcrumb`, `div.detail-head`,
`div.detail-grid` — and `detail-grid` holds two `detail-col`s.

| Column | Blocks, in the prototype's order |
| --- | --- |
| left | identity (`FieldGroup`), impact, acceptance, source, occurrences |
| right | disposition history, relations, provenance, identity keys |

`.detail-grid` and `.detail-col` already exist in `product.css` (`1.15fr : 1fr`, 28px gap)
and the other three detail screens use them.

**Shipped, by inserting three markers and moving nothing.** The screen is now
`nav.breadcrumb · header.detail-head · div.detail-grid`, and the grid's two `detail-col`s sit
at x=20 and x=782 — the prototype's own three-child shape.

**Two attempts failed before that**, and the reason is worth recording: a Python rewriter
that cut blocks out by `</section>` lost the `{…? null : (…)}` wrappers those blocks sit in —
the conditional opener is *above* the `<section`, and its `)}` is *below* the `</section>`.
What worked was the opposite approach: **never move a block**, only insert
`<div class="detail-grid"><div class="detail-col">` after `</header>`, `</div><div
class="detail-col">` after the occurrences block's `)}`, and `</div></div>` after the identity
keys block's `)}`. Three insertions, zero movement, and `tsc` stayed green.

**`source` moved to the left column**, so the split is now the prototype's: identity,
source, impact, acceptance, occurrences on the left; history, relations, provenance, identity
keys on the right.

**The two-column split and its collapse both match**, measured at three widths:

| Viewport | The prototype | This implementation |
| --- | --- | --- |
| 1440 | `733.859px 638.125px` | `733.859px 638.125px` — identical |
| 720 | `696px` (one column) | `680px` (one column) |
| 375 | `351px` (one column) | `335px` (one column) |

The 16px difference at the narrow widths is the page's own padding, not the grid. No
horizontal scroll at any of the three.

## What the negative tests used to guard, and what guards it now

Building the issue detail's six panels removed entries from five "NEGATIVE" tests one at a
time — `occurrences`, `transitions`, `provenance`, `relations`, `provider`, `identityKey`,
`builtAt`, `checkedAt`, `storeRevision`, `catalogRevision`, the catalog `revision`. Each was
a guard: the test failed if the UI started rendering something §8.1 had removed.

They are all gone now, and **that is the correct outcome** — the prototype renders every one
of them. But it means the §8.1 negative set no longer has a test behind it. What remains:

| Still guarded by a test | The issue id pattern, the external URL, the migration JSON (`legacyProject`, `legacyJson`, `Migration`) |
| No longer guarded by anything | Every row this document's §8.1 reconciliation table lists as superseded |

**What guards them instead**: this file, and the prototype. That is weaker than a test — a
future change can re-remove one of these panels and no suite will notice. If that matters,
the guard to add is not the old NEGATIVE test (it asserted the opposite of what ships) but a
*positive* one: a test that fails when a panel the prototype has stops rendering.

## A class name I invented, and what it cost

The issue detail's nine blocks were wrapped in `className="fact-block"`. That class exists
**nowhere** in `product.css` or `base.css` — I made it up while writing the components, and
no measurement caught it because every check was "does the panel render", not "does it look
like the prototype's".

The prototype uses `.sec`: `border-top: 1px solid var(--ms-border-hairline); padding-top:
9px; margin-top: 11px`, with `:first-child` removing all three. Six `fact-block`s became
`.sec` and the separators appeared.

**Why this one matters more than its size**: a fixture-rendered page — the method that found
it — is the only check that could have. The DOM assertions all passed with the invented
class; the browser, with the real sheets applied, showed nine blocks with no separators at
all.

**The general form**: a class name that appears in no stylesheet renders as if you had
written nothing, and nothing fails.

**So the check is now a script**: `bun run --cwd packages/ui check:classes` scans every
`.tsx` for `className` literals and fails on any that appears in neither `tokens.css`,
`base.css` nor `product.css`. It found three more the moment it existed — `.detail-text`
(four uses, now `.prose`), `.screen-sub` (the subtitle from an earlier round, now
`.screen-meta`), and `.attribution` (now `muted t-11`). All three had been rendering as bare
text with no rule behind them.

## The fixture-render method works on one screen and not on another

The check that found the invented `fact-block` was this: render a component to static markup
with real data, concatenate the three stylesheets, open it in the browser, look. It worked
because `IssueDetail` takes a single `read` prop whose shape the DTO already defines.

`Overview` does not cooperate the same way. Its model is assembled from five `Resolved`
members whose runtime shape (`state`/`data` vs `kind`/`value`) differs from the TypeScript
type a caller sees, and three attempts to hand-write that shape produced three different
"undefined is not an object" errors instead of a page. **The method did not fail; the input
did.** Rendering a fixture for `Overview` means building a real envelope through
`overviewFromEnvelope`, not hand-writing the model.

**The path is now verified, and it found a defect.** Building the DTO the way
`overview-data.test.ts` does — `{state: "read", data}` per member, not the `Resolved` shape —
rendered the gate track for the first time, and showed it printing `step 1 of 5 … step 5 of 5`
where the prototype names each step: `Start · Execute · Close · PR delivery · Merge ready`.

`copy.gateStepLabels` existed in both dictionaries and was read by nothing.

**And the markup was wrong in the same way `fact-block` was.** `product.css` defines
`.gate-step .glyph`, `.gate-step .gate-label` and both state classes — `.is-done` and
`.is-current` — and the component used none of them: it invented `.gate-step-num` and
`.gate-step-label` and printed the step number in all three states. The prototype's glyph is
`✓` for reached, `●` for current, the number for ahead, and the top border colour carries
the state (`--ms-border-strong` / `--ms-accent` / `--ms-border-hairline`).

Measured after the rewrite:

```
step 1  ✓  is-done     border-top rgb(54, 61, 70)
step 2  ●  is-current  border-top rgb(122, 162, 255)  weight 500
step 3  3  (none)      border-top rgb(36, 41, 48)
```

The labels read `["Start","Execute","Close","PR delivery","Merge ready"]`.

**Plan table `Title` is not a defect**: the model reads `plan.catalog?.title`, and the real
overview renders `Plan: dsh panel entry correction and its unavailable…`. The `—` came from
a fixture that supplied no catalog.

## The milestone board, rendered with data for the first time

The same fixture method that found the gate track's unnamed steps found a second one:

```
rows: 0        before
rows: 1        after
```

The board's content was there — the milestone's name, status, target and `4/14` counts all
rendered — but its row wore the generic `.row` class where the prototype has
`.milestone-row` (`padding: 7px 0; border-bottom: 1px solid`). `.row` supplies a different
rhythm and no per-row padding. `Row` gained a `rowClass` prop and the board passes it.

**One measurement that looked like a defect and was not**: the row's computed
`border-bottom-color` read `rgb(231, 234, 238)` — the text colour, not the hairline
`rgb(36, 41, 48)`. `border-bottom-width` was `0px`: the row is a `:last-of-type`, which the
prototype's own rule clears. Reading the width, not only the colour, is what settled it.

**That single row was itself the defect in the fixture.** One row is always the last, so it
never exercises the between-rows rhythm. With three, the measurement is:

```
row 1: padding-top 7px, border-bottom 1px, height 36
row 2: padding-top 7px, border-bottom 1px, height 36
row 3: padding-top 7px, border-bottom 0px, height 32
```

which is the prototype's `.milestone-row` with its own `:last-of-type` override.

## The `+N more` line, rendered for the first time

The overview shows one active workflow and counts the rest. That count had never rendered:
this store has exactly one workflow, so the branch that prints it never ran.

With two in the fixture it reads `+1 more running`, and the row above it carries
`issue-project-move · plan · phase-2-execute` — the prototype's summary line.

**Getting there took four fixture attempts**, each failing on a different missing field
(`catalog.rootKind`, `branch.base`, then `id` where I had written `workflowId`). None of them
was an implementation defect: the view model reads `workflow.id`, `workflow.catalog` and
`workflow.branch`, and my invented shape had one of each wrong.

**The lesson is about the fixture, not the product**: a hand-written DTO is a second
implementation of the shape, and it is wrong until it matches.

## The first whole-screen render of the overview

The fixture that finally rendered the page end to end (twelve fields before it was right)
produced the comparison the acceptance bar actually asks for:

| The prototype | This implementation |
| --- | --- |
| identity line with package, version, `{HARNESS_DIR}`, state, two times | same six members |
| `Active workflow` with its plan count and status | same |
| the workflow summary, the branch chain, the plan table | same |
| `Open residual issues` with five severities | same |
| `Milestones` with three rows | same |
| `Issue flow trend` with a Y axis | same, `900 / 845 / 790` against the prototype's `900 / 850 / 800` — both span the series' own floor to ceiling |
| `Latest iteration` with the five-step track | same, named |

**One difference the screenshot found that the fields did not**: with a bucket shape I got
wrong, the Y axis rendered `NaN · NaN · NaN` — three `NaN`s in a `<span>`, no error, no
empty state. The DTO's real field names (`capturedCumulative`, not `captured`) fixed the
fixture, but the page had been perfectly willing to print the arithmetic.

**That is worth a guard**: `flowModel` returns `null` below two buckets, and nothing checks
that the numbers inside a bucket are numbers. A missing field becomes `NaN`, and `NaN`
renders.

## The milestone counts cell, and the numerator that was wrong

The prototype's trailing cell reads `5/14 · 9 open`. This implementation rendered `4/14`:

| | The prototype | This implementation, before |
| --- | --- | --- |
| numerator | `total - open` = 14 − 9 = **5** | `resolvedIssues` = **4** |
| denominator | `total` | `total` |
| tail | ` · 9 open` | **absent** |

The two numerators differ exactly by the issues that were retired without being resolved, so
the old cell understated progress on every milestone whose retired count is not zero.

Both parts are rendered now, and the browser reads
`["5/14 · 9 open", "2/6 · 4 open", "13/13 · 0 open"]` — the prototype's own three strings.

`ProgressBar` had the same denominator bug through `done`: its `aria-valuenow` is the retired
count now, so the bar and the text agree.

## Reverse-scanning the stylesheet: 97 classes defined and never named

`check:classes` catches a class that no sheet defines. The inverse had no check, so this was
the next step: enumerate every class `product.css` defines and diff it against every
`className` a component writes. **97 classes** come back.

Most of the 97 are legitimate, and sorting them out is the point:

| Group | Why it is legitimate |
| --- | --- |
| `.tone-*`, `.w-400/500/600` | built by template literal (`className={`dot tone-${tone}`}`) |
| `.tk-*`, `.swatch-*`, `.t-13/14/16/20`, `.seg`, `.rule-list`, `.status-sample` | the prototype's `tokens` screen, which sits in its `proto-group` "System" switcher — a design-document surface, not a product screen |
| `.app-header`, `.brand-*`, `.dsh-page*`, `.pane-*` | the host shells and the dsh panel previews |

What remained was the real find: **`.occ`, `.occ-head`, `.occ-key`, `.occ-behavior`,
`.evidence`, `.fields.one`** — all defined, none used, because the occurrence block I wrote
invented `.occurrence`, `.occurrence-head` and `.occurrence-evidence` beside them.

**The prototype's occurrence block is four elements, not one article**: a `.occ` wrapper, a
`.occ-head` whose first child is the **occurrence key** (which this implementation did not
render at all), an `.occ-behavior` paragraph, a `.fields.one`, and an `.evidence` list whose
items are `<code>`. Measured after the rewrite, the head reads
`dashboard-issue-row-pill · review · qc3 · Observed at · 2026-10-23 09:14` — the prototype's
own five cells in its own order.

**This is the eleventh instance of one failure mode**: a class exists in the sheet, the
component writes a parallel name beside it, and the page renders bare.

**The 97 were then checked with evidence, not explanation.** The first pass wrote off whole
groups — "`.app-*`, `.brand-*`, `.pane-*` are the host shells" — without grepping them. Two
corrections came out of doing it properly:

| Class | First pass said | Evidence says |
| --- | --- | --- |
| `.status-list`, `.history-arrow`, `.screen-actions`, `.compass-body`, `.pane-nav`, `.dsh-shell` | "host shells and dsh" | **zero `className` uses in any `.tsx`** |
| `.history-arrow`, `.screen-actions` | "unused, then" | the **prototype** has zero HTML instances too — dead CSS in both |
| `.sec-note` | not noticed | the prototype uses it **9 times**, this implementation **0** |

`muted t-11` was doing `.sec-note`'s job on the disposition history's footer: two utility
classes that happen to look similar, against a purpose-built rule with its own
`margin: 4px 0 0`. It is `.sec-note` now.

**The honest state of the scan**: it is a **report**, run by hand. It cannot be a hard
failure — 97 classes hit, most legitimately — and the judgement that separates `.evidence`
from `.tk-swatch` is still a human one, but the judgement has to cite an instance count, not
a plausible category.## The Compass panel: three facts in the wrong places

`.compass-body` was the last unused class with a prototype instance behind it, and following
it found a panel whose **content was right and whose placement was wrong**:

| Fact | The prototype | This implementation, before |
| --- | --- | --- |
| compass status | `.panel-meta` in the **head**, as a `.status` dot | a `dt/dd` row in the body's `dl` |
| `startedAt` | `.panel-meta`, `started <time>` | **carried by the model, rendered nowhere** |
| the direction summary | `<p class="prose">` as the body's first column | a `dt/dd` row |
| the body | `panel-body compass-body` (two columns, `1fr : 1.15fr`) | `panel-body`, one column |

So `startedAt` was a **dead field** — the fourth this document has recorded, after the four
`chain*` keys, `gateStepLabels` and the catalog `revision`. The model read it, the type
declared it, and no element ever printed it.

Measured after the rewrite, on a real iteration that has a compass:

```
panel-meta: "completed · started 2026-08-11"
panel-body: "panel-body compass-body"
first prose: "本迭代锁定的 spec 点：..."
```

**The no-compass branch had its own defect, and only the browser showed it.** With
`compass === null`, the head read `no compass · started Date unknown` — the second half
asserting an unknown start time for an iteration that never started. `formatDate("")` returns
`UNKNOWN_DATE` by design (a recorded-but-empty date is worth saying), but here there is no
date to be empty. Both branches now measure:

```
iter-…authz-recovery  panel-meta: "no compass"
iter-…panel-fixes     panel-meta: "completed · started 2026-08-11"
```

**The prototype has no no-compass variant**, so that branch cannot be compared against it —
only against the rule that a screen states no fact it does not have.

## A panel inside the pane is not a card

The prototype's pane stacks **borderless** sections: `.pane-body .panel { background:
transparent; border: 0; border-radius: 0; border-bottom: 1px solid }`, with the head and
body flush to the pane's own padding. This implementation's pane body carried none of it, so
a 280px sidebar showed three 1px card borders inside its own 1px border.

Two mistakes on the way to fixing it, both caught by measuring rather than reading:

1. **Specificity.** The first rules were `.ms-pane-body .panel` — same weight as
   `product.css`'s `.ms-container .panel` and loaded *before* it, so they lost. The rewrite
   needed `.ms-container.ms-pane-body .panel`.
2. **A descendant where the same element was meant.** `.ms-container .ms-pane-body .panel`
   still failed, because the pane div carries **both** classes; the selector asked for a
   `.ms-pane-body` *inside* a `.ms-container`. Written as one compound selector it applies.

Measured after: the first panel reports `border-top 0px, border-bottom 1px, radius 0px,
background transparent`, and the last reports `border-bottom 0px` from its `:last-child`
override.

**Not verified**: the real dsh pane. The rule is measured on a fixture and the dsh package
builds green, but no screenshot of the running dsh panel with a panel inside it was taken.## Three defects a 360px pane render found in one screen

Rendering the real overview inside `.ms-pane-body` — the first time any screen was seen at
pane width — turned up three, none of which a computed-style check would have asked for:

**1. Two Tone values had no colour, and a third had the wrong one.** `.tone-success` and
`.tone-purple` appear nowhere in `product.css`; only `.tone-done`, `.tone-resolved` and
`.tone-terminal` cover those colours, so every dot carrying either rendered in the default
neutral grey. Both rules now exist.

**And mapping `active` to `success` was wrong.** The prototype draws `tone-active` as
`var(--ms-accent)` — a blue dot — where `tone-done` is `var(--ms-success)`. Folding the two
together made an active milestone green, and the first check only asked whether the dot *had*
a colour, not which one. `Tone` gained a sixth value, `accent`, with its own rule.

Measured on the three milestone states:

| Milestone status | The prototype's class | Its colour | This implementation |
| --- | --- | --- | --- |
| `active` | `tone-active` | `--ms-accent` `#7aa2ff` | `tone-accent` `rgb(122, 162, 255)` |
| `planned` | `tone-todo` | `--ms-neutral` `#8b939f` | `tone-neutral` `rgb(139, 147, 159)` |
| `delivered` | `tone-done` | `--ms-success` `#4cbd85` | `tone-success` `rgb(76, 189, 133)` |

**The lesson is the check, not the fix**: "the dot has a colour" and "the dot has the
prototype's colour" are different questions, and only the first was asked.

**2. The milestone row was two rows in the prototype and one row here.** The prototype's
`.milestone-top` (dot, name, target) and `.milestone-foot` (bar, counts) stack. As a single
flex line at 360px, the target broke across lines and `5/14 · 9 open` split in two. The row is
now the prototype's two divs.

**3. A dead rule was setting the layout.** `base.css` styled `.milestone-row` as a one-line
flex row for "the roadmap goal row" — a consumer that no longer exists; the only component
naming the class is the overview's board, whose rule lives in the product sheet. The dead rule
won the specificity and made `.milestone-foot` a *sibling* of `.milestone-top`, so the
progress bar measured **0px wide**. With the rule gone the bars measure `234 / 240 / 228`.

**The general form**, and the third time this file records it: a rule whose owner was deleted
does not go away, it applies to whoever else names the class.

## All 22 tone colours, compared as a table

The `active` mistake was not a one-off colour choice; it was a mapping nobody had ever held
against the prototype's own table. The fix was to stop sampling and compare the whole thing:
parse every `.tone-<name> .dot { background: … }` rule out of both sheets and diff them.

```
tone         prototype   ours        verdict
active       accent      accent      ok
blocked      warning     warning     ok
completed    purple      purple      ok
critical     danger      danger      ok
danger       danger      danger      ok
done         success     success     ok
high         warning     warning     ok
inprogress   accent      accent      ok
inreview     accent      accent      ok
low          neutral     neutral      ok
medium       neutral      neutral     ok
neutral      neutral      neutral     ok
nit          neutral     neutral     ok
open         neutral      neutral     ok
paused       warning     warning     ok
resolved     success     success     ok
running      accent      accent      ok
stale        warning     warning     ok
strong       accent      accent      ok
terminal     purple      purple      ok
todo         neutral     neutral     ok
warning      warning     warning     ok
```

**22 of 22 agree.** Three names are this implementation's own (`accent`, `purple`,
`success` — the `Tone` vocabulary) where the prototype spells the same colour `tone-running`,
`tone-terminal`, `tone-done`; the colours match, only the words differ.

**Two mappings were wrong before this table existed**:

- `workflowStatusTone("running")` returned `neutral` — a live workflow's dot was the same grey
  as a stopped one, where the prototype draws it accent.
- `workflowStatusTone("completed")` returned `neutral` too, where the prototype's
  `.tone-completed` is `--ms-purple`.

Both are `accent` and `purple` now, and the workflow row's pinned tone moved from `neutral`
to `accent` with them.

**The comparison is now two things a future round can run**, because one run is not a habit:

- `bun run --cwd packages/ui check:tones` diffs the whole table against the prototype's own
  rules. It needs the prototype file, which is gitignored, so it exits 0 with a notice when
  absent — a development check, not a CI gate.
- `src/view-model/status.test.ts` pins the same table as expectations, with the prototype's
  rule quoted beside each one. This one CI runs, and it has to be argued with to change.

Today it reports `every one of the prototype's 22 tone colours matches`.## Diffing whole stylesheets: 50 selectors, and three that mattered

The tone table worked because it compared the whole set instead of sampling. The same move on
selectors — parse every rule out of the prototype's `<style>` block and out of
`product.css`, normalise the `.ms-container` prefix, diff — gives 387 against 338, with
**50 selectors the prototype has and this implementation does not**.

Sorting them took one pass, and the largest group is not a gap at all:

| Group | Selectors | Verdict |
| --- | --- | --- |
| the design document's own chrome | `.proto-*` (11), `.pane-stage*` (7), `.pane-tabs`, `.pane-tab*`, `.pane-wrap`, `.pane-shell`, `.pane-ctl` | not product UI — a preview frame with its own width picker |
| global reset | `*`, `:root`, `html`, `body`, `[data-theme=*]` | **`box-sizing` and font smoothing in `base.css`; `html, body` in `packages/cli/web/shell.css`** — the product sheet scopes everything under `.ms-container` and cannot carry a document-level rule |
| dsh shell | `.dsh-top`, `.host-crumb`, `.dash-main` | **zero** `className` uses; the dsh pane spells its shell differently |
| controls | `.seg`, `.seg button*`, `.icon-btn`, `.icon-btn svg`, `.icon-btn:hover` | **used by components, defined nowhere** |

That last row is the find: `Segmented` and the theme toggle already name `.seg` and
`.icon-btn`, and neither class had a single rule. Both are copied from the prototype now — a
segmented control and a 26px square button.

**`check:classes` did not catch it, and could not.** It asks whether the class appears in any
stylesheet, and `.header-right .seg` was enough to make the string "seg" present. A class that
is *mentioned in a compound selector nobody renders* counts as defined to that check.

**One selector this implementation has and the prototype does not**: `.chart-svg.is-full`, the
trend chart's expanded height.

**The control row was not actually reconciled until the next pass.** `.ctl` appeared in both
sheets, so the diff did not flag it — but the prototype has a bare `.ctl { height: 26px;
padding: 0 6px; border-radius: 4px; border: 1px solid …; background: …; font-size: 12px }`
and this implementation only had the behaviour (`cursor`, `max-width`) plus the filter
field's overrides. Every `select.ctl` therefore drew the browser's default box. It is ported
now.

**And the diff is a check**: `bun run --cwd packages/ui check:selectors` lists every
prototype-only selector that is neither defined nor listed in its `NOT_APPLICABLE` table,
where each entry carries the reason it must not exist here. Today it reports that every one
is accounted for.## Diffing declarations, not just selectors: 337 shared, one difference

Comparing selector *names* found `.seg` and `.icon-btn` but could never find `.ctl`, because
`.ctl` exists on both sides. Comparing the declarations of the 337 shared selectors found
exactly one difference:

```
.chart-svg   height: prototype=auto  ours=88px
```

**The prototype lets the width decide the height.** Its `viewBox` is `0 0 872 88` and its rule
is `height: auto`, so a wider chart is a taller one — the issues screen gets a taller trend
than the overview for free. This implementation pinned 88px and then invented
`.chart-svg.is-full { height: 132px }` to make the issues screen look right; `is-full` appears
**zero times** in the prototype.

Both are gone, **and the first measurement of the result was wrong**. It read
`844 × 88` and `1346 × 132` — suspiciously close to the two pinned heights I had just
deleted — because the dashboard was serving a CLI bundle built *before* the CSS change. Only
`packages/ui` had been rebuilt; the CLI's `assets.generated.ts` still carried `height: 88px`.

Rebuilt properly, the real answer was worse than the old one: `844 × 338`, a 0.400 ratio.
That is the component's own `viewBox` — `0 0 100 40` with `preserveAspectRatio="none"` — so
`auto` gave the chart 40% of its width. The prototype's `viewBox` is `0 0 872 88`, and its
`auto` means *that* ratio.

The fix is to declare the ratio the component cannot infer:

```css
.chart-svg { height: auto; aspect-ratio: 872 / 88; }
```

Measured after, at three widths:

| Screen | Chart box | height/width |
| --- | --- | --- |
| overview @1440 | 844 × 85 | 0.101 |
| issues @1440 | 1346 × 136 | 0.101 |
| issues @720 | 626 × 63 | 0.101 |

Against 88/872 = 0.1009. **The lesson is the build order**: a UI-only rebuild leaves the
CLI's generated assets stale, and every browser measurement after it is a measurement of the
previous change.

**`.ctl` is the one deliberate narrowing**: the prototype's rule is the bare class, this
implementation writes `select.ctl`, because every `.ctl` here is a select and a bare class
would box any future button that reuses the name. `check:selectors` carries that reason.

## The panel head's meta is structure, not a string

A computed-style probe on the running dashboard found one difference on the overview: the
prototype's `Active workflow` head reads `7 plans · running` as

```html
<span class="panel-meta">
  <span><span class="num mono">7</span> <span>plans</span></span>
  <span aria-hidden="true">·</span>
  <span class="status tone-running is-strong"><span class="dot"></span><span class="label">running</span></span>
</span>
```

and this implementation passed `copy.workflowMeta(plans, status)` — one string. A string
carries neither the count's mono/tabular treatment nor the dot, and it was the same
`textContent` trap this file already records twice: the text matched, so nothing looked wrong.

The head takes the same three elements now. Measured:

```
text:       "1 个计划 · running"
status:     "status tone-accent is-strong"
font-weight: 500
dot:        rgb(47, 111, 237)      // --ms-accent
```

`is-strong` is the prototype's own class (`font-weight: 500`), and `accent` is the tone
`tone-running` resolves to.

**The probe itself was wrong first**: it asked for `.breadcrumb`, `.detail-title` and
`.field dt` on the *overview*, where those elements do not exist, and reported five `None`s
that looked like five missing elements. A probe has to name the screen it belongs to.

**And a check now guards the build order.** `bun run --cwd packages/ui check:stale` fails when
`packages/commands/src/dashboard/assets.generated.ts` is older than any sheet in
`packages/ui/src/styles`. That is the exact state that produced a `844 x 88` measurement of a
`height: 38%; aspect-ratio` change — twice. It is a timestamp comparison, which answers the
question that was missed: *was the CLI built after the sheets changed?*

**A test asserted too little, and that is now fixed too.** The panel-head assertion read
`expect(html).toContain("is-strong")` over the whole page, which passes if any element
anywhere carries the class. It now slices this head's own `panel-meta` by balanced `<span>`
nesting and asserts the count, the unit, `is-strong` and the label inside that slice.## Comparing whole screens by their panel set

Sampling one element at a time found the panel head. Asking each screen for its full set of
`.panel-title` strings found another, and confirms the rest:

| Screen | The prototype | This implementation |
| --- | --- | --- |
| overview | Active workflow · Issue flow trend · Open residual issues · Milestones · **Latest iteration** | same five, but the fifth read **Delivery** |
| issues | Issue flow trend · Filters | same |
| workflows | one panel, no head, one table | same |
| iterations | one panel, no head, one table | same |
| projects | Catalog projects, no table | same |

The overview's fifth panel is `Latest iteration` now, in both dictionaries.

**A count that looked like a difference and was not**: the overview shows two `<table>`s here
and one in the prototype, because this implementation wraps the trend's data table in a
`<details>` beside the chart and the prototype's own disclosure is `<details class="disc">`
too — my window into the prototype's body simply ended before it.

**The focus screen was found and answered.** It is a `<template id="session-focus-template">`
in the prototype, and it declares **four** panel titles: `Active workflow`, `Open residual
issues`, `Milestones`, **`Latest iteration`**. This implementation titled its fourth panel
`Delivery` — a word the prototype never uses on that screen. It is `Latest iteration` now, and
`landing.test.tsx` asserts both the presence of the prototype's word and the absence of the
old one.

**`focus` is a dsh-panel screen only.** `#focus` is not a dashboard route — it is the pane's
landing destination (`PanelView.tsx`, `shell-destinations` in `panel-shell.tsx`), so the
dashboard cannot render it and the GUI's own panel needs a token URL this session does not
have. The assertions above run against the component through the suite's `focus({})` helper,
not against a running pane.

**The body was thinner because a field was never read.** `DeliveryLine.steps` has existed
since the screen was written — five entries with their positions — and nothing rendered it;
the panel printed `step 2 of 5` and stopped. It renders the track now, with the prototype's
own glyphs and state classes (`✓` / `●` / the number, `is-done` / `is-current`), so the fourth
panel is id, track, and the position line.

**Still open, and honestly so**: the prototype's fourth panel also carries the iteration's
status, an `Open iteration` link, and `compass active · phase-1-direction · 3 plans`. This
implementation's `IterationDTO` slice for that screen is `{iterationId, gateStep}`, so those
three are not a rendering gap — the data is not read.

**On language**: the prototype is English and this dashboard resolves to `zh` by default
(`locale/index.ts`: anything not `"zh"` is English). That is a locale setting, not a styling
difference — the headings above are compared against the English dictionary, and the same
screens render those strings when the switch is on `en`. Every structural claim in this file
was checked in the dictionary the prototype uses.## The gate track, measured on both sides

The track was asserted by class name; the acceptance bar asks for the pixels. Both sides, at
the same five steps and the same theme:

| Step | The prototype | This implementation |
| --- | --- | --- |
| 1 | `gate-step is-done` `✓` `rgb(204, 208, 215)` 400 11px | identical |
| 2 | `gate-step is-current` `●` `rgb(47, 111, 237)` 500 11px | identical |
| 3–5 | `gate-step` `3` `4` `5` `rgb(227, 229, 233)` 400 11px | identical |

Class, glyph, top-border colour, weight and size all agree on all five — the only difference
in the two dumps is whitespace inside `rgb()`.

**A seventh dead field was found and deleted rather than described**:
`IterationDetailModel.workflowActiveRegistration` was declared, populated from
`iteration.workflow.activeRegistration`, and read by nothing. It is gone from the type and
from the read.

**The scan that found it is a name-level grep**, so it only finds a field that no component
mentions at all — a field read into a variable and then ignored does not appear. Running it
again would find nothing more, and the honest state is that the remaining dead-field risk is
of the second kind, which needs reading each screen rather than grepping.

## The light theme, measured on both rendered pages

The dark scheme has been measured many times; light had only been compared token to token.
Both pages, same six elements:

| Element | The prototype, light | This implementation |
| --- | --- | --- |
| `.screen-head h1` | `rgb(25, 28, 32)` | same |
| `.panel` | text `rgb(25, 28, 32)`, bg `rgb(255, 255, 255)`, border `rgb(227, 229, 233)` | same |
| `.panel-head` | `rgb(25, 28, 32)`, transparent, border `rgb(227, 229, 233)` | same |
| `.panel-title` | `rgb(86, 93, 103)` | same |
| `.table th` | `rgb(133, 140, 150)`, bg `rgb(255, 255, 255)`, border `rgb(227, 229, 233)` | same |
| accent dot | `rgb(47, 111, 237)` | same |

**One measurement that read as a difference and was not**: the first table cell's
`border-bottom` came back `0px none` here against `1px solid` there. The table in question has
**one row** — an only row is a `:last-child`, and `.table tbody tr:last-child td` clears the
border by design.

**That explanation was itself a claim about a rule, so it was measured instead of argued.**
A three-row table rendered here and the prototype's seven-row table both report:

```
row 1  1px rgb(227, 229, 233)
row 2  1px rgb(227, 229, 233)
last   0px              ← both sides
```

The clearing is the same behaviour, measured on both sides.

**Every top-level screen, both schemes, six elements each** — `h1`, `.panel`, `.panel-title`,
`.table th`, `.table td`, the accent dot — come back identical:

| | dark | light |
| --- | --- | --- |
| `h1` | `rgb(231, 234, 238)` | `rgb(25, 28, 32)` |
| `.panel` | bg `rgb(20, 23, 27)`, border `rgb(36, 41, 48)` | bg `rgb(255, 255, 255)`, border `rgb(227, 229, 233)` |
| `.panel-title` | `rgb(164, 172, 183)` | `rgb(86, 93, 103)` |
| `.table th` | `rgb(118, 126, 138)` | `rgb(133, 140, 150)` |
| accent dot | `rgb(122, 162, 255)` | `rgb(47, 111, 237)` |

`issues` reports a different `.table td` colour than the other four because its first cell is
the id column, which takes `.t-id`'s secondary colour — by design, and the same in both
schemes.

**Three of the six elements do not exist on every screen, and the table above is not a claim
that they do.** `workflows` and `iterations` have no `.panel-title` (the prototype's own two
list screens have no panel head either — verified by reading their markup), and `projects`
has no table. Those cells came back `-`, which means *not present*, not *equal*. What was
compared on all five screens is `h1`, `.panel` and the accent dot; the rest was compared where
both sides had the element.

**The four detail screens, both schemes.** Each was probed on a record that exists:
`#issue/I-000870`, `#workflow/w-1`,
`#iteration/iter-1`, `#project/dsh-integration`.

| | workflow | iteration | project | issue |
| --- | --- | --- | --- | --- |
| `.detail-head h1` | ✓ | ✓ | ✓ | ✓ |
| `.panel` | ✓ | ✓ | ✓ | **absent** |
| `.panel-title` | ✓ | ✓ | ✓ | **absent** |
| `.table th` | ✓ | ✓ | absent | **absent** |
| `.field dt` | ✓ | ✓ | ✓ | ✓ |

Every cell that exists has the same pair of values as the top-level screens — `h1`
`rgb(231,234,238)`/`rgb(25,28,32)`, `.panel` border `rgb(36,41,48)`/`rgb(227,229,233)`,
`.panel-title` `rgb(164,172,183)`/`rgb(86,93,103)`, `.table th`
`rgb(118,126,138)`/`rgb(133,140,150)`, `.field dt` in the muted pair.

**The issue detail has no `.panel` because the prototype's does not either** — its blocks take
the `.sec` rhythm (a hairline above each, no card border), which is what rounds 140–141 changed
`fact-block` into. An "absent" cell here is a structural fact about the screen, not a missing
measurement.

**First probe of this round was invalid, and it was the id**: `#workflow/w-0`
is an `execution_workflows.workflow_id`, but the route takes the *catalog* id the list shows
(`w-1`). Every element came back `-`, which reads exactly like a
screen that renders nothing.

**Still not compared**: any pixel or screenshot diff. Every measurement in this file is a
computed style on a named element, which cannot see spacing, alignment or ordering.## The first side-by-side screenshot, and what it showed

Every measurement before this one was a computed style on a named element. Putting the
prototype's overview and this dashboard's next to each other at 1440px found something no
element probe would: **the shell**.

| | The prototype | This implementation, before |
| --- | --- | --- |
| brand | star svg + `.brand-name` "Morning Star" + `.brand-ver` "v4.0.9" | a single `.app-title` span — no mark, no version |
| footer | two lines: `26 open issues · 1224 store revision`, then `Read-only · Make changes with the CLI` | one line: `48 次存储修订`, then the read-only note |

The brand block is the prototype's now: the same 16×16 star path, `.brand-name`, and
`.brand-ver` reading `v{major.minor.patch}` — measured as `Morning Star` + `v4.0.9` with an
`svg` child.

**Still different, and not fixed**: the footer's first segment. The prototype opens it with an
open-issue count (`26 open issues`) before the store revision; this implementation states only
the revision. That needs the shell to see the overview's residual total, which is a data path
the shell does not have today.

**The general form**: nine screens of element measurements passed while the frame around all
nine of them was missing a mark and a version. **An element probe can only find what it is
told to look for**; the screenshot is what finds the things nobody named.

**Two of the three things that screenshot suggested were wrong, and checking cost one round
each:**

- *"The theme button is a gear, the prototype's is not."* The prototype's button holds two
  svgs — `.icon-sun` and `.icon-moon` — swapped by `[data-theme]`. The sun at 14px reads as a
  gear in a screenshot. This implementation's paths are **character-for-character the same**,
  under `.app-icon-*` names and `[data-ms-theme]`; the shapes match.
- *"The issues subtitle is `134open`."* That is `textContent` again. `.screen-meta` is a flex
  row with `gap: 6px`, and `copy.scope` already returns `134 open across 4 projects`, which is
  the prototype's own phrasing.

**What the issues screen did confirm**: seven columns (ID, Title, Project, Kind, Severity,
Disposition, Last activity), the trend panel above the filters panel, and the ordering line —
all matching.

**The footer's first segment is fixed.** The prototype opens with an open-issue count before
the store revision; this implementation stated only the revision. The shell already held the
single `useOverview(true)` read, so the total was one hop away — the footer now renders

```
"134 open issues · 48 store revision"      "Read-only · Make changes with the CLI"
```

which is the prototype's two segments in its order.

**And this took three builds to see, for the same reason twice before in this file**: the
first attempt rendered nothing, because `bun run --cwd packages/cli build` had exited 1 — the
dashboard JS was 161 bytes over its ceiling — and the page served the *previous* bundle. Every
measurement until the ceiling was raised measured the old footer.

**`check:stale` now covers that hop.** It already compared stylesheets against
`assets.generated.ts`; it also compares `assets.generated.ts`, `packages/cli/src` and
`packages/cli/web` against `packages/cli/dist/mstar-harness.js`. A build that failed leaves the
bundle older than its sources, and the check says which file and which command.

**The ceiling itself is now a measurement, not a ratchet.** 340 KB was tried and the bundle
came out 71 bytes over — so the raise to 344 is what the footer actually costs, and the
comment says so. The next thing to shrink is the locale table, which ships both dictionaries
in full.## The workflow detail, side by side

Four panels on both sides — `Execution`, `Catalog identity`, `Plans`, `Leases` — in that
order, with the two-column split above and the full-width table and card below. What differs:

| | The prototype | This implementation |
| --- | --- | --- |
| breadcrumb | none | `Workflows / <id>` |
| meta line | `plan · running · phase-2-execute · updated …` | `plan · running · updated …` — **no phase** |
| Execution rows | Type, Status, Phase, Started, Ended, Updated | the same six plus **an `id` row** the prototype puts in the title instead |
| Catalog identity | six rows, plus a `Pin` / `rev 3` chip and the description paragraph | six rows, no pin |
| Plans table | **seven** columns — the sixth is `Status · phase`, the seventh is `Pin` | five columns |
| Leases | a table, `2 active · exclusive` | **the table exists**; this record holds no leases, so it renders its empty line |

**The `Leases` difference was a reading error on my part.** The table, its five columns and
its count were all implemented; the screenshot showed a workflow with zero leases. That is the
same "data absence read as an implementation gap" this file names twice already.

**Two of those "gaps" were also readings, and one was real.**

`phase` in the meta line **was implemented** (`WorkflowDetail.tsx` renders it between the
status and the update time); the record in the screenshot has `phase: null`, so nothing
printed. The `Status · phase` merged cell **was implemented** too — the status column already
carries a `.chip` for the phase.

**The `Pin` column was real and is now shipped.** `catalogPinRevision` has been on the DTO
since the read was written and no plan row carried it. The table reads six columns in the
prototype's order now:

```
Plan · Title · Status · Progress · Done at · Pin
```

measured as `["计划","标题","状态","进展","完成时间","固定版本"]`, with `.t-num` on the last
cell — the prototype right-aligns it.

**The Catalog identity head is shipped too**, and it was two changes: the heading read
`Catalog` where the prototype says **`Catalog identity`**, and the head carried no pin state.
Both are there now — `.chip` "Pin" beside a mono `rev <n>`, shown only when some plan is
actually pinned.

Measured on the one workflow in this store that has a pinned plan:

```
heading: "目录身份"
meta:    "固定 · 修订 1"
Pin列:   ["1"]
```

**That measurement needed a different record to exist at all.** The first workflow tried has
no pinned plan, so the chip correctly rendered nothing — which reads exactly like a missing
chip. `projection_plans` holds **1 pinned plan out of 5**.

**Still open**: the Catalog identity panel's description paragraph (that record's
`description` is null in this store, so it renders its absent line).

**A second, quieter lesson**: this round also fixed `check:stale`'s own silent pass — a
checkout with no `dist/mstar-harness.js` exited 0 with a log line, which is the exact state the
check exists to catch. It warns now, and fails under `STRICT_STALE=1`. `verify:visual` is one
command that runs it before any browser measurement.## The iteration detail, side by side

Five panels on both sides, in the same order: `Catalog identity · Execution · Compass · Plans ·
Documents`, with the first two in a two-column row above the rest.

**Two differences found and fixed:**

- the first panel's heading read `Catalog`; the prototype says **`Catalog identity`** — the
  same word it uses on the workflow detail, and the same mistake
- the heads were missing two meta segments: the Catalog chip (`active registration`) and the
  Plans count (`3 plans`)

Measured after: `["目录身份","执行","罗盘","计划","文档"]` with metas
`["completed · started …", "0 plans", "4 documents"]`.

**The Catalog chip renders only when the store still counts the registration**, and this
record's value is `false`, so three metas show where the prototype's screenshot has four. The
condition is right; the data is absent.

**That field was deleted two rounds ago as unread** (`IterationDetailModel.workflowActiveRegistration`).
It is back, and read, because the prototype's Catalog head states it — which is the honest
shape of that earlier deletion: "nothing reads it" was true, and "nothing should" was not.

**Also caught here**: the EN check that closed the previous round's loop read
`Catalog identity` / `Pin` / `rev 1`, so both dictionaries were verified, not only `zh`.## The project detail, side by side

Four panels on both sides, same words and order: `Catalog identity · Roadmap authority ·
Milestone board · Stored facts`, with the same `3 milestones · 3 unassigned issues` meta
shape (counts differ with the data).

**One difference, and it is not fixed**: the prototype's three feature tabs each carry a
count — `Roadmap 3`, `Issues 14`, `Iterations 2`. Only the roadmap tab does here.

**Fixed — and the first attempt at it is worth recording.** A callback from each list (report
its total when the read settles) rendered nothing, because **the lists only mount inside their
own tab**: on Roadmap nothing mounts `IssueListScreen`, so no read happens and no total is ever
reported. A tab count has to be known *before* the reader opens that tab.

So the reads moved up instead. `useIssues` takes an `enabled` flag and the iterations read
became a `useIterationsRaw` hook beside it; `ProjectDetailDestination` calls both, derives the
counts, and hands the same outcomes down to the lists — one fetch per list, two consumers.
Measured on two projects, because one zero is not evidence:

```
dsh-integration   ["路线图1", "问题19", "迭代0"]
_default          ["路线图",   "问题102", "迭代2"]
```

`dsh-integration` really has no linked iteration — `catalog_links` holds **2** `belongs-to`
iteration→project links in the whole store, and none of them point at it. `_default` carries
both, and its tab reads `Iterations 2`, which is the prototype's own number.

**The count is the project's size, not the list's filter result.** The prototype's tab reads
`Iterations 2` whatever the table below is filtered to, so the host derives it with the
default filters while the list keeps its own live ones — deliberately different inputs, and
the comment in the code says which is which.

**A first attempt at this lift was reverted.** It edited four files in one pass, put the
`outcome` prop on the wrong component, and never reached a green typecheck; the revert cost
one round. The version that worked did it one edit at a time with `tsc` after each.

**The Catalog chip's `true` branch is now tested.** Every check before this one — including
the browser — had only ever rendered the `false` case, so a chip that was always on would have
passed. `iterations-screens.test.tsx` now asserts `>active registration<` appears for a
registration the store counts and does not appear for one it does not.## The issue detail, side by side

Nine fact blocks in the prototype: `Identity · Source · Impact · Acceptance · Occurrences` in
the left column, `Disposition history · Relations · Provenance · Identity keys` in the right.
This screen renders **seven headings**: the two that do not appear are `Disposition history`
and `Relations`, and both are implemented — this record has no transitions and no relations.

**Two findings survived checking:**

| | The prototype | This implementation |
| --- | --- | --- |
| fact block heading | `<h2 class="sec-title">` | `<h3>` — same styling, different element |
| left column order | Identity, **Source**, Impact, Acceptance, Occurrences | Identity, Impact, Acceptance, **Source**, Occurrences |

Both are fixed now. `FieldGroup` renders `h2`, and the left column measures

```
["identity", "source", "impact", "acceptance", "occurrences"]
```

which is the prototype's order.

**And the order holds at every width**, measured at four viewports:

| Viewport | Columns | Left-column order | Horizontal scroll |
| --- | --- | --- | --- |
| 1440 | 2 | identity, source, impact | none |
| 900 | 2 | identity, source, impact | none |
| 720 | 1 | identity, source, impact | none |
| 375 | 1 | identity, source, impact | none |

The split's collapse point is what the prototype's own `@container (width<=899px)` gives —
two columns down to 900, one below.

**The move took two attempts and one mistake worth recording.** The scripted version hit its
own assertion and left the file untouched — the safe outcome. The `edit` version inserted the
block before `impact` and **forgot to delete the original**, so the file briefly carried two
`Source` panels; `grep -c data-ms-issue-source` reported `2` and the duplicate came out. A
copy-then-delete edit has to prove both halves.

**Reading the seven against the nine is a trap worth naming**: two absent headings look
exactly like two missing panels, and only opening the record proves otherwise. That is the
fifth time this file records the same misreading.## Responsiveness, measured on every screen

The acceptance bar names adaptivity explicitly, so it was measured rather than assumed: for
each of the nine screens, every element compared against **its own parent's** right edge —
not the viewport's, which a horizontally scrolling table never exceeds. Scroll containers
(`.table-wrap`, `.chart-wrap`, `pre`) are excluded because overflowing inside them is what
they are for.

| Viewport | Screens checked | Elements overflowing a parent | Whole-page horizontal scroll |
| --- | --- | --- | --- |
| 375 | all nine | **0** | none |
| 720 | five | **0** | none |
| 1440 | five | **0** | none |

Zero at every width on every screen, with the tables scrolling inside their own frames rather
than pushing the page.

**This is a coarse instrument and it is worth saying so**: it catches an element that leaves
its parent, not one that is merely crowded, misaligned or in the wrong order. The finer
checks in this file — the split's collapse point, the milestone row's two lines, the chart's
ratio — were each measured by hand because this sweep cannot see them.## Panel positions, measured rather than overlaid

An overlay of the two light-mode overviews was tried first and was not usable: the prototype
carries a 36px `.proto-bar` above its own header, and hiding it reflows everything while
removing it does not. Two screenshots half-blended show a difference and cannot say which one
caused it.

Measured instead — every `.panel`'s top edge, both sides, light mode, 1440:

| Panel | The prototype | This implementation |
| --- | --- | --- |
| Active workflow | 92 | **92** |
| Open residual issues | 92 | **92** |
| Milestones | 315 | **314** |
| Issue flow trend | 458 | 281 |
| Latest iteration | 657 | 535 |

The two that agree are the ones whose content is the same height. The two that differ are the
ones below the plan table — the prototype's holds **seven** plans, this store's holds **one**,
and every panel beneath inherits that difference. That is data, not layout.

**One 14px reading that was a measurement artefact**: `.screen`'s own top edge differs by 14
between the two (44 against 58), because the prototype puts that 14px of gutter on `<main>`
and this implementation puts it on `[data-ms-screen]` as padding. The *content* starts at the
same y — which is why both first panels measure 92.

**What this cannot see**: horizontal alignment, gaps between siblings, and whether an element
draws the right border. Those were measured separately (the four-width overflow sweep, the
declaration diff), and nobody has yet compared the two pages as pixels.## The workflows list, side by side

Six columns on both sides, same words and order — `Workflow · Catalog title · Status · phase ·
Root register · Projected updated · Join badges`.

**The head was missing its whole meta line.** The prototype's reads

```
4 workflows · 2 active registrations · projected from store rev 1224
```

and this implementation printed only `Workflows`. All three segments are there now, measured
as `5 workflows · 5 active registrations · projected from store rev 4905`. Two of them come
from the list model (`total`, and a count of `activeRegistration` rows); the third does not —
`storeRevision` belongs to the read envelope, not to any workflow, so the host passes it in
and the segment is left out when the host cannot state it.

**This was found by reading the two heads as text**, which is what the panel-and-position
comparisons could not do: the head is inside `.screen-head`, not a `.panel`, so every earlier
sweep walked past it.

**The same defect was in the other two lists**, and only because the first one was found:

| Screen | The prototype | Now |
| --- | --- | --- |
| Workflows | 4 workflows · 2 active registrations · projected from store rev 1224 | 5 workflows · 5 active registrations · projected from store rev 4905 |
| Iterations | 4 iterations · 1 active · catalog membership, independent of execution | 60 iterations · 49 active · catalog membership, independent of execution |
| Projects | 4 projects · 26 open issues · a project owns its roadmap, issues and iterations | 4 projects · 133 open issues · a project owns its roadmap, issues and iterations |

Each head's third segment is a **fixed sentence** stating what the noun means here — not a
count, and not a string the screens can derive. The first two are counts, and their sources
differ: workflows reads `total` and counts `activeRegistration` rows; iterations reads `total`
and counts `lifecycle === "active"` (the catalog's lifecycle, not the execution state — an
iteration whose workflow stopped is still an active registration); projects reads `total` and
sums `openIssues`.

**Three screens, one class of defect, found once by reading text.** The panel sweeps, the
coordinate comparison and the four-width overflow check all passed while an entire meta line
was missing on three screens.

**Both branches are tested** for the one segment that can be absent: `storeRevision` renders
`projected from store rev <n>` when the host states it and is omitted — not guessed — when it
does not.## Screen chrome: what the panel sweeps could not see

Every check in this file until now started from `.panel`. The heads, breadcrumbs and meta
lines live outside panels, and three of them were missing whole segments. Reading the nine
screens' chrome as text found them:

| Screen | The prototype | Before |
| --- | --- | --- |
| Workflows | 4 workflows · 2 active registrations · projected from store rev 1224 | `Workflows` |
| Iterations | 4 iterations · 1 active · catalog membership, independent of execution | `Iterations` |
| Projects | 4 projects · 26 open issues · a project owns its roadmap, issues and iterations | `Projects` |
| Issue detail | I-000870 · mstar-harness · critical · bug · open · Revision 4 | `high` `open` — **two segments of six** |

The issue detail's meta now reads `I-000870 · dsh-integration · high · bug · open`. Its sixth
segment, the catalog revision, is still missing: the model carries no revision for an issue.

**One more reading that was not a defect**: the iteration detail's `<h1>` renders
`iter-1 Delivery Compass`, which looks like a title and something else
concatenated. It is one string — a title in this store's own data. Checking the store was one
command and settled it.

**And the ceiling bit again.** The build failed on `352268B` against `352256B` — twelve bytes
over — so the first measurement of the new meta line was of the *previous* bundle and read
`highopen`. Fourth time. The budget is now 348 KB with a comment saying that it is the
tightest thing in the build and that it has silently reverted measurement work four times.## Labels, compared as text

The chrome sweep found missing *segments*. This sweep compared the labels themselves: every
heading, panel title, column header, button and chip on both sides, as text, in `en`.

**Two labels were wrong and are fixed:**

| | The prototype | Before |
| --- | --- | --- |
| the overview plan table's completion column | `Done` | `Completed` |
| the residuals panel's title | `Open residual issues` | `Open residuals` |

`Done` is also a status enum value, which this codebase's locale test forbids as a label —
that rule exists to stop a translated enum leaking into the UI. It has a narrow exception now,
with the prototype's own heading as the reason.

**Citations, since one of these was argued from a test rather than the source**:
`design-v1.html:953` is `<span class="panel-meta" data-t="ov.bySeverity">by severity</span>` —
the panel's own head, four lines under the `<!-- residual issues by severity -->` comment at
949. The `2424-2434` range this file cites elsewhere is the severity **tally inside** that
panel, which is a different element.

**Two differences that are deliberate — and both are now fixed instead:**

- The residuals panel's meta read `134 open · all projects`; it now reads **`by severity`**,
  which is what the prototype states at `design-v1.html:953`
  (`<span class="panel-meta" data-t="ov.bySeverity">by severity</span>`, four lines under the
  `<!-- residual issues by severity -->` comment at 949). The count was redundant — every
  number it repeated is already inside the panel, five severity rows with their own totals.
  The `2424-2434` range this file cites elsewhere is the severity **tally inside** that panel,
  which is a different element.
- The overview head's third segment is a clock — `All projects · 134 open issues · 14:30:35`
  against the prototype's `All projects · 26 open issues · 13:58:04`. **I first recorded this
  one as impossible and was wrong**: the read's clock does reach the screen, as
  `model.projection.checkedAt`, which the identity line at the bottom already prints as
  `read 14:30:35`. The head simply was not reading it. It is the read's own clock, not the
  paint time, so the value is stable and means what the prototype's means.

**One difference that is data**: `1 plan · running` against `7 plans · running` is this store's
plan count, not a label.

## The four detail screens' chrome, compared

The same text sweep over the detail screens — every heading, panel title, chip and meta
segment — against the prototype's own reads.

| Screen | The prototype's meta line | This implementation |
| --- | --- | --- |
| Workflow detail | `issue-project-move` · `plan · running · phase-2-execute · updated 2026-10-25 13:58` | same shape (phase absent when the row has none) |
| Iteration detail | `iter-…` · `active` · `compass active` · `3 plans` · `5 documents` | `completed · started 2026-08-11` — **two of five segments** |
| Project detail | `engine` · `active` · `Revision 12` · `14 open issues` | `_default · active · Revision 1` — the fourth segment exists in the code and this record's value is `null` |
| Issue detail | `I-000870` · `mstar-harness` · `critical` · `bug` · `open` · `Revision 4` | `I-000870` · `dsh-integration` · `high` · `bug` · `open` — **five of six** |

**One of the two gaps is fixed**: the issue detail's meta now reads
`I-000870 · dsh-integration · high · bug · open · Revision 1` — six segments, as the
prototype's six. The value was already on `IssueDetailDTO`; the view model had an old note
saying revisions were not carried, and a test enforced that note rather than the prototype.
Both are gone, and `revisionLabel` is a locale key.

**The other is not**: the iteration detail's `compass active · 3 plans · 5 documents`. The
`plans` and `documents` counts exist on `IterationDetailModel`; the banner that would state
them does not, and that is a rendering change plus one new field, not a data gap.

**The project detail's fourth segment is not a gap**: the code renders it whenever the record
has an open-issue count, and `_default` has none. The prototype's screenshot happens to be a
project that does.## The exhaustive label diff, and what it left

Nine screens, both sides, every heading, panel title, column header, button, chip and meta
segment — exported as text in one pass and compared, rather than screen by screen.

**Fixed from it:**

- `iterations`' first column reads `Catalog title`, not `Title` — and the whole header row is
  now `Iteration · Catalog title · Lifecycle · Projected execution · Plans · Documents`,
  matching the prototype column for column
- the plan tables' last dated column reads `Done at`, not `Completed`

**What the diff still reports, and why none of it is a styling gap:**

| Reported | Why it is not a gap |
| --- | --- |
| `26 open…` against `134open…`, `4 workflows` against `5 workflows`, dates, ids, titles | the two sides render different data |
| `plan·running` against `plan · running` | `.detail-meta` has `gap: 6px`; `textContent` has no separator. Measured, not assumed |
| `Date / Captured (cumulative) / …` only on this side | these are the chart's `aria` table headers inside `<details>`; the prototype's chart carries no table |
| `Previous / Next` only on this side | the prototype's list is a fixture of 26 rows; this store pages |
| `engine` / `Open project` / `active` / `Open iteration` only there | the prototype's overview links to a project and an iteration; those are per-row data here |
| `phase-1-direction`, `Pin rev 3`, `2 active · exclusive` | one record's fields, absent on the other record |

**What it found that is real and remains**: the workflow detail's `Pin rev 3` chip is on the
Catalog head — measured working on the one record that pins something — and the Leases table
renders only for a workflow that holds leases. Both are already implemented; this store has
one pining record and no leased workflow.

## The narrow gutter, which is where the 375px overflow actually came from

The prototype's `@media (max-width: 860px)` block carries three rules. Two were ported —
`.app-header`'s padding, and hiding the version, the segmented control and the project select.
**The third was not**: `.dash-main { padding: 12px }`, which in this implementation is the
screen frame's own padding.

So below 860 every screen here was **16px narrower than the prototype's** — 335 against 351 at
375 — and that is why the head's meta line truncated a segment earlier. Measured after the fix:
`headW: 351`, identical to the prototype, and the overflow sweep is zero at 375 and 1440 on all
nine screens.

**Both sides still truncate that line, and that is correct**: the prototype's `scrollWidth` is
448 against a 351 container, this implementation's 366 against 351. The prototype's sentence is
longer in English, so it loses more. What matters is that the container is the same width and
the same rule clips it.

## The container query was NOT dead CSS — and I said it was

**The correction first.** `.ms-container` has carried `container: pane / inline-size;` since
the stylesheet was written. `container-type` was never missing, every `@container` rule has
always applied, and the one narrow-layout defect found at 375 is a real layout overflow, not a
stylesheet that never ran.

**Why I got it wrong**: I grepped for `container-type` and `container-name` as separate
properties and found neither, because the rule uses the `container` **shorthand**. Two greps
that both missed is not two pieces of evidence; it is one wrong method applied twice.

**What the mistake cost**: a duplicate declaration added to `.ms-container`, a comment
rewritten to contradict the code, and a test asserting the container was unnamed while the
source names it. All three are reverted or corrected.

**What survived**: the fact that a container query with no container is silent dead CSS is
still worth a test — it is just not this file's bug. `tokens.test.ts` now asserts the shorthand
exists and that the *queries* stay unnamed (a CSS-module bundler hashes a named prelude, which
can never match a global declaration).

## The container query was dead CSS

`product.css` carries narrow-width rules — the split collapsing under 900, the chrome stacking
under 480 — and every one of them is an `@container` query. **A container query does nothing
without a container**, and `.ms-container` declared no `container-type`. So on the dashboard,
every one of those rules had never run.

The dsh pane had `container-type: inline-size; container-name: pane` on its own wrapper, so
the same rules worked there and not in the dashboard — the two hosts render the same
components and were reflowing differently.

**How it surfaced**: a zh-locale overflow sweep at 375 found one element
(`.screen-meta > span`, the projects head's closing sentence) 31px outside its parent. The
truncation rule for exactly that element already existed in `product.css`, under
`@container (max-width: 479px)`. It was dead.

Two lines in `base.css` fixed it, and the whole narrow behaviour came with it:
`container-type: inline-size` (unnamed — a named prelude gets hashed by the CSS-module
bundler and can never match a global declaration) and `min-inline-size: 0`.

**The comment had promised a test for both halves and no test existed.** `tokens.test.ts`
keeps them now: the declaration present, the name absent, the min-inline present.

**And `getComputedStyle` lied about it, twice.** With the fix built, it still reported
`container-name: pane` — a value that exists nowhere in the repository, nowhere in the built
assets, and (finally verified) nowhere in the **served** CSS, which is fetched with the
dashboard's own token and contains `container-type` once and `container-name` never. Enumerating
`document.styleSheets` came back empty too, so the source of that value was never found;
reloading the page did not clear it and a cache-busting query string broke the hash router.

**So the selector-level truth came from `curl`, not from the browser**: the served stylesheet
is the one that was just built. Any measurement taken after that point is of current CSS,
whatever `getComputedStyle` says about a property the served sheet does not set.

**The probe was wrong twice before the CSS was.** The first version flagged elements inside
`overflow: hidden` parents as overflowing — a clipping parent is not a broken layout. The
second excluded only `overflow-x: auto`. With the fix in, all nine screens measure zero at
375, 720 and 1440 in Chinese, and zero again in English.

**This is the only defect in this file that a text diff could not have found**: the markup was
right, the stylesheet was right, and the missing declaration was in a third place that neither
comparison reads.## The sweep is a script now, and it fails

The overflow sweep has been run by hand a dozen times in this file, twice with a bug in the
probe and **once with a probe that returned nothing at all** — an eval that failed printed
empty `over:` fields, the run looked like three clean lines, and only a second run with
different formatting showed it had measured nothing.

`packages/ui/scripts/responsive-sweep.sh` is that sweep, nine screens by three widths, and it
exits non-zero unless **every** screen answers with parseable JSON carrying `over: 0` and no
sideways scroll. A silent probe is a failure, not a pass. Run it as
`check:responsive <base-url>`.

**The verification rules this file has earned, collected:**

- a measurement is only as good as the build (`check:stale`, now covering the compiled bundle)
- a class name is not a stylesheet (`check:classes` found `fact-block`)
- a text comparison against `textContent` proves nothing about spacing (`gap` renders as no
  whitespace; three separate "defects" were this)
- a probe that returns nothing is not a probe that found nothing (this section)
- a grep for one spelling is not a search: `container-type` was in the tree the whole time,
  inside a `container:` shorthand
- parity is not exhausted by the checks you have written; every round of looking found
  something the last round's method could not see## The declaration diff could not see a breakpoint

`check:declarations` compared declarations between the two sheets with a regex —
`([^{}@]+)\{([^{}]*)\}`, "a selector, a brace, declarations, a brace". That form **cannot
see an at-rule prelude**: `@container (max-width: 479px) { .x { … } }` has two opening braces,
so the inner rule matches and the prelude is dropped. Every declaration inside every
breakpoint block was being compared as though it sat at top level, where it overwrote the
same selector's wide-layout declarations.

**The tell was that the script's own verdict did not say how much it had looked at.** It does
now:

```
every shared declaration matches the prototype — 313 shared selectors,
193 of them inside a breakpoint block
```

Before the fix the same sentence printed with **0 inside a breakpoint block**. Both sheets
have eleven at-rules; none of them had ever been compared.

**It is a block scan now**, with the at-rule context carried down by recursion and the
prototype's named prelude (`@container pane (…)`) normalised to the anonymous form this sheet
uses.

**And the first block scan was still wrong**, in a way its own coverage line could not show.
It pushed the at-rule onto a stack and then advanced past the block, so the declarations inside
were never visited — while the keys it printed carried the `@container …` prefix and the
coverage line said `193 of them inside a breakpoint block`. Those 193 keys existed; their
values were the top-level rule's.

**What caught it**: introducing a deliberate error. Changing the 479 block's `flex-wrap` to
`wrap` produced a clean run. A check you cannot make fail is not a check. Fixed, the same
error is named exactly:

```
@container (max-width: 479px) .screen-meta { flex-wrap: nowrap }   ours: wrap
```

Real coverage: **391 shared selectors, 70 inside a breakpoint block**, all matching. The `193`
was arithmetic over keys that had been stamped with a prefix they never earned.

**This is the fourth check in this file whose coverage was smaller than its verdict suggested**
— after `check:stale` (stylesheets only, not the compiled bundle), `check:classes` (a class
present as a substring in a selector it never renders for), and the overflow sweep (a probe
that returned nothing). The pattern is the same each time: **a check that reports a pass tells
you nothing about how much it checked**, unless it says so.## Can each check be made to fail? Three of four, and one could not

After the declaration diff was caught claiming `193 inside a breakpoint block` while comparing
none, every check was mutation-tested: introduce a real defect, confirm the check names it.

| Check | Injected | Named it? |
| --- | --- | --- |
| `check:tones` | a `.tone-danger .dot` colour changed | **yes** — `2 tone colour(s) disagree` |
| `check:declarations` | a breakpoint's `flex-wrap` flipped | **yes** — names the `@container` and the property |
| `check:classes` | `.res-grid` renamed everywhere | **yes, but it took four attempts to inject** |
| `check:selectors` | an allowlist entry removed | **yes** — `10 prototype selector(s) are neither defined nor explained` |

**`check:classes` was hiding a real blind spot**, and the failed mutations are what found it:
`sheets.includes(".res-grid")` is also true when the only rule carrying that spelling is
`.res-gridZZ` — a substring, not a class. Renaming a class to one that merely starts with the
old name passed. It matches on a word boundary now.

**The failed injections were my error five times over** — I renamed one of three occurrences,
then all three in one file while a fourth sat in `base.css`, then read `$?` after an `echo`,
then read it after a pipe (`| tail` reports *tail's* status), then added a prototype selector to
our sheet and expected a check that looks for the opposite direction to complain. Each time the
check was right and the experiment was wrong. That is worth stating plainly:
**a check that will not fail is a finding, and so is a check that will not be made to fail.**
The difference is whether the injection actually landed — and the only way to know is to look
at what the check read.

**The suite is a script** — `check:mutation`, four injection cases, each restored from a trap
so a mid-run failure cannot leave a mutated file behind. It passes when every check reports its
own defect.

**And `check:selectors` only guards one direction.** It flags a prototype surface this product
lacks; it says nothing about the 70 selectors this sheet carries that the prototype does not
(`.absence-*`, the chart frame, the dsh pane body, and the rules added to fix real defects).
Those are legitimate, so the count is **reported** rather than failed — but the asymmetry is now
visible in the output instead of being an assumption.

**Exit codes are read directly now** (`OUT=$(…); CODE=$?`, never `… | tail; echo $?`), because
a pipe reports the last process's status and `tail` succeeds no matter what failed upstream.
Two of the five bad injections were that mistake alone.## One dead rule, and the asymmetry that hid it

The 69 selectors this sheet carries that the prototype does not were audited by usage. Four are
live (`.ms-pane-body` and `.ms-pane-head` are exported constants the dsh pane names,
`.row-tall` and `.row:not(tr)` are the row primitive's two forms) and **one was dead**:
`.goal-list`, a rule for a roadmap list that no longer exists, carrying a comment about a bug
it once fixed.

**`check:classes` could not see it, and its name is why.** It fails when a component names a
class the sheets never define — "dead classes" read as *classes with no stylesheet*, which is
the opposite of *a rule nothing selects*. Both are dead in their own way; only one was checked.

The script measures the other direction now behind `SHOW_UNUSED=1`, and reports 118 — all but a
handful false, because the hosts in `packages/cli/web` and `packages/dsh` name classes this scan
does not read. **It is a measurement, not a gate**: wiring it in would fail on the hosts it
cannot see, and a check that cries wolf is worse than one that says less.## The narrow header: three items, not four

The prototype hides its scope select, its language group and the read-only note below 860 and
keeps the theme button (`design-v1.html:742-745`). This implementation kept all of them, with a
comment arguing the opposite:

> They wrap instead of disappearing at a narrow width, because a control a reader cannot reach
> is not a smaller control but a missing one.

That is a good argument and it is not this bar. At 375 the extra items pushed the screen title
under the header band — the controls sat *on top of* the heading, which is what the screenshot
showed and what no text diff could.

Below 860 the header now carries what the prototype's does: the brand, the nav, the theme
button. The language choice stays reachable in the wide layout and through the stored
preference.

**One thing that was not a defect, and the fix for it was reverted**: the title measured 32px
wide and looked squeezed to half of `Overview`. It was rendering `总览` — two characters, 32px,
its real width. The screenshot that started the chase was in English.

The `flex: none; white-space: nowrap` added to `.screen-head h1` for that phantom bug is gone
too, and this is the part worth keeping: **it shipped before anyone noticed the bug did not
exist**. Reverted, the rule is character-for-character the prototype's again, and `Overview`
measures 70px at 375 with 281px of room to spare — no squeeze, no overflow. A change made for a
defect that is not there is not harmless: `nowrap` on a long title would have overflowed the row
the prototype's own flex item shrinks in.

**A measurement is of the thing you measured**; the same selector in another locale is a
different number and a different question.## The issues head could not state its span

The prototype reads `26 open across 4 projects · severity desc, …`. This implementation read
`134 open · severity desc, …` — the span was simply absent.

**It was derived from the page, and the page is not the result set.** `projectCount` was
`new Set(items.map(projectId)).size` when the read happened to be complete and `null`
otherwise, so a paged list — which is every real list — printed no `across N projects` at all.

The read states it now: one `count(distinct project_id)` beside the existing `count(*)`, in
both readers, and `IssuePage.projectCount` in the DTO. Measured: `134 open across 5 projects`.

**The lesson is the same one the panel sweeps taught, in a different place**: a fact derived
from the rows on hand is only true when the rows on hand are all of them, and nothing in the
type says which case you are in.## Two real defects found by fixing a test

The engine suite had two failures after the overview DTO gained `projectId`. Neither was
caused by that change, and both were real:

**1. The relations query never selected a title.** `issue.ts` read relations with

```sql
select from_issue as fromIssue, relation, to_issue as toIssue from relations where …
```

and asserted the result as `IssueRelation[]` — a type that declares `title: string | null`.
The cast made the compiler quiet; the value was `undefined` on every row, so the prototype's
`Relations` table had an empty `Title` column whenever the CLI read path answered. The
dashboard's own reader in `store-read.ts` had the correlated subquery all along. Both do now.

**2. A test asserted the aggregate was five members.** The prototype's Milestones head states
the project the milestones belong to (`engine`), so the DTO carries `projectId` beside the
five. That is a sixth key, and the contract test now says six.

**And the milestones panel had never rendered its project.** The prototype's overview says
`All projects` in its head and `engine` on the Milestones panel — milestones are a project's,
not the store's, so the read names one. This implementation asked for none, the member came
back `not-applicable`, and the panel showed its absent arm on every load.

The shell now passes the first project the store holds, the read is scoped to it, and the head
states it: measured `["Milestones", "engine"]`, the prototype's own word.

**Two things this took**: the query parameter is `project`, not `projectId` (the first attempt
used the wrong name and the API ignored it), and the head states the project whether or not the
member resolved — a panel with an absent arm still belongs to a project, and the prototype's
head says which.

**Why this is worth writing down**: the failing test was the only thing that surfaced either
defect, and it surfaced them *while I was changing something else*. A suite that is green for
long enough stops being read; the two red rows here were doing their job and nobody had asked
them to.## Six host tests had been red, and every one was a stale §8.1 assertion

`packages/cli/web` carried **six failing tests** — not caused by any recent change; they had
been red long enough that I stopped reading them. All six asserted that a §8.1-removed fact was
**absent**, and the prototype renders every one of them:

| Assertion | The prototype |
| --- | --- |
| no lease / pin badge on the workflow detail | `Leases` and `Pin rev 3` (`design-v1.html`) |
| no document inventory, no revision on an iteration | its plan table has a `Documents` column; its detail a Documents panel |
| no occurrence row or history on an issue | `Occurrences` and `Disposition history` |
| no native `<select>` in the shell | `<select class="ctl" aria-label="Project scope">` at `:800` |
| the detail renders `PR delivery` | this fixture's gate has three reached steps, so it renders three |
| no `k1` occurrence key and no `revision` | both are in the prototype's issue detail |

**Each was checked against the prototype file before the assertion moved** — six greps, all
non-zero. An assertion is evidence about a decision someone made, not about the product; when
the decision is reversed, the assertion is the thing that is now wrong.

**One was skipped for a round, then fixed properly.** The iteration detail's gate-position
test passed a `{ step, steps: [...] }` object cast with `as unknown as IterationDTO["gateStep"]`.
The store's member is an integer `1 | 2 | 3 | 4`. The cast silenced the shape, so
`gateStepPosition` resolved `null` for a fixture that looked like a compass and the panel
rendered nothing — and the assertion had been written against `data-ms-gate-steps`, which is
the **overview's** track, not this screen's chip.

Fixed: the fixture is `4`, the assertion is `step 4 of 5`, and the test is un-skipped.
`packages/cli/web` is **153 pass, 0 fail, 0 skipped**.

**A cast is where a shape stops being checked.** That one hid a stale fixture for as long as
the test was red, and the red row was read as noise.## Three things the workflow detail screenshot confirmed

Rendered at 1440 / dark / en, beside the prototype's own: the four panels, the `Pin rev 1`
chip on the Catalog head, the `Pin` column at the table's right edge, and `0 active · exclusive`
on an unleased workflow. The structural work of the last twenty rounds is visible in one frame.

**Three differences, each checked and each deliberate:**

- **The breadcrumb was NOT a difference — I said it was, and the prototype has four.** The
  workflow detail's crumb was already the prototype's own shape (`<div>`, a link back, `/`,
  the record in mono). The **issue** detail's was incomplete: it rendered the section link and
  stopped, so the reader lost which record the page was about. Measured after the fix:
  `Issues / I-000870`, which is `design-v1.html:1355`'s own crumb.

**All four crumbs now carry the record's id.** Checked one by one: workflow-detail, iteration-detail
and project-detail were already complete (`<div>` or `<nav>`, a link back, `/`, the record); only
issue-detail stopped after the link. A difference found on one screen is a question to ask of the
other three, not a conclusion about them.
- **No description paragraph under Catalog identity.** The prototype's record has one; the one
  measured here has `description: null`, and the screen renders its absent line. Data.
- **`1 plan` against `7 plans`.** Data.

`gateStepPosition` survives its test fix: it is still called by `focus.ts` and `overview.ts`,
which is the point its own comment makes — the store's integer is the one derivation, and this
helper only formats it.

**There are no skipped tests left in the tree**, which is worth stating because a skip reads
like a decision and is usually a deferral.## Round accounting, corrected

Two recent reports said "round 230, 21 left". The goal's own counter says **225 started of
256**, so **31 remain**. The drift came from counting my own narration instead of reading the
counter, which is the same mistake as measuring the page instead of the build. The counter is
the authority; `get_goal` is one call.

## The project detail frame

Rendered at 1440 / dark / en: the crumb `Projects / _default`, the head, the two panels
(`Catalog identity`, `Roadmap authority`), and the three feature tabs **with their counts**
(`Roadmap`, `Issues 102`, `Iterations 2`) — the prototype's own arrangement, including the tab
counts added forty rounds after the tabs themselves.

The Roadmap body is its `not declared` arm because `_default` has no roadmap file. The prototype
screenshot is a project that has one. Data, not layout — the same distinction that has now been
the answer to four separate "missing panel" reports.

## The sweep now remembers how much it looked at

`check:responsive` prints, on every clean run, how many elements it evaluated per screen per
width — and compares that against a **committed** baseline (27 entries,
`scripts/responsive-baseline.txt`). A run that sees fewer than two thirds of the baseline fails:

```
FAIL 375 overview: probe saw 282 elements, baseline 2820
```

**Committed, not temporary**: a temp file makes every clean clone's first run a "first run", so
the comparison would never fire where it matters most.

**It took three corrections, all mine, all caught by running it:**

1. the `BACKUP` line I matched against in the previous round **did not exist** — I wrote the
   pattern from memory;
2. `printf '%s %s\n'` reached the shell as a literal `\n`, because my own escaping doubled it;
3. my first attempt to prove it could fail **poisoned the baseline downward** (5 against a real
   282) and the run correctly passed — the check only fears a probe that looks at *less*.

**The direction is the point.** A probe that sees more than before is a page that grew; a probe
that sees a third less has lost the page, and "over 0" then means the sweep measured a blank.

## "Narrow" is not a width

The workflows table, measured at three containers on the same build:

| Container | Visible columns |
| --- | --- |
| 1440 | 6 — `Workflow · Catalog title · Status · phase · Root register · Projected updated · Join badges` |
| **720** | **6 — unchanged** |
| 375 | 3 — `Workflow · Catalog title · Status · phase` |

I had written, the round before, that `Join badges` "does not exist on narrow screens". It does at
720. The rule is the prototype's own (`[data-narrow-cols="3"] … :nth-child(n+3)`), the collapse
point is a container width, and **a claim about narrow screens without the width is a claim no
measurement can contradict** — which is why it survived a round.

That is the third statement in this file that a measurement has corrected after I wrote it: the
breadcrumb prototype that "had none" (it had four), the title that "was squeezed" (it rendered
`总览`), and now this.

## One real difference, found last, not yet fixed

The narrow column sets, measured against the prototype's own `data-narrow-cols` and against this
build at 375:

| Screen | The prototype | This build | |
| --- | --- | --- | --- |
| issues | `2` | 2 | same |
| iterations | `2` | 2 | same |
| workflows | `2` | 2 | same (fixed) |
| projects | no table | no table | same |

The prototype keeps two columns and hides the rest (`[data-narrow-cols="2"] … :nth-child(n+3)`).
This build keeps three: `primaryCount` is `6 − 3 secondary = 3`, and `status · phase` is a
primary column, so it survives.

**The two implementations mean different things by "narrow", and that is why this is not a
one-line fix.** The prototype *hides* the columns it drops. `DataTable`'s `secondary` columns
*yield* — in `list` mode their fact reappears in the row's `meta` line, and only in `detail`
mode are they dropped outright. Making `status` secondary would move it to a second line rather
than remove it: **different from the prototype, and arguably better for a reader.**

**Fixed**: `status` is `secondary` now. Measured after — 1440 keeps its six columns, 375 shows
two (`Workflow`, `Catalog title`), which is the prototype's `data-narrow-cols="2"`.

**It took three attempts, and the first two were wrong in opposite directions.**

1. `secondary` — I judged it wrong because `secondary` "moves the fact to a second line".
   Measured at 800 it was right; I had verified only 1440 and 375.
2. `wide` — its rule fires at **899px**, so 800 lost the column while the prototype still
   showed six. Verified at 1440 and 375 only, again.
3. `secondary`, again — with all six widths measured:

| Width | 1440 | 1000 | 900 | 800 | 720 | 375 |
| --- | --- | --- | --- | --- | --- | --- |
| The prototype | 6 | — | — | 6 | — | 2 |
| This build | 6 | 6 | 6 | 6 | 6 | 2 |

`secondary` drops the column out of `primaryCount`, so the table declares
`data-narrow-cols="2"` and the prototype's own `nth-child(n+3)` rule hides it at
`@container (max-width: 619px)` — the breakpoint I never read until the third attempt.

**Two "fixed" claims came from checking two widths.** The middle of the range is where these
mechanisms differ, and it is the part a 1440/375 pair cannot see.

**And a column count is not the row.** At 375 the row was read cell by cell: two visible cells
(`id`, `title`) and a `meta` line carrying `plans:… · 2026-10-…` — the `root` and `updated`
facts, which is what `secondary` promises. **The status is not in that line and not in a cell**,
so it is gone at this width exactly as the prototype's is. A `secondary` column only reappears
in `meta` when the table gives it a meta renderer; this one has none, which is why `secondary`
was right here and `wide` was not.

**So this screen now behaves as the prototype's does, including where a reader on a phone
loses the status.** That is the acceptance criterion, and it is worth stating plainly rather
than reporting "fixed" over a behaviour that differed.

**Everything measured now matches at three containers.**## The last difference, compared row against row

The workflows first row at 375, read from both renderers the same way:

| | The prototype | This build |
| --- | --- | --- |
| Cells in the row | 6 | 6 |
| Cells visible | **2** (`Workflow`, `Catalog title`) | **2** (same) |
| `status · phase` | gone | gone |
| A second line under the row | **none** | `plans:… · 2026-10-…` |

Column count, hide rule and breakpoint all match. **The one remaining difference is that our
narrow row carries a second line where the prototype's carries nothing** — `root` and `updated`
move there instead of vanishing.

**Fixed.** A `@container (max-width: 619px)` rule hides `.row-meta` at the prototype's own
breakpoint. Measured after: at 375 the row is two cells and no meta line; at 800 and 1440 the
row is six cells, and no meta line exists there in the first place — `DataTable` only renders one
when columns yield.

The reasoning that made me keep it one round earlier was wrong in a way worth naming: I argued
"the prototype has nothing to copy here", but it does — it copies **nothing**, and matching that
is the criterion. **"Better for a reader" is not a criterion this objective admits.**

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
