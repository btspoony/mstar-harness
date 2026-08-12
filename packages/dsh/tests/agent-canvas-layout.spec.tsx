/**
 * Canvas LAYOUT tests (plan 20260812-panel-f5-agent-layout Task 2 + plan
 * 20260812-panel-f5-design-system Task 5 — the render layer): the column /
 * sub-bucket rework of the agent canvas —
 *
 * - column order: the 4 EXPECTED_ROLE_FLOW stages ONLY — the standalone
 *   UNKNOWN column is REMOVED (Task 5, user 2026-08-12 feedback #3: FOUR
 *   columns total); `zone: 'general'` entities render in the "unknown /
 *   未匹配角色" SUB-PARTITION at the bottom of the LAST column
 *   (`data-sub-bucket="unknown"` + `layout.unknown` band geometry);
 * - the sdd-implement sub-buckets: implementor partition above (flow roles
 *   in stage original order, then the on-demand roles with the badge),
 *   reviewer partition (code-reviewer) below — `data-agent-bucket` rides the
 *   PROJECTED `entity.bucket`, the `data-sub-bucket` captions + the
 *   deterministic band geometry come from `layoutAgents.subBuckets`;
 * - the bidirectional supervise line (`data-agent-edge-supervise`): static
 *   presence, SIDE-GAP vertical anchors (card right edge + 18px — design
 *   doc §2.5/§2.7, clear of the "sdd-reviewer" caption H2) with band-EDGE
 *   y-extents (QC W-001), drawn as a bezier `C` path (`edgePath`); dim
 *   dashed without evidence, lit business with it
 *   (`data-agent-edge-supervise-lit` — the projected `evidenced` flag);
 * - the Task 5 edge rework: expected/next edges NEVER render; actual edges
 *   are bezier `C` curves anchored to the card PORTS (east/west/south/north
 *   edge midpoints) with the target STANDOFF 10px (arrow tip off the card,
 *   H1); caption-crossing same-column flows route in the LEFT side gap (H2);
 *   the 4 hover-visible port dots (`data-agent-port`) render per card;
 * - the Legend / locale sync (plan 20260813-panel-agent-canvas-legend-layout
 *   Task 1: ONLY the 3 role-card status entries; the 7 collaboration-edge /
 *   layout entries are gone).
 *
 * The projection layer (bucket fields, supervise edge data, zones, the
 * general-endpoint edge filter) is covered by client-graph-projection.spec.ts;
 * the general canvas render (roster, statuses, pan) stays in
 * client-panel.spec.tsx.
 *
 * Renderer: react-dom/server.renderToStaticMarkup over the real component
 * (the `*.module.css` import resolves to the raw file-path string under `bun
 * test`, so assertions pin `data-*` anchors + inline style / SVG geometry,
 * never class names).
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import type { MstarEngineStatusSource } from '../src/types'
import type { AgentFlowEventView, AgentFlowView } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { clientExports } from './client-bundles.ts'
import { Context } from '@deepseek-ai/cordis'
import { projectGraph } from '../src/client/panel/graph/project-graph'
import { KNOWN_AGENTS } from '../src/client/panel/graph/schema'
import {
  AgentCanvasPage,
  edgePath,
  layoutAgents,
  UNKNOWN_COLUMN,
  type CanvasLayout,
  type PanState,
} from '../src/client/panel/pages/AgentCanvasPage'
import { en, NS, zh } from '../src/client/panel/locale'

type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleService: LocaleServiceCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleService'>

/** One real LocaleService over a fresh cordis context. */
function newLocale(): LocaleService {
  return new LocaleServiceCtor(new Context())
}

/* ------------------------------ fixtures ------------------------------ */

/** Minimal catalog source: harness present, no agentFlow → the degraded
 * branch (full idle roster + expected skeleton + a STATIC supervise edge,
 * dimmed). */
const baseSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.1.1',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: {
    plans: [],
    residuals: [],
    residualFindings: null,
    iterationBaseBranch: null,
    targetBranch: null,
    specIntegrationBranch: null,
    pushPolicy: null,
    worktreeMode: null,
    controlWorktreePath: null,
    leases: [],
    knowledge: null,
    direction: null,
    agentFlow: null,
  },
}

/** One dispatch row as the T1 ledger view emits it (spec §2.2). */
function dispatchEvent(over: { ts: number; role: string; agent?: string; planId?: string; taskId?: string }): AgentFlowEventView {
  return {
    ts: over.ts,
    kind: 'dispatch',
    agent: over.agent ?? null,
    role: over.role,
    planId: over.planId ?? null,
    taskId: over.taskId ?? null,
    taskCategory: null,
  }
}

/** One settle row as the T1 ledger view emits it (spec §2.2 — carries the
 * PAIRED dispatch identity when `role` is given, plan
 * `20260811-panel-f4-timeliness` Task 1 — the settled-status fixtures need
 * the exact-identity pairing). */
function settleEvent(over: { ts: number; agent?: string; outcome?: 'ok' | 'error' | 'denied'; role?: string; planId?: string; taskId?: string }): AgentFlowEventView {
  return {
    ts: over.ts,
    kind: 'settle',
    agent: over.agent ?? null,
    role: over.role ?? '',
    planId: over.planId ?? null,
    taskId: over.taskId ?? null,
    taskCategory: null,
    ...(over.role !== undefined ? { paired: true } : {}),
    ...(over.outcome !== undefined ? { outcome: over.outcome } : {}),
  }
}

/** A source whose `state.agentFlow` carries the given events (latest-first). */
function flowSource(events: readonly unknown[]): MstarEngineStatusSource {
  return {
    ...baseSource,
    state: {
      ...baseSource.state!,
      agentFlow: { events, summary: [] } as unknown as AgentFlowView,
    },
  }
}

/** A PHASE-2 source (gate transition `phase-2-execute` → `currentStep` 2)
 * with the given ledger events — the emphasis-tier render tests need an
 * ACTIVE iteration (the base `flowSource` carries none → `currentStep`
 * null → no emphasis override). */
function phase2Source(events: readonly unknown[]): MstarEngineStatusSource {
  return {
    ...flowSource(events),
    iteration: {
      iterationId: 'iter-x',
      statusPath: '/proj/.mstar/status.json',
      compassPath: '/proj/.mstar/iterations/iter-x/delivery-compass.md',
      gate: {
        transition: 'phase-2-execute',
        all_plans_done: false,
        ok: true,
        entry: { ok: true, violations: [] },
        exit: { ok: true, violations: [] },
        violations: [],
      },
    },
  }
}

/** Render the AgentCanvasPage to static HTML (optional locale / pan seed). */
function agentsHtml(source: MstarEngineStatusSource, lang: 'en' | 'zh' = 'en', initialPan?: PanState): string {
  const locale = newLocale()
  locale.register(NS, { zh, en })
  locale.setLocale(lang)
  const view = projectGraph(source)
  return renderToStaticMarkup(createElement(AgentCanvasPage, {
    view: view.agents,
    iteration: view.iteration,
    t: locale.bind(NS),
    ...(initialPan !== undefined ? { initialPan } : {}),
  }))
}

/* ------------------------------ helpers ------------------------------ */

/** The SSR markup of one entity card (the `<li data-agent-entity=...>` region). */
function cardRegion(html: string, key: string): string {
  const start = html.indexOf(`data-agent-entity="${key}"`)
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('</li>', start)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

/** The `name="value"` attribute of an SVG element (order-independent extraction). */
function lineAttr(line: string, name: string): string {
  const m = line.match(new RegExp(`${name}="([^"]*)"`))
  expect(m, `${name} attribute`).not.toBeNull()
  return m![1]!
}

/** The first SVG `<path>` carrying the given attribute (anchor selector).
 * React SSR renders SVG paths with an explicit `</path>` close tag. */
function pathOf(html: string, attr: string): string {
  const start = html.indexOf(`${attr}="`)
  expect(start, `${attr} path`).toBeGreaterThan(-1)
  const tagStart = html.lastIndexOf('<path', start)
  const end = html.indexOf('</path>', tagStart)
  expect(end, `${attr} path close`).toBeGreaterThan(tagStart)
  return html.slice(tagStart, end)
}

/** Parse an SVG path `d` (`M x1 y1 C cx1 cy1, cx2 cy2, x2 y2`) into its
 * endpoint + control points. */
function parsePath(d: string): { x1: number; y1: number; x2: number; y2: number; cx1: number; cy1: number; cx2: number; cy2: number } {
  const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]!))
  expect(nums.length, `d has 8 numbers: ${d}`).toBeGreaterThanOrEqual(8)
  return { x1: nums[0]!, y1: nums[1]!, cx1: nums[2]!, cy1: nums[3]!, cx2: nums[4]!, cy2: nums[5]!, x2: nums[6]!, y2: nums[7]! }
}

/** Axis-aligned box overlap (the H2 geometry check). */
function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** The bezier convex-hull bounding box (the curve lies inside it) — design
 * doc §2.6: the curve never leaves the endpoint/control-point bbox. */
function curveBBox(g: { x1: number; y1: number; x2: number; y2: number; cx1: number; cy1: number; cx2: number; cy2: number }) {
  const xs = [g.x1, g.cx1, g.cx2, g.x2]
  const ys = [g.y1, g.cy1, g.cy2, g.y2]
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** The text seats of the deterministic layout (design doc §1.1 constants):
 * Phase group labels (plan 20260812-panel-f5-design-system Task 8 — the
 * two-band layout adds a group label row per phase) + column labels
 * (LABEL_H) + sub-bucket captions (SUB_LABEL_H). */
function textSeats(layout: CanvasLayout): { x: number; y: number; w: number; h: number }[] {
  const seats: { x: number; y: number; w: number; h: number }[] = []
  for (const group of layout.groups) seats.push({ ...group.label })
  for (const col of layout.columns) seats.push({ x: col.x, y: col.y, w: col.w, h: 18 }) // LABEL_H
  for (const geometry of layout.subBuckets.values()) {
    for (const p of [geometry.implementor, geometry.reviewer]) {
      if (p.band !== null) seats.push({ x: p.label.x, y: p.label.y, w: p.label.w, h: 14 }) // SUB_LABEL_H
    }
  }
  if (layout.unknown !== null && layout.unknown.band !== null) {
    seats.push({ x: layout.unknown.label.x, y: layout.unknown.label.y, w: layout.unknown.label.w, h: 14 })
  }
  return seats
}

/* ------------------------------ the tests ------------------------------ */

describe('agent canvas layout — columns & sub-buckets (plan f5 T2 + design-system T5)', () => {
  it('column order: the 4 flow stages ONLY — the standalone unknown column is REMOVED (T5)', () => {
    const html = agentsHtml(baseSource)
    const cols = [...html.matchAll(/data-canvas-column="([^"]+)"/g)].map((m) => m[1]!)
    expect(cols).toEqual([
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
    ])
    // Task 5 (user 2026-08-12 feedback #3): FOUR columns — the rightmost
    // UNKNOWN_COLUMN is gone (general sinks into the qa-gate column bottom).
    expect(cols).toHaveLength(4)
    expect(html).not.toContain('data-canvas-column="unknown"')
    // The standalone on-demand column is REMOVED (plan f5 Task 2).
    expect(html).not.toContain('data-canvas-column="on-demand"')
    // The zh labels localize (qa-gate column label stays the stage id).
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain('data-canvas-column="autonomous-execute:qa-gate"')
  })

  it('layoutAgents: the general card sinks into the LAST column (qa-gate) bottom unknown sub-partition', () => {
    const view = projectGraph(baseSource).agents
    const layout = layoutAgents(view)
    expect(layout.columns.map((c) => c.id)).toEqual([
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
    ])
    const last = layout.columns[layout.columns.length - 1]!
    expect(last.id).toBe('autonomous-execute:qa-gate')
    // The general card is INSIDE the last column, BELOW the qa-gate card
    // (qa-engineer) — the unknown sub-partition (design doc §1.2).
    const general = layout.cards.get('general')!
    const qa = layout.cards.get('qa-engineer')!
    expect(general.x).toBeGreaterThanOrEqual(last.x)
    expect(general.x).toBeLessThan(last.x + last.w)
    expect(general.y).toBeGreaterThan(qa.y + qa.h)
    // The unknown caption seat sits ROW_GAP below the last flow card.
    expect(layout.unknown).not.toBeNull()
    expect(layout.unknown!.label.y).toBe(qa.y + qa.h + 12) // ROW_GAP
    // On-demand idle roles land INSIDE the sdd-implement column (implementor
    // partition — no standalone column).
    const sdd = layout.columns[1]!
    for (const key of ['ops-engineer', 'prompt-engineer']) {
      const box = layout.cards.get(key)!
      expect(box.x).toBeGreaterThanOrEqual(sdd.x)
      expect(box.x).toBeLessThan(sdd.x + sdd.w)
    }
  })

  it('renders the unknown sub-partition caption (data-sub-bucket="unknown") with the「unknown / 未匹配角色」label', () => {
    const html = agentsHtml(baseSource)
    expect(html).toContain(`data-sub-bucket="${UNKNOWN_COLUMN}"`)
    expect(html).toContain('>unknown / unmatched roles<') // the caption text (en)
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain(`data-sub-bucket="${UNKNOWN_COLUMN}"`)
    expect(zhHtml).toContain('>unknown / 未匹配角色<')
  })

  it('implementor partition order: flow roles first (stage order), on-demand roles after, reviewer below', () => {
    const view = projectGraph(baseSource).agents
    const layout = layoutAgents(view)
    const y = (key: string) => layout.cards.get(key)!.y
    // Flow implementor roles in the stage's original EXPECTED_ROLE_FLOW order.
    expect(y('fullstack-dev')).toBeLessThan(y('fullstack-dev-2'))
    expect(y('fullstack-dev-2')).toBeLessThan(y('frontend-dev'))
    // On-demand roles AFTER the flow roles (implementor partition tail).
    expect(y('frontend-dev')).toBeLessThan(y('ops-engineer'))
    expect(y('ops-engineer')).toBeLessThan(y('prompt-engineer'))
    // The reviewer partition (code-reviewer) below every implementor card.
    expect(y('prompt-engineer')).toBeLessThan(y('code-reviewer'))
  })

  it('code-reviewer card rides the reviewer sub-bucket; implementor cards ride data-agent-bucket="implementor"', () => {
    const html = agentsHtml(baseSource)
    expect(cardRegion(html, 'code-reviewer')).toContain('data-agent-bucket="reviewer"')
    expect(cardRegion(html, 'fullstack-dev')).toContain('data-agent-bucket="implementor"')
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-bucket="implementor"')
    // The general card (bucket null) carries NO sub-bucket anchor.
    expect(cardRegion(html, 'general')).not.toContain('data-agent-bucket')
  })

  it('renders the implementor / sdd-reviewer sub-bucket captions (data-sub-bucket)', () => {
    const html = agentsHtml(baseSource)
    expect(html).toContain('data-sub-bucket="implementor"')
    expect(html).toContain('data-sub-bucket="reviewer"')
    expect(html).toContain('>implementor<') // the caption text (same in both locales)
    expect(html).toContain('>sdd-reviewer<')
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain('data-sub-bucket="implementor"')
    expect(zhHtml).toContain('data-sub-bucket="reviewer"')
  })

  it('on-demand badge: data-agent-on-demand on ops-engineer / prompt-engineer cards only', () => {
    const html = agentsHtml(baseSource)
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-on-demand="true"')
    expect(cardRegion(html, 'prompt-engineer')).toContain('data-agent-on-demand="true"')
    expect(html.match(/data-agent-on-demand="true"/g)).toHaveLength(2)
    // Negative pins: flow + reviewer cards never carry the badge.
    expect(cardRegion(html, 'fullstack-dev')).not.toContain('data-agent-on-demand')
    expect(cardRegion(html, 'code-reviewer')).not.toContain('data-agent-on-demand')
  })
})

describe('agent canvas layout — supervise line (plan 20260812-panel-f5-agent-layout T2)', () => {
  it('renders the static bidirectional supervise edge, dimmed without dispatch evidence', () => {
    const html = agentsHtml(baseSource) // degraded → no dispatch evidence
    // The anchor value embeds the column id + sub-bucket prefix (React SSR
    // escapes `>` in attribute values).
    expect(html).toContain(
      'data-agent-edge-supervise="autonomous-execute:sdd-implement:implementor-&gt;autonomous-execute:sdd-implement:reviewer"',
    )
    // No evidence → no lit marker.
    expect(html).not.toContain('data-agent-edge-supervise-lit')
  })

  it('anchors to the SIDE-GAP vertical anchors, not the card centers (edgePath contract: <col-id>:<bucket> → band edge at card right + 18px)', () => {
    const view = projectGraph(baseSource).agents
    const layout = layoutAgents(view)
    const sdd = layout.columns.find((c) => c.id === 'autonomous-execute:sdd-implement')!
    const geometry = layout.subBuckets.get(sdd.id)!
    const html = agentsHtml(baseSource)
    const path = pathOf(html, 'data-agent-edge-supervise')
    const d = parsePath(lineAttr(path, 'd'))
    // v3 side-gap anchor (design doc §2.5/§2.7): x = card RIGHT edge + 18px
    // — inside the column gap, clear of the "sdd-reviewer" caption (H2).
    const cardRight = sdd.x + (200 - 176) / 2 + 176 // COL_W/CARD_W centering
    expect(d.x1).toBe(cardRight + 18)
    expect(d.x2).toBe(cardRight + 18)
    // QC W-001: the supervise line anchors to the sub-bucket band EDGES —
    // implementor bottom edge → reviewer top edge — the inter-partition gap.
    expect(d.y1).toBe(geometry.implementor.band!.y + geometry.implementor.band!.h)
    expect(d.y2).toBe(geometry.reviewer.band!.y)
    // The line's vertical center is the inter-partition gap midpoint.
    const gapMid = (geometry.implementor.band!.y + geometry.implementor.band!.h + geometry.reviewer.band!.y) / 2
    expect((d.y1 + d.y2) / 2).toBe(gapMid)
    // A bezier `C` path (design doc §2.6) with collinear vertical controls
    // (the degenerate vertical flow → vertical endpoint tangents, H1).
    expect(lineAttr(path, 'd')).toContain('C ')
    expect(d.cx1).toBe(d.x1)
    expect(d.cx2).toBe(d.x2)
    // Bidirectional double arrow: marker-start + marker-end (auto-start-reverse).
    expect(lineAttr(path, 'marker-start')).toBe('url(#canvas-arrow-supervise)')
    expect(lineAttr(path, 'marker-end')).toBe('url(#canvas-arrow-supervise)')
  })

  it('lights the supervise line with SDD sub-bucket dispatch evidence (data-agent-edge-supervise-lit)', () => {
    const html = agentsHtml(flowSource([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })]))
    expect(html).toContain('data-agent-edge-supervise=')
    expect(html).toContain('data-agent-edge-supervise-lit="true"')
  })

  it('stays dim with dispatch evidence OUTSIDE the sub-buckets (qa-engineer)', () => {
    const html = agentsHtml(flowSource([dispatchEvent({ ts: 1, role: 'qa-engineer', agent: 'a1' })]))
    expect(html).toContain('data-agent-edge-supervise=')
    expect(html).not.toContain('data-agent-edge-supervise-lit')
  })
})

describe('agent canvas layout — legend & locale (plan 20260813-panel-agent-canvas-legend-layout T1)', () => {
  it('legend: ONLY the 3 role-card status entries render; the 7 collaboration-edge / layout entries are REMOVED', () => {
    const html = agentsHtml(baseSource)
    // Task 1 (图例精简): exactly the 3 entity-status entries, no others.
    const items = [...html.matchAll(/data-mstar-legend-item="([^"]+)"/g)].map((m) => m[1]!)
    expect(items).toEqual(['agent-running', 'agent-settled', 'agent-idle'])
    // The 7 collaboration-edge / layout entries are gone.
    for (const key of ['flow-actual', 'port', 'group', 'sub-bucket', 'supervise', 'on-demand', 'unknown']) {
      expect(html).not.toContain(`data-mstar-legend-item="${key}"`)
    }
    // Historical negative pins stay (expected / next / general never rendered).
    expect(html).not.toContain('data-mstar-legend-item="flow-expected"')
    expect(html).not.toContain('data-mstar-legend-item="next"')
    expect(html).not.toContain('data-mstar-legend-item="general"')
    // The surviving entries' labels (en).
    expect(html).toContain('agent running (glow)')
    expect(html).toContain('settled agent (green done frame + ✓; off-tier roles show neither)')
    expect(html).toContain('idle agent (dashed)')
    // zh labels localize.
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain('执行中实体（发光）')
    expect(zhHtml).toContain('已完成实体（独立绿框 + ✓；off 阶段不显示）')
    expect(zhHtml).toContain('未工作实体（虚线）')
  })
})

describe('agent canvas — Task 5 edge rework: bezier curves + card ports + H1/H2 (plan 20260812-panel-f5-design-system T5)', () => {
  it('actual edge: a forward flow anchors to the card PORTS (source east → target west) with the 10px standoff (H1)', () => {
    // fullstack-dev (sdd-implement) → qc-specialist (qc-tri), same plan.
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'qc-specialist', agent: 'a2', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    const path = pathOf(html, 'data-agent-edge-actual')
    expect(lineAttr(path, 'data-agent-edge-actual')).toBe('fullstack-dev-&gt;qc-specialist')
    const d = parsePath(lineAttr(path, 'd'))
    // Source EAST port: the card right-edge midpoint. Phase 2 group (Task 8
    // — the two-band layout): the sdd-implement column sits at x=24 (group
    // label y=360 → column y=390), the implementor caption pushes the first
    // card (fullstack-dev) to y=438 — 176×72 card → east port (212, 474).
    expect(d.x1).toBe(24 + 12 + 176) // card left (colX + centering) + CARD_W
    expect(d.y1).toBe(438 + 72 / 2)
    // Target WEST port standoff: 10px LEFT of the west edge (arrow tip off
    // the card — 不贴卡) at the target card's vertical midpoint. The qc-tri
    // column (x=280) is a PLAIN stack — its first card (qc-specialist) sits
    // at y = 390 + LABEL_H + COL_PAD = 420, center y = 456.
    const targetWest = 280 + 12 // qc-tri column x + card centering
    expect(d.x2).toBe(targetWest - 10)
    expect(d.y2).toBe(420 + 36)
    // Bezier `C` with the horizontal-flow control formula: off =
    // max(|dx|/2, 24) = 35 → c1 = (sx+35, sy) — horizontal endpoint tangents.
    expect(lineAttr(path, 'd')).toContain('C ')
    expect(d.cx1).toBe(d.x1 + Math.max(Math.abs(d.x2 - d.x1) / 2, 24))
    expect(d.cy1).toBe(d.y1)
    expect(d.cy2).toBe(d.y2)
    // Single arrow at the target (marker-end, orient=auto); no start marker.
    expect(lineAttr(path, 'marker-end')).toBe('url(#canvas-arrow-actual)')
    expect(path).not.toContain('marker-start')
  })

  it('actual edge: a reverse flow anchors source west → target east (standoff outside the east edge)', () => {
    // qc-specialist (qc-tri) → fullstack-dev (sdd-implement): source column >
    // target column → source WEST → target EAST.
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'qc-specialist', agent: 'a2', planId: 'plan-x' }),
    ]))
    const d = parsePath(lineAttr(pathOf(html, 'data-agent-edge-actual'), 'd'))
    expect(d.x1).toBe(280 + 12) // qc card WEST edge (left edge midpoint)
    expect(d.x2).toBe(24 + 12 + 176 + 10) // fullstack EAST edge + 10px standoff
    expect(d.y1).toBe(420 + 36) // qc-specialist (plain qc-tri column, first card)
    expect(d.y2).toBe(438 + 36) // fullstack-dev (sdd-implement, center y = 474)
  })

  it('actual edge: a same-column flow uses south → north ports with a center-x vertical bezier', () => {
    // fullstack-dev → fullstack-dev-2 (both sdd-implement implementor) — no
    // caption between them, so the center-x vertical line is clean (H2).
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'fullstack-dev-2', agent: 'a2', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    const d = parsePath(lineAttr(pathOf(html, 'data-agent-edge-actual'), 'd'))
    const cx = 24 + 12 + 176 / 2
    expect(d.x1).toBe(cx)
    expect(d.x2).toBe(cx) // center-x vertical
    expect(d.y1).toBe(438 + 72) // source south port (card bottom)
    expect(d.y2).toBe(522 - 4) // target north − reduced standoff (gap 12 → 4)
    // Vertical degenerate bezier: control points collinear with the endpoints.
    expect(d.cx1).toBe(cx)
    expect(d.cx2).toBe(cx)
  })

  it('actual edge: a caption-crossing same-column flow routes in the LEFT side gap (H2 — 同列关系线移到侧隙)', () => {
    // fullstack-dev (implementor) → code-reviewer (reviewer): the center-x
    // vertical line would cross the "sdd-reviewer" caption → the route hangs
    // at `card left edge − 18px` (design doc §2.0 绕行策略 ②).
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'code-reviewer', agent: 'r1', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    const d = parsePath(lineAttr(pathOf(html, 'data-agent-edge-actual'), 'd'))
    expect(d.x1).toBe(24 + 12 - 18) // card LEFT edge − SIDE_GAP (inside the gap)
    expect(d.x2).toBe(24 + 12 - 18)
    expect(d.y1).toBe(438 + 72) // source south edge level
    expect(d.y2).toBe(876 - 10) // target north − STANDOFF
  })

  it('actual edge: a REVERSE same-column flow (source below target) ends on the target SOUTH side, arrow pointing up — never through the cards (qc3 W-001)', () => {
    // The caption-free reverse pair fullstack-dev-2 → fullstack-dev: the
    // pair-dedupe keeps the latest direction, so the implementor-2 →
    // implementor rework collapses to this direction (source BELOW target).
    // The old code put the tip ABOVE the target (`targetBox.y − standoff`)
    // and ran the center-x line through BOTH card bodies (H1/H2 violation).
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev-2', agent: 'a2', planId: 'plan-x' }),
    ]))
    const d = parsePath(lineAttr(pathOf(html, 'data-agent-edge-actual'), 'd'))
    const cx = 24 + 12 + 176 / 2
    expect(d.x1).toBe(cx)
    expect(d.x2).toBe(cx) // center-x vertical
    // Direction-aware endpoints: source NORTH (its top edge) → target SOUTH
    // + standoff (below the target's bottom edge) — the tip lands on the
    // NEAR side of the target, pointing UP into it (old code: tip at
    // 438−2=436, above the target, pointing away).
    expect(d.y1).toBe(522) // source top (fullstack-dev-2 north port)
    expect(d.y2).toBe(510 + 4) // target bottom + reduced standoff (gap 12 → 4)
    // The endpoint tangent points UP toward the target card (the bezier's
    // end control sits BELOW the endpoint, qc3 W-001 "tangent toward card").
    expect(d.cy2).toBeGreaterThan(d.y2)
    // The curve stays in the inter-card gap (510..522) — no segment crosses
    // either card body (H2): the bbox never overlaps the source or target box.
    const bbox = curveBBox(d)
    expect(overlaps(bbox, { x: 24 + 12, y: 438, w: 176, h: 72 })).toBe(false) // target fullstack-dev
    expect(overlaps(bbox, { x: 24 + 12, y: 522, w: 176, h: 72 })).toBe(false) // source fullstack-dev-2
  })

  it('actual edge: the REVERSE rework collapse (code-reviewer → fullstack-dev) reroutes in the side gap with the tip on the target SOUTH side (qc3 W-001)', () => {
    // The implement → review → rework cycle (fullstack-dev → code-reviewer →
    // fullstack-dev) collapses to the LATEST direction: code-reviewer →
    // fullstack-dev — a same-column edge whose source sits BELOW the target.
    // The center-x line would cross the "sdd-reviewer" caption → the side-gap
    // route (H2); the old code ended the line ABOVE the target's north edge
    // (tip pointing away at empty space) and started at the source's BOTTOM.
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 3, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
      dispatchEvent({ ts: 2, role: 'code-reviewer', agent: 'r1', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    const path = pathOf(html, 'data-agent-edge-actual')
    expect(lineAttr(path, 'data-agent-edge-actual')).toBe('code-reviewer-&gt;fullstack-dev')
    const d = parsePath(lineAttr(path, 'd'))
    expect(d.x1).toBe(24 + 12 - 18) // card LEFT edge − SIDE_GAP (side-gap route)
    expect(d.x2).toBe(24 + 12 - 18)
    // Direction-aware: source NORTH (code-reviewer top, 876) → target SOUTH +
    // standoff (fullstack bottom 510 + 10) — the tip lands BELOW the target,
    // pointing UP into it (old code: start at the source BOTTOM 948, tip at
    // 438−10=428 above the target).
    expect(d.y1).toBe(876)
    expect(d.y2).toBe(510 + 10)
    expect(d.cy2).toBeGreaterThan(d.y2) // end tangent points UP toward the card
    // The line hangs LEFT of both cards (x=18 < card left 36) — no card-body
    // crossing (H2).
    const bbox = curveBBox(d)
    expect(overlaps(bbox, { x: 24 + 12, y: 438, w: 176, h: 72 })).toBe(false) // target fullstack-dev
    expect(overlaps(bbox, { x: 24 + 12, y: 876, w: 176, h: 72 })).toBe(false) // source code-reviewer
  })

  it('arrow markers are pinned to a fixed 6px user-space body — the same-column standoff clears the source card for the REAL marker extents (qc2 F-001)', () => {
    // qc2 F-001: the old markers used the strokeWidth-scaled default
    // (markerUnits unset → "strokeWidth") — a 10×10 viewBox / refX=9 marker
    // at stroke-width 1.5 rendered ~9.45px long, so the `gap − 8` standoff
    // left the arrow base INSIDE the source card (the comment claimed a 7px
    // arrow). The markers are now pinned to userSpaceOnUse with an exact
    // 6px body, so the geometry math holds for the real extents.
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'fullstack-dev-2', agent: 'a2', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    // Marker defs: extract each marker's opening tag (the static SVG defs
    // always render, independent of the view state).
    const markerTag = (id: string): string => {
      const start = html.indexOf(`id="${id}"`)
      expect(start, `${id} marker def`).toBeGreaterThan(-1)
      const tagStart = html.lastIndexOf('<marker', start)
      const end = html.indexOf('>', start)
      expect(end, `${id} marker close`).toBeGreaterThan(tagStart)
      return html.slice(tagStart, end)
    }
    for (const id of ['canvas-arrow-actual', 'canvas-arrow-supervise', 'canvas-arrow-supervise-lit']) {
      const tag = markerTag(id)
      // Pinned user-space size: markerUnits=userSpaceOnUse + 1:1 viewBox
      // (markerWidth == viewBox width, tip at refX 6) → the rendered arrow
      // body is EXACTLY 6px long, independent of the stroke-width.
      expect(tag, `${id} markerUnits`).toContain('markerUnits="userSpaceOnUse"')
      expect(tag).toContain('viewBox="0 0 6 8"')
      expect(tag).toContain('refX="6"')
      expect(tag).toContain('markerWidth="6"')
    }
    // The forward same-column edge (fullstack-dev → fullstack-dev-2):
    // standoff = gap − 8 = 4 (tip 4px off the target north edge); the pinned
    // 6px arrow body extends BACKWARD from the tip (up toward the source) →
    // base at tip − 6 = 512, EXACTLY 2px clear of the source card bottom
    // (510). The comment's "base ≥ 2px clear" claim now matches the REAL
    // marker extents (old code: ~9.45px marker → base at 508.55, 1.45px INTO
    // the source card).
    const d = parsePath(lineAttr(pathOf(html, 'data-agent-edge-actual'), 'd'))
    expect(d.y1).toBe(438 + 72) // source south port
    expect(d.y2).toBe(522 - 4) // target north − reduced standoff (gap 12 → 4)
    const arrowLen = 6 // the pinned marker body (refX in the 1:1 userSpaceOnUse viewBox)
    expect(d.y2 - arrowLen).toBe(438 + 72 + 2) // base exactly 2px clear of the source bottom
  })

  it('expected / next edge anchors NEVER render (design doc §2.2 — 简洁化)', () => {
    for (const source of [baseSource, flowSource([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })])]) {
      const html = agentsHtml(source)
      expect(html).not.toContain('data-agent-edge-expected')
      expect(html).not.toContain('data-agent-edge-next')
    }
    // The removed expected/next markers are gone from the SVG defs too.
    expect(agentsHtml(baseSource)).not.toContain('canvas-arrow-expected')
    expect(agentsHtml(baseSource)).not.toContain('canvas-arrow-next')
  })

  it('ports: every card renders the 4 fixed edge-midpoint anchors (data-agent-port)', () => {
    const html = agentsHtml(baseSource)
    expect(html.match(/data-agent-port="/g)).toHaveLength(KNOWN_AGENTS.length * 4)
    for (const port of ['north', 'south', 'west', 'east']) {
      expect(html.match(new RegExp(`data-agent-port="${port}"`, 'g'))).toHaveLength(KNOWN_AGENTS.length)
    }
    // A sample card carries all four (the general card — the unknown partition).
    const region = cardRegion(html, 'general')
    for (const port of ['north', 'south', 'west', 'east']) {
      expect(region).toContain(`data-agent-port="${port}"`)
    }
  })

  it('H2 geometry: no edge curve bbox intersects any text seat (column labels / sub-bucket captions / unknown caption)', () => {
    // A mixed view: forward + reverse cross-column flows, a caption-crossing
    // same-column flow (side-gap route) and the supervise line.
    const view = projectGraph(flowSource([
      dispatchEvent({ ts: 40, role: 'code-reviewer', agent: 'r1', planId: 'plan-x' }),
      dispatchEvent({ ts: 30, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
      dispatchEvent({ ts: 20, role: 'qc-specialist', agent: 'a2', planId: 'plan-x' }),
      dispatchEvent({ ts: 10, role: 'frontend-dev', agent: 'a3', planId: 'plan-x' }),
    ])).agents
    const layout = layoutAgents(view)
    // The view must actually exercise all three routing shapes.
    expect(view.edges.filter((e) => e.kind === 'actual')).toHaveLength(3)
    expect(view.edges.filter((e) => e.kind === 'supervise')).toHaveLength(1)
    const seats = textSeats(layout)
    expect(seats.length).toBeGreaterThan(0)
    for (const edge of view.edges) {
      const g = edgePath(edge, layout)
      if (g === null) continue
      const bbox = curveBBox(parsePath(g.d))
      for (const seat of seats) {
        expect(overlaps(bbox, seat), `${edge.kind} ${edge.source}->${edge.target} vs text seat`).toBe(false)
      }
    }
  })
})

describe('agent canvas — emphasis tiers (plan 20260812-panel-f5-design-system T4, design doc §3)', () => {
  it('Phase 2: autonomous-execute cards current, review-edit-chain + on-demand/general off (data-agent-emphasis)', () => {
    const html = agentsHtml(phase2Source([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })]))
    // Lit AND idle cards both carry the PROJECTED tier (idle fullstack-dev
    // would also be current — its KNOWN_AGENTS stage is autonomous-execute).
    expect(cardRegion(html, 'fullstack-dev')).toContain('data-agent-emphasis="current"')
    expect(cardRegion(html, 'product-manager')).toContain('data-agent-emphasis="off"')
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-emphasis="off"')
    expect(cardRegion(html, 'general')).toContain('data-agent-emphasis="off"')
  })

  it('Phase 1: review-edit-chain current, autonomous-execute next (the only phase with a next tier)', () => {
    const phase1 = agentsHtml({
      ...phase2Source([dispatchEvent({ ts: 1, role: 'product-manager', agent: 'pm1' })]),
      iteration: { ...phase2Source([]).iteration!, compassStatus: 'active' },
    })
    expect(cardRegion(phase1, 'product-manager')).toContain('data-agent-emphasis="current"')
    expect(cardRegion(phase1, 'fullstack-dev')).toContain('data-agent-emphasis="next"')
    expect(cardRegion(phase1, 'ops-engineer')).toContain('data-agent-emphasis="off"')
  })

  it('no iteration (currentStep null): NO card carries data-agent-emphasis — the no-override case', () => {
    const html = agentsHtml(baseSource) // no iteration section at all
    expect(html.match(/data-agent-emphasis=/g)).toBeNull()
  })

  it('status point stays OPAQUE on an emphasized card — zero whole-card opacity (design doc §3.4 HARD)', () => {
    // A RUNNING on-demand card during Phase 2: emphasis 'off' (stage null)
    // × status 'running' — the time (emphasis) and evidence (status)
    // dimensions stack independently (design doc §3.1/§3.4).
    const html = agentsHtml(phase2Source([dispatchEvent({ ts: 1, role: 'ops-engineer', agent: 'o1' })]))
    const region = cardRegion(html, 'ops-engineer')
    expect(region).toContain('data-agent-emphasis="off"')
    expect(region).toContain('data-agent-status="running"')
    // The fade lives in the chrome COLOR mix (color-mix toward the layer
    // background) — never in an `opacity` property, because a whole-card
    // opacity would fade the status point and the running glow with it (the
    // HARD rule). Pin: no `opacity` anywhere in the card markup (the inline
    // `style` carries left/top/width/height only).
    expect(region).not.toContain('opacity')
  })
})

describe('agent canvas — Phase 1/2 groups + current-plan annotation (plan 20260812-panel-f5-design-system T8, user feedback #2)', () => {
  /** A phase-2 source whose state.plans carries the given InProgress rows. */
  function planSource(inProgress: string[]): MstarEngineStatusSource {
    return {
      ...phase2Source([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })]),
      state: {
        ...baseSource.state!,
        plans: [
          ...inProgress.map((id) => ({ id, status: 'InProgress', doneAt: null })),
          { id: 'plan-done', status: 'Done', doneAt: '2026-08-08' },
        ],
      },
    }
  }

  it('two group anchors in stage order: Phase 1 (iteration-start) ABOVE, Phase 2 (autonomous-execute) BELOW', () => {
    const view = projectGraph(baseSource).agents
    const layout = layoutAgents(view)
    // The groups split the 4 columns by phase: Phase 1 = review-edit-chain,
    // Phase 2 = sdd-implement / qc-tri / qa-gate.
    expect(layout.groups.map((g) => g.phase)).toEqual(['iteration-start', 'autonomous-execute'])
    expect(layout.groups.map((g) => g.index)).toEqual([1, 2])
    expect(layout.groups.map((g) => g.columnIds)).toEqual([
      ['iteration-start:review-edit-chain'],
      ['autonomous-execute:sdd-implement', 'autonomous-execute:qc-tri', 'autonomous-execute:qa-gate'],
    ])
    // Phase 2 group carries the plan-note host; Phase 1 does not.
    expect(layout.groups.map((g) => g.planNote)).toEqual([false, true])
    // The Phase 1 band sits ABOVE the Phase 2 band (label rows + column bands).
    const [g1, g2] = layout.groups
    expect(g1!.label.y).toBeLessThan(g2!.label.y)
    const review = layout.columns.find((c) => c.id === 'iteration-start:review-edit-chain')!
    const sdd = layout.columns.find((c) => c.id === 'autonomous-execute:sdd-implement')!
    expect(review.y).toBeLessThan(sdd.y)
    // The Phase-2 group label row sits between the two column bands.
    expect(review.y + review.h).toBeLessThan(g2!.label.y)
    expect(g2!.label.y).toBeLessThan(sdd.y)
    // Width = the widest group (Phase 2: 3 columns); the canvas is narrower
    // than the old single-row 4-column layout.
    expect(layout.width).toBe(24 + 3 * (200 + 56) - 56 + 24)
    // Column x positions: the sdd-implement column is back at PAD_X (24) —
    // the same x as the review-edit-chain column ABOVE it (the y bands
    // disambiguate; `columnIndexOfBox` is y-aware, T8).
    expect(sdd.x).toBe(24)
    expect(review.x).toBe(24)
  })

  it('renders the group labels: Phase 1 label + Phase 2 label with the CURRENT-PLAN chip (data-canvas-group-plan)', () => {
    const html = agentsHtml(planSource(['20260812-panel-f5-design-system']))
    expect(html).toContain('data-canvas-group="iteration-start"')
    expect(html).toContain('data-canvas-group-index="1"')
    expect(html).toContain('data-canvas-group="autonomous-execute"')
    expect(html).toContain('data-canvas-group-index="2"')
    expect(html).toContain('Phase 1 · sequential (review-edit-chain)')
    expect(html).toContain('Phase 2 · iterative plan loop')
    // The Phase-2 annotation chip carries the FIRST InProgress plan id.
    expect(html).toContain('data-canvas-group-plan="20260812-panel-f5-design-system"')
    expect(html).toContain('plan: 20260812-panel-f5-design-system')
    // Phase 1 carries no plan chip.
    expect(html).not.toContain('data-canvas-group-no-plan')
    // zh labels localize.
    const zhHtml = agentsHtml(planSource(['20260812-panel-f5-design-system']), 'zh')
    expect(zhHtml).toContain('Phase 1 · 顺序完成（review-edit-chain）')
    expect(zhHtml).toContain('Phase 2 · 循环迭代 plans')
    expect(zhHtml).toContain('plan: 20260812-panel-f5-design-system')
  })

  it('no InProgress plan → the muted「no in-progress plan」note, no plan chip', () => {
    const html = agentsHtml(planSource([]))
    expect(html).not.toContain('data-canvas-group-plan=')
    expect(html).toContain('data-canvas-group-no-plan')
    expect(html).toContain('no in-progress plan')
    // A state with NO plans array at all degrades the same way (total function).
    expect(agentsHtml(phase2Source([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })]))).toContain('data-canvas-group-no-plan')
  })

  it('several InProgress plans → the FIRST id + the honest `+N more` count', () => {
    const html = agentsHtml(planSource(['plan-a', 'plan-b', 'plan-c']))
    expect(html).toContain('data-canvas-group-plan="plan-a"')
    expect(html).toContain('plan: plan-a')
    expect(html).toContain('data-canvas-group-plan-more')
    expect(html).toContain('+2 more')
    // Single InProgress → no more-count.
    expect(agentsHtml(planSource(['plan-a']))).not.toContain('data-canvas-group-plan-more')
  })

  it('the degraded branch (no agentFlow) still annotates the current plan — the note rides state.plans, not the ledger', () => {
    // baseSource has no agentFlow → the degraded canvas; with an InProgress
    // plan the Phase-2 note still renders.
    const html = agentsHtml({
      ...planSource(['plan-x']),
      state: { ...planSource(['plan-x']).state!, agentFlow: null },
    })
    expect(html).toContain('data-canvas-note="degraded"')
    expect(html).toContain('data-canvas-group-plan="plan-x"')
  })
})

describe('agent canvas — inter-band edge routing (plan 20260812-panel-f5-design-system T8, H2)', () => {
  it('a Phase 1 → Phase 2 handoff (writing-specialist → fullstack-dev) reroutes via the LEFT side gap — never crosses the Phase-2 group label row (H2)', () => {
    // writing-specialist (Phase 1, review-edit-chain) → fullstack-dev (Phase
    // 2, sdd-implement), same plan — the DIRECT horizontal bezier's bbox
    // would cross the Phase-2 group label + the sdd-implement column label
    // rows, so the side-gap vertical reroute (source SOUTH → target NORTH at
    // card left − SIDE_GAP) takes over.
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'writing-specialist', agent: 'w1', planId: 'plan-x' }),
    ]))
    const d = parsePath(lineAttr(pathOf(html, 'data-agent-edge-actual'), 'd'))
    // Source south → target north in the LEFT side gap (x = card left − 18).
    // The review-edit-chain column is a PLAIN stack (entity order — the lit
    // writing-specialist card is FIRST, y=84), so its south port is 156.
    expect(d.x1).toBe(24 + 12 - 18)
    expect(d.x2).toBe(24 + 12 - 18)
    expect(d.y1).toBe(84 + 72) // writing-specialist south (the first Phase-1 card)
    expect(d.y2).toBe(438 - 10) // fullstack-dev north − STANDOFF
    // The bbox of the rerouted line never intersects ANY label seat (H2 —
    // the line hangs LEFT of every label row: x=18 < all label x≥24).
    const layout = layoutAgents(projectGraph(flowSource([
      dispatchEvent({ ts: 2, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'writing-specialist', agent: 'w1', planId: 'plan-x' }),
    ])).agents)
    for (const seat of textSeats(layout)) {
      expect(overlaps({ x: d.x1, y: d.y1, w: 0, h: d.y2 - d.y1 }, seat)).toBe(false)
    }
  })

  it('a direct Phase-2 cross-column flow stays a horizontal bezier (no label between the cards)', () => {
    // fullstack-dev → qc-specialist — both Phase 2 bands, horizontal line at
    // the card centers — no label row in between → the direct curve holds.
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'qc-specialist', agent: 'a2', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    const d = parsePath(lineAttr(pathOf(html, 'data-agent-edge-actual'), 'd'))
    expect(d.cy1).toBe(d.y1) // horizontal endpoint tangent — NOT the side-gap vertical
    expect(d.cx1).not.toBe(d.x1)
    expect(d.x1).toBe(24 + 12 + 176) // source east port
  })
})

describe('agent canvas — settled done frame + off interaction (plan 20260812-panel-f5-design-system T8, user feedback #1/#3)', () => {
  it('settled + emphasis current → the green done frame marker + the green ✓ (data-agent-done="true")', () => {
    // Phase 2: fullstack-dev settled (paired settle) + emphasis 'current' →
    // the completion marker shows.
    const html = agentsHtml(phase2Source([
      settleEvent({ ts: 2, agent: 'a1', outcome: 'ok', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
    ]))
    const region = cardRegion(html, 'fullstack-dev')
    expect(region).toContain('data-agent-status="settled"')
    expect(region).toContain('data-agent-emphasis="current"')
    expect(region).toContain('data-agent-done="true"')
    expect(region).toContain('>✓<') // the green checkmark renders
  })

  it('settled + emphasis null (no iteration) → still done: the pre-T4 settled ✓ survives', () => {
    // No iteration → emphasis null → `settled && null !== 'off'` → done.
    const html = agentsHtml(flowSource([
      settleEvent({ ts: 2, agent: 'a1', outcome: 'ok', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
    ]))
    const region = cardRegion(html, 'fullstack-dev')
    expect(region).toContain('data-agent-status="settled"')
    expect(region).not.toContain('data-agent-emphasis=')
    expect(region).toContain('data-agent-done="true"')
    expect(region).toContain('>✓<')
  })

  it('settled + emphasis off → NO completion marker: the card is data-agent-done="false" with no ✓ (feedback #3)', () => {
    // Phase 2: a review-edit-chain role (product-manager) settled — its
    // stage phase (iteration-start) is ALREADY PASSED → emphasis 'off' → the
    // ✓ must NOT render (the v3 leak: the ✓ survived the off-tier low
    // transparency).
    const html = agentsHtml(phase2Source([
      settleEvent({ ts: 2, agent: 'pm1', outcome: 'ok', role: 'product-manager', planId: 'plan-x', taskId: 'T1' }),
      dispatchEvent({ ts: 1, role: 'product-manager', agent: 'pm1', planId: 'plan-x', taskId: 'T1' }),
    ]))
    const region = cardRegion(html, 'product-manager')
    expect(region).toContain('data-agent-status="settled"')
    expect(region).toContain('data-agent-emphasis="off"')
    expect(region).toContain('data-agent-done="false"')
    expect(region).not.toContain('>✓<')
    expect(region).not.toContain('data-agent-done="true"')
    // The status point still reports the honest status (no ✓ glyph, muted dot).
    expect(region).toContain('data-agent-status="settled"')
  })

  it('off-tier settled + running siblings: only the off card loses the ✓ (whole-canvas count)', () => {
    // Phase 2: product-manager settled (off) + fullstack-dev settled
    // (current) + qc-specialist running — exactly ONE green ✓ on the canvas.
    const html = agentsHtml(phase2Source([
      settleEvent({ ts: 30, agent: 'a2', outcome: 'ok', role: 'qc-specialist', planId: 'plan-x', taskId: 'T3' }),
      dispatchEvent({ ts: 29, role: 'qc-specialist', agent: 'a2', planId: 'plan-x', taskId: 'T3' }),
      settleEvent({ ts: 20, agent: 'a1', outcome: 'ok', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1' }),
      dispatchEvent({ ts: 19, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
      settleEvent({ ts: 10, agent: 'pm1', outcome: 'ok', role: 'product-manager', planId: 'plan-x', taskId: 'T2' }),
      dispatchEvent({ ts: 9, role: 'product-manager', agent: 'pm1', planId: 'plan-x', taskId: 'T2' }),
    ]))
    // Exactly the two CURRENT-tier settled cards carry the green ✓ (the off
    // product-manager shows neither). `data-agent-done="true"` appears TWICE
    // per done card (the card frame + the ✓ span) — the ✓ glyph is the
    // completion marker count.
    expect(html.match(/>✓</g)).toHaveLength(2)
    expect(html.match(/data-agent-done="true" data-agent-stage/g)).toHaveLength(2) // the card-level frame
    expect(cardRegion(html, 'product-manager')).toContain('data-agent-done="false"')
  })
})
