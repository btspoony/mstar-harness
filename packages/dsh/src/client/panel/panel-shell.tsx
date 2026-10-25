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
import { issueQuery as serializeIssueQuery, parseIssueQuery, type IssueQuery } from '@mstar-harness/ui'
import { useMstarSessionDigest } from './use-mstar-session-digest.ts'
import {
  DetailBody,
  type DetailView,
  IssuesDestination,
  IterationsDestination,
  OverviewDestination,
  ProjectsDestination,
  WorkflowsDestination,
} from './destinations.tsx'
import { useMstarDashboardView, type MstarDashboardViewState } from './use-mstar-dashboard-view.ts'
import { useMstarWorkflowPicker, type UseSessions } from './use-mstar-workflow-picker.ts'
import type { PanelDestination } from './panel-store.ts'
import type { ColorScheme, HostThemeFace } from './theme.ts'

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
  /** The host's resolved colour scheme (only the scheme is inherited). */
  scheme?: ColorScheme
  /** Accessible name for the nav landmark (the panel's own name). */
  navLabel: string
  onSelect: (destination: string) => void
  select: ((workflowId: string) => void) | null
  /** The ACTIVE destination's per-view read (one request, issued by the seat). */
  reads?: Partial<Record<PanelDestination, MstarDashboardViewState>>
  /** Issues owns the only interactive seat a destination has (its filter query). */
  issueQuery?: IssueQuery
  onIssueQueryChange?: (query: IssueQuery) => void
  /** The open detail route, or null for the destination's list. */
  detail?: { view: DetailView; id: string; state: MstarDashboardViewState } | null
  onBack?: () => void
  /** Open one record from its destination's list (the shell owns the open record). */
  onOpen?: (view: DetailView, id: string) => void
  /** A project detail's scoped Iterations read. */
  projectIterations?: MstarDashboardViewState
  /** A project detail's scoped Issues read. */
  projectIssues?: MstarDashboardViewState
}): React.ReactElement {
  const copy = copyFor(props.locale)
  const selection: SessionBinding | null = props.snapshot.selection
  // The flag is a literal enum; an unreadable member says so rather than
  // guessing `soft` (the host's own line renders the arm's detail).
  // A failed enforcement read is NOT a soft flag: it says `unavailable`, so the
  // shared screen's own line cannot be mistaken for a genuine `soft`.
  const flag = typeof props.snapshot.enforcement?.hard === 'boolean'
    ? (props.snapshot.enforcement.hard ? 'hard' : 'soft')
    : 'unavailable'
  const model = focusModel({
    enforcement: flag,
    selection,
    workflow: props.workflow,
    iteration: props.delivery === undefined ? deliveryOf(props.snapshot, props.workflow) ?? null : props.delivery,
    ...(props.phase === undefined ? {} : { phase: props.phase }),
  })
  return (
    <LocaleProvider locale={props.locale}>
      <div className={css.shell} data-ms-shell="" data-ms-destination={props.destination} data-ms-theme={props.scheme ?? 'light'}>
        <div className={css.nav}>
          <Nav items={navItems(copy)} activeId={props.destination} onSelect={props.onSelect} label={props.navLabel} />
        </div>
        <div className={css.scroll} data-mstar-scroll>
          {props.detail === null || props.detail === undefined ? null : (
            <DetailBody
              view={props.detail.view}
              id={props.detail.id}
              state={props.detail.state}
              locale={props.locale}
              onBack={props.onBack ?? (() => {})}
              {...(props.projectIterations === undefined ? {} : { projectIterations: props.projectIterations })}
              {...(props.projectIssues === undefined ? {} : { projectIssues: props.projectIssues })}
              {...(props.onOpen === undefined ? {} : { onOpenWorkflow: (id: string) => props.onOpen?.('workflow-detail', id) })}
            />
          )}
          {props.detail !== null && props.detail !== undefined ? null : props.destination === 'focus' ? (
            <Focus
              model={model}
              copy={focusCopy(copy)}
              {...(props.select === null ? {} : { onPick: props.select })}
            />
          ) : (
            <DestinationBody
              destination={props.destination}
              state={props.reads?.[props.destination] ?? { kind: 'waiting' }}
              locale={props.locale}
              issueQuery={props.issueQuery}
              onIssueQueryChange={props.onIssueQueryChange}
              onOpen={props.onOpen}
            />
          )}
        </div>
      </div>
    </LocaleProvider>
  )
}

/** One destination's body: its shared screen, or its own read state. */
function DestinationBody(props: {
  destination: Exclude<PanelDestination, 'focus'>
  state: MstarDashboardViewState
  locale: Locale
  issueQuery?: IssueQuery
  onIssueQueryChange?: (query: IssueQuery) => void
  /** The open detail route, or null for the destination's list. */
  detail?: { view: DetailView; id: string; state: MstarDashboardViewState } | null
  onBack?: () => void
  /** Open one record from its destination's list (the shell owns the open record). */
  onOpen?: (view: DetailView, id: string) => void
  /** A project detail's scoped Iterations read. */
  projectIterations?: MstarDashboardViewState
  /** A project detail's scoped Issues read. */
  projectIssues?: MstarDashboardViewState
}): React.ReactElement {
  const shared = { state: props.state, locale: props.locale }
  const open = props.onOpen
  switch (props.destination) {
    case 'overview':
      return <OverviewDestination {...shared} />
    case 'issues':
      return (
        <IssuesDestination
          {...shared}
          {...(props.issueQuery === undefined ? {} : { query: props.issueQuery })}
          {...(props.onIssueQueryChange === undefined ? {} : { onQueryChange: props.onIssueQueryChange })}
          {...(open === undefined ? {} : { onOpen: (id: string) => open('issue-detail', id) })}
        />
      )
    case 'workflows':
      return <WorkflowsDestination {...shared} {...(open === undefined ? {} : { onOpen: (id: string) => open('workflow-detail', id) })} />
    case 'iterations':
      return <IterationsDestination {...shared} {...(open === undefined ? {} : { onOpen: (id: string) => open('iteration-detail', id) })} />
    case 'projects':
      return <ProjectsDestination {...shared} {...(open === undefined ? {} : { onOpen: (id: string) => open('project-detail', id) })} />
  }
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

/**
 * The read target for an open detail. The engine has NO `project-detail` view:
 * a project's page is composed from the views that exist, so the project open
 * reads its `roadmap` scoped to the project. Every other detail is its own view.
 */
export function detailReadTarget(
  view: DetailView,
  id: string,
): { view: string; params?: Record<string, string>; id?: string } {
  return view === 'project-detail' ? { view: 'roadmap', params: { project: id } } : { view, id }
}

/**
 * The view a destination reads. `iterations` reads its own list — the delivery
 * read is gated on a bound workflow, and a destination must answer for an
 * unbound (or fresh) session too.
 */
export function destinationReadView(destination: PanelDestination): string | null {
  return destination === 'focus' ? null : destination
}

/**
 * The parameters a destination's read carries. Always EXPLICIT: the engine's
 * default page is 50 rows, and a destination with no pager would silently drop
 * everything past that. `iterations` asks for the documented ceiling (200) and
 * the adapter discloses any truncation from the DTO's own `total`.
 */
export function destinationReadParams(destination: PanelDestination): Record<string, string> {
  return destination === 'iterations' ? { limit: '200' } : {}
}

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

/** Stable no-op theme subscription (a seat composed without the theme face). */
const NO_THEME_SUBSCRIBE = (): (() => void) => () => {}

/**
 * The product's colour scheme, read from the host's theme face (uSES-safe), so a
 * host theme switch re-renders the wrapper and the shared `[data-ms-theme]`
 * token block flips with it.
 */
function useProductScheme(face: HostThemeFace | undefined): ColorScheme {
  const read = (): ColorScheme => (face === undefined ? 'light' : face.getSnapshot())
  return React.useSyncExternalStore(
    face === undefined ? NO_THEME_SUBSCRIBE : (listener) => face.subscribe(listener),
    read,
    read,
  )
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
  themeFace?: HostThemeFace
  /**
   * The seat is the main-area panel: the host gives a non-`conversation` key no
   * session, so an absent session is a FACT to state, not a read still pending.
   */
  sessionFreeMainPanel?: boolean
}

export function PanelSeat(props: PanelSeatProps): React.ReactElement | null {
  const { t, visible, destination, onSelect, useSessions, sessionId, picker, panelSnapshot, localeFace, themeFace } = props
  const cwd = sessionCwd(useSessions, sessionId)
  const wireSession = sessionId === undefined ? null : String(sessionId)
  const locale = useProductLocale(localeFace)
  const scheme = useProductScheme(themeFace)
  // The picker's WRITE half only: the selection it shows rides the digest.
  const { pick, select } = useMstarWorkflowPicker({ useSessions, sessionId, picker })

  const digestReader = useMstarSessionDigest({ client: panelSnapshot, sessionId: wireSession, cwd })
  const digest = digestReader.state
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
  // The ACTIVE destination's own view: one read, only while it is shown. The
  // Iterations destination reuses the delivery read above — one request, not two.
  const [issueQueryState, setIssueQueryState] = React.useState<IssueQuery>(() => parseIssueQuery(''))
  // The screen's query IS the read's filter set: the shared serializer produces
  // the `/api`-style parameters the engine view layer validates.
  const issueParams = React.useMemo(
    () => Object.fromEntries(new URLSearchParams(serializeIssueQuery(issueQueryState)).entries()),
    [issueQueryState],
  )
  const destinationView = useMstarDashboardView({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    // `iterations` reads its OWN list: the delivery read is gated on a bound
    // workflow (it needs one), so reusing it left the destination waiting forever
    // for an unbound or fresh session.
    view: snapshot === null ? null : destinationReadView(destination),
    ...(destination === 'issues'
      ? { params: issueParams }
      : destination === 'iterations' ? { params: destinationReadParams(destination) } : {}),
  })
  const destinationRead = destinationView.state
  // The open record (list → detail), and its own read.
  const [detail, setDetail] = React.useState<{ view: DetailView; id: string } | null>(null)
  React.useEffect(() => { setDetail(null) }, [destination])
  // The engine has no `project-detail` view: a project's page is composed from
  // the views that exist — its `roadmap` (project-scoped), plus the scoped
  // `issues` / `iterations` reads below.
  const detailView = useMstarDashboardView({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    view: detail === null ? null : detailReadTarget(detail.view, detail.id).view,
    ...(detail === null ? {} : (() => {
      const target = detailReadTarget(detail.view, detail.id)
      return { ...(target.params === undefined ? {} : { params: target.params }), ...(target.id === undefined ? {} : { id: target.id }) }
    })()),
  })
  const projectIssuesView = useMstarDashboardView({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    view: detail !== null && detail.view === 'project-detail' ? 'issues' : null,
    ...(detail !== null && detail.view === 'project-detail' ? { params: { project: detail.id, limit: '200' } } : {}),
  })
  const projectIterationsView = useMstarDashboardView({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    view: detail !== null && detail.view === 'project-detail' ? 'iterations' : null,
    ...(detail !== null && detail.view === 'project-detail' ? { params: { project: detail.id, limit: '200' } } : {}),
  })

  // (b) The workflow pick is the product's only write: once the commit lands,
  // every read that DEPENDS on the binding re-reads — the digest (selection),
  // the bound workflow, the delivery iteration and the active destination.
  const pickReloadKey = pick.state === 'selected' ? pick.workflowId : null
  React.useEffect(() => {
    if (pickReloadKey === null) return
    digestReader.reload()
    workflowView.reload()
    iterationsView.reload()
    destinationView.reload()
    // A new commit is a new key; the first mount is not a commit.
  }, [pickReloadKey])

  // Every hook runs before the early returns (hooks rule).
  if (!visible) return null
  if (props.sessionFreeMainPanel === true && sessionId === undefined) {
    return (
      <div className={css.state} data-mstar-panel="no-session">
        <p data-mstar-empty="no-session">{t('empty.no-session')}</p>
      </div>
    )
  }
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

  const pickLine = pick.state === 'idle'
    ? null
    : (
      <p className={css.pickState} data-mstar-pick={pick.state}>
        {pick.state === 'pending'
          ? t('state.pick.pending')
          : pick.state === 'selected' ? t('state.pick.selected', { workflowId: pick.workflowId }) : t('state.pick.failed', { reason: pick.reason ?? '' })}
      </p>
    )
  return (
    <>
    {pickLine}
    <PanelShell
      snapshot={snapshot}
      workflow={workflow}
      {...(phase === 'loading' ? { phase } : {})}
      delivery={deliveryFromView(iterationsView.state, planIds)}
      reads={{ [destination]: destinationRead }}
      issueQuery={issueQueryState}
      onIssueQueryChange={setIssueQueryState}
      detail={detail === null ? null : { ...detail, state: detailView.state }}
      onOpen={(view, id) => setDetail({ view, id })}
      onBack={() => setDetail(null)}
      projectIterations={projectIterationsView.state}
      projectIssues={projectIssuesView.state}
      destination={destination}
      locale={locale}
      scheme={scheme}
      navLabel={t('view.mstar-workflow')}
      onSelect={onSelect}
      select={select}
    />
    </>
  )
}
