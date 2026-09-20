---
version: 0.1.0
name: Morning Star Local Dashboard
description: A quiet, readable light-theme dashboard for local governance records and execution visibility. Read-only by design.
colors:
  background-100: "#ffffff"
  background-200: "#f5f7fa"
  background-300: "#edf1f6"
  gray-400: "#d5dce5"
  gray-600: "#8995a6"
  gray-900: "#506070"
  gray-1000: "#1c2430"
  blue-700: "#1756b8"
  blue-800: "#12458f"
  blue-100: "#eaf1ff"
  red-700: "#b42318"
  red-100: "#fff0ed"
  amber-700: "#a35300"
  amber-100: "#fff5e5"
  green-700: "#147d48"
  green-100: "#eaf8ef"
  purple-700: "#7042a0"
typography:
  heading-28:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.02em
  heading-20:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: -0.01em
  copy-16:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  copy-14:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  label-14:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  button-14:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  copy-13-mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
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
  md: 10px
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.blue-700}"
    textColor: "{colors.background-100}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: 44px
  button-secondary:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    borderColor: "{colors.gray-600}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: 44px
  input:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    borderColor: "{colors.gray-600}"
    typography: "{typography.copy-16}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 44px
---

<!-- COMPLETENESS_LEVEL: 1 — last audited 2026-09-18 -->

# Morning Star Local Dashboard

## Overview

A local, read-only information surface for people reviewing confirmed findings, execution progress and direction. Prioritize readable evidence and truthful state over decorative metrics. White surfaces, a cool neutral page, restrained blue navigation, compact tables and generous detail text. No gradients, ornamental cards, remote fonts or marketing hero. This is the light theme only; dark mode and a full design-system library are not current requirements.

Frontmatter is the sole token-value authority. Body rules explain its use. Components consume tokens rather than inventing alternate color/spacing scales.

## Information architecture

Four primary destinations: **Issues** (default), **Workflows**, **Iterations**, **Roadmap**. Use a simple top navigation and project selector. Issues contains list, selected detail and one issue-flow chart panel; the chart is not a fifth destination. The persistent footer reads “Read-only · Make changes with the CLI”. No create/edit/close/drag-to-state affordances.

Issue list defaults to open items across all projects, sorted by severity then latest real activity then stable ID. Filters remain visible with a clear-filters action. Clicking a row/title opens a detail region/page; back preserves filters and focus. Detail displays identity, impact, acceptance, evidence, occurrences, disposition transitions and relations, without nesting cards inside cards.

Workflows show projected phase/progress/leases with freshness disclosure. Iterations show catalog membership and documents independently from execution state. Roadmap shows project direction/goals as text, not editable checkboxes. Status badges must name whether they describe catalog lifecycle, issue disposition or projected execution; never use the same unlabeled “status” for all three.

## Colors and typography

Primary body text uses gray-1000; secondary text uses gray-900. Blue is links/focus/selection, not success. Red signals error or critical/high severity with a text label; amber signals stale/warning; green signals resolved only, not waived/duplicate/superseded. Neutral/purple terminal labels remain textually distinct. No information conveyed only by color.

Use heading-28 once per view, heading-20 for detail sections. Tables and helper text use copy-14; evidence and longer prose use copy-16. IDs, hashes and timestamps use mono; numeric columns use tabular figures. Wrap long paths/untrusted text with overflow-wrap, never squeeze columns to illegibility. Truncation requires a keyboard-accessible way to read the full text. Dates retain their precision; absent dates say “Date unknown”, not zero or the import time.

## Spacing and responsive layout

Rhythm: 8px inside a control group, 16px between related groups, 32px between sections. Desktop content max-width 1440px, side padding 32px; smaller screens 16px. Flat white table/detail regions with 1px separators, not stacked ornamental cards.

| Breakpoint | Min width | Layout |
|---|---:|---|
| sm | 480px | Filters wrap naturally; one-column detail |
| md | 768px | Navigation and filters share rows when space permits |
| lg | 1024px | Optional issue list/detail split, minimum readable detail width 360px |
| xl | 1440px | Cap content width; no stretched text paragraphs |

Below sm, keep headings, filters, freshness notice and navigation visible; issue rows collapse secondary metadata below title instead of causing page-wide horizontal scroll. Data tables may scroll inside a labelled container. Chart keeps readable axes and an accessible table alternative; do not scale text down to fit a phone.

## Controls, focus and accessibility

Navigation, filters and inputs have visible labels and a minimum 44px target. Buttons are navigation/query actions only. Hover: primary blue-800, secondary background-200; active background-300 for neutral controls. Focus-visible outline 2px blue-700 with 2px surface gap; never remove focus. Disabled controls use neutral fill/text and native disabled semantics, not merely opacity. Input errors add red border plus a specific message associated by aria-describedby.

Use semantic header/nav/main/footer, native buttons/links/selects, table captions/headers and exactly one h1. Skip-to-content link, keyboard-accessible details and filters, visible focus and Escape/back behavior where appropriate. Announce loaded results and source errors with a polite live region without moving focus. Focus returns to the originating issue link when closing details. Do not rely on hover tooltips for evidence.

Text contrast target WCAG AA: at least 4.5:1 body text and 3:1 large text/interactive boundaries. Use tested foreground/surface pairs from these tokens; muted border gray-400 is decorative only. Severity/status labels combine text with shape/icon only when the icon adds meaning. No external icon/font dependency is required.

## Empty, stale and error states

- **No issues yet:** “No issues captured. Use the CLI to record a confirmed finding.” A CLI command hint is text, not a fake web mutation button.
- **No matches:** “No issues match these filters.” Provide Clear Filters, preserve navigation.
- **No catalog records / no execution data:** distinguish an empty registered catalog from an iteration that has never started execution.
- **Stale projection:** amber notice on every affected view names source and reason, shows last successful build time and checked time. Retained data is explicitly labelled stale, not current.
- **Unavailable initial projection:** show unavailable state and diagnostic, never zero active workflows or “all clear”.
- **Store/runtime failure:** server startup refusal or structured error state; never an empty success page. Error copy says what failed and the safe next action, without leaking secrets or raw stacks.

## History and chart honesty

History contains only recorded occurrences and disposition transitions. Migrated records carry a visible migration/source label. A migrated closed record shows capture and closure only; unknown intermediate events/durations are absent. Render source data as text, never raw HTML or unsanitized Markdown.

One chart family: cumulative captured vs retired issues. Solid blue capture and dashed neutral/purple retirement lines also have explicit labels. Every terminal disposition counts retired; retired never means all were fixed. Known-dated gap is shown alongside authoritative current open count; missing dates are disclosed and excluded from dated buckets, not imputed. Pre-store dates are labelled register history. Include a tabular data alternative and an empty/incomplete-history message.

## Motion, elevation and content

No animation is needed for data changes. Optional focus/hover transition ≤120ms ease-out; prefers-reduced-motion removes it. No chart entrance animation or looping refresh effects. Hierarchy comes from type, spacing and borders; avoid shadows except a restrained focus layer. No modal is required for the basic IA.

Use plain, precise labels and short action verbs: View Issue, Clear Filters, Back to Issues. Retain original severity/disposition vocabulary in details. Do not call stale, missing or refused data healthy. Avoid congratulatory “successfully”, fabricated timestamps and unsupported speed/reliability claims.

## Completeness and upgrade boundary

Level 1 is intentional: concrete palette, body/heading typography, nine-step spacing, radii and breakpoints are complete; common controls and accessibility/state rules are additionally specified. No claim of Level 2 full scales or Level 3 dual-theme coverage. Revisit broader component/token scales only when a new approved UI requirement needs them; do not infer dark mode from system preference.
