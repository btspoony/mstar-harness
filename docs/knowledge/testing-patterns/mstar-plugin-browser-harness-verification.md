---
module: @mstar-harness/dsh
date: 2026-08-10
last_updated: 2026-11-09
problem_type: testing_pattern
category: testing-patterns
severity: medium
plan_id: "<plan-id>, <plan-id>, <plan-id>, <plan-id>, <plan-id>, <plan-id>, <plan-id>"
tags:
  - "browser-harness"
  - "cdp"
  - "zone-dashboard"
  - "dual-theme"
  - "verification"
  - "panel"
  - "headless-chrome"
  - "reduced-motion"
---

# In-loop browser harness verification for dsh client plugin bundles

## Context

dsh client plugin bundles (closure-factory CJS, served at `/plugins/<id>/client.js`, loaded as classic scripts via `window.__ModuleLoader__.load({ id, factory })`) were historically verified by node-vm materialization shims and "style tag injected" assertions — which repeatedly missed real rendering failures. Real defects that slipped through: digit-leading CSS-module hashes (all styles dropped, see `docs/knowledge/ui-bugs/mstar-panel-css-module-hash-selectors.md`) and ReactFlow v12 silently dropping edges whose endpoint nodes expose no `<Handle>` (SSR tests cannot see either). The panel has since moved from react-flow to an **HTML/CSS zone dashboard** (iteration/tasks/agents zones + footer + agent-event dock, dual-theme) — the harness remains the acceptance path for CSSOM-level, computed-style, animation, and layout-invariant failures. The environment often cannot restart the user's live dsh web, so an explicitly requested independent E2E run may verify the **rebuilt bundle** in a **real browser engine** without touching the running GUI. This does not authorize in-loop browser work.

## Verification scope

Browser, device, real-install and GUI-restart methods below apply only inside an explicitly requested independent `mstar-e2e` workflow, executed by ops under its named environment/scenario scope. They are not iteration or routine QA gates; UI changes and missing screenshots do not activate them. Routine QA remains targeted unit-only. Historical in-loop acceptance describes past evidence, not current authorization. Reuse the technical findings for affected unit checks without rerunning broad scans or real environments.

## Guidance

**Build a self-contained harness page** (`{SDD_DIR}/review/harness/harness.html`) that:
1. Implements `__ModuleLoader__` with a `require` module table: extract the bundle's external ids (grep `require("` in dist/client.js), build browser implementations with `bun build --target=browser` per external (react / react-dom / react/jsx-runtime for this panel), and inline everything (file:// must work; escape </script> as `\u003c`).
2. Loads `packages/dsh/dist/client.js` as a classic script, calls `factory(require)`, and asserts the export surface (`{ inject, apply }`).
3. Runs assertions against real DOM/CSSOM:
   - style tags: `<style data-plugin>` injected with expected ids (panel + zones for the dashboard; counts changed as zones evolved: 3 → 2 after react-flow removal);
   - **parse**: `new CSSStyleSheet().replaceSync(cssText)` then `cssRules.length === expected rule count` (replaceSync silently drops invalid rules — the count is the strongest parse assertion); per-rule `document.querySelector(rule.selectorText)` must not throw (null match is legal);
   - **computed styles**: probe elements via `getElementsByClassName('<raw-class>')` (never `querySelector('.20fd0e45_root')` — raw selectors with digit-leading classes still throw; that is a DOM API constraint, not a CSS bug);
   - **negative controls**: an unescaped/old variant of the CSS must drop rules (19 < 37 etc.); a real **pre-fix bundle** (the bundle the GUI actually serves) as the before-control;
   - **panel rendering**: mount the real product screens (`packages/ui/src/screens/*.tsx` via the `packages/dsh/src/client/panel` seats) through a fake session kit and probe the **live** anchor set — `data-ms-screen`, `data-ms-destination-body`, `data-ms-shell`, `data-ms-theme`, `data-mstar-seat`, `data-mstar-panel`, `data-mstar-scroll`, `data-mstar-empty`/`data-mstar-pick` (see `conventions/dsh-client-panel-authoring.md` (archived)). The zone-dashboard anchors this section originally named (`data-zone-*` / `data-step-*` / `data-kanban-*` / `data-agent-*`, `AgentEventDock`, react-flow edges) are **gone** from `packages/dsh/src` and `packages/ui/src` — grep before reusing any anchor name;
   - **layout invariants**: page never scrolls (scrollHeight === innerHeight) and the single scroll body is the element carrying `data-mstar-scroll` / `data-ms-pane-body` (`packages/dsh/src/client/panel/panel-shell.tsx`); assert its overflow and internal scroll metrics rather than a named canvas container, which no longer exists;
   - degraded/empty/garbage sources: no crash, correct fallback notes.
4. Writes results to window.__HARNESS_RESULTS__ (and a `<pre>`), with `OVERALL` computed over PASS/FAIL lines only (INFO lines must not fail the run).

**Running the browser in the DSH sandbox**: Google Chrome / agent-browser CDP cannot start inside the sandbox (`Failed to create headless user data directory container` / `CDP response channel closed`). The working path is **playwright's single-process Chromium** in headless `--dump-dom` mode: `--headless --no-sandbox --disable-gpu --disable-crash-reporter --disable-dev-shm-usage --single-process --user-data-dir=/tmp/... --virtual-time-budget=15000-20000 --dump-dom file://.../harness.html`, then extract `<pre id="results">` (the process may linger after dump — `timeout` reclaims it). Reuse the same Chromium for `--force-prefers-reduced-motion` variants and `--screenshot` theme shots. When agent-browser is available, the harness page doubles as the PM-side re-run (open the page, read OVERALL PASS).

**Dual-theme computed-style probing (light/dark)**:
- **Host token table, not self-invented values**: extract the tokens' light AND dark values from the REAL host/product CSS at generation time (`packages/ui/src/styles/tokens.css` is the current product SSOT; the historical `--dsw-*` host table and its `index-Dg_Ii6cY.css` source belong to the pre-unification host-seat era), and keep a **runtime drift guard** — the pinned table must match the current source token-by-token (0 drift), so a theme change fails loudly instead of silently passing stale expectations.
- Flip the theme via `data-ms-theme="dark"` on the product wrapper (`MS_THEME_ATTRIBUTE` in `packages/ui/src/index.ts` sets the same attribute `packages/ui/src/styles/base.css` keys off); the host resolves the scheme from `ctx.theme.getTheme()` — `theme.ts` in `packages/dsh/src/client/panel` maps `active.colorScheme` onto it. Assert per-screen/per-element computed styles in both themes (`theme_light_*` / `theme_dark_*`) AND the observable flip (`theme_flip_*`), and assert the panel seat CSS declares zero bare colors (it holds geometry only; `panel.module.css` says so in its header).
- **Probe timing (compositor trap)**: CSS transitions are compositor-driven and `--virtual-time-budget` does NOT advance their clock — reading immediately after a dark flip lands on the transition START value (first run: 6 FAIL, all on `transition`-declaring elements; transition-less elements flipped correctly, which is itself proof the mechanism works). Inject a probe-kill rule (`#mount * { transition: none; animation: none !important }` — the same technique as the panel's own `prefers-reduced-motion` root rule) so theme probes read deterministic final values; where the kill is not used, add a 300ms settle before reading. The 120–200ms transition window itself is asserted by render tests, not this probe.

**Animation + reduced-motion verification**:
- Static: no `@keyframes` exist anywhere in `packages/ui/src` or `packages/dsh/src` today, so the historical agent-flow animation assertions (`agent-dash-flow` / `agent-card-pulse`) describe a removed surface — assert what the current CSS declares instead of re-using those names.
- The single reduced-motion coverage point is now `packages/ui/src/styles/base.css` (`@media (prefers-reduced-motion: reduce)` collapsing `animation-duration`/`transition-duration`/`animation-iteration-count`/`scroll-behavior` on `*`).
- **Reduced-motion variant**: run the harness with `?reduced=1` + `--force-prefers-reduced-motion`; assert `matchMedia('(prefers-reduced-motion: reduce)').matches === true` AND the computed `animation-duration` / `transition-duration` of a probe element collapsed to `0.01ms` and `animation-iteration-count` to `1` — reduced motion is engine-verified, not just declared.

**Probe hygiene**: generator scripts should derive paths from `import.meta.dirname` (never hardcoded `/Users/<name>/…`); regenerate the harness whenever the bundle or probes change; keep the byte count of the pinned artifact in sync.

## Interaction probes + per-page harness (tabs era — historical, anchors retired)

Static DOM/CSSOM probes cannot prove **interactive** behavior, so the tabs-era pages added real input events to the harness. **The specific anchors below are retired**: `packages/dsh/tests/panel-anchor-contract.spec.ts` now asserts that `data-canvas-*`, `data-agent-port`, `data-mstar-edge-*`, `data-agent-edge-*`, `data-agent-*`, `layoutAgents`, `edgePath`, `panDrag` and `setPointerCapture` are all absent from `src/client/**` and the panel dir. Keep the *method*; re-derive the anchor names from the current seats before writing probes:

- **Pointer drag / canvas pan**: retired with the canvas (`data-canvas-pan`, `setPointerCapture`). Any surviving drag surface follows the same shape: dispatch real `pointerdown` → `pointermove` → `pointerup` and assert the observable transform, plus a **negative control** (non-primary pointer must not move it).
- **Details/summary expansion (event log)**: real click on `<summary>` → assert `details.open` and expanded content visibility; also assert collapsed default in the empty-mode variant.
- **Empty-mode variant**: a third harness run with an empty fixture (0 events + 0 violations) asserting muted empty state and that row-based probes are guarded (probes that only exist with rows must be skipped, not failed).
- **Per-page adaptation pattern**: copy the previous plan's `gen-harness.mjs` + `static-preverify.mjs` into the new plan's `{SDD_DIR}/review/harness/`, adapt the fixture + probes to the new page's anchors, regenerate after every `build-client` (the harness embeds the bundle — a stale bundle silently tests the old code; pin the bundle sha1 in `browser-results.txt` and in `static-preverify.json` so drift fails loudly).
- **Screenshot verification without a vision model**: assert theme flip via mean luminance of the PNG (convert with `sips` to BMP and read pixels — light ≈ 250, dark ≈ 82 for the dsh host tokens); a wrong theme (e.g. both screenshots dark) fails the check.
- **Bundle freshness**: rebuild (`build-client`) BEFORE regenerating the harness; `static-preverify` re-run must report 0 drift against the pinned token table.

**Settle + step-refresh probes (timeliness era — historical anchors):** the F4.1 probes drove `data-agent-status="running"|"settled"` on entity cards, which no longer exist. The *contract* they proved is still live and testable at the projection layer: a settle pairs to its dispatch only by exact `(agent, role, planId, taskId)` identity, an unpaired dispatch stays `running` (no fabrication), and a new snapshot with a changed ledger re-renders without any client timer. Assert those in the projection/render tests (`packages/ui/src/**/*.test.tsx`), not by re-adding deleted anchors.

## Why This Matters

"Style tag exists ≠ styles apply" and "SSR renders nodes ≠ browser renders edges" generalize to: static checks cannot see CSSOM parsing, computed styles, animation state, or layout. The harness is the only acceptance path that catches these classes; it produced the evidence that closed the CSS bug (pre-fix bundle control: `display:block`, rules 20<34), the all-edges-dropped defect, and the dual-theme/animation/layout invariants of the zone dashboard (46 PASS sidebar, 79 PASS canvas zones, agent-flow zone default ×2 + reduced-motion variant — all OVERALL PASS / 0 FAIL; theme_flip + reduced-motion evidence). Historically it replaced deferred "user-restart" acceptance in-loop. Current browser or GUI-restart acceptance requires an explicitly requested independent E2E workflow; that past evidence does not create an iteration gate.

## When to Apply

- Explicitly requested independent E2E scenarios for client-bundle CSS, rendering, animation, or layout behavior.
- Independently authorized GUI acceptance when the named live GUI cannot be restarted; missing restart access never adds an iteration gate.
- Named regression scenarios for dual-theme parity, animation/reduced-motion behavior, and layout invariants within that independent workflow.

## Examples

- `{HARNESS_DIR}/iterations/iter-<plan-id>/guides/` (css-selector-verification / browser-harness-verification / agentflow-pipeline-verification) + `{SDD_DIR}/review/harness/` (self-contained pages, checklists, static-preverify + gen-harness scripts, browser-run evidence + screenshots).
- `{HARNESS_DIR}/iterations/iter-<plan-id>/guides/` — the three dual-theme verification guides are the zone-dashboard evidence records (kept as iteration snapshots; their methods are consolidated here): `panel-sidebar-dual-theme-verification.md` (sidebar/meta/enforcement, 46 PASS), `canvas-zones-dual-theme-verification.md` (three zones + footer + dock + layout invariants, 79 PASS), `agent-flow-zone-dual-theme-verification.md` (entities/edges + animation + reduced-motion, default ×2 + reduced-motion variant).
- Handle-era lesson (historical): react-flow 12.11.2 silently drops edges whose endpoint nodes expose no `<Handle>` — custom node types had to render invisible `<Handle>` elements; this class of runtime-only failure is why the harness exists. react-flow is now removed from the panel (negative bundle assertion in `scripts/build-client-bundle.ts`), and the zone dashboard's HTML/CSS structure is directly assertable.
