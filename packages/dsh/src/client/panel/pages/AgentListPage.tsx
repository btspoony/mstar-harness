/**
 * AgentListPage (plan sidebar §L3) — the 代理执行 tab: a VERTICAL GROUPED
 * LIST. Replaces the deleted absolutely-positioned agent canvas: every
 * geometry concept (the coordinate-space content layer, the pointer pan, the
 * stage columns, the card boxes, the SVG edge layer, the card ports) is
 * gone — the flow itself is carried by the group/stage/sub-bucket headings
 * in constant order, exactly as the column order did before.
 *
 * Grouping (plan sidebar §L3.2 — locked, PROJECTION-driven, never a render
 * guess): two levels. The OUTER group is the phase of the entity's stage
 * (`entity.stage.phase`, or `entity.zone` when `stage === null`), in the
 * `EXPECTED_ROLE_FLOW`/`view.stages` constant order — Phase 1
 * (iteration-start: the sequential review-edit-chain) then Phase 2
 * (autonomous-execute: the iterative plan loop, annotated with the current
 * `activePlanId`). The INNER group is the stage with the implementor stage
 * split by the PROJECTED `entity.bucket`: the implementor partition above
 * (flow roles in `SDD_BUCKET_ROLES.implementor` order, then the on-demand
 * roles, carrying the on-demand badge) and the reviewer partition below —
 * plus the「unknown / 未匹配角色」sub-bucket at the bottom of the LAST stage
 * group for `zone: 'general'` entities, rendered only when it has members
 * (the canvas's placement rule, unchanged). Every stage group always
 * renders, because the projection always yields the full 14-role roster as
 * cards (idle at minimum). The implementor-partition host stage is DERIVED
 * from the projected skeleton (the stage whose expected roles intersect
 * `SDD_BUCKET_ROLES.implementor`), so a phase/stage rename can never
 * silently orphan the sub-buckets; absent that stage the LAST stage group is
 * the total-function sink (never a throw).
 *
 * Card anatomy (plan sidebar §L3.3): each entity is a FULL-WIDTH FLOW ROW —
 * no inline box style, no absolute positioning, no ports. The status point,
 * done-✓ restriction (`status === 'settled' && emphasis !== 'off'`), the
 * title rule, the ×N count, the role chip, the record line and the on-demand
 * badge are all carried over unchanged.
 *
 * Emphasis tiers (design doc §3): the projected `data-agent-emphasis` tier
 * fades the card CHROME only (chrome colors mix toward the layer background
 * by tier — current 100% / next 75% / off 45%, theme-independent per
 * `DESIGN.md` §3.5) — NEVER a whole-card opacity, so the status point and
 * the ✓ never fade.
 *
 * Shared iteration section: the page renders the SAME `IterationInfoSection`
 * the tasks tab uses, from the SAME `view.iteration` data — 两个 tab 显示同一
 * 迭代信息块. The degradation note (degraded / empty / settle-only) is
 * PROJECTED metadata, never inferred from the entity list, and the `Legend`
 * (the 3 role-card status treatments) sits in flow BELOW the list.
 *
 * Scrolling (plan sidebar §L2.2): the page owns NO scroller — the rows grow
 * the panel's single scroll body (`[data-mstar-scroll]`). The phase groups
 * ride the shell's shared `.groupGrid` class (one column below the 720px
 * container breakpoint, the two-column spread above it is that rule's).
 */

import * as React from 'react'
import { useMemo } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentEntityStatus, AgentEntityView, AgentZoneStage, ZoneView } from '../graph/project-graph.ts'
import { GENERAL_BUCKET, SDD_BUCKET_ROLES, type PhaseId } from '../graph/schema.ts'
import { Legend } from '../zones/Legend.tsx'
import { IterationInfoSection } from './IterationInfoSection.tsx'
import css from './agent-list.module.css'
import panelCss from '../panel.module.css'

export interface AgentListPageProps {
  /** The projected agents zone (spec §6.2 — `ZoneView['agents']`). */
  view: ZoneView['agents']
  /** The projected iteration zone (spec §3) — the SHARED iteration info
   * block: BOTH the tasks tab and this page render the SAME
   * `IterationInfoSection` from the SAME `view.iteration` data. */
  iteration: ZoneView['iteration']
  t: TranslateNS<'mstar-panel'>
}

/**
 * The unknown sub-bucket id : `zone: 'general'` entities render in the
 * 「unknown / 未匹配角色」sub-bucket at the bottom of the LAST stage group,
 * marked `data-sub-bucket="unknown"`. The constant survives the canvas
 * deletion — it names the sub-bucket VALUE, not a column.
 */
export const UNKNOWN_COLUMN = 'unknown'

/* ------------------------------ list model ------------------------------ */

/** One sub-bucket partition inside a stage group (projected membership). */
interface SubBucketView {
  /** The partition id — `implementor` / `reviewer` / the unknown constant. */
  id: 'implementor' | 'reviewer' | typeof UNKNOWN_COLUMN
  /** The partition's cards, deterministic order. */
  entities: readonly AgentEntityView[]
}

/** One stage group: the stage label + its direct cards + its sub-buckets. */
interface StageGroupView {
  /** The `${phase}:${stage}` id (the group anchor value). */
  id: string
  /** The label text — the stage slice of the id (the pipeline-order context). */
  label: string
  /** Cards rendered directly in the stage group (before any sub-bucket). */
  flow: readonly AgentEntityView[]
  /** Sub-bucket partitions, render order: implementor → reviewer → unknown. */
  buckets: readonly SubBucketView[]
}

/** One phase group (plan sidebar §L3.2): the phase label row (+ the Phase-2
 * current-plan chip) over its stage groups in skeleton order. */
interface PhaseGroupView {
  /** The group's iteration phase id. */
  phase: PhaseId
  /** 1-based group ordinal in stage order (Phase 1 = 1, Phase 2 = 2). */
  index: number
  /** Current-plan annotation host: true for the `autonomous-execute` phase
   * group (the iterative plan loop) only. */
  planNote: boolean
  stages: readonly StageGroupView[]
}

/**
 * Deterministic member order inside a partition: the roles of `order` first
 * (the projected stage's expected-role order, or the SDD sub-bucket roster),
 * then any defensive leftover in entity order — never a throw, never a loss.
 */
function orderedByRole(members: readonly AgentEntityView[], order: readonly string[]): AgentEntityView[] {
  const byKey = new Map(members.map((e) => [e.key, e]))
  const ordered: AgentEntityView[] = []
  const claimed = new Set<string>()
  for (const role of order) {
    const entity = byKey.get(role)
    if (entity !== undefined) {
      ordered.push(entity)
      claimed.add(role)
    }
  }
  for (const entity of members) {
    if (!claimed.has(entity.key)) ordered.push(entity)
  }
  return ordered
}

/**
 * Build the two-level list model from the PROJECTION (plan sidebar §L3.2):
 * phase groups from consecutive same-phase runs over `view.stages` (the
 * skeleton's constant order), stage groups from the skeleton, membership
 * from each entity's projected zone / stage / bucket. Total function — an
 * entity whose stage group does not exist (impossible via the projection:
 * the skeleton is constant) is skipped rather than thrown.
 */
function buildGroups(view: ZoneView['agents']): PhaseGroupView[] {
  // Phase groups: consecutive same-phase runs over the projected skeleton —
  // derived, never literal, so a phase/stage rename can never orphan the
  // groups (the same derivation the canvas used, now in flow).
  const rawGroups: { phase: PhaseId; index: number; stageIds: string[]; planNote: boolean }[] = []
  for (const stage of view.stages) {
    const last = rawGroups[rawGroups.length - 1]
    if (last === undefined || last.phase !== stage.phase) {
      rawGroups.push({
        phase: stage.phase,
        index: rawGroups.length + 1,
        stageIds: [stage.id],
        planNote: stage.phase === 'autonomous-execute',
      })
    } else {
      last.stageIds.push(stage.id)
    }
  }

  const stageById = new Map<string, AgentZoneStage>(view.stages.map((s) => [s.id, s]))
  const lastStageId = view.stages.length > 0 ? view.stages[view.stages.length - 1]!.id : null
  // The implementor-partition host: the stage whose expected roles intersect
  // SDD_BUCKET_ROLES.implementor (the sdd-implement stage in the current
  // pipeline) — DERIVED from the projected skeleton + the same locked
  // constant the projection buckets with, never a stage-name literal. Absent
  // that stage → the LAST stage group (total function, never a throw).
  const implementorHostId = view.stages.find((s) =>
    s.roles.some((r) => SDD_BUCKET_ROLES.implementor.includes(r))
  )?.id ?? lastStageId

  // Bucket the entities by their stage group (the canvas's placement rule):
  // 'flow' → the entity's stage group; 'on-demand' → the implementor host
  // (the implementor partition — no standalone group anymore); 'general' →
  // the LAST stage group's unknown sub-bucket; a stage-less flow entity →
  // the implementor host (defensive — impossible via the projection).
  const members = new Map<string, AgentEntityView[]>()
  for (const entity of view.entities) {
    const stageId = entity.zone === GENERAL_BUCKET
      ? lastStageId
      : entity.zone === 'on-demand'
        ? implementorHostId
        : entity.zone === 'flow' && entity.stage !== null
          ? `${entity.stage.phase}:${entity.stage.stage}`
          : implementorHostId
    if (stageId === null) continue // no stage skeleton at all → nowhere to place
    const list = members.get(stageId)
    if (list === undefined) members.set(stageId, [entity])
    else list.push(entity)
  }

  return rawGroups.map((raw) => ({
    phase: raw.phase,
    index: raw.index,
    planNote: raw.planNote,
    stages: raw.stageIds.map((stageId) => {
      const stage = stageById.get(stageId)
      const list = members.get(stageId) ?? []
      const isImplementorHost = stageId === implementorHostId
      const isLast = stageId === lastStageId
      const flow: AgentEntityView[] = []
      const implementor: AgentEntityView[] = []
      const reviewer: AgentEntityView[] = []
      const unknown: AgentEntityView[] = []
      for (const entity of list) {
        if (isLast && entity.zone === GENERAL_BUCKET) unknown.push(entity)
        else if (isImplementorHost && entity.bucket === 'implementor') implementor.push(entity)
        else if (isImplementorHost && entity.bucket === 'reviewer') reviewer.push(entity)
        else flow.push(entity)
      }
      // Sub-buckets in render order; a partition renders only with members
      // (implementor/reviewer are never empty via the roster — the unknown
      // sub-bucket is the only one the projection can leave empty).
      const buckets: SubBucketView[] = []
      if (implementor.length > 0) {
        buckets.push({ id: 'implementor', entities: orderedByRole(implementor, SDD_BUCKET_ROLES.implementor) })
      }
      if (reviewer.length > 0) {
        buckets.push({ id: 'reviewer', entities: orderedByRole(reviewer, SDD_BUCKET_ROLES.reviewer) })
      }
      if (unknown.length > 0) {
        buckets.push({ id: UNKNOWN_COLUMN, entities: orderedByRole(unknown, []) })
      }
      return {
        id: stageId,
        label: stageId.slice(stageId.indexOf(':') + 1),
        flow: orderedByRole(flow, stage?.roles ?? []),
        buckets,
      }
    }),
  }))
}

/* ------------------------------ card pieces ------------------------------ */

/**
 * The card status point (spec §4): running glows, settled shows the ✓,
 * idle stays muted. The ✓ is the COMPLETION marker: it renders ONLY for a
 * settled entity whose emphasis is NOT 'off' (`done` — the card also carries
 * the green done frame); a settled entity on an 'off' tier (already-passed /
 * stage-less on-demand + general roles) shows the plain MUTED dot instead —
 * the completed state never appears on a stage-less role. The component is
 * carried over from the deleted canvas VERBATIM. `data-agent-status` always
 * reports the honest projected status; `data-agent-done` carries the frame
 * decision.
 */
function StatusPoint({ status, done }: { status: AgentEntityStatus; done: boolean }) {
  const className = css.agentStatusDot
    + (status === 'running'
      ? ` ${css.agentStatusRunning}`
      : status === 'settled'
        ? done
          ? ` ${css.agentStatusSettled}`
          : ` ${css.agentStatusIdle}` // settled + off → muted dot, NO ✓
        : status === 'error' || status === 'denied'
          ? ` ${css.agentStatusError}`
          : status === 'advisory'
            ? ` ${css.agentStatusAdvisory}`
            : ` ${css.agentStatusIdle}`)
  if (status === 'settled' && done) {
    return <span className={className} data-agent-status={status} data-agent-done="true" aria-label="settled">✓</span>
  }
  return <span className={className} data-agent-status={status} aria-hidden="true" />
}

/**
 * One entity row (plan sidebar §L3.3): a FULL-WIDTH FLOW ROW — no inline box
 * style, no absolute positioning, no ports. Title = the AGENT NAME (role id
 * for lit cards; displayName ?? id for idle cards); the session id / task
 * tag are record fields on `data-agent-record`; idle cards carry
 * `data-agent-idle` (muted).
 */
function EntityCard({ entity, t }: { entity: AgentEntityView; t: TranslateNS<'mstar-panel'> }) {
  const running = entity.status === 'running'
  // Done frame: settled AND emphasis ≠ 'off' → the standalone GREEN frame +
  // green ✓. emphasis === 'off' (already-passed / stage-less on-demand +
  // general roles) NEVER shows the completion marker — the completed state
  // cannot appear on an off-tier role.
  const done = entity.status === 'settled' && entity.emphasis !== 'off'
  // Title = agent 名 (role display id/name; idle cards carry displayName ?? id
  // through `entity.name`); the session id is a record field.
  const title = entity.idle ? entity.name : entity.role !== '' ? entity.role : entity.name
  const record: string[] = []
  if (entity.agent !== null) record.push(entity.agent)
  if (entity.task !== null) record.push(entity.task)
  return (
    <li
      className={entity.idle
        ? `${css.agentCard} ${css.agentCardIdle}`
        : running
          ? `${css.agentCard} ${css.agentCardRunning}`
          : done
            ? `${css.agentCard} ${css.agentCardDone}`
            : css.agentCard}
      data-agent-entity={entity.key}
      data-agent-status={entity.status}
      data-agent-idle={entity.idle ? 'true' : undefined}
      data-agent-running={running ? 'true' : undefined}
      data-agent-done={done ? 'true' : 'false'}
      data-agent-stage={entity.stage === null ? entity.zone : `${entity.stage.phase}:${entity.stage.stage}`}
      data-agent-bucket={entity.bucket ?? undefined}
      data-agent-emphasis={entity.emphasis ?? undefined}
    >
      {/* On-demand badge: the implementor-partition on-demand roles
       * (ops-engineer / prompt-engineer) carry the badge — the PROJECTED
       * `zone === 'on-demand'`, never a render guess. */}
      {entity.zone === 'on-demand' && (
        <span className={css.onDemandBadge} data-agent-on-demand="true">
          {t('zone.agents.on-demand')}
        </span>
      )}
      <div className={css.agentCardLine}>
        <span className={css.agentCardName} title={title}>{title}</span>
        <StatusPoint status={entity.status} done={done} />
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

/** The sub-bucket caption text (implementor / reviewer / unknown). */
function subBucketLabel(id: SubBucketView['id'], t: TranslateNS<'mstar-panel'>): string {
  if (id === 'implementor') return t('zone.agents.bucket.implementor')
  if (id === 'reviewer') return t('zone.agents.bucket.reviewer')
  return t('zone.agents.unknown-sub')
}

/* ------------------------------ the page ------------------------------ */

export function AgentListPage({ view, iteration, t }: AgentListPageProps) {
  const { degraded, note, executing, pending } = view
  // Memoized on the projection identity: `view.agents` is stable per snapshot
  // (PanelContent memoizes `projectGraph` on the payload), so the group model
  // rebuilds only when the projection actually changes.
  const groups = useMemo(() => buildGroups(view), [view])

  // Muted degradation note (spec §8 — four honest states, never orange):
  // `degraded` (unreadable ledger) is its own flag; the projected `note`
  // classifies the readable ledger — 'empty' = 0 events, 'settle-only' =
  // events but no dispatch rows, null = dispatch evidence. The note comes
  // from the PROJECTION, never from an `entities.every(idle)` heuristic — a
  // garbage ledger would fake settle-only.
  const noteInfo = degraded
    ? { anchor: 'degraded', text: t('flow.degraded') }
    : note === 'empty'
      ? { anchor: 'empty', text: t('flow.empty') }
      : note === 'settle-only'
        ? { anchor: 'settle-only', text: t('flow.settle-only') }
        : null

  return (
    <div className={css.listPage} data-mstar-page="agents">
      {/* The SHARED iteration info section: the SAME block the tasks tab
       * renders (IterationInfoSection), from the SAME `view.iteration` data. */}
      <IterationInfoSection iteration={iteration} t={t} />

      <header className={css.listHeader}>
        <h2 className={css.listTitle}>{t('zone.agents.title')}</h2>
        <span
          className={css.listSummary}
          data-agent-summary
          data-agent-summary-executing={executing}
          data-agent-summary-pending={pending}
        >
          {t('zone.agents.summary', { executing: String(executing), pending: String(pending) })}
        </span>
      </header>

      {noteInfo !== null && <p className={css.listNote} data-agents-note={noteInfo.anchor}>{noteInfo.text}</p>}

      {/* The vertical grouped list (plan sidebar §L3.2): phase groups in the
       * skeleton's constant order, stage groups inside, sub-bucket partitions
       * inside those. The grid rides the shell's shared `.groupGrid` — one
       * column below the 720px container breakpoint, the two-column spread
       * above it is that rule's (one rule, not a second layout). */}
      <div className={`${css.agentList} ${panelCss.groupGrid}`} data-agent-list>
        {groups.map((group) => (
          <section
            key={group.phase}
            className={css.agentGroup}
            data-agent-group={group.phase}
            data-agent-group-index={group.index}
          >
            {/* Phase label row: the Phase-2 row additionally carries the
             * CURRENT-PLAN annotation (the projected `activePlanId` — the
             * first InProgress `state.plans[]` row; muted 「无进行中 plan」
             * when none; `+N more` when several run in parallel — honest,
             * never hides the rest). */}
            <span className={css.groupLabel}>
              {group.phase === 'iteration-start'
                ? t('zone.agents.group.phase-1')
                : group.phase === 'autonomous-execute'
                  ? t('zone.agents.group.phase-2')
                  : t('zone.agents.group.phase-n', { n: String(group.index) })}
              {group.planNote && (
                view.activePlanId === null
                  ? (
                    <span className={css.groupNoPlan} data-agent-group-no-plan>
                      {t('zone.agents.group.no-plan')}
                    </span>
                  )
                  : (
                    <span className={css.groupPlan} data-agent-group-plan={view.activePlanId}>
                      {t('zone.agents.group.plan', { plan: view.activePlanId })}
                      {view.activePlanCount > 1 && (
                        <span className={css.groupPlanMore} data-agent-group-plan-more>
                          {t('zone.agents.group.plan-more', { n: String(view.activePlanCount - 1) })}
                        </span>
                      )}
                    </span>
                  )
              )}
            </span>

            {group.stages.map((stage) => (
              <section key={stage.id} className={css.stageGroup} data-agent-stage={stage.id}>
                {/* Stage label (the pipeline-order context — the stage slice
                 * of the projected id, as the old column label read). */}
                <span className={css.stageLabel}>{stage.label}</span>
                {stage.flow.length > 0 && (
                  <ul className={css.cardList}>
                    {stage.flow.map((entity) => (
                      <EntityCard key={entity.key} entity={entity} t={t} />
                    ))}
                  </ul>
                )}
                {stage.buckets.map((bucket) => (
                  <section key={bucket.id} className={css.subBucket} data-sub-bucket={bucket.id}>
                    {/* Partition caption + the dashed rule (rendered only
                     * while the partition has cards). */}
                    <span className={css.subBucketLabel}>{subBucketLabel(bucket.id, t)}</span>
                    <ul className={css.cardList}>
                      {bucket.entities.map((entity) => (
                        <EntityCard key={entity.key} entity={entity} t={t} />
                      ))}
                    </ul>
                  </section>
                ))}
              </section>
            ))}
          </section>
        ))}
      </div>

      {/* Legend IN FLOW below the list (the header / summary / note stay
       * above; the legend frame itself is the shared zone component). */}
      <div className={css.listLegend}>
        <Legend t={t} />
      </div>
    </div>
  )
}
