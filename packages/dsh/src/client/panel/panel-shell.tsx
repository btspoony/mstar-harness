/**
 * The unified product's shell for this host: the ONE implementation both seats
 * mount (plan dsh-panel-unification Tasks 3–4).
 *
 * The right-Sidebar tab and the keyed `main` panel are the same product at two
 * sizes — same nav, same destination ids, same screens, same copy, same absence
 * decisions. Everything they share lives here, so a prop only one seat can
 * supply becomes a prop of this module instead of a second call site:
 *
 * - `PANEL_DESTINATIONS` is the destination set, in IA §8.2 order.
 * - `PanelSeat` owns the transport states and the adapter work. Its data is the
 *   SESSION DIGEST (enforcement / knowledge / selection, plus the delivery
 *   fallback) read once, plus two per-view reads (`workflow-detail`, `iterations`)
 *   issued by the screen that needs them. Nothing polls.
 * - `PanelShell` is the pure composition (provider + nav + destination body), so
 *   a test can render any destination without a transport.
 *
 * No product markup, styling or copy is declared here: they come from
 * `@mstar-harness/ui`. This module is the adapter, and nothing else.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  Focus,
  LocaleProvider,
  Nav,
  copyFor,
  focusModel,
  type Copy,
  type FocusCopy,
  type Locale,
  type SessionBinding,
} from '@mstar-harness/ui'
import type { IterationGateStep, IterationListDTO, WorkflowDTO } from '@mstar-harness/engine'
import css from './panel.module.css'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import type { MstarWorkflowPickerClient } from './workflow-picker-client.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'
import { useMstarSessionDigest } from './use-mstar-session-digest.ts'
import { useMstarDashboardView, type MstarDashboardViewState } from './use-mstar-dashboard-view.ts'
import { useMstarWorkflowPicker, type UseSessions } from './use-mstar-workflow-picker.ts'
import type { PanelDestination } from './panel-store.ts'

/**
 * The host locale face the product needs, declared structurally (the
 * `LocaleFace` getSnapshot/subscribe pair) so this module never value-imports a
 * host package.
 */
export type HostLocaleFace = {
  getSnapshot(): { readonly active: string }
  subscribe(listener: () => void): () => void
}

/** The five product destinations, in IA §8.2 order; `focus` is this host's landing. */
export const PANEL_DESTINATIONS = ['overview', 'issues', 'workflows', 'iterations', 'projects'] as const

/** The full nav: the session landing, then the five destinations. */
export const SHELL_DESTINATIONS: readonly PanelDestination[] = ['focus', ...PANEL_DESTINATIONS]

/** The host's locale id → the product's two locales. */
export function productLocale(active: string): Locale {
  return /^zh/i.test(active) ? 'zh' : 'en'
}

/** The shared nav's items: the session landing first, then the five destinations. */
export function navItems(copy: Copy): Array<{ id: string; label: string }> {
  return SHELL_DESTINATIONS.map((id) => ({ id, label: copy[id].pageTitle }))
}

/** The shared `Focus` screen's copy object: its section plus the four absence arms. */
function focusCopy(copy: Copy): FocusCopy {
  return {
    ...copy.focus,
    absence: {
      'not-applicable': copy.state['not-applicable'],
      absent: copy.state.absent,
      empty: copy.state.empty,
      unavailable: copy.state.unavailable,
    },
  }
}

/**
 * The session's delivery line from the ENVELOPE's iteration member — the
 * fallback used while the per-view `iterations` read has no answer.
 */
function deliveryOf(
  snapshot: PanelSnapshot,
  workflow: WorkflowMember,
): { iterationId: string; gateStep: IterationGateStep | null } | null | undefined {
  const read = snapshot.iteration
  if (read.state !== 'ok') return undefined
  if (read.data === null) return null
  // Membership, not proximity: an iteration that holds none of the bound
  // workflow's plans is not this session's delivery (IA §3.2 item 4).
  const bound = new Set(workflow.state === 'read' && workflow.data !== null ? workflow.data.plans.map((plan) => plan.planId) : [])
  if (!read.data.plans.some((plan) => bound.has(plan.planId))) return null
  return { iterationId: read.data.iterationId, gateStep: read.data.gateStep }
}

/** The bound workflow as the shared model wants it: a three-state member. */
export type WorkflowMember =
  | { readonly state: 'read'; readonly data: WorkflowDTO | null }
  | { readonly state: 'not-applicable'; readonly reason: string }
  | { readonly state: 'unavailable'; readonly reason: string }

/** Map one per-view read of `workflow-detail` onto the member the model takes. */
export function workflowMemberOf(state: MstarDashboardViewState): {
  readonly member: WorkflowMember
  readonly phase: 'loading' | 'loaded'
} {
  switch (state.kind) {
    case 'ok':
      return { member: { state: 'read', data: state.envelope.data as WorkflowDTO | null }, phase: 'loaded' }
    case 'unavailable':
      return { member: { state: 'unavailable', reason: state.reason }, phase: 'loaded' }
    case 'no-harness':
      return { member: { state: 'not-applicable', reason: 'no harness root resolves for this workspace' }, phase: 'loaded' }
    case 'waiting':
    case 'loading':
      // A pending read has no subject state: the model's `phase` says so, and the
      // screen renders nothing rather than an arm the transport has not reached.
      return { member: { state: 'not-applicable', reason: 'no workflow read yet' }, phase: 'loading' }
  }
}

/**
 * The delivery line as the per-view `iterations` read proves it.
 *
 * `undefined` = no answer (the digest's iteration member is the only evidence);
 * `null` = the read answered and none of the bound workflow's plans is
 * attributed to an iteration, so the plans are delivered standalone.
 */
export function deliveryFromView(
  state: MstarDashboardViewState,
  planIds: readonly string[],
): { iterationId: string; gateStep: IterationGateStep | null } | null | undefined {
  if (state.kind !== 'ok') return undefined
  const list = state.envelope.data as IterationListDTO | null
  if (list === null) return undefined
  const bound = new Set(planIds)
  for (const item of list.items) {
    if (item.plans.some((plan) => bound.has(plan.planId))) {
      return { iterationId: item.iterationId, gateStep: item.gateStep }
    }
  }
  return null
}

/** The pure shell: provider, nav, and the active destination's body. */
export function PanelShell(props: {
  snapshot: PanelSnapshot
  /** The bound workflow as the per-view `workflow-detail` read answered it. */
  workflow: WorkflowMember
  /** A pending workflow read: the board renders no arm for a fact not yet known. */
  phase?: 'loading' | 'loaded'
  /**
   * The session's delivery as the per-view `iterations` read proves it: a value
   * wins, `null` means "the bound plans are delivered standalone", and
   * `undefined` means the envelope's own member is the only evidence.
   */
  delivery?: { iterationId: string; gateStep: IterationGateStep | null } | null
  destination: PanelDestination
  locale: Locale
  /** Accessible name for the nav landmark (the panel's own name). */
  navLabel: string
  onSelect: (destination: string) => void
  select: ((workflowId: string) => void) | null
}): React.ReactElement {
  const copy = copyFor(props.locale)
  const selection: SessionBinding | null = props.snapshot.selection
  const model = focusModel({
    enforcement: props.snapshot.enforcement.hard ? 'hard' : 'soft',
    selection,
    workflow: props.workflow,
    iteration: props.delivery === undefined ? deliveryOf(props.snapshot, props.workflow) ?? null : props.delivery,
    ...(props.phase === undefined ? {} : { phase: props.phase }),
  })
  return (
    <LocaleProvider locale={props.locale}>
      <div className={css.shell} data-ms-shell="" data-ms-destination={props.destination}>
        <div className={css.nav}>
          <Nav items={navItems(copy)} activeId={props.destination} onSelect={props.onSelect} label={props.navLabel} />
        </div>
        <div className={css.scroll} data-mstar-scroll>
          {props.destination === 'focus'
            ? (
              <Focus
                model={model}
                copy={focusCopy(copy)}
                {...(props.select === null ? {} : { onPick: props.select })}
              />
            )
            : null}
        </div>
      </div>
    </LocaleProvider>
  )
}

/** The "no harness" state: one line, no card, no chrome. */
function NoHarness({ t }: { t: TranslateNS<'mstar-panel'> }): React.ReactElement {
  return (
    <div className={css.state} data-mstar-panel="no-harness">
      <p data-mstar-empty="no-harness">{t('empty.no-harness')}</p>
      <p className={css.hint}>{t('empty.no-harness-hint')}</p>
    </div>
  )
}

/** Stable no-op subscribe (a seat composed without a locale face). */
const NO_SUBSCRIBE = (): (() => void) => () => {}

/** The product locale, read from the host's own locale face (uSES-safe). */
function useProductLocale(face: HostLocaleFace | undefined): Locale {
  const read = (): string => (face === undefined ? 'en' : face.getSnapshot().active)
  const active = React.useSyncExternalStore(
    face === undefined ? NO_SUBSCRIBE : (listener) => face.subscribe(listener),
    read,
    // The server render path must answer the SAME value as the client read.
    read,
  )
  return productLocale(active)
}

/** The session's workspace directory (the host cross-checks it against the session). */
function sessionCwd(useSessions: UseSessions | undefined, sessionId: SessionId | undefined): string | null {
  if (useSessions === undefined || sessionId === undefined) return null
  const cwd = useSessions((s) => s.byId[sessionId]?.cwd ?? null)
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * One seat's body: the digest read, the two per-view reads, the adapter and the
 * shell. `visible` is the seat's own gate (a collapsed sidebar column renders
 * nothing; the main panel is always visible).
 */
export type PanelSeatProps = {
  /** The seat's visibility gate (`useTabInfo().tab.visible` for the sidebar; always true for the main panel). */
  visible: boolean
  /** The active destination, owned by the seat (entry store or component state). */
  destination: PanelDestination
  /** Destination selection, owned by the seat's own state. */
  onSelect: (destination: string) => void
  /** The seat's typed translate face. */
  t: TranslateNS<'mstar-panel'>
  sessionId?: SessionId
  useSessions?: UseSessions
  picker?: MstarWorkflowPickerClient
  panelSnapshot?: MstarPanelSnapshotClient
  localeFace?: HostLocaleFace
}

export function PanelSeat(props: PanelSeatProps): React.ReactElement | null {
  const { t, visible, destination, onSelect, useSessions, sessionId, picker, panelSnapshot, localeFace } = props
  const cwd = sessionCwd(useSessions, sessionId)
  const wireSession = sessionId === undefined ? null : String(sessionId)
  const locale = useProductLocale(localeFace)
  // The picker's WRITE half only: the selection it shows rides the digest.
  const { select } = useMstarWorkflowPicker({ useSessions, sessionId, picker })

  const digest = useMstarSessionDigest({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
  }).state
  const snapshot = digest.kind === 'ok' ? digest.snapshot : null
  const selection = snapshot?.selection ?? null
  const boundWorkflowId =
    selection !== null && (selection.kind === 'active' || selection.kind === 'terminal') ? selection.workflowId : null

  // The per-view reads: one each, issued only once their subject exists.
  const workflowView = useMstarDashboardView({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    view: snapshot !== null && boundWorkflowId !== null ? 'workflow-detail' : null,
    ...(boundWorkflowId === null ? {} : { id: boundWorkflowId }),
  })
  const { member: workflow, phase } = workflowMemberOf(workflowView.state)
  const planIds = workflow.state === 'read' && workflow.data !== null ? workflow.data.plans.map((plan) => plan.planId) : []
  const iterationsView = useMstarDashboardView({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    view: snapshot !== null && workflow.state === 'read' && workflow.data !== null ? 'iterations' : null,
    params: { limit: '200' },
  })

  // Every hook runs before the early returns (hooks rule).
  if (!visible) return null
  if (digest.kind === 'waiting') {
    return (
      <div className={css.state} data-mstar-panel="waiting">
        <p data-mstar-empty="waiting">{t('empty.waiting')}</p>
      </div>
    )
  }
  if (digest.kind === 'no-harness') return <NoHarness t={t} />
  if (digest.kind === 'unavailable') {
    return (
      <div className={css.state} data-mstar-panel="unavailable">
        <p data-mstar-empty="unavailable" data-mstar-unavailable-reason={digest.reason}>
          {t('empty.unavailable', { reason: digest.reason })}
        </p>
      </div>
    )
  }
  if (snapshot === null) {
    return (
      <div className={css.state} data-mstar-panel="loading">
        <p data-mstar-empty="loading">{t('empty.loading')}</p>
      </div>
    )
  }

  return (
    <PanelShell
      snapshot={snapshot}
      workflow={workflow}
      {...(phase === 'loading' ? { phase } : {})}
      delivery={deliveryFromView(iterationsView.state, planIds)}
      destination={destination}
      locale={locale}
      navLabel={t('view.mstar-workflow')}
      onSelect={onSelect}
      select={select}
    />
  )
}
