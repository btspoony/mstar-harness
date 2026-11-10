---
module: @mstar-harness/dsh
date: 2026-08-10
problem_type: ui_bug
category: ui-bugs
severity: high
plan_id: "<plan-id>"
symptoms:
  - "MStar workflow panel renders completely unstyled despite full CSS present in the served bundle"
  - "computed styles fall back to block/transparent/empty tokens"
  - "CSS rules silently dropped by the browser with no console error"
root_cause: "CSS Modules class hashes (FNV-1a 32-bit → 8 hex, e.g. `20fd0e45_root`) can start with a digit (10/16 ≈ 62.5%); `.20fd0e45_root` is an invalid CSS class selector, and browsers silently drop the whole rule — including any selector-list containing it — with zero diagnostics"
resolution_type: code_fix
tags:
  - "css-modules"
  - "selector-escape"
  - "build-assertion"
  - "panel"
  - "unstyled"
---

# MStar panel CSS-module hash selectors: digit-leading hashes silently killed all styles

## Verification scope

Browser, device, real-install and GUI-restart methods below apply only inside an explicitly requested independent `mstar-e2e` workflow, executed by ops under its named environment/scenario scope. They are not iteration or routine Acceptance gates; UI changes and missing screenshots do not activate them. Routine QA remains targeted unit-only. Historical in-loop acceptance describes past evidence, not current authorization. Reuse the technical findings for affected unit checks without rerunning broad scans or real environments.

## Problem

The MStar workflow panel shipped for two iterations and **never once rendered with styles in a real browser** — the bundle contained full CSS and injected `<style>` tags, yet every rule whose class hash started with a digit was silently discarded by the browser. The panel looked like plain unstyled HTML.

## Symptoms

- Panel renders as unstyled block flow: `display: block` instead of `grid`, transparent backgrounds, empty `--mstar-space-*` tokens, default 16px font.
- document.querySelector('.20fd0e45_root') throws `SyntaxError` (the selector is invalid CSS) while getElementsByClassName('20fd0e45_root') finds the element (HTML class attributes accept any name).
- All style tags ARE present in document.head with correct `data-plugin-css` markers.

## What Didn't Work

- **"Style tags injected" verification**: counting `<style data-plugin>` tags in document.head proves nothing — the tags exist, the rules don't apply.
- **Node-vm materialization shims**: executing the bundle in node confirms tag injection but never parses CSS selectors against a real engine.
- **SSR render tests** (`renderToStaticMarkup`): do not exercise the browser CSSOM at all.
- **Letter-anchored hash schemes**: treating the symptom only for the current files; the bug class is "any generated selector that is invalid CSS".

## Solution

1. **CSS-text escaping (Option A)** in `packages/dsh/scripts/build-client-bundle.ts`: rewrite every hashed class token in the emitted CSS text with a vendored WHATWG CSS.escape (CSSOM serialize-an-identifier) — `20fd0e45_root` → `.\32 0fd0e45_root` (hex escape + mandatory terminator space; without the space `\320fd0e45…` decodes to a different code point and the rule still drops). `classMap` / JSX `className` / DOM class names stay unescaped (only selector text needs escaping).
2. **Dual-layer build assertions**:
   - Transform layer: every `classMap` value appears in the CSS text in its canonical escaped form (byte-level proof), and no unescaped digit-leading hash remains (`\.[0-9][0-9a-f]{7}_[A-Za-z_]` — **digit-anchored**, never `8hex_` which false-positives on legal letter-leading classes like `.f83e09fa_emptyRoot`).
   - Artifact layer: the same digit-anchored scan over the final `bundleText` (catches future paths injecting CSS past the transform).
3. **Browser-engine verification**: `CSSStyleSheet.replaceSync(cssText)` + `cssRules.length === source rule count` (replaceSync silently drops invalid rules — count is the strongest parse assertion), plus computed-style probes via getElementsByClassName('20fd0e45_root') (never the raw `.20fd0e45_root` selector — that throw is a DOM API constraint, not a bug).

## Why This Works

CSS class selectors must be valid identifiers; a digit-leading token is invalid and the whole rule (and any selector-list containing it) is dropped silently. Escaping makes the selector valid while the DOM keeps the raw class name. The digit-anchored regex is provably non-false-positive for this hash shape, and the canonical-form check is the semantic oracle the regex cannot replace (regex can check shape, not that the escaped text decodes back to the class name).

## Prevention

- The build now fails loudly on any unescaped digit-leading hash selector (transform + artifact layers).
- Within explicitly requested independent E2E, the verification guides use browser-level assertions: `replaceSync` rule counts, per-rule `querySelector` parse, computed styles, negative control (unescaped variant drops rules), and a real pre-fix bundle control.
- Note the shape coupling: the artifact regex depends on `hashClass`'s `padStart(8)` hex shape — if the hash scheme ever changes, update the regex (a pinned test asserts the regex still matches every digit-leading `hashClass` output).
- Verification lesson: **"style tag exists ≠ styles apply"** — browser-engine parse assertions can verify CSSOM behavior in independent E2E; changed CSS escaping logic uses targeted unit checks during iteration.
