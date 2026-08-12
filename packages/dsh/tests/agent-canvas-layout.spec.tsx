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
 * - the Legend / locale sync (port entry, unknown sub-partition wording;
 *   the expected/next entries are gone).
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
import { Context } from 'cordis'
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
  return renderToStaticMarkup(createElement(AgentCanvasPage, {
    view: projectGraph(source).agents,
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
 * column labels (LABEL_H) + sub-bucket captions (SUB_LABEL_H). */
function textSeats(layout: CanvasLayout): { x: number; y: number; w: number; h: number }[] {
  const seats: { x: number; y: number; w: number; h: number }[] = []
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

describe('agent canvas layout — legend & locale (plan f5 T2 + design-system T5)', () => {
  it('legend: the port entry joins; expected/next entries are REMOVED; unknown rewords to the sub-partition', () => {
    const html = agentsHtml(baseSource)
    // Task 5 (design doc §2.8): expected + next legend entries are gone.
    expect(html).not.toContain('data-mstar-legend-item="flow-expected"')
    expect(html).not.toContain('data-mstar-legend-item="next"')
    for (const key of ['flow-actual', 'port', 'sub-bucket', 'supervise', 'on-demand', 'unknown', 'agent-running', 'agent-settled', 'agent-idle']) {
      expect(html).toContain(`data-mstar-legend-item="${key}"`)
    }
    expect(html).not.toContain('data-mstar-legend-item="general"')
    expect(html).toContain('unknown partition (bottom of the qa-gate column · unmatched / general roles)')
    expect(html).toContain('implementor ↔ sdd-reviewer bidirectional supervise line (side-gap vertical anchor)')
    expect(html).toContain('card ports (hover-visible · 4 fixed anchors · line ends at the standoff, off the card)')
    expect(html).toContain('on-demand role (implementor sub-bucket badge)')
    // zh labels localize.
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain('sdd-implement 子桶（implementor / sdd-reviewer）')
    expect(zhHtml).toContain('implementor ↔ sdd-reviewer 双向监督线（侧隙垂直锚点）')
    expect(zhHtml).toContain('unknown 分区（qa-gate 列底部 · 未匹配 / general 角色）')
    expect(zhHtml).toContain('按需执行角色（implementor 子桶徽标）')
    expect(zhHtml).toContain('卡片端口（hover 显示 · 4 固定锚点 · 线止于 standoff 不贴卡）')
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
    // Source EAST port: the card right-edge midpoint (fullstack-dev card at
    // sdd-implement x=292, y=72 — the implementor caption pushes the first
    // card below the plain-column start — 176×72).
    expect(d.x1).toBe(292 + 176)
    expect(d.y1).toBe(72 + 72 / 2)
    // Target WEST port standoff: 10px LEFT of the west edge (arrow tip off
    // the card — 不贴卡) at the target card's vertical midpoint. The qc-tri
    // column is a PLAIN stack — its first card (qc-specialist) sits at
    // PAD_Y + LABEL_H + COL_PAD = 54, center y = 90.
    const targetWest = 536 + 12 // qc-tri column x + card centering
    expect(d.x2).toBe(targetWest - 10)
    expect(d.y2).toBe(54 + 36)
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
    expect(d.x1).toBe(536 + 12) // qc card WEST edge (left edge midpoint)
    expect(d.x2).toBe(292 + 176 + 10) // fullstack EAST edge + 10px standoff
    expect(d.y1).toBe(54 + 36) // qc-specialist (plain qc-tri column, first card)
    expect(d.y2).toBe(72 + 36) // fullstack-dev (sdd-implement, center y = 108)
  })

  it('actual edge: a same-column flow uses south → north ports with a center-x vertical bezier', () => {
    // fullstack-dev → fullstack-dev-2 (both sdd-implement implementor) — no
    // caption between them, so the center-x vertical line is clean (H2).
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'fullstack-dev-2', agent: 'a2', planId: 'plan-x' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    const d = parsePath(lineAttr(pathOf(html, 'data-agent-edge-actual'), 'd'))
    const cx = 292 + 176 / 2
    expect(d.x1).toBe(cx)
    expect(d.x2).toBe(cx) // center-x vertical
    expect(d.y1).toBe(72 + 72) // source south port (card bottom)
    expect(d.y2).toBe(156 - 4) // target north − reduced standoff (gap 12 → 4)
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
    expect(d.x1).toBe(292 - 18) // card LEFT edge − SIDE_GAP (inside the gap)
    expect(d.x2).toBe(292 - 18)
    expect(d.y1).toBe(72 + 72) // source south edge level
    expect(d.y2).toBe(510 - 10) // target north − STANDOFF
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
