/**
 * Canvas LAYOUT tests (plan 20260812-panel-f5-agent-layout Task 2 — the
 * render layer): the column / sub-bucket rework of the agent canvas —
 *
 * - column order: the 4 EXPECTED_ROLE_FLOW stages + the rightmost UNKNOWN
 *   column (`data-canvas-column` order); the standalone on-demand column is
 *   GONE (zone 'on-demand' entities live in the sdd-implement implementor
 *   partition);
 * - the sdd-implement sub-buckets: implementor partition above (flow roles
 *   in stage original order, then the on-demand roles with the badge),
 *   reviewer partition (code-reviewer) below — `data-agent-bucket` rides the
 *   PROJECTED `entity.bucket`, the `data-sub-bucket` captions + the
 *   deterministic band geometry come from `layoutAgents.subBuckets`;
 * - the general bucket in the rightmost unknown column (the F4.2 sink inside
 *   the sdd-implement column is superseded);
 * - the bidirectional supervise line (`data-agent-edge-supervise`): static
 *   presence, band-EDGE anchors in the inter-partition gap (edgeLine — QC
 *   W-001: implementor band bottom → reviewer band top, so the outward
 *   arrowheads render clear of the opaque cards), dim dashed without
 *   evidence, lit business with it (`data-agent-edge-supervise-lit` — the
 *   projected `evidenced` flag, never a render-side fabrication);
 * - the Legend / locale sync (sub-bucket / supervise / unknown entries).
 *
 * The projection layer (bucket fields, supervise edge data, zones) is
 * covered by client-graph-projection.spec.ts; the general canvas render
 * (roster, statuses, pan, expected/actual/next edges) stays in
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
import {
  AgentCanvasPage,
  layoutAgents,
  UNKNOWN_COLUMN,
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

/** The `name="value"` attribute of an SVG line (order-independent extraction). */
function lineAttr(line: string, name: string): string {
  const m = line.match(new RegExp(`${name}="([^"]*)"`))
  expect(m, `${name} attribute on <line>`).not.toBeNull()
  return m![1]!
}

/* ------------------------------ the tests ------------------------------ */

describe('agent canvas layout — columns & sub-buckets (plan 20260812-panel-f5-agent-layout T2)', () => {
  it('column order: 4 flow stages + the rightmost unknown column; NO on-demand column', () => {
    const html = agentsHtml(baseSource)
    const cols = [...html.matchAll(/data-canvas-column="([^"]+)"/g)].map((m) => m[1]!)
    expect(cols).toEqual([
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
      UNKNOWN_COLUMN,
    ])
    expect(cols[cols.length - 1]).toBe(UNKNOWN_COLUMN)
    // The standalone on-demand column is REMOVED (plan f5 Task 2).
    expect(html).not.toContain('data-canvas-column="on-demand"')
    // The unknown column label localizes (zh).
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain('data-canvas-column="unknown"')
    expect(zhHtml).toContain('>未知<')
  })

  it('layoutAgents: the general card sits in the rightmost unknown column; on-demand roles live inside sdd-implement', () => {
    const view = projectGraph(baseSource).agents
    const layout = layoutAgents(view)
    const unknown = layout.columns[layout.columns.length - 1]!
    expect(unknown.id).toBe(UNKNOWN_COLUMN)
    const general = layout.cards.get('general')!
    expect(general.x).toBeGreaterThanOrEqual(unknown.x)
    expect(general.x).toBeLessThan(unknown.x + unknown.w)
    // The general card is NOT inside the sdd-implement column anymore (the
    // F4.2 sink is superseded — the unknown column comes AFTER it).
    const sdd = layout.columns[1]!
    expect(general.x).toBeGreaterThanOrEqual(sdd.x + sdd.w)
    // On-demand idle roles land INSIDE the sdd-implement column (implementor
    // partition — no standalone column).
    for (const key of ['ops-engineer', 'prompt-engineer']) {
      const box = layout.cards.get(key)!
      expect(box.x).toBeGreaterThanOrEqual(sdd.x)
      expect(box.x).toBeLessThan(sdd.x + sdd.w)
    }
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

  it('anchors to the inter-partition gap, not the card centers (edgeLine contract: <col-id>:<bucket> → band edge)', () => {
    const view = projectGraph(baseSource).agents
    const layout = layoutAgents(view)
    const sdd = layout.columns.find((c) => c.id === 'autonomous-execute:sdd-implement')!
    const geometry = layout.subBuckets.get(sdd.id)!
    const html = agentsHtml(baseSource)
    const line = html.match(/<line[^>]*data-agent-edge-supervise="[^"]*"[^>]*>/)![0]
    const cx = sdd.x + sdd.w / 2
    // QC W-001: the supervise line anchors to the sub-bucket band EDGES —
    // implementor bottom edge → reviewer top edge — the inter-partition gap
    // (NOT the card centers / band midpoints the opaque cards occlude).
    // Both endpoints stay on the column center.
    expect(Number(lineAttr(line, 'x1'))).toBe(cx)
    expect(Number(lineAttr(line, 'x2'))).toBe(cx)
    expect(Number(lineAttr(line, 'y1'))).toBe(geometry.implementor.band!.y + geometry.implementor.band!.h)
    expect(Number(lineAttr(line, 'y2'))).toBe(geometry.reviewer.band!.y)
    // The line's vertical center is the inter-partition gap midpoint (the
    // ~30 px row between the two bands) — it never crosses the card bodies.
    const gapMid = (geometry.implementor.band!.y + geometry.implementor.band!.h + geometry.reviewer.band!.y) / 2
    expect((Number(lineAttr(line, 'y1')) + Number(lineAttr(line, 'y2'))) / 2).toBe(gapMid)
    // Bidirectional double arrow: marker-start + marker-end (auto-start-reverse).
    expect(lineAttr(line, 'marker-start')).toBe('url(#canvas-arrow-supervise)')
    expect(lineAttr(line, 'marker-end')).toBe('url(#canvas-arrow-supervise)')
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

describe('agent canvas layout — legend & locale (plan 20260812-panel-f5-agent-layout T2)', () => {
  it('legend carries the sub-bucket / supervise / unknown entries; the former general entry is replaced', () => {
    const html = agentsHtml(baseSource)
    for (const key of ['sub-bucket', 'supervise', 'unknown']) {
      expect(html).toContain(`data-mstar-legend-item="${key}"`)
    }
    expect(html).not.toContain('data-mstar-legend-item="general"')
    expect(html).not.toContain('general at the bottom of the sdd-implement bucket')
    expect(html).toContain('unknown column (unmatched / general roles)')
    expect(html).toContain('implementor ↔ sdd-reviewer bidirectional supervise line')
    expect(html).toContain('on-demand role (implementor sub-bucket badge)')
    // zh labels localize.
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain('sdd-implement 子桶（implementor / sdd-reviewer）')
    expect(zhHtml).toContain('implementor ↔ sdd-reviewer 双向监督线')
    expect(zhHtml).toContain('unknown 列（未匹配 / general 角色）')
    expect(zhHtml).toContain('按需执行角色（implementor 子桶徽标）')
  })
})
