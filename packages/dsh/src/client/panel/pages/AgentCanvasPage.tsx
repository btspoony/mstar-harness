/**
 * AgentCanvasPage (spec panel-tabs §4/§6.2, plan 20260811-panel-agent-canvas
 * Task 2) — the 代理执行 tab: a DRAGGABLE agent canvas. Replaces the muted
 * placeholder page (tabs-shell Task 3) and the stage-column AgentFlowZone
 * (deleted by this plan — the free canvas supersedes it).
 *
 * Canvas contract (spec §6.2 — zero third-party deps):
 * - pan ONLY (translate, no zoom / pinch / rotate) via native pointer events
 *   (pointerdown / pointermove / pointerup + setPointerCapture) on the
 *   viewport; `touch-action: none` + `preventDefault` on pointerdown stop
 *   native scroll / text selection; during capture the entity cards never
 *   receive the pointer (no click-through); no pan bounds (free pan).
 * - the content layer carries `data-canvas-pan` and exposes the pan state as
 *   `transform: translate(xpx, ypx)`; the grid background moves WITH the
 *   content. Pan is instant (no animation), so `prefers-reduced-motion`
 *   needs no pan-specific handling; the next-edge dash flow and the running
 *   card pulse are CSS animations killed by the panel root's reduced-motion
 *   rule (`* { animation: none !important }`).
 * - pan state `{ x, y }` is LOCAL useState; the drag math is extracted into
 *   the exported pure helpers (`panDragStart` / `panDragMove` / `panTransform`)
 *   so the pointer-event sequence is unit-testable without a DOM.
 *
 * Entities (spec §4/§6.2): every KNOWN_AGENTS roster member renders a card —
 * title = the AGENT NAME (role id, or displayName for idle cards via
 * `entity.name`); the session id / task tag are AUXILIARY record fields on
 * `data-agent-record` (never the title). Idle (no dispatch evidence) cards
 * are muted (`data-agent-idle`); lit cards follow the projection's status
 * priority (running/settled/error/denied/advisory).
 *
 * Edges (spec §4 — AgentEdge model reused): expected skeleton (dim dashed
 * stage→stage), actual handoffs (business entity→entity), next (business
 * ANIMATED dash-flow stage→stage) — all drawn as SVG lines over the layout
 * computed by the exported pure `layoutAgents` (deterministic columns per
 * EXPECTED_ROLE_FLOW stage + a trailing unexpected/off-pipeline column).
 *
 * Degradation (spec §8 — never throws / never orange): the projection always
 * yields the full idle roster, so the canvas renders it with the muted
 * `data-canvas-note` (degraded = ledger missing; empty/all-idle = no
 * dispatches yet). `initialPan` is a deterministic SSR/test seed — the live
 * page starts at the origin.
 */

import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentEdge, AgentEntityStatus, AgentEntityView, ZoneView } from '../graph/project-graph.ts'
import css from './agent-canvas.module.css'

export interface AgentCanvasPageProps {
  /** The projected agents zone (spec §6.2 — `ZoneView['agents']`). */
  view: ZoneView['agents']
  t: TranslateNS<'mstar-panel'>
  /** Deterministic initial pan seed (SSR/tests); the live page starts at the origin. */
  initialPan?: PanState
}

/** Pan state: the content-layer translate (spec §6.2 — free pan, no bounds). */
export interface PanState {
  x: number
  y: number
}

/** A live drag gesture: the pan at pointerdown + the pointer start position. */
export interface PanDrag {
  originX: number
  originY: number
  startX: number
  startY: number
}

export const PAN_ORIGIN: PanState = { x: 0, y: 0 }

/** Open a drag gesture: remember the pan at pointerdown and the pointer seat. */
export function panDragStart(pan: PanState, x: number, y: number): PanDrag {
  return { originX: pan.x, originY: pan.y, startX: x, startY: y }
}

/** Follow the pointer: pan = origin + (current − start) — free pan (spec §6.2). */
export function panDragMove(drag: PanDrag, x: number, y: number): PanState {
  return { x: drag.originX + (x - drag.startX), y: drag.originY + (y - drag.startY) }
}

/** The `data-canvas-pan` transform string (spec §6.2 — translate only). */
export function panTransform(pan: PanState): string {
  return `translate(${pan.x}px, ${pan.y}px)`
}

/* ------------------------------ canvas layout ------------------------------ */

/** One positioned box in the canvas coordinate space. */
export interface CanvasBox {
  x: number
  y: number
  w: number
  h: number
}

/** One stage column track (expected/next edge anchors + the column label). */
export interface CanvasColumn extends CanvasBox {
  id: string
}

/** The deterministic canvas geometry: stage columns + per-entity card boxes. */
export interface CanvasLayout {
  width: number
  height: number
  columns: readonly CanvasColumn[]
  cards: ReadonlyMap<string, CanvasBox>
}

/** Layout metrics (canvas coordinate space — px, deterministic per view). */
const COL_W = 200
const COL_GAP = 56
const CARD_W = 176
const CARD_H = 72
const ROW_GAP = 12
const PAD_X = 24
const PAD_Y = 24
const COL_PAD = 12
/** Column label band height (the cards start below it). */
const LABEL_H = 18

/** The trailing column id for stage-null entities (off-pipeline + unexpected). */
export const UNEXPECTED_COLUMN = 'unexpected'

/**
 * Deterministic canvas layout (spec §4 — the collaboration story): one column
 * per EXPECTED_ROLE_FLOW stage (view order) + a trailing `unexpected` column
 * for stage-null entities; cards stack vertically inside their column; the
 * canvas bounds grow with the tallest column. Total function — every entity
 * gets a box (stage ids that do not match any column fall back to the
 * unexpected track; never a throw).
 */
export function layoutAgents(view: ZoneView['agents']): CanvasLayout {
  const columnIds = [...view.stages.map((s) => s.id), UNEXPECTED_COLUMN]
  const buckets = new Map<string, AgentEntityView[]>()
  for (const entity of view.entities) {
    const colId = entity.stage === null
      ? UNEXPECTED_COLUMN
      : `${entity.stage.phase}:${entity.stage.stage}`
    const bucketId = columnIds.includes(colId) ? colId : UNEXPECTED_COLUMN
    const bucket = buckets.get(bucketId)
    if (bucket === undefined) buckets.set(bucketId, [entity])
    else bucket.push(entity)
  }
  const cards = new Map<string, CanvasBox>()
  const columns: CanvasColumn[] = []
  let maxColH = 0
  let x = PAD_X
  for (const id of columnIds) {
    const list = buckets.get(id) ?? []
    const h = COL_PAD * 2 + LABEL_H + list.length * CARD_H + Math.max(0, list.length - 1) * ROW_GAP
    const colH = Math.max(h, CARD_H + LABEL_H + COL_PAD * 2)
    columns.push({ id, x, y: PAD_Y, w: COL_W, h: colH })
    list.forEach((entity, i) => {
      cards.set(entity.key, {
        x: x + (COL_W - CARD_W) / 2,
        y: PAD_Y + LABEL_H + COL_PAD + i * (CARD_H + ROW_GAP),
        w: CARD_W,
        h: CARD_H,
      })
    })
    maxColH = Math.max(maxColH, colH)
    x += COL_W + COL_GAP
  }
  return {
    width: x - COL_GAP + PAD_X,
    height: PAD_Y + maxColH + PAD_Y,
    columns,
    cards,
  }
}

/** One edge's SVG line geometry; null when an anchor is missing (total function). */
function edgeLine(edge: AgentEdge, layout: CanvasLayout): { x1: number; y1: number; x2: number; y2: number } | null {
  if (edge.kind === 'actual') {
    const source = layout.cards.get(edge.source)
    const target = layout.cards.get(edge.target)
    if (source === undefined || target === undefined) return null
    return {
      x1: source.x + source.w / 2,
      y1: source.y + source.h / 2,
      x2: target.x + target.w / 2,
      y2: target.y + target.h / 2,
    }
  }
  const source = layout.columns.find((c) => c.id === edge.source)
  const target = layout.columns.find((c) => c.id === edge.target)
  if (source === undefined || target === undefined) return null
  return {
    x1: source.x + source.w,
    y1: source.y + source.h / 2,
    x2: target.x,
    y2: target.y + target.h / 2,
  }
}

/* ------------------------------ card / edge pieces ------------------------------ */

/** The card status point (spec §4): running glows, settled shows the ✓, idle stays muted. */
function StatusPoint({ status }: { status: AgentEntityStatus }) {
  const className = css.agentStatusDot
    + (status === 'running'
      ? ` ${css.agentStatusRunning}`
      : status === 'settled'
        ? ` ${css.agentStatusSettled}`
        : status === 'error' || status === 'denied'
          ? ` ${css.agentStatusError}`
          : status === 'advisory'
            ? ` ${css.agentStatusAdvisory}`
            : ` ${css.agentStatusIdle}`)
  if (status === 'settled') {
    return <span className={className} data-agent-status={status} aria-label="settled">✓</span>
  }
  return <span className={className} data-agent-status={status} aria-hidden="true" />
}

/**
 * One entity card (spec §4/§6.2): title = the AGENT NAME (role id for lit
 * cards; displayName ?? id for idle cards); session id / task tag are record
 * fields on `data-agent-record`; idle cards carry `data-agent-idle` (muted).
 */
function EntityCard({ entity, t, box }: { entity: AgentEntityView; t: TranslateNS<'mstar-panel'>; box: CanvasBox }) {
  const running = entity.status === 'running'
  // title = agent 名 (spec §4 — role display id/name; idle cards carry
  // displayName ?? id through `entity.name`); the session id is a record field.
  const title = entity.idle ? entity.name : entity.role !== '' ? entity.role : entity.name
  const record: string[] = []
  if (entity.agent !== null) record.push(entity.agent)
  if (entity.task !== null) record.push(entity.task)
  return (
    <li
      className={entity.idle ? `${css.agentCard} ${css.agentCardIdle}` : running ? `${css.agentCard} ${css.agentCardRunning}` : css.agentCard}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      data-agent-entity={entity.key}
      data-agent-status={entity.status}
      data-agent-idle={entity.idle ? 'true' : undefined}
      data-agent-running={running ? 'true' : undefined}
      data-agent-stage={entity.stage === null ? 'unexpected' : `${entity.stage.phase}:${entity.stage.stage}`}
    >
      <div className={css.agentCardLine}>
        <span className={css.agentCardName} title={title}>{title}</span>
        <StatusPoint status={entity.status} />
        {entity.count > 1 && (
          <span className={css.agentCount} data-agent-count={entity.count}>{`×${entity.count}`}</span>
        )}
      </div>
      {entity.role !== '' && entity.role !== entity.key && (
        <span className={css.agentRoleChip} data-agent-role={entity.role}>{entity.role}</span>
      )}
      {record.length > 0 && (
        <span className={css.agentRecord} data-agent-record>{record.join(' · ')}</span>
      )}
    </li>
  )
}

/* ------------------------------ the page ------------------------------ */

export function AgentCanvasPage({ view, t, initialPan }: AgentCanvasPageProps) {
  const { entities, edges, degraded, empty, executing, pending } = view
  const [pan, setPan] = useState<PanState>(() => initialPan ?? PAN_ORIGIN)
  const dragRef = useRef<PanDrag | null>(null)
  const layout = useMemo(() => layoutAgents(view), [view])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return // primary button only
    e.preventDefault() // no native scroll / text selection while dragging
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = panDragStart(pan, e.clientX, e.clientY)
  }
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null) return
    setPan(panDragMove(drag, e.clientX, e.clientY))
  }
  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // Muted degradation note (spec §8 — three honest states, never orange):
  // degraded = unreadable ledger; empty = 0 events; all-idle = settles only.
  const allIdle = entities.length > 0 && entities.every((e) => e.idle)
  const note = degraded
    ? { anchor: 'degraded', text: t('flow.degraded') }
    : empty || allIdle
      ? { anchor: 'empty', text: t('flow.empty') }
      : null

  return (
    <div className={css.canvasPage} data-mstar-page="agents">
      <header className={css.canvasHeader}>
        <h2 className={css.canvasTitle}>{t('zone.agents.title')}</h2>
        <span
          className={css.canvasSummary}
          data-agent-summary
          data-agent-summary-executing={executing}
          data-agent-summary-pending={pending}
        >
          {t('zone.agents.summary', { executing: String(executing), pending: String(pending) })}
        </span>
      </header>

      {note !== null && <p className={css.canvasNote} data-canvas-note={note.anchor}>{note.text}</p>}

      <div
        className={css.canvasViewport}
        data-canvas-viewport
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <div
          className={css.canvasContent}
          data-canvas-pan
          style={{ transform: panTransform(pan), width: layout.width, height: layout.height }}
        >
          {layout.columns.map((col) => (
            <span
              key={col.id}
              className={css.canvasColumnLabel}
              style={{ left: col.x, top: col.y }}
              data-canvas-column={col.id}
            >
              {col.id === UNEXPECTED_COLUMN ? t('flow.unexpected') : col.id.slice(col.id.indexOf(':') + 1)}
            </span>
          ))}

          <svg className={css.canvasEdges} width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker id="canvas-arrow-expected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path className={css.canvasArrowExpected} d="M 0 1 L 9 5 L 0 9 z" />
              </marker>
              <marker id="canvas-arrow-actual" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path className={css.canvasArrowActual} d="M 0 1 L 9 5 L 0 9 z" />
              </marker>
              <marker id="canvas-arrow-next" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path className={css.canvasArrowNext} d="M 0 1 L 9 5 L 0 9 z" />
              </marker>
            </defs>
            {edges.map((edge, i) => {
              const line = edgeLine(edge, layout)
              if (line === null) return null
              const kind = edge.kind
              const className = kind === 'next'
                ? css.canvasEdgeNext
                : kind === 'actual'
                  ? css.canvasEdgeActual
                  : css.canvasEdgeExpected
              const marker = kind === 'next'
                ? 'url(#canvas-arrow-next)'
                : kind === 'actual'
                  ? 'url(#canvas-arrow-actual)'
                  : 'url(#canvas-arrow-expected)'
              return (
                <line
                  key={`${kind}-${i}-${edge.source}-${edge.target}`}
                  className={className}
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  markerEnd={marker}
                  data-agent-edge-expected={kind === 'expected' ? `${edge.source}->${edge.target}` : undefined}
                  data-agent-edge-actual={kind === 'actual' ? `${edge.source}->${edge.target}` : undefined}
                  data-agent-edge-next={kind === 'next' ? `${edge.source}->${edge.target}` : undefined}
                  data-agent-edge-next-from={kind === 'next' ? (edge.entityKey ?? '') : undefined}
                />
              )
            })}
          </svg>

          <ul className={css.canvasCards}>
            {entities.map((entity) => (
              <EntityCard key={entity.key} entity={entity} t={t} box={layout.cards.get(entity.key)!} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
