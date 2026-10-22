/**
 * Workspace-state digest (the sidebar block at the end of the panel's scroll
 * body): this session's workflow selection with its picker, the plan list, the
 * open-residual counts, the enforcement flag, the knowledge rollup and the
 * roadmap direction.
 *
 * DATA PATH: every row reads the polled `PanelSnapshot` (and the projection
 * built from it) — the digest is store-backed like the pages. Nothing here
 * reads the retired emission relay, so a row and a page can never disagree.
 *
 * Degradation is per row: an unreadable authority renders that row's muted
 * `state.none` seat, never a guessed value and never a fabricated zero.
 *
 * The session-selection seat (`selection` / `pick` / `select`) still rides its
 * own client until its read path retires; it is rendered here, never merged
 * into the snapshot rows.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowSelectionView } from '../../types.ts'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import type { ZoneView } from './graph/project-graph.ts'
import css from './panel.module.css'
import { bool, count, str } from './guards.ts'
import type { MstarSelectionState } from './engine-status-client.ts'
import { FINDINGS_CAP, PLAN_CAP } from './plan-sort.ts'

/**
 * The picker seat: the selection the panel SHOWS, this session's own commit
 * state, and the commit seat itself. Handed down as one unit from the hook
 * result to the section that renders it.
 */
export interface MstarSelectionSeat {
  /**
   * This session's CURRENT selection: the host's live control-state `binding`
   * when the response carries one, else the last emission's own record.
   * `null` renders the unknown arm rather than throwing.
   */
  readonly selection: WorkflowSelectionView | null
  /** This session's picker state (control feedback, never a selection source). */
  readonly pick: MstarSelectionState
  /**
   * Commit a workflow pick for this session, or null when the panel cannot
   * (no client / no session / unknown cwd). Null renders an error selection
   * WITHOUT a picker: a row that cannot be committed must not look clickable.
   */
  readonly select: ((workflowId: string) => void) | null
}

export interface StateSectionProps extends MstarSelectionSeat {
  t: TranslateNS<'mstar-panel'>
  /** The projection of the same snapshot the pages render. */
  view: ZoneView
  snapshot: PanelSnapshot
}

/** No picker candidates — one shared reference (stable across renders). */
const NO_IDS: readonly string[] = []

/** Enforcement flag label: hard/soft (+ provenance source), unknown when missing. */
function enforcementLabel(t: TranslateNS<'mstar-panel'>, enforcement: PanelSnapshot['enforcement']): string {
  if (enforcement === null || enforcement === undefined || typeof enforcement !== 'object') {
    return t('panel.unknown')
  }
  const hard = bool((enforcement as { hard?: unknown }).hard)
  const source = str((enforcement as { source?: unknown }).source)
  const flag = hard === null ? t('panel.unknown') : hard ? t('state.enforcement.hard') : t('state.enforcement.soft')
  return source === null ? flag : `${flag} (${source})`
}

/**
 * Does the picker acknowledgement still stand in for the served selection?
 *
 * The acknowledgement is a BRIDGE for the window between committing a pick and
 * the refreshed host binding that reflects it, never a permanent override. It
 * therefore applies only while the served verdict still names the picked
 * lifecycle as an active candidate: an unbound `error` whose `activeWorkflowIds`
 * list it (the verdict from BEFORE the pick, or a host that has not caught up),
 * or no verdict at all (loading / unavailable — no evidence to contradict it).
 *
 * The moment the verdict proves the picked lifecycle is gone — an unbound
 * `error` that no longer lists it, a `terminal` history view, an `active`
 * selection that names a different lifecycle, a candidate-less error — the
 * acknowledgement is dropped so the resolver's own verdict renders.
 */
function ackStandsFor(selection: WorkflowSelectionView | null, workflowId: string): boolean {
  if (selection === null) return true
  if (selection.kind === 'active') return selection.workflowId === workflowId
  if (selection.kind === 'error') return selection.activeWorkflowIds?.includes(workflowId) ?? false
  return false
}

/** The plan rows of the projection, in kanban order (Done already plan-sorted). */
function planRows(view: ZoneView): { id: string; status: string }[] {
  return view.tasks.columns.flatMap((column) => column.plans)
}

export function StateSection({ t, view, snapshot, selection, pick, select }: StateSectionProps) {
  const rows = planRows(view)
  const visiblePlans = rows.slice(0, PLAN_CAP)
  const hiddenPlans = rows.length - visiblePlans.length
  const residuals = view.project.openResiduals.slice(0, FINDINGS_CAP)
  const hiddenResiduals = Math.max(0, view.project.openResiduals.length - FINDINGS_CAP)
  const knowledge = (snapshot.retained.knowledge ?? null) as { docCount?: unknown; categories?: unknown } | null
  // The served binding outranks the last emission's own record; an acknowledged
  // pick outranks a served binding that has not caught up yet — but ONLY while
  // that binding still names the picked lifecycle as an active candidate.
  const acked = pick.state === 'selected' && ackStandsFor(selection, pick.workflowId) ? pick.workflowId : null
  const activeId = selection?.kind === 'active' ? selection.workflowId : acked
  const activeWarning = selection?.kind === 'active' ? selection.warning : undefined
  const errorView = selection?.kind === 'error' ? selection : null
  const unbound = selection?.kind === 'error' && (selection.activeWorkflowIds?.length ?? 0) > 0 ? selection : null
  const candidates = unbound?.activeWorkflowIds ?? NO_IDS
  const commit = select
  return (
    <section className={css.section} data-mstar-section="state">
      <h2 className={css.sectionTitle}>{t('state.title')}</h2>

      <h3 className={css.subTitle}>{t('state.selection')}</h3>
      {activeId !== null ? (
        <p className={css.selection} data-selection-kind="active" data-selection-workflow={activeId}>
          <span className={css.selectionId}>{activeId}</span>
          {activeWarning !== undefined
            ? <span className={css.selectionWarning} data-selection-warning>{activeWarning.message}</span>
            : null}
        </p>
      ) : selection?.kind === 'terminal' ? (
        <p className={css.selection} data-selection-kind="terminal" data-selection-workflow={selection.workflowId}>
          <span className={css.selectionId}>{selection.workflowId}</span>
          <span className={css.selectionMeta} data-selection-history>{t('state.selection.history')}</span>
        </p>
      ) : (
        <p className={css.selection} data-selection-kind="error" data-selection-code={errorView?.code ?? t('panel.unknown')}>
          <span className={css.selectionCode}>{errorView?.code ?? t('panel.unknown')}</span>
          <span className={css.selectionMeta}>{errorView?.message ?? t('state.none')}</span>
        </p>
      )}
      {unbound !== null && commit !== null ? (
        <div className={css.picker} data-mstar-picker data-picker-code={unbound.code}>
          <p className={css.pickerCopy} data-picker-copy>{t('state.selection.unbound')}</p>
          <ul className={css.pickerList}>
            {candidates.map((id) => (
              <li key={id} className={css.pickerItem}>
                <button
                  type="button"
                  className={css.pickerButton}
                  data-picker-option={id}
                  // One submission per session: the client refuses a second, so
                  // the rows are disabled rather than silently ignored.
                  disabled={pick.state === 'pending'}
                  onClick={() => commit(id)}
                >
                  {t('state.selection.pick', { workflowId: id })}
                </button>
              </li>
            ))}
          </ul>
          {pick.state === 'pending'
            ? <p className={css.pickerStatus} data-picker-pending>{t('state.selection.pending')}</p>
            : null}
          {pick.state === 'failed'
            ? <p className={css.pickerStatus} data-picker-failed data-picker-reason={pick.reason}>{t('state.selection.failed', { reason: pick.reason })}</p>
            : null}
        </div>
      ) : null}

      <h3 className={css.subTitle}>{t('state.plans')}</h3>
      {visiblePlans.length === 0
        ? <p className={css.empty} data-mstar-empty="no-plans">{t('state.none')}</p>
        : (
          <ul className={css.planList}>
            {visiblePlans.map((plan, i) => (
              <li key={plan.id === '' ? `plan-${i}` : plan.id} data-plan-id={plan.id === '' ? 'unknown' : plan.id} data-plan-status={plan.status === '' ? 'unknown' : plan.status}>
                <span className={css.planStatus} data-status={plan.status === '' ? 'unknown' : plan.status}>
                  {plan.status === '' ? t('panel.unknown') : plan.status}
                </span>
                <span className={css.planId}>{plan.id === '' ? t('panel.unknown') : plan.id}</span>
              </li>
            ))}
          </ul>
        )}
      {hiddenPlans > 0
        ? <p className={css.truncated} data-plan-truncated>{t('state.plans.more', { count: String(hiddenPlans) })}</p>
        : null}

      <h3 className={css.subTitle}>{t('state.residuals')}</h3>
      {residuals.length === 0
        ? <p className={css.empty} data-mstar-empty="no-residuals">{t('state.none')}</p>
        : (
          <ul className={css.residualList}>
            {residuals.map((residual) => (
              <li
                key={residual.severity}
                data-residual-finding
                data-residual-finding-severity={residual.severity}
                data-residual-finding-count={residual.count}
              >
                <span className={css.findingSeverity} data-severity={residual.severity}>
                  {residual.severity === '' ? t('panel.unknown') : residual.severity}
                </span>
                <span className={css.findingTitle}>{residual.count}</span>
              </li>
            ))}
          </ul>
        )}
      {hiddenResiduals > 0
        ? <p className={css.truncated} data-residual-truncated>{t('state.residual.more', { count: String(hiddenResiduals) })}</p>
        : null}

      <h3 className={css.subTitle}>{t('state.policy')}</h3>
      <dl className={css.defList}>
        <dt className={css.defTerm}>{t('state.enforcement')}</dt>
        <dd className={css.defValue} data-field="enforcement">{enforcementLabel(t, snapshot.enforcement)}</dd>
      </dl>

      <h3 className={css.subTitle}>{t('state.knowledge')}</h3>
      {knowledge === null
        ? <p className={css.empty} data-mstar-empty="no-knowledge">{t('state.none')}</p>
        : (
          <p className={css.knowledge} data-knowledge-docs={count(knowledge.docCount) === null ? 'unknown' : String(knowledge.docCount)}>
            <span>{t('state.knowledge.docs', { count: count(knowledge.docCount) === null ? t('panel.unknown') : String(count(knowledge.docCount)) })}</span>
            {Array.isArray(knowledge.categories) && knowledge.categories.length > 0
              ? <span className={css.knowledgeCategories}>
                {knowledge.categories.filter((category): category is string => typeof category === 'string').join(' · ')}
              </span>
              : null}
          </p>
        )}

      <h3 className={css.subTitle}>{t('state.direction')}</h3>
      <p className={css.direction} data-direction>{view.roadmap.direction ?? t('state.none')}</p>
    </section>
  )
}
