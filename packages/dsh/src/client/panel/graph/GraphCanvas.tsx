/**
 * GraphCanvas — the react-flow adapter (spec panel-layout-graph §2.6 / §4 +
 * agent-flow-catalog-graph §2.4): pure render of a projected `GraphView` onto
 * a read-only loop graph.
 *
 * Layout: static position table (THREE subgraphs — phase ring left, plan
 * state machine center, expected/actual agent-flow pipeline right; no
 * auto-layout engine). Phase pill nodes (current = emphasized fill + glow
 * border + PASS/FAIL verdict badge, next = dashed border, idle = dim, unknown
 * = dim + `?`), plan-state box nodes (lit = fill + count badge + plan id
 * rows, unknown bucket warn style), flow-stage box nodes (stage label + phase
 * + roles chips + count badge; lit = business border, unlit = dim) + the
 * evidence-driven `flow-unexpected` warn node, solid forward edges, dashed
 * loop edge (merge-ready → iteration-start), dotted connector edge (current
 * phase → active plan bucket), and the pipeline skeleton edges (stage order —
 * dim when unlit, business highlight when either endpoint stage is lit, warn
 * dash from the current phase's stage to the unexpected node). The iteration
 * id renders as the phase-ring caption (spec §2.6).
 *
 * Agent-flow event detail renders as a collapsible footer strip (spec
 * agent-flow-catalog-graph §2.4): ≤50 event rows (role → planId#taskId, ts,
 * status-colored label + dot, agent, settled ✓) with unexpected events
 * re-listed in their own warn section — events are NOT graph nodes (a ≤50
 * node swarm needs a layout engine and destroys readability). The event
 * `id` is a window-relative `${ts}-${kind}-${index}` (T2 review: NEVER a
 * durable key — strip re-mounts are harmless; React keys only need
 * intra-render stability).
 *
 * Interaction contract (panel read-only constraint): `nodesDraggable={false}`
 * (+ non-connectable / non-selectable), pan + wheel zoom + default controls
 * (zoom/fit) + `fitView` (padding 0.3 — raised for the third column).
 * Degraded overlays (spec §2.5 + agent-flow §2.4): ring no-compass note,
 * machine no-state / no-plans notes, flow no-evidence (degraded) /
 * no-dispatches-yet (empty) notes — the canvas still mounts the schema
 * skeleton; never a crash, never a guessed value.
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
import {
  type FlowEventView, type FlowStageView, type GraphView, type PhaseView, type PlanStateView,
} from './project-graph.ts'
import { EXPECTED_ROLE_FLOW, type PhaseId, type PlanStateId } from './schema.ts'

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

/**
 * Agent-flow pipeline third column (spec agent-flow-catalog-graph §2.4):
 * a static position table derived IN LOCKSTEP from the EXPECTED_ROLE_FLOW
 * schema constant — 6 expected stage nodes stacked vertically at x ≈ 920
 * (same 104px rhythm as the phase ring), plus the `flow-unexpected` node on
 * its own track at x ≈ 1180, vertically centered. Deriving the table from
 * the schema means the layout can never drift from the skeleton (a stage
 * added to EXPECTED_ROLE_FLOW gets a position automatically).
 */
const FLOW_X = 920
const FLOW_Y_START = 20
const FLOW_Y_STEP = 104
const FLOW_POSITIONS: Record<string, { x: number; y: number }> = Object.fromEntries(
  EXPECTED_ROLE_FLOW.map((s, i) => [`${s.phase}:${s.stage}`, { x: FLOW_X, y: FLOW_Y_START + i * FLOW_Y_STEP }]),
)
const FLOW_UNEXPECTED_POSITION = { x: 1180, y: 280 }

interface PhaseNodeData extends Record<string, unknown> {
  phase: PhaseView
  t: TranslateNS<'mstar-panel'>
}
interface StateNodeData extends Record<string, unknown> {
  state: PlanStateView
  t: TranslateNS<'mstar-panel'>
}
interface FlowStageNodeData extends Record<string, unknown> {
  stage: FlowStageView
  t: TranslateNS<'mstar-panel'>
}
interface FlowUnexpectedNodeData extends Record<string, unknown> {
  unexpected: readonly FlowEventView[]
  t: TranslateNS<'mstar-panel'>
}
type PhaseFlowNode = Node<PhaseNodeData, 'phase'>
type StateFlowNode = Node<StateNodeData, 'state'>
type FlowStageFlowNode = Node<FlowStageNodeData, 'flow-stage'>
type FlowUnexpectedFlowNode = Node<FlowUnexpectedNodeData, 'flow-unexpected'>

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

/** Expected-pipeline stage box: stage label + phase + roles chips + count badge (lit/unlit). */
function FlowStageNode({ data }: NodeProps<FlowStageFlowNode>) {
  const { stage, t } = data
  const stateClass = stage.lit ? css.flowStageLit : css.flowStageUnlit
  return (
    <div className={`${css.flowStageNode} ${stateClass}`} data-graph-node={`flow:${stage.id}`} data-graph-lit={stage.lit}>
      <div className={css.flowStageHeader}>
        <span className={css.nodeTitle}>{stage.stage}</span>
        {stage.lit && (
          <span className={css.flowStageCount} data-graph-count={stage.count}>{stage.count}</span>
        )}
      </div>
      <span className={css.flowStagePhase} data-graph-flow-phase={stage.phase}>{t(`graph.phase.${stage.phase}`)}</span>
      <ul className={css.flowRoleList}>
        {stage.roles.map((role) => (
          <li key={role} className={css.flowRoleChip} data-flow-role={role}>{role}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Evidence-driven unexpected-role warn node (spec agent-flow-catalog-graph
 * §2.4): mounted ONLY when unexpected dispatch events exist — the schema never
 * renders a warning that claims events the evidence does not show.
 */
function FlowUnexpectedNode({ data }: NodeProps<FlowUnexpectedFlowNode>) {
  const { unexpected, t } = data
  return (
    <div className={css.flowUnexpectedNode} data-graph-node="flow:unexpected">
      <div className={css.flowStageHeader}>
        <span className={css.nodeTitle}>{t('flow.unexpected')}</span>
        <span className={css.flowStageCount} data-graph-count={unexpected.length}>{unexpected.length}</span>
      </div>
    </div>
  )
}

/** Status label for one event row (spec agent-flow-catalog-graph §2.4 key set). */
function flowStatusLabel(status: FlowEventView['status'], t: TranslateNS<'mstar-panel'>): string {
  switch (status) {
    case 'dispatched': return t('flow.in-flight')
    case 'advisory': return t('flow.advisory')
    case 'denied': return t('flow.denied')
    case 'ok': return t('flow.settled-ok')
    case 'error': return t('flow.error')
    default: return t('panel.unknown')
  }
}

/** Status chip color class (dispatch → business/warn/error; settle → success/error). */
function flowStatusClass(status: FlowEventView['status']): string {
  switch (status) {
    case 'dispatched': return css.flowStatusDispatched
    case 'advisory': return css.flowStatusAdvisory
    case 'denied': return css.flowStatusDenied
    case 'ok': return css.flowStatusOk
    case 'error': return css.flowStatusError
    default: return css.flowStatusUnknown
  }
}

/** Local HH:MM clock time; ts 0 (missing) renders empty — never a fabricated time. */
function formatEventTime(ts: number): string {
  if (ts <= 0) return ''
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** `planId#taskId` best-effort target cell (spec §2.4: role → planId#taskId). */
function flowEventTarget(event: FlowEventView): string {
  if (event.planId !== null && event.taskId !== null) return `${event.planId}#${event.taskId}`
  if (event.planId !== null) return event.planId
  if (event.taskId !== null) return `#${event.taskId}`
  return ''
}

/** One agent-flow event row (shared by the main list and the unexpected re-list). */
function FlowEventRow({ event, t }: { event: FlowEventView; t: TranslateNS<'mstar-panel'> }) {
  const statusLabel = flowStatusLabel(event.status, t)
  const target = flowEventTarget(event)
  const time = formatEventTime(event.ts)
  return (
    <li
      className={css.flowEventRow}
      data-graph-flow-event={event.id}
      data-graph-flow-event-kind={event.kind}
      data-graph-flow-event-status={event.status}
      data-graph-flow-event-expected={event.expected}
      data-graph-flow-event-settled={event.settled}
    >
      <span className={css.flowEventRole}>
        {event.kind === 'settle'
          // Settle rows carry no role (T1 sets '') — the glyph marks the
          // completion record itself; the outcome is the status chip.
          ? <span className={css.flowSettleGlyph} aria-hidden="true">✓</span>
          : event.role !== '' ? event.role : t('panel.unknown')}
      </span>
      {target !== '' && <span className={css.flowEventTarget}>{target}</span>}
      {time !== '' && <span className={css.flowEventTime}>{time}</span>}
      <span className={`${css.flowStatus} ${flowStatusClass(event.status)}`}>
        <span className={css.flowStatusDot} aria-hidden="true" />
        {statusLabel}
      </span>
      {event.kind === 'dispatch' && event.settled && (
        <span className={css.flowSettledMark} aria-hidden="true">✓</span>
      )}
      {event.agent !== null && <span className={css.flowEventAgent}>{event.agent}</span>}
      {event.durationMs !== null && <span className={css.flowEventDuration}>{event.durationMs}ms</span>}
    </li>
  )
}

const nodeTypes = { phase: PhaseNode, state: StateNode, 'flow-stage': FlowStageNode, 'flow-unexpected': FlowUnexpectedNode }

function buildNodes(
  view: GraphView,
  t: TranslateNS<'mstar-panel'>,
): (PhaseFlowNode | StateFlowNode | FlowStageFlowNode | FlowUnexpectedFlowNode)[] {
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
  const flowStages: FlowStageFlowNode[] = view.flow.stages.map((stage) => ({
    id: `flow:${stage.id}`,
    type: 'flow-stage',
    position: FLOW_POSITIONS[stage.id] ?? FLOW_UNEXPECTED_POSITION,
    data: { stage, t },
  }))
  // The unexpected warn node mounts ONLY on evidence (never a guessed warning).
  const unexpected: FlowUnexpectedFlowNode[] = view.flow.unexpected.length > 0
    ? [{
        id: 'flow:unexpected',
        type: 'flow-unexpected',
        position: FLOW_UNEXPECTED_POSITION,
        data: { unexpected: view.flow.unexpected, t },
      }]
    : []
  return [...phases, ...states, ...flowStages, ...unexpected]
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
  // Pipeline skeleton edges in EXPECTED_ROLE_FLOW constant order (spec
  // agent-flow-catalog-graph §2.4): dim when both endpoints are unlit,
  // business highlight when either endpoint stage carries dispatch evidence.
  const stages = view.flow.stages
  for (let i = 0; i + 1 < stages.length; i++) {
    const source = stages[i]!
    const target = stages[i + 1]!
    const lit = source.lit || target.lit
    edges.push({
      id: `flow:${source.id}->${target.id}`,
      source: `flow:${source.id}`,
      target: `flow:${target.id}`,
      type: 'smoothstep',
      className: lit ? css.edgeFlowLit : css.edgeFlow,
    })
  }
  // Unexpected evidence edge: the current phase's first stage → the
  // unexpected node (spec §2.4 — only when unexpected events exist, and only
  // when the current phase has a pipeline stage to originate from).
  if (view.flow.unexpected.length > 0) {
    const currentStage = stages.find((s) => s.phase === view.currentPhase)
    if (currentStage !== undefined) {
      edges.push({
        id: `flow:${currentStage.id}->unexpected`,
        source: `flow:${currentStage.id}`,
        target: 'flow:unexpected',
        type: 'smoothstep',
        className: css.edgeFlowUnexpected,
      })
    }
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
          fitViewOptions={{ padding: 0.3 }}
          panOnDrag
          zoomOnScroll
          minZoom={0.25}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {view.iterationId !== null && (
          <div className={css.ringCaption} data-graph-iteration-id={view.iterationId}>
            <span className={css.ringCaptionLabel}>{t('graph.iteration-id')}</span>
            <span className={css.ringCaptionId}>{view.iterationId}</span>
          </div>
        )}
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
        {view.flow.degraded && (
          <div className={`${css.note} ${css.noteFlow}`} data-graph-empty="flow-degraded">
            {t('flow.degraded')}
          </div>
        )}
        {view.flow.empty && (
          <div className={`${css.note} ${css.noteFlow}`} data-graph-empty="flow-empty">
            {t('flow.empty')}
          </div>
        )}
      </div>
      <footer className={css.footer} data-mstar-graph-footer>
        <div className={css.footerRow}>
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
        </div>
        {/* Agent-flow event strip (spec agent-flow-catalog-graph §2.4): a
            collapsible footer list — never graph nodes. Event ids are
            window-relative (T2 review) → plain array-index-free React keys via
            the projected stable id; strip re-mounts are harmless. */}
        <details className={css.flowDetails} data-graph-flow-count={view.flow.events.length} data-graph-flow-unexpected-count={view.flow.unexpected.length}>
          <summary className={css.flowSummary}>
            <span className={css.flowTitle}>{t('flow.title')}</span>
            <span className={css.flowCount} data-graph-flow-events={view.flow.events.length}>
              {t('flow.event-count', { count: String(view.flow.events.length) })}
            </span>
            {view.flow.unexpected.length > 0 && (
              <span className={css.flowUnexpectedBadge} data-graph-flow-unexpected={view.flow.unexpected.length}>
                {t('flow.unexpected')} · {view.flow.unexpected.length}
              </span>
            )}
          </summary>
          {view.flow.events.length > 0 && (
            <ul className={css.flowEventList} data-mstar-flow-events>
              {view.flow.events.map((event) => (
                <FlowEventRow key={event.id} event={event} t={t} />
              ))}
            </ul>
          )}
          {view.flow.unexpected.length > 0 && (
            <div className={css.flowUnexpectedSection} data-mstar-flow-unexpected>
              <span className={css.flowUnexpectedHeading}>{t('flow.unexpected')}</span>
              <ul className={css.flowEventList}>
                {view.flow.unexpected.map((event) => (
                  <FlowEventRow key={event.id} event={event} t={t} />
                ))}
              </ul>
            </div>
          )}
        </details>
      </footer>
    </div>
  )
}
