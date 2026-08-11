/**
 * AgentFlowZone (plan 20260810-panel-agent-flow-zone Task 2, spec panel-zones
 * §4) — the agents zone rendered for real: the 6 EXPECTED_ROLE_FLOW stage
 * columns (stage label + phase tag), the dispatch-derived entity cards (agent
 * display name / role chip / task tag / status point / ×N count), the dashed
 * "待执行" pending placeholders (expected role chips, per-stage evidence via
 * the projection's `stage.evidenced`), the `N executing · M pending` summary
 * row, and the flow arrows:
 *
 * - expected: dim skeleton arrow between consecutive stage columns;
 * - actual: small `→` between same-column entity cards (same-plan ts-adjacent
 *   dispatch pairs, rendered only when BOTH cards share the column);
 * - next: the latest running entity's stage column → the next constant-order
 *   column — business-highlighted, dash-flow ANIMATED (CSS
 *   background-position dash flow, killed by the root prefers-reduced-motion
 *   rule), with the localized "next" label. Honest: no running entity / no
 *   stage / last column → NO next edge (the projection decides).
 *
 * Unexpected-role entities (stage null — e.g. `scout`) get a trailing dim
 * "unexpected" column so every running card stays visible next to the summary
 * count (the dock re-lists their events too). The zone scrolls horizontally
 * (6 columns + arrows overflow internally; the page never scrolls — spec §2).
 *
 * Degradation (spec §8, all muted — never an orange frame): agentFlow
 * unreadable → `degraded` (muted "agentFlow 证据缺失" + empty stage skeleton —
 * NO entity/pending claims, the projection zeroes both counts); empty ledger →
 * full pending skeleton + muted "暂无派发"; settle-only ledger → no cards +
 * full pending skeleton + the same muted note (summary 0 · M).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentEdge, AgentEntityStatus, AgentEntityView, ZoneView } from '../graph/project-graph.ts'
import type { PhaseId } from '../graph/schema.ts'
import type { PanelKey } from '../locale.ts'
import css from './zones.module.css'

export interface AgentFlowZoneProps {
  view: ZoneView['agents']
  t: TranslateNS<'mstar-panel'>
}

/** Phase-tag label seat (spec §4 — column header shows the phase name). */
const PHASE_TITLE: Readonly<Record<PhaseId, PanelKey>> = {
  'iteration-start': 'zone.phase.iteration-start',
  'autonomous-execute': 'zone.phase.autonomous-execute',
  'iteration-close': 'zone.phase.iteration-close',
  'pr-delivery': 'zone.phase.pr-delivery',
  'merge-ready': 'zone.phase.merge-ready',
}

/** The card status point (spec §4): a colored dot — running glows (business),
 * settled shows the ✓, error/denied/advisory carry their state color. */
function StatusPoint({ status }: { status: AgentEntityStatus }) {
  const className = css.agentStatusDot
    + (status === 'running'
      ? ` ${css.agentStatusRunning}`
      : status === 'settled'
        ? ` ${css.agentStatusSettled}`
        : status === 'error' || status === 'denied'
          ? ` ${css.agentStatusError}`
          : ` ${css.agentStatusAdvisory}`)
  if (status === 'settled') {
    return <span className={className} data-agent-status={status} aria-label="settled">✓</span>
  }
  return <span className={className} data-agent-status={status} aria-hidden="true" />
}

/** One entity card (spec §4): name / role chip / task tag / status point / ×N. */
function EntityCard({ entity, t }: { entity: AgentEntityView; t: TranslateNS<'mstar-panel'> }) {
  const running = entity.status === 'running'
  return (
    <li
      className={running ? `${css.agentCard} ${css.agentCardRunning}` : css.agentCard}
      data-agent-entity={entity.key}
      data-agent-status={entity.status}
      data-agent-running={running ? 'true' : undefined}
      data-agent-stage={entity.stage === null ? 'unexpected' : `${entity.stage.phase}:${entity.stage.stage}`}
    >
      <div className={css.agentCardLine}>
        <span className={css.agentCardName} title={entity.name}>{entity.name}</span>
        <StatusPoint status={entity.status} />
        {entity.count > 1 && (
          <span className={css.agentCount} data-agent-count={entity.count}>{`×${entity.count}`}</span>
        )}
      </div>
      {entity.role !== '' && <span className={css.agentRoleChip}>{entity.role}</span>}
      {entity.task !== null && <span className={css.agentTaskTag}>{entity.task}</span>}
    </li>
  )
}

/**
 * One stage column's card list with the in-column handoff arrows (spec §4):
 * a small `→` between consecutive cards when the projection carries an actual
 * edge between them (same-plan ts-adjacent dispatch pair — rendered only when
 * both cards share this column; non-adjacent pairs simply get no visual arrow).
 */
function StageCards({
  cards,
  actual,
  t,
}: {
  cards: readonly AgentEntityView[]
  actual: ReadonlyMap<string, AgentEdge>
  t: TranslateNS<'mstar-panel'>
}) {
  return (
    <ul className={css.agentStageCards}>
      {cards.map((entity, j) => {
        const prev = j > 0 ? cards[j - 1] : null
        const edge = prev === null
          ? undefined
          : actual.get(`${prev.key}|${entity.key}`) ?? actual.get(`${entity.key}|${prev.key}`)
        return (
          <React.Fragment key={entity.key}>
            {edge !== undefined && (
              <li className={css.agentActualArrow} data-agent-actual-edge={`${edge.source}->${edge.target}`} aria-hidden="true">→</li>
            )}
            <EntityCard entity={entity} t={t} />
          </React.Fragment>
        )
      })}
    </ul>
  )
}

/** The dashed "待执行" placeholder (spec §4): expected role chips of an un-evidenced stage. */
function PendingPlaceholder({ stage, t }: { stage: ZoneView['agents']['stages'][number]; t: TranslateNS<'mstar-panel'> }) {
  return (
    <div className={css.agentPending} data-agent-pending={stage.id}>
      <span className={css.agentPendingLabel}>{t('zone.agents.pending-label')}</span>
      <ul className={css.agentRoleChips}>
        {stage.roles.map((role) => (
          <li key={role} className={css.agentRoleChipPending} data-role={role}>{role}</li>
        ))}
      </ul>
    </div>
  )
}

export function AgentFlowZone({ view, t }: AgentFlowZoneProps) {
  const { stages, entities, edges, degraded, empty, executing, pending } = view

  // The single next edge (at most one — the projection's latest-running rule).
  const next = edges.find((e) => e.kind === 'next') ?? null
  // Actual edges by unordered key pair — the in-column arrow lookup.
  const actual = new Map<string, AgentEdge>()
  for (const e of edges) {
    if (e.kind === 'actual') actual.set(`${e.source}|${e.target}`, e)
  }

  // Muted degradation note (spec §8 — three distinct anchors, never orange):
  // degraded = unreadable ledger (no claims); empty = 0 events; settle-only =
  // events but no dispatch rows (no cards). The note is rendered above the
  // skeleton, whose stage bodies follow the same honesty rules.
  const note = degraded
    ? { anchor: 'degraded', text: t('flow.degraded') }
    : empty
      ? { anchor: 'empty', text: t('flow.empty') }
      : entities.length === 0
        ? { anchor: 'settle-only', text: t('flow.empty') }
        : null

  // Unexpected-role cards (stage null — scout/explore/…) get a trailing column.
  const unexpected = entities.filter((e) => e.stage === null)

  return (
    <section className={css.zone} data-zone="agents">
      <header className={css.agentsHeader} data-zone-header>
        <h2 className={css.zoneHeader}>{t('zone.agents.title')}</h2>
        <span
          className={css.agentsSummary}
          data-agent-summary
          data-agent-summary-executing={executing}
          data-agent-summary-pending={pending}
        >
          {t('zone.agents.summary', { executing: String(executing), pending: String(pending) })}
        </span>
      </header>

      {note !== null && <p className={css.zoneEmpty} data-zone-empty={note.anchor}>{note.text}</p>}

      <div className={css.agentFlow} data-mstar-agent-flow>
        {stages.map((stage, i) => {
          const prev = stages[i - 1]
          const nextHere = next !== null && prev !== undefined && next.source === prev.id && next.target === stage.id
          const cards = stage.evidenced ? entities.filter((e) => e.stage !== null && `${e.stage.phase}:${e.stage.stage}` === stage.id) : []
          return (
            <React.Fragment key={stage.id}>
              {prev !== undefined && (
                nextHere
                  ? (
                    <span
                      className={css.agentNextEdge}
                      data-agent-next-edge={`${next!.source}->${next!.target}`}
                      data-agent-next-from={next!.entityKey ?? ''}
                    >
                      <span className={css.agentNextDash} data-agent-next-dash />
                      <span className={css.agentNextGlyph} aria-hidden="true">→</span>
                      <span className={css.agentNextLabel} data-agent-next-label>{t('zone.agents.next')}</span>
                    </span>
                  )
                  : (
                    <span
                      className={css.agentExpectedEdge}
                      data-agent-expected-edge={`${prev.id}->${stage.id}`}
                      aria-hidden="true"
                    >→</span>
                  )
              )}
              <div className={css.agentStage} data-agent-stage={stage.id}>
                <header className={css.agentStageHeader}>
                  <span className={css.agentStageLabel}>{stage.stage}</span>
                  <span className={css.agentStagePhase} data-agent-stage-phase={stage.phase}>
                    {t(PHASE_TITLE[stage.phase])}
                  </span>
                </header>
                {degraded
                  ? null
                  : stage.evidenced
                    ? <StageCards cards={cards} actual={actual} t={t} />
                    : <PendingPlaceholder stage={stage} t={t} />}
              </div>
            </React.Fragment>
          )
        })}
        {unexpected.length > 0 && (
          <div className={css.agentStage} data-agent-stage="unexpected">
            <header className={css.agentStageHeader}>
              <span className={css.agentStageLabel}>{t('flow.unexpected')}</span>
            </header>
            <StageCards cards={unexpected} actual={actual} t={t} />
          </div>
        )}
      </div>
    </section>
  )
}
