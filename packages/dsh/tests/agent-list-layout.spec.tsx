/**
 * Agent LIST layout tests (the render layer, plan sidebar §L3 + §L6.2): the
 * 代理执行 tab as a VERTICAL GROUPED LIST — the absolutely-positioned agent
 * canvas is DELETED (its geometry/pan/edge assertions died with it; every
 * LIVE-behaviour assertion the deleted canvas spec covered is ported here):
 *
 * - the L3.2 group/stage/sub-bucket ORDER from a projected `AgentZoneView`:
 *   Phase 1 (iteration-start: review-edit-chain) → Phase 2
 *   (autonomous-execute: sdd-implement with the implementor/reviewer
 *   sub-buckets → qc-tri → qa-gate with the unknown sub-bucket LAST,
 *   rendered only when it has members);
 * - all 14 roster role ids present exactly once as `data-agent-entity`
 *   (idle / running / pending included);
 * - idle/running/done/emphasis mapping and the off-tier settled card's
 *   missing ✓ (`data-agent-done` restricted to
 *   `status === 'settled' && emphasis !== 'off'`);
 * - the ×N aggregation (`data-agent-count`), the record line
 *   (`data-agent-record`), the on-demand badge (`data-agent-on-demand`);
 * - the `N executing · M pending` summary (`data-agent-summary-*`);
 * - the three degradation notes (`data-agents-note` = degraded / empty /
 *   settle-only);
 * - the legend's three entries below the list;
 * - zero `<svg>` and zero pan/port/canvas anchors in
 *   `[data-mstar-page="agents"]` (AC5's negative half).
 *
 * Renderer: react-dom/server.renderToStaticMarkup over the real component
 * (the `*.module.css` import resolves to the raw file-path string under
 * `bun test`, so assertions pin `data-*` anchors + DOM order, never class
 * names).
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { MstarEngineStatusPayload } from '../src/types'
import type { AgentFlowEventView, AgentFlowView } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { clientExports } from './client-bundles.ts'
import { Context } from '@deepseek-ai/cordis'
import { projectGraph, type ZoneView } from '../src/client/panel/graph/project-graph'
import { KNOWN_AGENTS } from '../src/client/panel/graph/schema'
import { AgentListPage, UNKNOWN_COLUMN } from '../src/client/panel/pages/AgentListPage'
import { en, NS, zh } from '../src/client/panel/locale'

type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

/** One real LocaleRuntime over a fresh cordis context. */
function newLocale(): LocaleRuntime {
  return new LocaleRuntimeCtor(new Context())
}

/* ------------------------------ fixtures ------------------------------ */

/** Minimal catalog source: harness present, no agentFlow → the degraded
 * branch (full idle roster + the full stage skeleton). */
const baseSource: MstarEngineStatusPayload = {
  version: '2.1.1',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: {
    selection: { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' },
    workflowType: 'plan',
    workflowStatus: 'running',
    plans: [],
    residuals: [],
    residualFindings: null,
    project: { milestones: [], openResiduals: [] },
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
 * PAIRED dispatch identity when `role` is given, so the exact-identity
 * pairing can settle the paired dispatch). */
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
function flowSource(events: readonly unknown[]): MstarEngineStatusPayload {
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
function phase2Source(events: readonly unknown[]): MstarEngineStatusPayload {
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

/** A phase-2 source whose state.plans carries the given InProgress rows. */
function planSource(inProgress: string[]): MstarEngineStatusPayload {
  return {
    ...phase2Source([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })]),
    state: {
      ...baseSource.state!,
      agentFlow: { events: [dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })], summary: [] } as unknown as AgentFlowView,
      plans: [
        ...inProgress.map((id) => ({ id, status: 'InProgress', doneAt: null, iterationRefs: [] })),
        { id: 'plan-done', status: 'Done', doneAt: '2026-08-08', iterationRefs: [] },
      ],
    },
  }
}

/** Render the AgentListPage to static HTML (en by default). */
function agentsHtml(source: MstarEngineStatusPayload, lang: 'en' | 'zh' = 'en'): string {
  const locale = newLocale()
  locale.register(NS, { zh, en })
  locale.setLocale(lang)
  const view = projectGraph(source)
  return renderToStaticMarkup(createElement(AgentListPage, {
    view: view.agents,
    iteration: view.iteration,
    t: locale.bind(NS),
  }))
}

/* ------------------------------ helpers ------------------------------ */

/** The SSR markup of one entity row (the `<li data-agent-entity=...>` region). */
function cardRegion(html: string, key: string): string {
  const start = html.indexOf(`data-agent-entity="${key}"`)
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('</li>', start)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

/** The `data-agent-stage` values of the stage GROUP containers in DOM order
 * (`<section ... data-agent-stage="...">`) — entity rows are `<li>` elements
 * carrying their own `data-agent-stage` (incl. the `on-demand` / `general`
 * zone values), so only the section tags mark the group order. */
function stageGroupOrder(html: string): string[] {
  return [...html.matchAll(/<section[^>]*?data-agent-stage="([^"]+)"/g)].map((m) => m[1]!)
}

/** The markup slice between two anchors (the sub-partition regions). */
function between(html: string, startAnchor: string, endAnchor: string): string {
  const start = html.indexOf(startAnchor)
  expect(start, startAnchor).toBeGreaterThan(-1)
  const end = endAnchor === '' ? html.length : html.indexOf(endAnchor, start)
  expect(end, endAnchor).toBeGreaterThan(start)
  return html.slice(start, end)
}

/* ------------------------------ the tests ------------------------------ */

describe('agent list — L3.2 group/stage/sub-bucket order (plan sidebar §L3.2)', () => {
  it('two phase groups in skeleton order: Phase 1 (iteration-start) then Phase 2 (autonomous-execute), with indexes', () => {
    const html = agentsHtml(baseSource)
    const groups = [...html.matchAll(/data-agent-group="([^"]+)"/g)].map((m) => m[1]!)
    expect(groups).toEqual(['iteration-start', 'autonomous-execute'])
    const indexes = [...html.matchAll(/data-agent-group-index="([^"]+)"/g)].map((m) => m[1]!)
    expect(indexes).toEqual(['1', '2'])
    // zh labels localize (the same phase labels the canvas group rows used).
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain('Phase 1 · 顺序完成（review-edit-chain）')
    expect(zhHtml).toContain('Phase 2 · 循环迭代 plans')
  })

  it('stage groups in EXPECTED_ROLE_FLOW order: review-edit-chain → sdd-implement → qc-tri → qa-gate', () => {
    const html = agentsHtml(baseSource)
    expect(stageGroupOrder(html)).toEqual([
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
    ])
  })

  it('sub-bucket partitions in order: implementor → reviewer inside sdd-implement; unknown LAST inside qa-gate', () => {
    const html = agentsHtml(baseSource)
    const impl = html.indexOf('data-sub-bucket="implementor"')
    const rev = html.indexOf('data-sub-bucket="reviewer"')
    const unknown = html.indexOf(`data-sub-bucket="${UNKNOWN_COLUMN}"`)
    expect(impl).toBeGreaterThan(-1)
    expect(rev).toBeGreaterThan(impl)
    expect(unknown).toBeGreaterThan(rev)
    // The unknown partition rides the LAST stage group (qa-gate).
    const qaGate = html.indexOf('data-agent-stage="autonomous-execute:qa-gate"')
    expect(qaGate).toBeGreaterThan(-1)
    expect(unknown).toBeGreaterThan(qaGate)
    // The zone.agents.bucket.* captions render with their partitions (the
    // reviewer caption is the distinct 「sdd-reviewer」 copy).
    expect(html).toContain('>implementor</span>')
    expect(html).toContain('>sdd-reviewer</span>')
  })

  it('implementor partition order: flow roles first (SDD_BUCKET_ROLES order), on-demand roles after, reviewer below', () => {
    const html = agentsHtml(baseSource)
    const implRegion = between(html, 'data-sub-bucket="implementor"', 'data-sub-bucket="reviewer"')
    const implOrder = [...implRegion.matchAll(/data-agent-entity="([^"]+)"/g)].map((m) => m[1]!)
    expect(implOrder).toEqual(['fullstack-dev', 'fullstack-dev-2', 'frontend-dev', 'ops-engineer', 'prompt-engineer'])
    // The reviewer partition keeps only its own role — the region ends at
    // the NEXT STAGE group (the unknown sub-bucket sits in qa-gate, after
    // qc-tri).
    const revRegion = between(html, 'data-sub-bucket="reviewer"', 'data-agent-stage="autonomous-execute:qc-tri"')
    const revOrder = [...revRegion.matchAll(/data-agent-entity="([^"]+)"/g)].map((m) => m[1]!)
    expect(revOrder).toEqual(['code-reviewer'])
  })

  it('plain stage groups ride the stage roles order (review-edit-chain: pm → architect → writing-specialist)', () => {
    const html = agentsHtml(baseSource)
    const region = between(html, 'data-agent-stage="iteration-start:review-edit-chain"', 'data-agent-stage="autonomous-execute:sdd-implement"')
    const order = [...region.matchAll(/data-agent-entity="([^"]+)"/g)].map((m) => m[1]!)
    expect(order).toEqual(['product-manager', 'architect', 'writing-specialist'])
    // qc-tri keeps its roles order too.
    const qcRegion = between(html, 'data-agent-stage="autonomous-execute:qc-tri"', 'data-agent-stage="autonomous-execute:qa-gate"')
    const qcOrder = [...qcRegion.matchAll(/data-agent-entity="([^"]+)"/g)].map((m) => m[1]!)
    expect(qcOrder).toEqual(['qc-specialist', 'qc-specialist-2', 'qc-specialist-3'])
  })

  it('the general entity renders in the unknown sub-bucket with the「unknown / 未匹配角色」caption (en + zh)', () => {
    const html = agentsHtml(baseSource)
    expect(html).toContain(`data-sub-bucket="${UNKNOWN_COLUMN}"`)
    expect(html).toContain('>unknown / unmatched roles<')
    const unknownRegion = between(html, `data-sub-bucket="${UNKNOWN_COLUMN}"`, 'data-mstar-legend')
    expect(unknownRegion).toContain('data-agent-entity="general"')
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain(`data-sub-bucket="${UNKNOWN_COLUMN}"`)
    expect(zhHtml).toContain('>unknown / 未匹配角色<')
  })

  it('the unknown sub-bucket renders ONLY when it has members (a view without a general entity omits it)', () => {
    const view = projectGraph(baseSource).agents
    const withoutGeneral: ZoneView['agents'] = {
      ...view,
      entities: view.entities.filter((e) => e.key !== 'general'),
    }
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const html = renderToStaticMarkup(createElement(AgentListPage, {
      view: withoutGeneral,
      iteration: projectGraph(baseSource).iteration,
      t: locale.bind(NS),
    }))
    expect(html).not.toContain(`data-sub-bucket="${UNKNOWN_COLUMN}"`)
    // The stage group itself still renders (every stage group always renders).
    expect(html).toContain('data-agent-stage="autonomous-execute:qa-gate"')
  })

  it('every entity row is a FLOW row: no inline style, no ports, no svg (plan sidebar §L3.3)', () => {
    const html = agentsHtml(baseSource)
    for (const known of KNOWN_AGENTS) {
      const region = cardRegion(html, known.id)
      expect(region).not.toContain('style="')
      expect(region).not.toContain('data-agent-port')
    }
    // The list root anchors the list (plan sidebar §L4.4).
    expect(html).toContain('data-agent-list')
  })
})

describe('agent list — roster parity + card anatomy (plan sidebar §L3.3, AC5)', () => {
  it('data-agent-entity covers the full KNOWN_AGENTS roster exactly once (idle degraded ledger never hides a known agent)', () => {
    const html = agentsHtml(baseSource)
    for (const known of KNOWN_AGENTS) {
      expect(html).toContain(`data-agent-entity="${known.id}"`)
    }
    expect(html.match(/data-agent-entity="/g)).toHaveLength(KNOWN_AGENTS.length)
    expect(html.match(/data-agent-idle="true"/g)).toHaveLength(KNOWN_AGENTS.length)
    expect(html).toContain('data-agent-summary-executing="0"')
    expect(html).toContain('data-agent-summary-pending="0"')
  })

  it('the general card rides the unknown bucket: projected stage value, no bucket anchor, no on-demand badge', () => {
    const html = agentsHtml(baseSource)
    const region = cardRegion(html, 'general')
    expect(region).toContain('data-agent-stage="general"')
    expect(region).not.toContain('data-agent-bucket')
    expect(region).not.toContain('data-agent-on-demand')
  })

  it('cards ride the projected bucket anchors: implementor (flow + on-demand) / reviewer (code-reviewer)', () => {
    const html = agentsHtml(baseSource)
    expect(cardRegion(html, 'code-reviewer')).toContain('data-agent-bucket="reviewer"')
    expect(cardRegion(html, 'fullstack-dev')).toContain('data-agent-bucket="implementor"')
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-bucket="implementor"')
  })

  it('on-demand badge: data-agent-on-demand on ops-engineer / prompt-engineer cards only', () => {
    const html = agentsHtml(baseSource)
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-on-demand="true"')
    expect(cardRegion(html, 'prompt-engineer')).toContain('data-agent-on-demand="true"')
    expect(html.match(/data-agent-on-demand="true"/g)).toHaveLength(2)
    // Negative pins: flow + reviewer cards never carry the badge.
    expect(cardRegion(html, 'fullstack-dev')).not.toContain('data-agent-on-demand')
    expect(cardRegion(html, 'code-reviewer')).not.toContain('data-agent-on-demand')
    // The on-demand zone rides the projected data-agent-stage value.
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-stage="on-demand"')
  })

  it('lit cards carry the honest status + record line; idle cards carry no fabricated record', () => {
    const html = agentsHtml(flowSource([dispatchEvent({ ts: 7, role: 'fullstack-dev', agent: 'explore' })]))
    expect(html.match(/data-agent-entity="/g)).toHaveLength(KNOWN_AGENTS.length)
    expect(html.match(/data-agent-entity="fullstack-dev"/g)).toHaveLength(1)
    expect(html).not.toContain('data-agent-entity="explore"')
    const lit = cardRegion(html, 'fullstack-dev')
    expect(lit).toContain('data-agent-status="running"')
    expect(lit).toContain('data-agent-running="true"')
    expect(lit).not.toContain('data-agent-idle')
    expect(lit).toContain('data-agent-record')
    expect(lit).toContain('explore')
    expect(lit).toContain('title="fullstack-dev"')
    // Executing matches the visible running row.
    expect(html).toContain('data-agent-summary-executing="1"')
  })

  it('×N aggregation (data-agent-count) renders for count > 1 only', () => {
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 2, role: 'fullstack-dev', agent: 'a1' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    const lit = cardRegion(html, 'fullstack-dev')
    expect(lit).toContain('data-agent-count="2"')
    expect(lit).toContain('×2')
    // A single-dispatch card carries no count anchor.
    expect(cardRegion(html, 'general')).not.toContain('data-agent-count')
  })

  it('the role chip anchor stays idle today: every projected entity\'s role equals its key', () => {
    // The anatomy keeps the chip rule (`entity.role !== '' &&
    // entity.role !== entity.key`), but the projection NORMALIZES the general
    // bucket entity's role to the bucket id (and roster roles key their own
    // cards), so no row can carry `data-agent-role` today — a non-roster
    // dispatch ('scout') folds into the general bucket with role 'general'.
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 1, role: 'scout', agent: 's1' }),
      dispatchEvent({ ts: 2, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    expect(html).not.toContain('data-agent-role=')
    // The scout dispatch still lands in the bucket row, honest title + record.
    const region = cardRegion(html, 'general')
    expect(region).toContain('title="general"')
    expect(region).toContain('s1')
  })
})

describe('agent list — emphasis tiers + done restriction (plan sidebar §L3.3, design doc §3)', () => {
  it('Phase 2: autonomous-execute cards current, review-edit-chain + on-demand/general off (data-agent-emphasis)', () => {
    const html = agentsHtml(phase2Source([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })]))
    expect(cardRegion(html, 'fullstack-dev')).toContain('data-agent-emphasis="current"')
    expect(cardRegion(html, 'product-manager')).toContain('data-agent-emphasis="off"')
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-emphasis="off"')
    expect(cardRegion(html, 'general')).toContain('data-agent-emphasis="off"')
  })

  it('Phase 1: review-edit-chain current, autonomous-execute next (the only phase with a next tier)', () => {
    const html = agentsHtml({
      ...phase2Source([dispatchEvent({ ts: 1, role: 'product-manager', agent: 'pm1' })]),
      iteration: { ...phase2Source([]).iteration!, compassStatus: 'active' },
    })
    expect(cardRegion(html, 'product-manager')).toContain('data-agent-emphasis="current"')
    expect(cardRegion(html, 'fullstack-dev')).toContain('data-agent-emphasis="next"')
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-emphasis="off"')
  })

  it('no iteration (currentStep null): NO card carries data-agent-emphasis — the no-override case', () => {
    const html = agentsHtml(baseSource)
    expect(html.match(/data-agent-emphasis=/g)).toBeNull()
  })

  it('settled + emphasis current → the green done frame marker + the green ✓ (data-agent-done="true")', () => {
    const html = agentsHtml(phase2Source([
      settleEvent({ ts: 2, agent: 'a1', outcome: 'ok', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1' }),
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
    ]))
    const region = cardRegion(html, 'fullstack-dev')
    expect(region).toContain('data-agent-status="settled"')
    expect(region).toContain('data-agent-emphasis="current"')
    expect(region).toContain('data-agent-done="true"')
    expect(region).toContain('>✓<')
  })

  it('settled + emphasis null (no iteration) → still done: the settled ✓ survives', () => {
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

  it('settled + emphasis off → NO completion marker: data-agent-done="false" with no ✓', () => {
    // Phase 2: a review-edit-chain role settled — its stage phase is ALREADY
    // PASSED → emphasis 'off' → the ✓ must NOT render.
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
  })

  it('off-tier settled + running siblings: only the current-tier settled rows show the ✓ (whole-list count)', () => {
    const html = agentsHtml(phase2Source([
      settleEvent({ ts: 30, agent: 'a2', outcome: 'ok', role: 'qc-specialist', planId: 'plan-x', taskId: 'T3' }),
      dispatchEvent({ ts: 29, role: 'qc-specialist', agent: 'a2', planId: 'plan-x', taskId: 'T3' }),
      settleEvent({ ts: 20, agent: 'a1', outcome: 'ok', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1' }),
      dispatchEvent({ ts: 19, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
      settleEvent({ ts: 10, agent: 'pm1', outcome: 'ok', role: 'product-manager', planId: 'plan-x', taskId: 'T2' }),
      dispatchEvent({ ts: 9, role: 'product-manager', agent: 'pm1', planId: 'plan-x', taskId: 'T2' }),
    ]))
    // Exactly the two CURRENT-tier settled rows carry the green ✓ (the off
    // product-manager shows neither). `data-agent-done="true"` appears TWICE
    // per done row (the row frame + the ✓ span) — the ✓ glyph is the
    // completion marker count.
    expect(html.match(/>✓</g)).toHaveLength(2)
    expect(html.match(/data-agent-done="true" data-agent-stage/g)).toHaveLength(2)
    expect(cardRegion(html, 'product-manager')).toContain('data-agent-done="false"')
  })

  it('a running off-tier row keeps the honest running status next to its off emphasis (dimensions stack)', () => {
    const html = agentsHtml(phase2Source([dispatchEvent({ ts: 1, role: 'ops-engineer', agent: 'o1' })]))
    const region = cardRegion(html, 'ops-engineer')
    expect(region).toContain('data-agent-emphasis="off"')
    expect(region).toContain('data-agent-status="running"')
    // The fade lives in the chrome COLOR mix — never an `opacity` property
    // (a whole-card opacity would fade the status point, the HARD rule).
    expect(region).not.toContain('opacity')
  })
})

describe('agent list — summary, notes, and the Phase-2 plan annotation (plan sidebar §L3.2)', () => {
  it('the summary header reports `N executing · M pending` (data-agent-summary-*)', () => {
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
      dispatchEvent({ ts: 2, role: 'qc-specialist', agent: 'a2' }),
      dispatchEvent({ ts: 3, role: 'qa-engineer', agent: 'a3' }),
      dispatchEvent({ ts: 4, role: 'code-reviewer', agent: 'a4' }),
    ]))
    // 3 running (fullstack-dev / qc-specialist / qa-engineer) + 1 settled
    // code-reviewer (unpaired settle... no — no settle row: all 4 running).
    expect(html).toContain('data-agent-summary-executing="4"')
    // Every evidenced stage role is pending-0; the review-edit-chain roles
    // (3 expected roles) are un-evidenced → pending 3.
    expect(html).toContain('data-agent-summary-pending="3"')
  })

  it('degraded ledger → data-agents-note="degraded"', () => {
    const html = agentsHtml(baseSource)
    expect(html).toContain('data-agents-note="degraded"')
    expect(html).not.toContain('data-agents-note="empty"')
    expect(html).not.toContain('data-agents-note="settle-only"')
  })

  it('empty ledger → data-agents-note="empty"', () => {
    const html = agentsHtml(flowSource([]))
    expect(html).toContain('data-agents-note="empty"')
    expect(html).not.toContain('data-agents-note="degraded"')
  })

  it('settle-only ledger → data-agents-note="settle-only" (garbage rows too — never a guessed dispatch)', () => {
    const settleOnly = agentsHtml(flowSource([settleEvent({ ts: 1, outcome: 'ok' })]))
    expect(settleOnly).toContain('data-agents-note="settle-only"')
    expect(settleOnly).not.toContain('data-agents-note="empty"')
    expect(settleOnly).not.toContain('data-agents-note="degraded"')
    // Garbage-only rows classify settle-only too (no dispatch row exists).
    const garbageOnly = agentsHtml(flowSource([42, null, 'garbage', { kind: 'banana' }]))
    expect(garbageOnly).toContain('data-agents-note="settle-only"')
  })

  it('dispatch evidence (anonymous included) → NO note anchor', () => {
    const html = agentsHtml(flowSource([{ kind: 'dispatch' }]))
    expect(html).not.toContain('data-agents-note')
    expect(html).toContain('data-agent-summary-executing="1"')
  })

  it('Phase-2 heading with an InProgress plan → the plan chip; several plans → the honest `+N more`', () => {
    const html = agentsHtml(planSource(['plan-a', 'plan-b', 'plan-c']))
    expect(html).toContain('data-agent-group-plan="plan-a"')
    expect(html).toContain('plan: plan-a')
    expect(html).toContain('data-agent-group-plan-more')
    expect(html).toContain('+2 more')
    // Single InProgress → no more-count.
    const single = agentsHtml(planSource(['plan-a']))
    expect(single).not.toContain('data-agent-group-plan-more')
  })

  it('no InProgress plan → the muted「no in-progress plan」note, no plan chip', () => {
    const html = agentsHtml(planSource([]))
    expect(html).not.toContain('data-agent-group-plan=')
    expect(html).toContain('data-agent-group-no-plan')
    expect(html).toContain('no in-progress plan')
    // A state with NO plans array at all degrades the same way (total function).
    expect(agentsHtml(phase2Source([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })]))).toContain('data-agent-group-no-plan')
  })

  it('the degraded branch still annotates the current plan — the note rides state.plans, not the ledger', () => {
    const source = planSource(['plan-x'])
    const html = agentsHtml({ ...source, state: { ...source.state!, agentFlow: null } })
    expect(html).toContain('data-agents-note="degraded"')
    expect(html).toContain('data-agent-group-plan="plan-x"')
  })
})

describe('agent list — legend + AC5 negative probes', () => {
  it('legend: ONLY the 3 role-card status entries render, below the list', () => {
    const html = agentsHtml(baseSource)
    const items = [...html.matchAll(/data-mstar-legend-item="([^"]+)"/g)].map((m) => m[1]!)
    expect(items).toEqual(['agent-running', 'agent-settled', 'agent-idle'])
    // The 7 collaboration-edge / layout entries stay gone.
    for (const key of ['flow-actual', 'port', 'group', 'sub-bucket', 'supervise', 'on-demand', 'unknown']) {
      expect(html).not.toContain(`data-mstar-legend-item="${key}"`)
    }
    // The legend renders AFTER the list (in flow below it).
    const list = html.indexOf('data-agent-list')
    const legend = html.indexOf('data-mstar-legend')
    expect(list).toBeGreaterThan(-1)
    expect(legend).toBeGreaterThan(list)
    // The surviving entries' labels (en + zh).
    expect(html).toContain('agent running (glow)')
    expect(html).toContain('settled agent (green done frame + ✓; off-tier roles show neither)')
    expect(html).toContain('idle agent (dashed)')
    const zhHtml = agentsHtml(baseSource, 'zh')
    expect(zhHtml).toContain('执行中实体（发光）')
    expect(zhHtml).toContain('已完成实体（独立绿框 + ✓；off 阶段不显示）')
    expect(zhHtml).toContain('未工作实体（虚线）')
  })

  it('AC5 negatives: zero <svg>, zero ports, zero pan/port/edge/canvas anchors in the agents page', () => {
    const html = agentsHtml(baseSource)
    const page = between(html, 'data-mstar-page="agents"', 'data-mstar-legend')
    expect(page).not.toContain('<svg')
    expect(page).not.toContain('data-agent-port')
    expect(page).not.toContain('data-canvas-')
    expect(page).not.toContain('data-agent-edge')
    expect(page).not.toContain('translate(')
    expect(page).not.toContain('position: absolute')
  })
})
