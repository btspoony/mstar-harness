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
 * Edges (spec §4 + plan 20260812-panel-f5-design-system Task 5 — the
 * finalized 2026-08-12 line semantics, design doc §2): ONLY the actual
 * handoffs (business entity→entity — role-keyed, general endpoints
 * filtered, one edge per pair) and the supervise line (plan
 * 20260812-panel-f5-agent-layout Task 2 — the static bidirectional
 * implementor ↔ sdd-reviewer sub-bucket line inside the `sdd-implement`
 * column, dim dashed by default, lit business when the projected
 * `evidenced` flag is true — never a fabricated activation) — all drawn as
 * SVG bezier `C` paths (design doc §2.6) over the layout computed by the
 * exported pure `layoutAgents`. The `expected` stage skeleton and the
 * animated `next` edge are REMOVED (user feedback #1/#5 — the column order
 * implies the flow, the running card glow + status point carry the
 * position). Every line anchors to a CARD PORT (4 fixed edge-midpoint
 * ports, design doc §2.5 — hover-visible dots, static-invisible) or the
 * supervise side-gap anchors (card right edge + 18px); the arrow tip sits
 * at the STANDOFF point 10px off the target port (arrow along the endpoint
 * tangent — H1) and no line crosses text (H2: standoff + side-gap routing
 * for caption-crossing same-column flows + column-gap crossings).
 *
 * Layout (plan 20260812-panel-f5-agent-layout Task 2 + plan
 * 20260812-panel-f5-design-system Task 5 — the F5 rework): deterministic
 * columns per EXPECTED_ROLE_FLOW stage (review-edit-chain → sdd-implement →
 * qc-tri → qa-gate) — FOUR columns total (user 2026-08-12 feedback #3: the
 * standalone rightmost UNKNOWN column is REMOVED; `zone: 'general'`
 * entities render in an "unknown / 未匹配角色" SUB-PARTITION at the bottom
 * of the LAST column, `data-sub-bucket="unknown"`). The
 * `sdd-implement` column is split into sub-buckets by the PROJECTED
 * `entity.bucket` (never a render guess): the implementor partition above —
 * flow roles in the stage's original order, then the on-demand roles
 * (ops-engineer / prompt-engineer, carrying the on-demand badge) — and the
 * reviewer partition (code-reviewer, idle included) below, with the
 * implementor / sdd-reviewer caption labels. `zone: 'on-demand'` entities
 * have NO standalone column anymore — they live in the implementor
 * partition. The former F4.2 "general sinks to the bottom of
 * the sdd-implement column" placement is superseded (Task 2), as is the
 * Task-2 rightmost unknown column (Task 5); the former
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
  /** The unknown sub-partition at the bottom of the LAST column (plan
   * 20260812-panel-f5-design-system Task 5 — user 2026-08-12 feedback #3:
   * `zone: 'general'` entities sink into a qa-gate-column-bottom sub-partition
   * instead of a standalone fifth column). The caption seat + card band;
   * null when the layout has no columns (total function — never a throw). */
  unknown: UnknownSubPartition | null
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

/** The arrow-tip standoff (plan 20260812-panel-f5-design-system Task 5 —
 * design doc §2.5, H1): every actual-edge path END retreats this far from
 * the target port along the endpoint tangent, so the arrow tip sits 10px
 * OUTSIDE the card border (不贴卡). Same-column flows with a tighter gap
 * reduce it so the 7px arrowhead never overlaps the source card (see
 * `sameColumnStandoff`). */
const STANDOFF = 10

/** The side-gap offset (design doc §2.5/§2.7 — 侧隙垂直锚点): the supervise
 * line and the caption-crossing same-column flows hang at
 * `card edge ± 18px` inside the column gap — clear of every caption / card
 * text (H2). */
const SIDE_GAP = 18

/** The unknown sub-partition id (plan 20260812-panel-f5-design-system Task 5
 * — design doc §1.2): `zone: 'general'` entities render in a bottom
 * sub-partition of the LAST column titled「unknown / 未匹配角色」and marked
 * `data-sub-bucket="unknown"`. The former standalone rightmost UNKNOWN column
 * (plan 20260812-panel-f5-agent-layout Task 2) is REMOVED — the constant
 * value survives as the sub-partition bucket id. */
export const UNKNOWN_COLUMN = 'unknown'

/** The sdd-implement stage id (plan 20260812-panel-f5-agent-layout Task 2):
 * the sub-bucket host column (implementor partition above / reviewer
 * partition below) AND the implementor sink for `zone: 'on-demand'`
 * entities (ops-engineer / prompt-engineer — the standalone on-demand column
 * is REMOVED). The column id is DERIVED from the projected stages inside
 * `layoutAgents` (`view.stages.find(...)` → the stage's `${phase}:${stage}`
 * id — single source of truth, the same key construction the projection's
 * EXPECTED_ROLE_FLOW map emits), so a phase/stage rename can never silently
 * orphan the sub-buckets; the stage selector below is the ONLY literal. When
 * the stage column is absent, `layoutAgents` falls back to the LAST column
 * (total function, never a throw). */
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

/** The unknown sub-partition of the LAST column (plan 20260812-panel-f5-design-system
 * Task 5 — design doc §1.2): the caption seat + the general cards' band. The
 * caption row (SUB_LABEL_H) sits ROW_GAP below the last flow card; the
 * general cards follow SUB_GAP below it. */
export interface UnknownSubPartition {
  /** The caption row's top-left seat (canvas coordinates; width = the card
   * row width so the dashed rule fills the row). */
  label: { x: number; y: number; w: number }
  /** The unknown partition's card bounding band; null when the partition has
   * no general card (total function — the caption renders only with cards). */
  band: CanvasBox | null
}

/**
 * Deterministic canvas layout (spec §4 + plan 20260812-panel-f5-agent-layout
 * Task 2 + plan 20260812-panel-f5-design-system Task 5 — the F5 rework): one
 * column per EXPECTED_ROLE_FLOW stage (view order: review-edit-chain →
 * sdd-implement → qc-tri → qa-gate) — FOUR columns total (user 2026-08-12
 * feedback #3; the standalone rightmost unknown column is REMOVED). The
 * `sdd-implement` column is split into sub-buckets by the PROJECTED
 * `entity.bucket` (never a render-side guess): the implementor partition
 * above — flow roles in the stage's original EXPECTED_ROLE_FLOW order, then
 * the on-demand roles (ops-engineer / prompt-engineer — the standalone
 * on-demand column is REMOVED) — and the reviewer partition (code-reviewer)
 * below, with the implementor / sdd-reviewer caption seats + card bands
 * recorded in `subBuckets` (the supervise-line anchors). `zone: 'general'`
 * entities (the general bucket — unmatched / anonymous dispatches) render in
 * the "unknown / 未匹配角色" SUB-PARTITION at the bottom of the LAST column
 * (`layout.unknown` — design doc §1.2: caption row ROW_GAP below the last
 * flow card, general cards SUB_GAP below it). The column bucket comes from
 * the PROJECTED `entity.zone`: 'flow' → the entity's stage column,
 * 'on-demand' → the sdd-implement column's implementor partition, 'general'
 * → the last column's unknown partition. Total function — every entity gets
 * a box; absent sdd-implement stage → on-demand falls back to the LAST
 * column; unknown column ids fall back to the same sink; never a throw.
 */
export function layoutAgents(view: ZoneView['agents']): CanvasLayout {
  const columnIds = view.stages.map((s) => s.id)
  // The general-bucket sink (design doc §1.2): the LAST stage column (qa-gate
  // in the current pipeline) hosts the unknown sub-partition — DERIVED from
  // the projected stages (never a literal), so a stage/order rename can never
  // silently orphan the sink.
  const unknownSinkId = columnIds[columnIds.length - 1] ?? UNKNOWN_COLUMN
  // The sdd-implement stage column: the sub-bucket host + the on-demand
  // implementor sink — DERIVED from the projected stages (the `${phase}:
  // ${stage}` id — the projection's own key construction, so the sub-buckets
  // / on-demand placement can never silently miss a phase/stage rename).
  // Absent that stage → the unknown sink (the last column — total function,
  // never a throw).
  const sddStage = view.stages.find((s) => s.stage === GENERAL_SINK_STAGE)
  const sddSinkId = sddStage === undefined ? unknownSinkId : sddStage.id

  const buckets = new Map<string, AgentEntityView[]>()
  for (const entity of view.entities) {
    // zone → column (plan f5 Task 2 + Task 5): 'flow' → the entity's stage
    // column (the sdd-implement column re-partitions it by bucket below);
    // 'on-demand' → the sdd-implement column (implementor partition — NO
    // standalone on-demand column anymore); 'general' → the LAST column's
    // unknown sub-partition (NO standalone unknown column anymore — Task 5).
    const colId = entity.zone === GENERAL_BUCKET
      ? unknownSinkId
      : entity.zone === 'on-demand'
        ? sddSinkId
        : entity.zone === 'flow' && entity.stage !== null
          ? `${entity.stage.phase}:${entity.stage.stage}`
          : sddSinkId
    const bucketId = columnIds.includes(colId) ? colId : sddSinkId
    const bucket = buckets.get(bucketId)
    if (bucket === undefined) buckets.set(bucketId, [entity])
    else bucket.push(entity)
  }

  const cards = new Map<string, CanvasBox>()
  const columns: CanvasColumn[] = []
  const subBuckets = new Map<string, SubBucketGeometry>()
  let unknown: UnknownSubPartition | null = null
  let maxColH = 0
  let x = PAD_X
  for (const id of columnIds) {
    const list = buckets.get(id) ?? []
    const column: CanvasColumn = { id, x, y: PAD_Y, w: COL_W, h: 0 }
    columns.push(column)
    if (id === sddSinkId && sddStage !== undefined) {
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
    } else if (id === unknownSinkId) {
      // The LAST column (qa-gate in the current pipeline) hosts the unknown
      // sub-partition (plan 20260812-panel-f5-design-system Task 5 — design
      // doc §1.2): the flow cards (qa-gate entities) stack first, then the
      //「unknown / 未匹配角色」caption row (SUB_LABEL_H) ROW_GAP below the last
      // flow card, then the general cards SUB_GAP below the caption. The
      // caption seat + band feed the render (data-sub-bucket="unknown").
      const flowList = list.filter((e) => e.zone !== GENERAL_BUCKET)
      const generalList = list.filter((e) => e.zone === GENERAL_BUCKET)
      let y = PAD_Y + LABEL_H + COL_PAD
      for (const entity of flowList) {
        cards.set(entity.key, { x: x + (COL_W - CARD_W) / 2, y, w: CARD_W, h: CARD_H })
        y += CARD_H + ROW_GAP
      }
      const unknownLabelY = y // the last flow card's bottom + ROW_GAP
      const unknownBoxes: CanvasBox[] = []
      y = unknownLabelY + SUB_LABEL_H + SUB_GAP
      for (const entity of generalList) {
        const box = { x: x + (COL_W - CARD_W) / 2, y, w: CARD_W, h: CARD_H }
        cards.set(entity.key, box)
        unknownBoxes.push(box)
        y += CARD_H + ROW_GAP
      }
      const colBottom = y - ROW_GAP // the last card's bottom edge
      column.h = Math.max(colBottom - PAD_Y + COL_PAD, CARD_H + LABEL_H + COL_PAD * 2)
      const labelW = CARD_W
      unknown = {
        label: { x: x + (COL_W - CARD_W) / 2, y: unknownLabelY, w: labelW },
        band: unknownBoxes.length === 0
          ? null
          : { x, y: unknownBoxes[0]!.y, w: COL_W, h: unknownBoxes[unknownBoxes.length - 1]!.y + CARD_H - unknownBoxes[0]!.y },
      }
    } else {
      // Plain stack (every other column).
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
    unknown,
  }
}

/**
 * Resolve one supervise anchor `<col-id>:<bucket>` to the side-gap vertical
 * anchor point (plan 20260812-panel-f5-agent-layout Task 2 + plan
 * 20260812-panel-f5-design-system Task 5 — design doc §2.5/§2.7, user
 * 2026-08-12 feedback #4): the column id is the anchor prefix BEFORE the
 * last `:` (column ids themselves contain `:`, so the bucket suffix is the
 * LAST segment); the implementor anchor lands at the band's BOTTOM edge and
 * the reviewer anchor at the band's TOP edge — the inter-partition gap (the
 * supervise line spans the gap, so both outward auto-start-reverse
 * arrowheads render clear of the opaque cards; a single gap-midpoint anchor
 * would collapse the line to zero length, which cannot draw visible
 * markers). The X is the SIDE-GAP coordinate: the sdd-implement CARD right
 * edge + 18px (inside the column gap) — the v3 fix (v2 drew the line through
 * the "sdd-reviewer" caption text): at that x the line is clear of every
 * caption / card text (H2). The band is the deterministic sub-bucket
 * geometry from `layoutAgents` (idle cards are in the layout, so the band is
 * computable whenever the partition has any card). Null when the column /
 * sub-bucket geometry / band is missing — total function, never a throw.
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
  // row + SUB_GAP) and both arrowheads stay visible. x = the side-gap
  // vertical anchor: card right edge + SIDE_GAP (design doc §2.5 — H2, the
  // v3 fix that clears the "sdd-reviewer" caption text).
  const cardLeft = column.x + (COL_W - CARD_W) / 2
  const x = cardLeft + CARD_W + SIDE_GAP
  const y = bucket === 'implementor' ? band.y + band.h : band.y
  return { x, y }
}

/** The fixed port points of a card box (design doc §2.5 — 4 edge-midpoint
 * ports, no new tokens). */
export type PortId = 'north' | 'south' | 'west' | 'east'

/** One card's port point in canvas coordinates (edge midpoint). */
function portPoint(box: CanvasBox, port: PortId): { x: number; y: number } {
  switch (port) {
    case 'north': return { x: box.x + box.w / 2, y: box.y }
    case 'south': return { x: box.x + box.w / 2, y: box.y + box.h }
    case 'west': return { x: box.x, y: box.y + box.h / 2 }
    case 'east': return { x: box.x + box.w, y: box.y + box.h / 2 }
  }
}

/** The canvas column index of a card box (deterministic — columns never
 * overlap, so exactly one column contains box.x; -1 only when the layout has
 * no columns — total function). */
function columnIndexOfBox(layout: CanvasLayout, box: CanvasBox): number {
  return layout.columns.findIndex((c) => box.x >= c.x && box.x < c.x + c.w)
}

/** The sub-bucket CAPTION rows of a column (implementor / sdd-reviewer
 * labels + the unknown caption of the last column) — the text seats a
 * same-column vertical flow must not cross (H2, design doc §2.0). Each row
 * is the label seat (the caption text + the dashed rule occupy the row). */
function captionRows(layout: CanvasLayout, columnId: string): { x: number; y: number; w: number; h: number }[] {
  const rows: { x: number; y: number; w: number; h: number }[] = []
  const geometry = layout.subBuckets.get(columnId)
  if (geometry !== undefined) {
    for (const p of [geometry.implementor, geometry.reviewer]) {
      if (p.band !== null) rows.push({ x: p.label.x, y: p.label.y, w: p.label.w, h: SUB_LABEL_H })
    }
  }
  const lastId = layout.columns[layout.columns.length - 1]?.id
  if (columnId === lastId && layout.unknown !== null && layout.unknown.band !== null) {
    rows.push({ x: layout.unknown.label.x, y: layout.unknown.label.y, w: layout.unknown.label.w, h: SUB_LABEL_H })
  }
  return rows
}

/** The standoff for a same-column south↔north flow: the doc's 10px would
 * leave the 7px arrowhead overlapping the source card in the tight ROW_GAP
 * (12px) — shrink to fit: standoff = min(STANDOFF, gap − 8) keeps the arrow
 * base ≥ 2px clear of the source card (simplify: the vertical arrowhead
 * needs ~8px of the gap; a future larger ROW_GAP token restores the full
 * 10px standoff). */
function sameColumnStandoff(gap: number): number {
  return Math.min(STANDOFF, Math.max(2, gap - 8))
}

/** One edge's bezier geometry (design doc §2.6): the `d` path + the
 * endpoint coordinates (start = the source port, end = the target STANDOFF
 * point — the arrow tip lands there, 10px off the card border H1). Null
 * when an anchor is missing (total function). */
export interface EdgeGeometry {
  /** The SVG path `d` (single `C` cubic-bezier command). */
  d: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/** The horizontal bezier (design doc §2.6): `M sx sy C (sx+off) sy,
 * (tx−off) ty, tx ty` with off = max(|tx−sx|/2, 24) — endpoint tangents
 * horizontal → the arrow rides the line (H1). */
function horizontalCurve(sx: number, sy: number, tx: number, ty: number): EdgeGeometry {
  const off = Math.max(Math.abs(tx - sx) / 2, 24)
  const d = `M ${sx} ${sy} C ${sx + off} ${sy}, ${tx - off} ${ty}, ${tx} ${ty}`
  return { d, x1: sx, y1: sy, x2: tx, y2: ty }
}

/** The vertical bezier (design doc §2.6 — the "degenerate" vertical flow,
 * preview §2.6: control points collinear with the endpoints at ⅓ / ⅔ of the
 * span → the curve is the straight vertical segment with VERTICAL endpoint
 * tangents → the arrows ride the line (H1)). The 24px floor does NOT apply
 * here: it exists to avoid flat curves between adjacent columns (horizontal
 * flows); on a short vertical span it would push the controls outside the
 * endpoint band and bulge the curve into the cards. */
function verticalCurve(sx: number, sy: number, tx: number, ty: number): EdgeGeometry {
  const span = ty - sy
  const d = `M ${sx} ${sy} C ${sx} ${sy + span / 3}, ${tx} ${ty - span / 3}, ${tx} ${ty}`
  return { d, x1: sx, y1: sy, x2: tx, y2: ty }
}

/**
 * One edge's SVG bezier geometry (plan 20260812-panel-f5-design-system Task
 * 5 — design doc §2.5/§2.6); null when an anchor is missing (total
 * function).
 *
 * Port selection (design doc §2.5 — lines connect ports only, never through
 * a card): forward (source column < target column) → source EAST → target
 * WEST; reverse (source column > target column) → source WEST → target
 * EAST; same column → source SOUTH → target NORTH. The path END stands off
 * STANDOFF px from the target port along the endpoint tangent (arrow tip off
 * the card, H1); the source starts AT its port (no arrow there).
 *
 * Same-column flows whose center-x vertical line would cross a sub-bucket
 * CAPTION row (the implementor↔reviewer flow crosses the "sdd-reviewer"
 * caption, the qa-gate↔unknown flow crosses the「unknown / 未匹配角色」
 * caption) route in the column's LEFT side gap instead (design doc §2.0
 * 绕行策略 ② — 同列关系线移到卡片列外侧的间隙带): the vertical bezier hangs
 * at `card left edge − SIDE_GAP`, clear of every text (H2).
 */
export function edgePath(edge: AgentEdge, layout: CanvasLayout): EdgeGeometry | null {
  if (edge.kind === 'supervise') {
    // The bidirectional sub-bucket supervision line (plan f5 Task 2 + Task
    // 5): implementor ↔ sdd-reviewer — a vertical bezier in the side gap
    // (implementor band bottom → reviewer band top at card right edge +
    // SIDE_GAP), so the outward double-arrow markers stay visible AND clear
    // of the caption text (H2 — the v3 side-gap fix).
    const source = superviseAnchor(edge.source, layout)
    const target = superviseAnchor(edge.target, layout)
    if (source === null || target === null) return null
    return verticalCurve(source.x, source.y, target.x, target.y)
  }
  // actual: entity-keyed handoff (design doc §2.5 — port anchoring).
  const sourceBox = layout.cards.get(edge.source)
  const targetBox = layout.cards.get(edge.target)
  if (sourceBox === undefined || targetBox === undefined) return null
  const srcCol = columnIndexOfBox(layout, sourceBox)
  const tgtCol = columnIndexOfBox(layout, targetBox)
  if (srcCol < tgtCol) {
    // Forward: source east → target west; the path ends 10px LEFT of the
    // west edge (outside the card) with a horizontal tangent (H1).
    const s = portPoint(sourceBox, 'east')
    const t = portPoint(targetBox, 'west')
    return horizontalCurve(s.x, s.y, t.x - STANDOFF, t.y)
  }
  if (srcCol > tgtCol) {
    // Reverse: source west → target east; ends 10px RIGHT of the east edge.
    const s = portPoint(sourceBox, 'west')
    const t = portPoint(targetBox, 'east')
    return horizontalCurve(s.x, s.y, t.x + STANDOFF, t.y)
  }
  // Same column: south → north (design doc §2.5). The center-x vertical line
  // must not cross a caption row of the column (H2 — e.g. implementor →
  // code-reviewer crosses the "sdd-reviewer" caption); when it would, route
  // in the column's LEFT side gap (card left edge − SIDE_GAP).
  const srcBottom = sourceBox.y + sourceBox.h
  const gap = targetBox.y - srcBottom
  const standoff = sameColumnStandoff(gap)
  const cx = sourceBox.x + sourceBox.w / 2
  const endY = targetBox.y - standoff
  const colId = layout.columns[srcCol]?.id
  const crossesCaption = colId !== undefined && captionRows(layout, colId).some(
    (row) => cx >= row.x && cx <= row.x + row.w && Math.min(srcBottom, endY) < row.y + row.h && Math.max(srcBottom, endY) > row.y,
  )
  if (crossesCaption) {
    const sideX = sourceBox.x - SIDE_GAP
    return verticalCurve(sideX, srcBottom, sideX, endY)
  }
  return verticalCurve(cx, srcBottom, cx, endY)
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
      {/* Card ports (plan 20260812-panel-f5-design-system Task 5 — design
       * doc §2.5): the 4 fixed edge-midpoint anchors (north / south / west /
       * east). Static-INVISIBLE geometry (no dot at rest); the CSS reveals
       * them on card hover / selected (running cards hover in business
       * color). Non-interactive (pointer-events: none — the ports are
       * anchors, not controls). */}
      <span className={css.agentPort} data-agent-port="north" aria-hidden="true" />
      <span className={css.agentPort} data-agent-port="south" aria-hidden="true" />
      <span className={css.agentPort} data-agent-port="west" aria-hidden="true" />
      <span className={css.agentPort} data-agent-port="east" aria-hidden="true" />
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
              {/* Stage column labels (plan f5 Task 5 — design doc §1.2: FOUR
               * columns, the standalone unknown column is removed; the last
               * column's label stays the stage id, the general bucket lives
               * in its bottom unknown SUB-partition instead). */}
              {col.id.slice(col.id.indexOf(':') + 1)}
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

          {/* The unknown sub-partition caption (plan 20260812-panel-f5-design-system
           * Task 5 — design doc §1.2, user 2026-08-12 feedback #3): the
           *「unknown / 未匹配角色」caption of the LAST column's bottom
           * sub-partition (the general bucket). Rendered only while the
           * partition has cards (the band exists — the layout records the
           * seat deterministically). */}
          {layout.unknown !== null && layout.unknown.band !== null && (
            <span
              className={css.subBucketLabel}
              style={{ left: layout.unknown.label.x, top: layout.unknown.label.y, width: layout.unknown.label.w }}
              data-sub-bucket={UNKNOWN_COLUMN}
            >
              {t('zone.agents.unknown-sub')}
            </span>
          )}

          <svg className={css.canvasEdges} width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              {/* Task 5 line set (design doc §2.2/§2.6): actual + supervise
               * markers only — the expected / next markers are REMOVED. All
               * markers use orient="auto" (H1: the arrow rides the path's
               * endpoint tangent — the bezier shapes guarantee the tangent
               * equals the line's dominant direction, §2.6); supervise uses
               * orient="auto-start-reverse" so BOTH ends point outward — the
               * bidirectional implementor ↔ sdd-reviewer double arrow. */}
              <marker id="canvas-arrow-actual" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path className={css.canvasArrowActual} d="M 0 1 L 9 5 L 0 9 z" />
              </marker>
              <marker id="canvas-arrow-supervise" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className={css.canvasArrowSupervise} d="M 0 1 L 9 5 L 0 9 z" />
              </marker>
              <marker id="canvas-arrow-supervise-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className={css.canvasArrowSuperviseLit} d="M 0 1 L 9 5 L 0 9 z" />
              </marker>
            </defs>
            {edges.map((edge, i) => {
              const curve = edgePath(edge, layout)
              if (curve === null) return null
              if (edge.kind === 'supervise') {
                // The static bidirectional supervision line (plan f5 Task 2 +
                // Task 5): dim dashed without implement/review dispatch
                // evidence, lit business with it — `evidenced` is PROJECTED,
                // never a render-side fabrication. A vertical bezier in the
                // side gap (card right edge + SIDE_GAP) — H2 (clear of the
                // "sdd-reviewer" caption text).
                const lit = edge.evidenced === true
                return (
                  <path
                    key={`supervise-${i}-${edge.source}-${edge.target}`}
                    className={`${css.canvasEdgeCurve} ${lit ? `${css.canvasEdgeSupervise} ${css.canvasEdgeSuperviseLit}` : css.canvasEdgeSupervise}`}
                    d={curve.d}
                    markerStart={lit ? 'url(#canvas-arrow-supervise-lit)' : 'url(#canvas-arrow-supervise)'}
                    markerEnd={lit ? 'url(#canvas-arrow-supervise-lit)' : 'url(#canvas-arrow-supervise)'}
                    data-agent-edge-supervise={`${edge.source}->${edge.target}`}
                    data-agent-edge-supervise-lit={lit ? 'true' : undefined}
                  />
                )
              }
              return (
                <path
                  key={`actual-${i}-${edge.source}-${edge.target}`}
                  className={`${css.canvasEdgeCurve} ${css.canvasEdgeActual}`}
                  d={curve.d}
                  markerEnd="url(#canvas-arrow-actual)"
                  data-agent-edge-actual={`${edge.source}->${edge.target}`}
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
