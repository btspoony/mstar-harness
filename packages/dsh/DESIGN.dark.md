---
version: 0.2.0
name: "MStar Panel Design System"
description: "Dark theme companion to MStar Panel Design System — same token names, different values (host alias flip, design-platform.css data-ds-dark-theme). The Light theme lives at /DESIGN.md."

# ── Host alias tokens (name-level interface — identical to DESIGN.md) ──────
dswAlias:
  bg-layer-1: --dsw-alias-bg-layer-1
  border-l1: --dsw-alias-border-l1
  border-l2: --dsw-alias-border-l2
  label-primary: --dsw-alias-label-primary
  label-secondary: --dsw-alias-label-secondary
  label-caption: --dsw-alias-label-caption
  state-business-primary: --dsw-alias-state-business-primary
  state-error-primary: --dsw-alias-state-error-primary
  state-success-primary: --dsw-alias-state-success-primary
  state-warn-label: --dsw-alias-state-warn-label

colors:
  # Panel semantic color tokens — pinned DARK values (host-alias provenance
  # in comments; runtime consumption stays alias-based, zero bare hex in CSS).
  # background-100: panel surface = --dsw-alias-bg-layer-1 (dark)
  background-100: "#232324"
  # gray-1000: primary label = --dsw-alias-label-primary (dark)
  gray-1000: "#f9fafb"
  # gray-900: secondary label = --dsw-alias-label-secondary (dark)
  gray-900: "#cfd3d6"
  # gray-400: caption label = --dsw-alias-label-caption (dark)
  gray-400: "#81858c"
  # blue-700: business accent = --dsw-alias-state-business-primary (dark)
  blue-700: "#679efe"
  # red-700: error = --dsw-alias-state-error-primary (dark)
  red-700: "#f25a5a"
  # amber-700: warn = --dsw-alias-state-warn-label (dark)
  amber-700: "#dd8629"
  # green-700: success = --dsw-alias-state-success-primary (dark)
  green-700: "#22c55e"

typography:
  # Typography is theme-independent — identical to DESIGN.md (fonts do not
  # flip with the theme; host --dsw-font-family stack).
  heading-13:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0
  heading-11:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 14px
    letterSpacing: 0
  copy-13:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0
  copy-12:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0
  copy-11:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 14px
    letterSpacing: 0

spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 24px
  6: 32px

rounded:
  sm: 8px
  full: 999px

# ── List semantic tokens — theme-independent, identical to DESIGN.md ───────
canvas:
  row-gap: 4px        # entity-row gap = --mstar-space-1 (.cardList)
  group-gap: 16px     # group-grid gap = --mstar-space-4 (.groupGrid); 12px (--mstar-space-3) in the ≤480px container
  label-h: 14px       # group/stage/sub-bucket label row line box (--dsw-font-xxxs-11 = 11px/14px; line-height-driven, no fixed height)
  emphasis-current: 100%
  emphasis-next: 75%
  emphasis-off: 45%
---

<!-- COMPLETENESS_LEVEL: 1 — dark theme companion to DESIGN.md (last audited 2026-09-11) -->

# MStar 面板设计系统 — Dark（深色主题）

## Overview

MStar Panel Design System **Dark** is the dark-theme companion to
[`DESIGN.md`](DESIGN.md). Token names are **identical**; only the `colors:`
values change (host alias flip — `data-ds-dark-theme` in the dsh web
`design-platform.css`). Typography, spacing, radius, and the pruned
`canvas:` semantic group (list row metrics + emphasis opacity tiers) are
**theme-independent** — same values as the light theme (深浅同值).

The dark theme needs **no theme branch in the panel**: the panel consumes
`--dsw-alias-*` by name, and the host flips the values. This file pins the
panel semantic tokens' dark values so the contract is self-contained and
verifiable per theme.

## Colors

Token values are defined in the frontmatter `colors:` map — same key set as
DESIGN.md, dark-appropriate values. The panel still consumes **zero bare
hex** at runtime.

| Panel role | Token | Dark value | Host alias (provenance) |
|-------------|-------|------------|--------------------------|
| Surface (shell / rows / group frames) | `background-100` | `#232324` | `--dsw-alias-bg-layer-1` (dark) |
| Primary label (titles) | `gray-1000` | `#f9fafb` | `--dsw-alias-label-primary` (dark) |
| Secondary label | `gray-900` | `#cfd3d6` | `--dsw-alias-label-secondary` (dark) |
| Caption (record rows, dim) | `gray-400` | `#81858c` | `--dsw-alias-label-caption` (dark) |
| Business (running, active nav) | `blue-700` | `#679efe` | `--dsw-alias-state-business-primary` (dark) |
| Error / denied | `red-700` | `#f25a5a` | `--dsw-alias-state-error-primary` (dark) |
| Success (done frame + ✓) | `green-700` | `#22c55e` | `--dsw-alias-state-success-primary` (dark) |
| Warn (advisory) | `amber-700` | `#dd8629` | `--dsw-alias-state-warn-label` (dark) |

- Border colors ride `--dsw-alias-border-l1` / `--dsw-alias-border-l2`
  (dark values `rgba(255,255,255,0.06)` / `rgba(255,255,255,0.12)`) — host
  alias, name-level.
- Emphasis chrome mixing base = dark `--dsw-alias-bg-layer-1`; the three
  tiers keep identical relative contrast (DESIGN.md §4.3 深浅一致性检查).

## Typography

Identical to DESIGN.md — fonts are theme-independent (host `--dsw-font-*`
ramp, family = host `--dsw-font-family` stack). See
[`DESIGN.md`](DESIGN.md) § Typography.

## Spacing & Layout

Identical to DESIGN.md — `--mstar-space-1..6` ramp, `rounded.sm` 8px /
`rounded.full` 999px, the `canvas:` row metrics + emphasis tiers
(theme-independent), and the container-query breakpoints (the width signal
is the shell's `container-type: inline-size`, never a viewport media
query). See [`DESIGN.md`](DESIGN.md) § Spacing & Layout.

## Interaction & theme

All interaction rules (hover 150ms, status-point priority, reduced-motion)
are theme-independent — see [`DESIGN.md`](DESIGN.md) § Panel Structure &
Flow §4.

<!--
  IMPORTANT: Switch to dark mode by loading this file's values in place of
  DESIGN.md values. Consumers reference tokens by name, not by value — the
  switch is transparent.
-->
