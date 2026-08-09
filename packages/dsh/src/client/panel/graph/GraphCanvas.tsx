/**
 * GraphCanvas — the react-flow adapter (spec panel-layout-graph §2.6 / §4):
 * pure render of a projected `GraphView` onto a read-only loop graph.
 *
 * Layout: static position table (two subgraphs side by side — phase ring
 * left, plan state machine right; no auto-layout engine). Phase pill nodes
 * (current = emphasized fill + glow border + PASS/FAIL verdict badge, next =
 * dashed border, idle = dim, unknown = dim + `?`), plan-state box nodes (lit
 * = fill + count badge + plan id rows, unknown bucket warn style), solid
 * forward edges, dashed loop edge (merge-ready → iteration-start), dotted
 * connector edge (current phase → active plan bucket).
 *
 * Interaction contract (panel read-only constraint): `nodesDraggable={false}`
 * (+ non-connectable / non-selectable), pan + wheel zoom + default controls
 * (zoom/fit) + `fitView` (padding 0.2). Degraded overlays (spec §2.5): ring
 * no-compass note, machine no-state / no-plans notes — the canvas still
 * mounts the schema skeleton; never a crash, never a guessed value.
 *
 * ReactFlow renders fine under `renderToStaticMarkup` (SSR seam, spec §3.4),
 * so the render tests assert the real node/edge/overlay markup.
 */

import * as React from 'react'
import {
  Background, Controls, ReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import xyflowCss from '@xyflow/react/dist/style.css'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './graph.module.css'
import { Legend } from './legend.tsx'
import type { GraphView, PhaseView, PlanStateView } from './project-graph.ts'
import type { PhaseId, PlanStateId } from './schema.ts'

/**
 * ReactFlow's base stylesheet is imported as a TEXT module (the client-bundle
 * build loads plain `.css` as text — spec §3.2) and injected once at factory
 * materialization, mirroring the `<style data-plugin>` contract the
 * CSS-modules loader uses (the closure loader removes plugin-owned tags on
 * unload). A second emitted asset would never be served by the loader.
 */
const XYFLOW_STYLE_TAG = '@mstar-harness/dsh/xyflow-style.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${XYFLOW_STYLE_TAG}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@mstar-harness/dsh'
  tag.dataset.pluginCss = XYFLOW_STYLE_TAG
  tag.textContent = xyflowCss
  document.head.appendChild(tag)
}

/** Static layout table (spec §2.6): phase ring left column, machine right. */
const PHASE_POSITIONS: Record<PhaseId, { x: number; y: number }> = {
  'iteration-start': { x: 20, y: 20 },
  'autonomous-execute': { x: 20, y: 124 },
  'iteration-close': { x: 20, y: 228 },
  'pr-delivery': { x: 20, y: 332 },
  'merge-ready': { x: 20, y: 436 },
}

const STATE_POSITIONS: Record<PlanStateId, { x: number; y: number }> = {
  Todo: { x: 420, y: 20 },
  InProgress: { x: 420, y: 140 },
  InReview: { x: 420, y: 260 },
  Done: { x: 420, y: 380 },
  Blocked: { x: 680, y: 140 },
  unknown: { x: 680, y: 260 },
}

interface PhaseNodeData extends Record<string, unknown> {
  phase: PhaseView
  t: TranslateNS<'mstar-panel'>
}
interface StateNodeData extends Record<string, unknown> {
  state: PlanStateView
  t: TranslateNS<'mstar-panel'>
}
type PhaseFlowNode = Node<PhaseNodeData, 'phase'>
type StateFlowNode = Node<StateNodeData, 'state'>

/** Phase pill node: title + state chip + (current) verdict badge. */
function PhaseNode({ data }: NodeProps<PhaseFlowNode>) {
  const { phase, t } = data
  const stateClass = phase.state === 'current'
    ? css.phaseCurrent
    : phase.state === 'next' ? css.phaseNext : css.phaseIdle
  const chipLabel = phase.state === 'current'
    ? t('graph.current')
    : phase.state === 'next' ? t('graph.next') : phase.state === 'unknown' ? t('panel.unknown') : ''
  return (
    <div className={`${css.phaseNode} ${stateClass}`} data-graph-node={`phase:${phase.id}`}>
      <span className={css.nodeTitle}>{t(`graph.phase.${phase.id}`)}</span>
      <span className={css.nodeStateChip} data-graph-node-state={phase.state}>{chipLabel}</span>
      {phase.state === 'current' && phase.verdict !== 'unknown' && (
        <span
          className={phase.verdict === 'pass' ? css.verdictPass : css.verdictFail}
          data-graph-verdict={phase.verdict}
          data-graph-violations={phase.violationCount ?? undefined}
        >
          {phase.verdict === 'pass' ? t('graph.pass') : `${t('graph.fail')} (${phase.violationCount ?? 0})`}
        </span>
      )}
    </div>
  )
}

/** Plan-state box node: bucket label + count badge + plan id rows. */
function StateNode({ data }: NodeProps<StateFlowNode>) {
  const { state, t } = data
  const stateClass = state.id === 'unknown'
    ? css.stateUnknown
    : state.lit ? css.stateLit : css.stateUnlit
  return (
    <div className={`${css.stateNode} ${stateClass}`} data-graph-node={`state:${state.id}`} data-graph-lit={state.lit}>
      <div className={css.stateHeader}>
        <span className={css.nodeTitle}>{t(`graph.state.${state.id}`)}</span>
        {state.lit && (
          <span className={css.stateCount} data-graph-count={state.plans.length}>{state.plans.length}</span>
        )}
      </div>
      {state.lit && (
        <ul className={css.statePlanList}>
          {state.plans.map((plan, i) => (
            <li key={plan.id !== '' ? plan.id : `plan-${i}`} data-plan-id={plan.id} data-plan-status={plan.status}>
              <span className={css.statePlanId}>{plan.id}</span>
              {plan.status !== '' && <span className={css.statePlanStatus}>{plan.status}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const nodeTypes = { phase: PhaseNode, state: StateNode }

function buildNodes(view: GraphView, t: TranslateNS<'mstar-panel'>): (PhaseFlowNode | StateFlowNode)[] {
  const phases: PhaseFlowNode[] = view.phases.map((phase) => ({
    id: `phase:${phase.id}`,
    type: 'phase',
    position: PHASE_POSITIONS[phase.id],
    data: { phase, t },
  }))
  const states: StateFlowNode[] = view.planStates.map((state) => ({
    id: `state:${state.id}`,
    type: 'state',
    position: STATE_POSITIONS[state.id],
    data: { state, t },
  }))
  return [...phases, ...states]
}

function buildEdges(view: GraphView): Edge[] {
  const edges: Edge[] = view.phaseEdges.map((e) => ({
    id: `phase:${e.source}->${e.target}`,
    source: `phase:${e.source}`,
    target: `phase:${e.target}`,
    type: 'smoothstep',
    className: e.kind === 'loop' ? css.edgeLoop : css.edgeForward,
  }))
  for (const e of view.planEdges) {
    edges.push({
      id: `state:${e.source}->${e.target}`,
      source: `state:${e.source}`,
      target: `state:${e.target}`,
      type: 'smoothstep',
      className: css.edgeForward,
    })
  }
  if (view.connector !== null) {
    edges.push({
      id: `connector:${view.connector.source}->${view.connector.target}`,
      source: `phase:${view.connector.source}`,
      target: `state:${view.connector.target}`,
      type: 'smoothstep',
      className: css.edgeConnector,
    })
  }
  return edges
}

export interface GraphCanvasProps {
  view: GraphView
  t: TranslateNS<'mstar-panel'>
}

export function GraphCanvas({ view, t }: GraphCanvasProps) {
  const nodes = buildNodes(view, t)
  const edges = buildEdges(view)
  const current = view.phases.find((p) => p.state === 'current') ?? null
  const verdict = current === null ? 'unknown' : current.verdict
  const verdictLabel = verdict === 'pass'
    ? t('graph.pass')
    : verdict === 'fail'
      ? `${t('graph.fail')} (${current?.violationCount ?? 0})`
      : t('panel.unknown')
  return (
    <div className={css.canvas} data-graph-canvas data-graph-nodes-draggable="false">
      <div className={css.viewport}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          panOnDrag
          zoomOnScroll
          minZoom={0.25}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {view.connector !== null && (
          <div
            className={css.connectorBadge}
            data-graph-connector={`phase:${view.connector.source}→state:${view.connector.target}`}
          >
            {t('graph.legend.edge-connector')}
          </div>
        )}
        {view.degraded.transition && (
          <div className={`${css.note} ${css.noteCompass}`} data-graph-empty="no-compass">
            {t('graph.no-compass')}
          </div>
        )}
        {view.degraded.state && (
          <div className={`${css.note} ${css.noteState}`} data-graph-empty="no-state">
            {t('graph.no-state')}
          </div>
        )}
        {view.degraded.plans && (
          <div className={`${css.note} ${css.notePlans}`} data-graph-empty="no-plans">
            {t('graph.no-plans')}
          </div>
        )}
      </div>
      <footer className={css.footer} data-mstar-graph-footer>
        <Legend t={t} />
        <div className={css.gateSummary} data-mstar-gate-summary>
          <span
            className={verdict === 'fail' ? css.summaryFail : verdict === 'pass' ? css.summaryPass : css.summaryUnknown}
            data-graph-verdict={verdict}
          >
            {verdictLabel}
          </span>
          <details className={css.violationsDetails} data-graph-violations-count={view.violations.length}>
            <summary>
              {view.violations.length > 0
                ? t('graph.violations', { count: String(view.violations.length) })
                : t('graph.no-violations')}
            </summary>
            {view.violations.length > 0 && (
              <ul className={css.violationList} data-mstar-violations>
                {view.violations.map((v, i) => (
                  <li key={v.code !== '' ? v.code : `violation-${i}`} data-violation-code={v.code || 'unknown'} data-severity={v.severity || 'unknown'}>
                    <code className={css.violationCode}>{v.code || t('panel.unknown')}</code>
                    <span className={css.violationMessage}>{v.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </footer>
    </div>
  )
}
