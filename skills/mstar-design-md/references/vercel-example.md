# Vercel Geist DESIGN.md — Annotated Reference

This is Vercel's Geist design system as published at `vercel.com/design.md`, presented as a reference for creating new DESIGN.md files. Annotations are inline as `> **Design note:**` blockquotes explaining the rationale behind key decisions.

**Source:** <https://vercel.com/design.md>

**Why this as reference:**
- Vercel's DESIGN.md is the canonical example of the `DESIGN.md` format in the `awesome-design-md` ecosystem
- It defines a complete Level 3 design system covering all sections
- The token naming conventions (100-1000 step scale with intent encoding) are widely adopted
- Light/Dark dual-theme pattern shows how to split same-name tokens across two files
- The YAML frontmatter + Markdown body split is the standard DESIGN.md file structure

---

## YAML Frontmatter: Structured Token Store

Vercel Geist DESIGN.md uses a YAML frontmatter block (`---` ... `---`) as the **single source of truth for token values**. The Markdown body below is human-readable documentation. Every DESIGN.md file must follow this pattern.

### Frontmatter structure

```yaml
---
version: 0.1.0
name: Geist
description: Vercel's Geist design system, Light theme.
colors:
  background-100: "#ffffff"
  gray-1000: "#171717"
  blue-700: "#006bff"
  # … all color tokens as flat map …
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  # … all typography tokens with 5 properties each …
spacing:
  base: 4px
  1: 4px
  2: 8px
  # … full scale …
rounded:
  sm: 6px
  md: 12px
  lg: 16px
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.gray-1000}"
    textColor: "{colors.background-100}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 40px
  # … all component variants referencing other frontmatter keys …
---
```

> **Design note:** The frontmatter-body split is fundamental to the DESIGN.md format. The frontmatter is structured, parseable data; the body is prose documentation. This is the same pattern used by Jekyll, Hugo, and many static site generators — it's well-understood by tooling and agents. The `{colors.X}` reference syntax in components enables single-point-of-change: update `colors.gray-1000` in one place and all components that reference it automatically follow.

### Key design decisions in the frontmatter

1. **Flat color map, not nested by family** — `gray-100: "#…"` not `gray: {100: "#…"}`. This allows flat lookups and avoids deep nesting.
2. **10-step color scale encodes intent** — `400 = border`, `700 = solid fill`, `1000 = primary text`. Agent reads the step number and knows the role.
3. **All 5 typography properties per token** — no defaults assumed; every token is self-contained.
4. **Reference syntax for components** — `"{colors.gray-1000}"` keeps components declarative and avoids value duplication.
5. **Full frontmatter even for dark theme** — `design.dark.md` has the exact same frontmatter keys with different values.

---

## Markdown Body (documentation)

Below the frontmatter, the body provides human/agent-readable documentation:

## Overview

Geist is Vercel's design system for building consistent, developer-focused interfaces. The aesthetic is minimal and high-contrast: plenty of whitespace, restrained color, and content set on near-neutral surfaces. Prioritize readability and accessibility, and use color to signal state or hierarchy rather than decoration.

This is the Light theme. The Dark theme uses the same token names with different values and lives at `/design.dark.md`. Colors are sRGB hex with Display P3 equivalents.

> **Design note:** The Overview does two things well: (1) it states the aesthetic in terms an agent can operationalize ("minimal and high-contrast", "color to signal state or hierarchy rather than decoration"), and (2) it declares the multi-theme structure upfront.

## Colors

Each non-background scale runs 10 steps (`100`–`1000`), and the step encodes intent, not just lightness:

- `100` default background
- `200` hover background
- `300` active background
- `400` default border
- `500` hover border
- `600` active border
- `700` solid fill, high contrast
- `800` solid fill, hover
- `900` secondary text and icons
- `1000` primary text and icons

`background-100` is the primary page and card surface; `background-200` is a secondary surface for subtle separation. The `gray-alpha-*` tokens are translucent, so they layer over any background; use them for borders, dividers, overlays, and hover states. Solid `gray-*` holds its contrast on any surface, so use it for text and opaque fills. Accent scales carry meaning: `blue` for success, links, and focus; `red` for errors; `amber` for warnings; plus `green`, `teal`, `purple`, and `pink`. Use the hex tokens everywhere; each accent scale also ships a `*-p3` wide-gamut value in `oklch()` for Display P3 screens. The Dark theme redefines the same names at `/design.dark.md`.

> **Design note:** This is the key innovation of Vercel's approach: the 10-step scale encodes **intent**, not just a lightness gradient. An agent reading this knows that `700` means "solid fill" and `400` means "border", regardless of the actual hex value. This makes the scale **self-documenting** — an agent can apply tokens correctly without memorizing specific colors. The separation of `gray-alpha` (translucent, layers over any background) from `gray` (solid, holds contrast) is another critical design decision that prevents common UI mistakes.

## Typography

Geist Sans sets UI and prose; Geist Mono sets code, data, and tabular figures. Both are open-source. The `typography` tokens above carry concrete `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, and `letterSpacing`:

- Headings, `heading-72` through `heading-14`, title pages and sections; `letterSpacing` tightens as the size grows.
- Labels, `label-20` through `label-12`, carry single-line, scannable text: navigation, form labels, table headers, metadata.
- Copy, `copy-24` through `copy-13`, set multi-line body text with a taller `lineHeight`.
- Buttons, `button-16` through `button-12`, are medium-weight labels for buttons and compact controls.

`copy-14` and `label-14` cover most text. The `-mono` tokens pair Geist Mono with the same metrics; prefer tabular figures when numbers need to align.

> **Design note:** The typography system encodes **role** plus **size** in the token name (`copy-14`, `label-14`, `button-16`). An agent knows `copy-14` is body text (multi-line, taller line-height) and `label-14` is single-line scannable text — even though they share the same font size. This is the same "intent encoding" pattern as the color scales.

## Layout

Spacing follows a 4px scale: 4, 8, 12, 16, 24, 32, 40, 64, 96px. Keep a three-step rhythm: 8px inside a group, 16px between groups, 32–40px between sections. Cards use 24px padding, 16px when compact and 32px for hero areas. Center content in a 1200px column with side padding that grows at wider breakpoints, and make every layout work on mobile and desktop. Breakpoints are `sm` 401px, `md` 601px, `lg` 961px, `xl` 1200px, and `2xl` 1400px.

> **Design note:** The "three-step rhythm" rule (8px/16px/32px) gives an agent a clear, mechanical way to decide how much space to put between elements. Without this, agents tend to use arbitrary spacing. The card padding variants (24px/16px/32px) similarly prevent inconsistent padding choices.

## Elevation & Depth

Hierarchy comes from tonal surfaces and borders first, so shadows stay subtle. Apply these `box-shadow` values for the light theme:

- Raised cards: `0 2px 2px rgba(0, 0, 0, 0.04)`
- Popovers and menus: `0 1px 1px rgba(0, 0, 0, 0.02), 0 4px 8px -4px rgba(0, 0, 0, 0.04), 0 16px 24px -8px rgba(0, 0, 0, 0.06)`
- Modals and dialogs: `0 1px 1px rgba(0, 0, 0, 0.02), 0 8px 16px -4px rgba(0, 0, 0, 0.04), 0 24px 32px -8px rgba(0, 0, 0, 0.06)`

Tooltips take the lightest of these. Pair each elevation with the matching radius below.

> **Design note:** The hierarchy principle is stated first ("tonal surfaces and borders first, so shadows stay subtle"). This prevents agents from over-using shadows. Each elevation is tied to a specific UI element (card, popover, modal) — not an abstract level number — making it trivial for an agent to pick the right shadow.

## Motion

Use motion only when it clarifies a change, never for decoration. Most interactions should feel instant: a duration of `0ms` is often the snappiest and best choice, and the call is context-dependent. When motion genuinely helps, such as revealing or moving an element, keep it short and physical with the easing `cubic-bezier(0.175, 0.885, 0.32, 1.1)`: roughly 150ms for state changes, 200ms for popovers and tooltips, and 300ms for overlays and modals. Avoid long, looping, or attention-grabbing animation, and honor `prefers-reduced-motion` by dropping nonessential motion.

> **Design note:** The explicit "0ms is often the best choice" is crucial — it prevents agents from defaulting to the common 300ms ease-out. The duration table maps cleanly to element types (state change → popover → modal), making it self-documenting.

## Shapes

Radii stay tight: 6px for everyday surfaces and controls, 12px for menus and modals, 16px for fullscreen surfaces. Reserve 9999px for pills, avatars, and circular controls. Keep one radius family per view rather than mixing rounded and sharp corners.

> **Design note:** "One radius family per view" is a strong constraint that prevents inconsistent corner radius mixing — a common agent mistake.

## Components

The `components` tokens above give ready-to-use values per element (`backgroundColor`, `textColor`, `rounded`, `height`) drawn from this theme:

- Primary button: solid `gray-1000` fill with a `background-100` label, for the single most important action on a view.
- Secondary button: `background-100` fill with a translucent `gray-alpha-400` border.
- Tertiary button: transparent fill with `gray-1000` text for low-emphasis actions; it tints with `gray-alpha` on hover.
- Error button: solid `red-800` fill with white text, for destructive actions.
- Input: `background-100` fill, translucent border, 6px radius.

The variant tokens are the default medium (40px) size. Use the `button-small`/`input-small` (32px) and `button-large`/`input-large` (48px) tokens for the other sizes; large buttons step up to `button-16`. Hover and active states step up the scale: a `100` fill becomes `200` on hover and `300` on active, and borders move from `400` to `500` to `600`. Disabled uses a `gray-100` fill, `gray-700` text, and a not-allowed cursor. Focus shows a two-layer ring (`box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px #006bff`): a 2px gap in the surface color, then a 2px `blue-700` ring.

> **Design note:** The component tokens reference the color/typography/shape tokens defined above — there is no duplication. The state progression rule ("100 → 200 → 300 fill on hover → active") is a **systematic rule**, not a per-component value table. An agent can derive any component's hover state from this rule alone. The focus ring pattern (surface gap + accent ring) is explicitly described with box-shadow values, preventing agents from guessing focus styles.

## Voice & Content

Copy is part of the design; keep it precise and free of filler.

- Use Title Case for labels, buttons, titles, and tabs; sentence case for body, helper text, and toasts.
- Name actions with a verb and a noun (`Deploy Project`, `Delete Member`), never `Confirm`, `OK`, or a bare verb.
- Write errors as what happened plus what to do next: `Build failed. Bundle exceeds 50 MB. Reduce it or raise the limit.`
- Toasts name the specific thing that changed, drop the trailing period, and never say `successfully`: `Project deleted`, not `Successfully deleted the project.`
- Empty states point to the first action: `No deployments yet. Push to your Git repository to create one.`
- Use the present participle with an ellipsis for in-progress states: `Deploying…`, `Saving…`.
- Use numerals (`3 projects`), curly quotes, and the ellipsis character; skip `please` and marketing superlatives.

> **Design note:** Voice rules are highly actionable for agents because they give negative examples ("never `Confirm`, `OK`") and positive patterns ("what happened + what to do next"). This turns copy generation from guesswork into a mechanical fill-in-the-blank exercise.

## Do's and Don'ts

- Use the gray scale to rank information: `1000` for primary text, `900` for secondary, `700` for disabled.
- Keep solid accent color for state and the single most important action on a view.
- Hold WCAG AA contrast (4.5:1 for body text).
- Show the focus ring on every interactive element at `:focus-visible`, and never remove an outline without a visible replacement.
- Apply the typography tokens instead of setting font size, line height, or weight by hand.
- Don't signal state with color alone; pair it with an icon or text label.
- Don't use `background-200` as a general fill; it is for subtle separation only.
- Don't mix rounded and sharp corners, or more than two font weights, in one view.
- Don't swap `gray-*` for `background-*`; they are separate scales.

> **Design note:** The Do's and Don'ts section serves as a **correctness checklist** for agents. Each item is a specific, verifiable rule. Agents can self-check their UI output against this list. The "Don't" items prevent common mistakes ("don't mix rounded and sharp corners", "don't use `background-200` as a general fill").

---

## Key takeaways for creating your own DESIGN.md

1. **Use YAML frontmatter as the token SSOT** — structured colors, typography, spacing, rounded, and components in parseable form; the body is documentation
2. **Encode intent in token names**, not just values — `gray-400 = border`, `copy-14 = body text`
3. **State rules, not just values** — "three-step spacing rhythm" is more useful than a raw scale
4. **Give negative examples** — agents need to know what NOT to do as much as what to do
5. **Make state derivable** — "100 → 200 → 300 on hover" means the agent can compute any component's state
6. **Tie tokens to concrete UI elements** — "card shadow", not "level-1 shadow"
7. **Voice rules should be mechanical** — fill-in-the-blank templates, not vague principles
