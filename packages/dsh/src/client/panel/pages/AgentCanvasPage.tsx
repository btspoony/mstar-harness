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
 * - forced capture loss (window blur / alt-tab / element removal mid-gesture)
 *   fires `lostpointercapture` without pointerup — it binds the same end
 *   handler so `dragRef` never goes stale (review S-002).
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
 * Edges (spec §4 + plan 20260811-panel-f3-agent-general — AgentEdge model
 * reused): expected skeleton (dim dashed stage→stage, 3 forward edges),
 * actual handoffs (business entity→entity — role-keyed), next (business
 * ANIMATED dash-flow stage→stage) and the supervise line (plan
 * 20260812-panel-f5-agent-layout Task 2 — the static bidirectional
 * implementor ↔ sdd-reviewer sub-bucket line inside the `sdd-implement`
 * column, dim dashed by default, lit business when the projected
 * `evidenced` flag is true — never a fabricated activation) — all drawn as
 * SVG over the layout computed by the exported pure `layoutAgents`.
 *
 * Layout (plan 20260812-panel-f5-agent-layout Task 2 — the F5 rework):
 * deterministic columns per EXPECTED_ROLE_FLOW stage (review-edit-chain →
 * sdd-implement → qc-tri → qa-gate) + the rightmost UNKNOWN_COLUMN. The
 * `sdd-implement` column is split into sub-buckets by the PROJECTED
 * `entity.bucket` (never a render guess): the implementor partition above —
 * flow roles in the stage's original order, then the on-demand roles
 * (ops-engineer / prompt-engineer, carrying the on-demand badge) — and the
 * reviewer partition (code-reviewer, idle included) below, with the
 * implementor / sdd-reviewer caption labels. `zone: 'on-demand'` entities
 * have NO standalone column anymore — they live in the implementor
 * partition; `zone: 'general'` entities (the general bucket) render in the
 * rightmost unknown column. The former F4.2 "general sinks to the bottom of
 * the sdd-implement column" placement is superseded; the former
 * sdd-implement → general SDD loop back-edge stays REMOVED (the render
 * draws no loop branch).
 *
 * Degradation (spec §8 — never throws / never orange): the projection always
 * yields the full idle roster, so the canvas renders it with the muted
 * `data-canvas-note` (degraded = ledger missing; empty = no events;
 * settle-only = events but no dispatch rows — review T2-Imp-2 restored the
 * old zone's distinct settle-only anchor; F-002: the empty/settle-only note
 * is PROJECTED metadata, never inferred from the entity list). The Legend
 * (idle / collaboration swatches, plan Task 3) sits above the viewport.
 * `initialPan` is a deterministic SSR/test seed — the live page starts at the
 * origin.
 */

import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentEdge, AgentEntityStatus, AgentEntityView, ZoneView } from '../graph/project-graph.ts'
import { GENERAL_BUCKET, KNOWN_AGENTS } from '../graph/schema.ts'
import { Legend } from '../zones/Legend.tsx'
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
  /** Sub-bucket geometry per column id (plan 20260812-panel-f5-agent-layout
   * Task 2): the `sdd-implement` column's implementor/reviewer caption seats
   * + card bands — the supervise line anchors to the band edges (the
   * inter-partition gap; QC W-001).
   * Columns without sub-buckets are absent from the map. */
  subBuckets: ReadonlyMap<string, SubBucketGeometry>
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
/** Sub-bucket caption row height (plan 20260812-panel-f5-agent-layout Task
 * 2): the implementor / sdd-reviewer partition labels inside the
 * `sdd-implement` column (the caption consumes its own row above the
 * partition's cards). */
const SUB_LABEL_H = 14
/** Gap between a sub-bucket caption row and its first card (canvas metric). */
const SUB_GAP = 4

/** The unknown column id (plan 20260812-panel-f5-agent-layout Task 2): the
 * rightmost catch-all column for `zone: 'general'` entities (the general
 * bucket — unmatched / anonymous dispatches). Appended LAST in the column
 * order — it inherits the former ON_DEMAND_COLUMN's "always the last
 * column" total-function fallback role (when the `sdd-implement` stage
 * column is absent, on-demand/general entities sink here — never a throw). */
export const UNKNOWN_COLUMN = 'unknown'

/** The sdd-implement stage id (plan 20260812-panel-f5-agent-layout Task 2):
 * the sub-bucket host column (implementor partition above / reviewer
 * partition below) AND the implementor sink for `zone: 'on-demand'`
 * entities (ops-engineer / prompt-engineer — the standalone on-demand column
 * is REMOVED). The column id is DERIVED from the projected stages inside
 * `layoutAgents` (`view.stages.find(...)` → the stage's `${phase}:${stage}`
 * id — single source of truth, the same key construction the projection's
 * EXPECTED_ROLE_FLOW map emits), so a phase/stage rename can never silently
 * orphan the sub-buckets; the stage selector below is the ONLY literal. The
 * GENERAL bucket no longer sinks into this column — it has its own rightmost
 * UNKNOWN_COLUMN (Task 2). When the stage column is absent, `layoutAgents`
 * falls back to the LAST column (the unknown column is always appended last
 * — total function, never a throw). */
const GENERAL_SINK_STAGE = 'sdd-implement'

/** One sub-bucket partition inside the `sdd-implement` column (plan
 * 20260812-panel-f5-agent-layout Task 2): the caption seat + the cards'
 * band — the supervise line anchors to the band's edge (implementor:
 * bottom edge; reviewer: top edge — the inter-partition gap; QC W-001). */
export interface SubBucketPartition {
  /** The caption row's top-left seat (canvas coordinates; width = the card
   * row width so the dashed rule fills the row). */
  label: { x: number; y: number; w: number }
  /** The bucket's card bounding band (canvas coordinates); null when the
   * partition has no cards (total function — the caption and the supervise
   * line skip). */
  band: CanvasBox | null
}

/** The sub-bucket geometry of one column (plan f5 Task 2): implementor +
 * reviewer partitions. Present ONLY for the `sdd-implement` column — the
 * supervise anchors read the bands. */
export interface SubBucketGeometry {
  implementor: SubBucketPartition
  reviewer: SubBucketPartition
}

/**
 * Deterministic canvas layout (spec §4 + plan 20260812-panel-f5-agent-layout
 * Task 2 — the F5 rework): one column per EXPECTED_ROLE_FLOW stage (view
 * order: review-edit-chain → sdd-implement → qc-tri → qa-gate) + the
 * rightmost UNKNOWN_COLUMN. The `sdd-implement` column is split into
 * sub-buckets by the PROJECTED `entity.bucket` (never a render-side guess):
 * the implementor partition above — flow roles in the stage's original
 * EXPECTED_ROLE_FLOW order, then the on-demand roles (ops-engineer /
 * prompt-engineer — the standalone on-demand column is REMOVED) — and the
 * reviewer partition (code-reviewer) below, with the implementor /
 * sdd-reviewer caption seats + card bands recorded in `subBuckets` (the
 * supervise-line anchors). `zone: 'general'` entities (the general bucket —
 * unmatched / anonymous dispatches) render in the rightmost unknown column;
 * the former F4.2 "general sinks to the bottom of the sdd-implement column"
 * placement is superseded. The column bucket comes from the PROJECTED
 * `entity.zone`: 'flow' → the entity's stage column, 'on-demand' → the
 * sdd-implement column's implementor partition, 'general' → UNKNOWN_COLUMN.
 * Total function — every entity gets a box; absent sdd-implement stage →
 * on-demand/general fall back to the LAST column (UNKNOWN_COLUMN, always
 * appended last); unknown column ids fall back to the same sink; never a
 * throw.
 */
export function layoutAgents(view: ZoneView['agents']): CanvasLayout {
  const columnIds = [...view.stages.map((s) => s.id), UNKNOWN_COLUMN]
  // The sdd-implement stage column: the sub-bucket host + the on-demand
  // implementor sink — DERIVED from the projected stages (the `${phase}:
  // ${stage}` id — the projection's own key construction, so the sub-buckets
  // / on-demand placement can never silently miss a phase/stage rename).
  // Absent that stage → UNKNOWN_COLUMN: the unknown column is always
  // appended last, so it is exactly that fallback (total function — never a
  // throw).
  const sddStage = view.stages.find((s) => s.stage === GENERAL_SINK_STAGE)
  const sinkId = sddStage === undefined ? UNKNOWN_COLUMN : sddStage.id

  const buckets = new Map<string, AgentEntityView[]>()
  for (const entity of view.entities) {
    // zone → column (plan f5 Task 2): 'flow' → the entity's stage column
    // (the sdd-implement column re-partitions it by bucket below);
    // 'on-demand' → the sdd-implement column (implementor partition — NO
    // standalone on-demand column anymore); 'general' → UNKNOWN_COLUMN.
    const colId = entity.zone === GENERAL_BUCKET
      ? UNKNOWN_COLUMN
      : entity.zone === 'on-demand'
        ? sinkId
        : entity.zone === 'flow' && entity.stage !== null
          ? `${entity.stage.phase}:${entity.stage.stage}`
          : sinkId
    const bucketId = columnIds.includes(colId) ? colId : sinkId
    const bucket = buckets.get(bucketId)
    if (bucket === undefined) buckets.set(bucketId, [entity])
    else bucket.push(entity)
  }

  const cards = new Map<string, CanvasBox>()
  const columns: CanvasColumn[] = []
  const subBuckets = new Map<string, SubBucketGeometry>()
  let maxColH = 0
  let x = PAD_X
  for (const id of columnIds) {
    const list = buckets.get(id) ?? []
    const column: CanvasColumn = { id, x, y: PAD_Y, w: COL_W, h: 0 }
    columns.push(column)
    if (id === sinkId && sddStage !== undefined) {
      // Deterministic sub-bucket partition (plan f5 Task 2 — the partition
      // boundary comes from the PROJECTED `entity.bucket`, never a render
      // guess; same determinism discipline as the former F4.2 general sink):
      // the implementor partition above — flow roles in the stage's original
      // EXPECTED_ROLE_FLOW order, then the on-demand roles in roster order —
      // the reviewer partition (code-reviewer) below. The bands (each
      // bucket's card y-extent) become the supervise-line anchor edges —
      // the line spans the inter-partition gap (QC W-001).
      const implementor = list.filter((e) => e.bucket === 'implementor')
      const reviewer = list.filter((e) => e.bucket === 'reviewer')
      const rest = list.filter((e) => e.bucket !== 'implementor' && e.bucket !== 'reviewer')
      // The implementor partition order key: flow roles by their index in
      // the stage's original roles array (fullstack-dev / fullstack-dev-2 /
      // frontend-dev), on-demand roles AFTER all flow roles (roster order —
      // ops-engineer / prompt-engineer). Defensive unknowns stay last.
      const rosterIndex = new Map(KNOWN_AGENTS.map((a, i) => [a.id, i]))
      const implementorKey = (e: AgentEntityView): number => {
        if (e.zone === 'flow') {
          const i = sddStage.roles.indexOf(e.role)
          return i === -1 ? Number.MAX_SAFE_INTEGER : i
        }
        if (e.zone === 'on-demand') {
          return sddStage.roles.length + (rosterIndex.get(e.role) ?? Number.MAX_SAFE_INTEGER)
        }
        return Number.MAX_SAFE_INTEGER
      }
      implementor.sort((a, b) => implementorKey(a) - implementorKey(b))
      // The reviewer partition keeps its (deterministic) insertion order —
      // the only reviewer role today is code-reviewer.
      const implLabelY = PAD_Y + LABEL_H + COL_PAD
      const implCards: CanvasBox[] = []
      let y = implLabelY + SUB_LABEL_H + SUB_GAP
      for (const entity of implementor) {
        const box = { x: x + (COL_W - CARD_W) / 2, y, w: CARD_W, h: CARD_H }
        cards.set(entity.key, box)
        implCards.push(box)
        y += CARD_H + ROW_GAP
      }
      const revLabelY = y // the last implementor card's bottom + ROW_GAP
      const revCards: CanvasBox[] = []
      y = revLabelY + SUB_LABEL_H + SUB_GAP
      for (const entity of reviewer) {
        const box = { x: x + (COL_W - CARD_W) / 2, y, w: CARD_W, h: CARD_H }
        cards.set(entity.key, box)
        revCards.push(box)
        y += CARD_H + ROW_GAP
      }
      // Defensive tail: null-bucket entities in the sdd-implement column
      // (impossible via the projection — every sdd-implement role is
      // bucketed) stack below the reviewer partition.
      for (const entity of rest) {
        const box = { x: x + (COL_W - CARD_W) / 2, y, w: CARD_W, h: CARD_H }
        cards.set(entity.key, box)
        y += CARD_H + ROW_GAP
      }
      const colBottom = y - ROW_GAP // the last card's bottom edge
      column.h = Math.max(colBottom - PAD_Y + COL_PAD, CARD_H + LABEL_H + COL_PAD * 2)
      const band = (boxes: readonly CanvasBox[]): CanvasBox | null =>
        boxes.length === 0
          ? null
          : { x, y: boxes[0]!.y, w: COL_W, h: boxes[boxes.length - 1]!.y + CARD_H - boxes[0]!.y }
      const labelW = CARD_W
      subBuckets.set(id, {
        implementor: { label: { x: x + (COL_W - CARD_W) / 2, y: implLabelY, w: labelW }, band: band(implCards) },
        reviewer: { label: { x: x + (COL_W - CARD_W) / 2, y: revLabelY, w: labelW }, band: band(revCards) },
      })
    } else {
      // Plain stack (every other column — incl. the UNKNOWN column, which
      // stacks its general entities in entity order).
      list.forEach((entity, i) => {
        cards.set(entity.key, {
          x: x + (COL_W - CARD_W) / 2,
          y: PAD_Y + LABEL_H + COL_PAD + i * (CARD_H + ROW_GAP),
          w: CARD_W,
          h: CARD_H,
        })
      })
      const h = COL_PAD * 2 + LABEL_H + list.length * CARD_H + Math.max(0, list.length - 1) * ROW_GAP
      column.h = Math.max(h, CARD_H + LABEL_H + COL_PAD * 2)
    }
    maxColH = Math.max(maxColH, column.h)
    x += COL_W + COL_GAP
  }
  return {
    width: x - COL_GAP + PAD_X,
    height: PAD_Y + maxColH + PAD_Y,
    columns,
    cards,
    subBuckets,
  }
}

/**
 * Resolve one supervise anchor `<col-id>:<bucket>` to the sub-bucket band
 * EDGE point (plan 20260812-panel-f5-agent-layout Task 2 + QC W-001): the
 * column id is the anchor prefix BEFORE the last `:` (column ids themselves
 * contain `:`, so the bucket suffix is the LAST segment); the implementor
 * anchor lands on its band's BOTTOM edge and the reviewer anchor on its
 * band's TOP edge — the inter-partition gap (the supervise line spans the
 * gap, so both outward auto-start-reverse arrowheads render clear of the
 * opaque cards; a single gap-midpoint anchor would collapse the line to
 * zero length, which cannot draw visible markers). The band is the
 * deterministic sub-bucket geometry from `layoutAgents` (idle cards are in
 * the layout, so the band is computable whenever the partition has any
 * card). Null when the column / sub-bucket geometry / band is missing —
 * total function, never a throw.
 */
function superviseAnchor(anchor: string, layout: CanvasLayout): { x: number; y: number } | null {
  const idx = anchor.lastIndexOf(':')
  if (idx === -1) return null
  const columnId = anchor.slice(0, idx)
  const bucket = anchor.slice(idx + 1)
  if (bucket !== 'implementor' && bucket !== 'reviewer') return null
  const column = layout.columns.find((c) => c.id === columnId)
  if (column === undefined) return null
  const geometry = layout.subBuckets.get(columnId)
  if (geometry === undefined) return null
  const partition = bucket === 'implementor' ? geometry.implementor : geometry.reviewer
  const band = partition.band
  if (band === null) return null
  // Inter-partition gap anchor (QC W-001): the endpoint sits on the band
  // EDGE — implementor at its bottom edge, reviewer at its top edge — so
  // the supervise line spans the ~30 px gap (ROW_GAP + the reviewer caption
  // row + SUB_GAP) and both arrowheads stay visible. x = the column center.
  const y = bucket === 'implementor' ? band.y + band.h : band.y
  return { x: column.x + column.w / 2, y }
}

/** One edge's SVG line geometry; null when an anchor is missing (total function). */
function edgeLine(edge: AgentEdge, layout: CanvasLayout): { x1: number; y1: number; x2: number; y2: number } | null {
  if (edge.kind === 'supervise') {
    // The bidirectional sub-bucket supervision line (plan f5 Task 2, QC
    // W-001): implementor ↔ sdd-reviewer — a vertical line spanning the
    // inter-partition gap (implementor band bottom → reviewer band top, both
    // bands in the same column), so the outward double-arrow markers stay
    // visible in the gap instead of landing behind the opaque cards.
    const source = superviseAnchor(edge.source, layout)
    const target = superviseAnchor(edge.target, layout)
    if (source === null || target === null) return null
    return { x1: source.x, y1: source.y, x2: target.x, y2: target.y }
  }
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
      data-agent-stage={entity.stage === null ? entity.zone : `${entity.stage.phase}:${entity.stage.stage}`}
      data-agent-bucket={entity.bucket ?? undefined}
      data-agent-emphasis={entity.emphasis ?? undefined}
    >
      {/* On-demand badge (plan 20260812-panel-f5-agent-layout Task 2): the
       * implementor-sub-bucket on-demand roles (ops-engineer /
       * prompt-engineer) carry the badge — the PROJECTED `zone ===
       * 'on-demand'`, never a render guess. The badge marks the on-demand
       * nature inside the implementor partition (the standalone on-demand
       * column is removed). */}
      {entity.zone === 'on-demand' && (
        <span className={css.onDemandBadge} data-agent-on-demand="true">
          {t('zone.agents.on-demand')}
        </span>
      )}
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
  const { entities, edges, degraded, note, executing, pending } = view
  const [pan, setPan] = useState<PanState>(() => initialPan ?? PAN_ORIGIN)
  const dragRef = useRef<PanDrag | null>(null)
  const layout = useMemo(() => layoutAgents(view), [view])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return // primary pointer/button only
    e.preventDefault() // no native scroll / text selection while dragging
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = panDragStart(pan, e.clientX, e.clientY)
  }
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null) return
    setPan(panDragMove(drag, e.clientX, e.clientY))
  }
  // Shared end handler: pointerup / pointercancel (normal end) AND
  // lostpointercapture (forced capture loss — window blur / alt-tab /
  // element removal mid-gesture, review S-002). Resets `dragRef` so a stale
  // drag never re-applies pan on a later button-less hover pointermove; the
  // capture check keeps releasePointerCapture safe when capture is already
  // gone (it would throw NotFoundError otherwise).
  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // Muted degradation note (spec §8 — four honest states, never orange):
  // `degraded` (unreadable ledger) is its own flag; the projected `note`
  // classifies the readable ledger — 'empty' = 0 events, 'settle-only' =
  // events but no dispatch rows, null = dispatch evidence (the old
  // AgentFlowZone `data-zone-empty="settle-only"` semantic, review
  // T2-Imp-2, restored as `data-canvas-note="settle-only"`). F-002: the
  // note comes from the PROJECTION, never from an `entities.every(idle)`
  // heuristic — a garbage ledger would fake settle-only.
  const noteInfo = degraded
    ? { anchor: 'degraded', text: t('flow.degraded') }
    : note === 'empty'
      ? { anchor: 'empty', text: t('flow.empty') }
      : note === 'settle-only'
        ? { anchor: 'settle-only', text: t('flow.settle-only') }
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

      {noteInfo !== null && <p className={css.canvasNote} data-canvas-note={noteInfo.anchor}>{noteInfo.text}</p>}

      <div className={css.canvasLegend}>
        <Legend t={t} />
      </div>

      <div
        className={css.canvasViewport}
        data-canvas-viewport
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
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
              {col.id === UNKNOWN_COLUMN
                ? t('zone.agents.unknown')
                : col.id.slice(col.id.indexOf(':') + 1)}
            </span>
          ))}

          {/* Sub-bucket captions (plan f5 Task 2): the implementor /
           * sdd-reviewer partition labels inside the `sdd-implement` column —
           * rendered only while the partition has cards (the band exists);
           * the caption seat + band come from the deterministic layout. */}
          {Array.from(layout.subBuckets.entries()).map(([colId, geometry]) => (
            <span key={colId}>
              {geometry.implementor.band !== null && (
                <span
                  className={css.subBucketLabel}
                  style={{ left: geometry.implementor.label.x, top: geometry.implementor.label.y, width: geometry.implementor.label.w }}
                  data-sub-bucket="implementor"
                >
                  {t('zone.agents.bucket.implementor')}
                </span>
              )}
              {geometry.reviewer.band !== null && (
                <span
                  className={css.subBucketLabel}
                  style={{ left: geometry.reviewer.label.x, top: geometry.reviewer.label.y, width: geometry.reviewer.label.w }}
                  data-sub-bucket="reviewer"
                >
                  {t('zone.agents.bucket.reviewer')}
                </span>
              )}
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
              {/* Supervise markers (plan f5 Task 2): `orient=auto-start-reverse`
               * flips the marker at marker-start, so BOTH ends point outward —
               * the bidirectional implementor ↔ sdd-reviewer double arrow. */}
              <marker id="canvas-arrow-supervise" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className={css.canvasArrowSupervise} d="M 0 1 L 9 5 L 0 9 z" />
              </marker>
              <marker id="canvas-arrow-supervise-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className={css.canvasArrowSuperviseLit} d="M 0 1 L 9 5 L 0 9 z" />
              </marker>
            </defs>
            {edges.map((edge, i) => {
              const line = edgeLine(edge, layout)
              if (line === null) return null
              if (edge.kind === 'supervise') {
                // The static bidirectional supervision line (plan f5 Task 2):
                // dim dashed without implement/review dispatch evidence,
                // lit business with it — `evidenced` is PROJECTED, never a
                // render-side fabrication.
                const lit = edge.evidenced === true
                return (
                  <line
                    key={`supervise-${i}-${edge.source}-${edge.target}`}
                    className={lit ? `${css.canvasEdgeSupervise} ${css.canvasEdgeSuperviseLit}` : css.canvasEdgeSupervise}
                    x1={line.x1}
                    y1={line.y1}
                    x2={line.x2}
                    y2={line.y2}
                    markerStart={lit ? 'url(#canvas-arrow-supervise-lit)' : 'url(#canvas-arrow-supervise)'}
                    markerEnd={lit ? 'url(#canvas-arrow-supervise-lit)' : 'url(#canvas-arrow-supervise)'}
                    data-agent-edge-supervise={`${edge.source}->${edge.target}`}
                    data-agent-edge-supervise-lit={lit ? 'true' : undefined}
                  />
                )
              }
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
            {entities.map((entity) => {
              // Defensive skip (review T2-Imp-1 — never throw/guess): the
              // deterministic layout is total (every entity gets a box), but a
              // card without one renders nothing instead of a runtime crash.
              const box = layout.cards.get(entity.key)
              if (box === undefined) return null
              return <EntityCard key={entity.key} entity={entity} t={t} box={box} />
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
