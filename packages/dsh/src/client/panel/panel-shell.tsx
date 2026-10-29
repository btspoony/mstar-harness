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
  EmptyState,
  Notice,
  Focus,
  LocaleProvider,
  MS_CONTAINER_CLASS,
  MS_PANE_BODY_CLASS,
  ASSIGNABLE_ISSUE_LIMIT,
  MS_PANE_HEAD_CLASS,
  Nav,
  copyFor,
  focusModel,
  type Copy,
  type FocusCopy,
  type FocusOverviewInput,
  type Locale,
  type SessionBinding,
} from '@mstar-harness/ui'
import type { IterationGateStep, IterationListDTO, WorkflowDTO } from '@mstar-harness/engine'
import css from './panel.module.css'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import type { MilestoneWriteResult } from './panel-snapshot-client.ts'
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
import type { PanelKey } from './locale.ts'
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
    // The gate step names live in the iteration detail's block; the focus track prints the
    // same five words.
    gateStepLabels: copy.iterationDetail.gateStepLabels,
    // The two project panels reuse the Overview screen's strings: one fact, one copy.
    residualsHeading: copy.overview.residualsHeading,
    // The Focus-only scope labels live beside those strings; the adapter must carry
    // them or the typed copy contract is unsatisfied (a required mapping, not a
    // product decision).
    residualsScope: copy.overview.residualsScope,
    milestoneProjectUnattributed: copy.overview.milestoneProjectUnattributed,
    milestonesHeading: copy.overview.milestonesHeading,
    milestoneProgress: copy.overview.milestoneProgress,
    milestoneOpenCount: copy.overview.milestoneOpenCount,
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
 * Map one per-view read of `overview` onto the member Focus's three project
 * panels take (the dashboard alignment change, contract C3).
 */
export function overviewMemberOf(state: MstarDashboardViewState): {
  readonly member: FocusOverviewInput
  readonly phase: 'loading' | 'loaded'
} {
  switch (state.kind) {
    case 'ok':
      return { member: { state: 'read', data: state.envelope.data as never }, phase: 'loaded' }
    case 'unavailable':
      return { member: { state: 'unavailable', reason: state.reason }, phase: 'loaded' }
    case 'no-harness':
      return { member: { state: 'not-applicable', reason: 'no harness root resolves for this workspace' }, phase: 'loaded' }
    case 'waiting':
    case 'loading':
      return { member: { state: 'not-applicable', reason: 'no overview read yet' }, phase: 'loading' }
  }
}

/**
 * The project scope the Focus overview read must carry (Greptile 3): the engine's
 * `readOverview` answers `not-applicable` for milestones and latestIteration with
 * no `project` filter, so the panel resolves one from the catalog project list —
 * the same source the Projects destination renders. `_default` wins when it is
 * registered (it is the store's bucket for unattributed records), else the single
 * project, else the first row. `null` = no project to scope by, and the read stays
 * unscoped rather than inventing an id.
 */
export function focusOverviewProject(data: unknown): string | null {
  const items = (data as { items?: ReadonlyArray<{ project?: { id?: unknown } }> } | null | undefined)?.items
  if (!Array.isArray(items) || items.length === 0) return null
  const ids = items
    .map((item) => item?.project?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  if (ids.includes('_default')) return '_default'
  return ids[0] ?? null
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
  /** The shared `overview` read behind Focus's three project panels. */
  overview?: FocusOverviewInput
  /** A pending overview read: the project panels render no arm for an unread fact. */
  overviewPhase?: 'loading' | 'loaded'
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
  /** The milestone write channel, alive only while a project page is open. */
  writes?: MilestoneWriteChannel
  /** The project's open unassigned issues, as the assign picker's options. */
  assignableIssues?: ReadonlyArray<{ id: string; title: string; severity: string; revision: number }>
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
    ...(props.overview === undefined ? {} : { overview: props.overview }),
    ...(props.overviewPhase === undefined ? {} : { overviewPhase: props.overviewPhase }),
    ...(props.phase === undefined ? {} : { phase: props.phase }),
  })
  return (
    <LocaleProvider locale={props.locale}>
      <div className={css.shell} data-ms-shell="" data-ms-destination={props.destination} data-ms-theme={props.scheme ?? 'light'}>
        {/* The pane's head band: the prototype's surface + hairline, shared with
            the dashboard's window header (`base.css`, `.ms-pane-head`). */}
        <div className={`${css.nav} ${MS_PANE_HEAD_CLASS}`} data-ms-pane-head="">
          <Nav items={navItems(copy)} activeId={props.destination} onSelect={props.onSelect} label={props.navLabel} />
        </div>
        {/* The product surface, and the shared frame's anchor: the screens' gutter,
            max width and title scale are keyed on `.ms-container` in the shared
            base layer, which the dashboard supplies and this seat must too — the
            class goes on the PRODUCT scroller, not on the whole shell, so the host's
            own nav band keeps its chrome. */}
        <div className={`${css.scroll} ${MS_CONTAINER_CLASS} ${MS_PANE_BODY_CLASS}`} data-mstar-scroll data-ms-pane-body="">
          {props.detail === null || props.detail === undefined ? null : (
            <DetailBody
              view={props.detail.view}
              id={props.detail.id}
              state={props.detail.state}
              locale={props.locale}
              onBack={props.onBack ?? (() => {})}
              {...(props.projectIterations === undefined ? {} : { projectIterations: props.projectIterations })}
              {...(props.projectIssues === undefined ? {} : { projectIssues: props.projectIssues })}
              {...(props.writes === undefined ? {} : { writes: props.writes })}
              {...(props.assignableIssues === undefined ? {} : { assignableIssues: props.assignableIssues })}
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

/**
 * The "no harness" state: the shared ABSENT arm (an explanation, not an error),
 * with the host's own hint as its detail line.
 */
function NoHarness({ t, locale }: { t: TranslateNS<'mstar-panel'>; locale: Locale }): React.ReactElement {
  const copy = copyFor(locale)
  return (
    <div className={css.state}>
      <EmptyState
        arm="absent"
        labelWord={copy.state.absent.labelWord}
        heading={t('state.failure.heading')}
        body={t('empty.no-harness')}
      />
      <p className={css.hint}>{t('empty.no-harness-hint')}</p>
    </div>
  )
}

/**
 * The state frame. EVERY early arm of the seat renders inside it, carrying the
 * host's resolved scheme: the surfaces (`Notice` / `EmptyState`) paint `--ms-*`
 * tokens, and outside a `data-ms-theme` carrier they would paint the light set
 * under a dark host.
 */
function StateFrame(props: {
  scheme: ColorScheme
  panel: string
  reason?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      className={css.shell}
      data-ms-theme={props.scheme}
      data-mstar-panel={props.panel}
      {...(props.reason === undefined ? {} : { 'data-mstar-reason': props.reason })}
    >
      {props.children}
    </div>
  )
}

/**
 * The reader-facing sentence for one internal failure reason. The CODE is a
 * diagnostic token, never copy: every reason the endpoint can emit has a
 * human sentence, and a reason this build does not know answers the generic
 * sentence rather than printing the token.
 */
const FAILURE_KEYS: Record<string, PanelKey> = {
  'session-absent': 'state.failure.session-absent',
  'session-cwd-absent': 'state.failure.session-cwd-absent',
  'session-inspect-failed': 'state.failure.session-inspect-failed',
  'cwd-mismatch': 'state.failure.cwd-mismatch',
  'malformed-answer': 'state.failure.malformed-answer',
}

/** The dictionary key that explains one reason code (unknown → the generic one). */
export function failureKey(reason: string): PanelKey {
  return FAILURE_KEYS[reason] ?? 'state.failure.unknown'
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
 * The milestone write channel the seat hands the project page (plan Task 4).
 * The UI owns no optimistic state: a refused write only sets the refusal copy,
 * and BOTH arms re-issue the roadmap read (contract C2 — a success proves new
 * store state, a refusal may mean the observed revision moved).
 */
export type MilestoneWriteChannel = {
  readonly busy: boolean
  readonly refusal: string | null
  create(input: { name: string; target: string | null; ordinal: number }): void
  update(milestoneId: string, patch: { name?: string; target?: string | null; status?: string }): void
  assign(issueId: string, issueRevision: number, milestoneId: string | null): void
  remove(milestoneId: string): void
}

/**
 * The C1 retry policy. One id — and the WHOLE request it was minted for — per
 * LOGICAL write, retained until the store answers terminally: a success (the
 * receipt replays) or a non-transport refusal (the store judged the request, so a
 * retry is a new intent). A transport failure, the deadline abort above all, is
 * AMBIGUOUS: the engine may have committed after the client gave up.
 *
 * Retaining the request and not just the id is the load-bearing part: the engine
 * hashes `expectedStoreRevision` into the operation's request hash, so a retry
 * carrying a NEWLY observed revision answers `store.operation-conflict` instead of
 * replaying — a create would then be duplicated with a new id and ordinal. The
 * ambiguous write therefore keeps its original revision, and the caller does not
 * reload the read while the outcome is unknown.
 */
export function writeOperationIds<T>(
  makeId: () => string = () => crypto.randomUUID(),
): {
  /** The id + request this logical write must carry (kept across an ambiguous retry). */
  for(signature: string, request: T): { operationId: string; request: T }
  /** The store answered terminally: the next write of any kind starts a fresh intent. */
  settled(): void
} {
  let pending: { signature: string; operationId: string; request: T } | null = null
  return {
    for(signature, request) {
      if (pending !== null && pending.signature === signature) return { operationId: pending.operationId, request: pending.request }
      pending = { signature, operationId: makeId(), request }
      return { operationId: pending.operationId, request }
    },
    settled() {
      pending = null
    },
  }
}

/**
 * One write at a time, and the EXECUTED C1 id policy: every write names its
 * logical signature, {@link writeOperationIds} hands back the id for it, and the
 * id is settled only on a terminal answer — success, or a refusal the store
 * itself made. A transport-ambiguous deadline abort keeps the id, so the user's
 * retry replays the engine's recorded receipt instead of writing twice.
 */
export function createMilestoneWrites(seats: {
  client: MstarPanelSnapshotClient
  sessionId: string
  cwd: string
  projectId: string
  expectedStoreRevision: number
  reload: () => void
  /** The channel's busy/refusal mirror — React state in the seat, recorded in a spec. */
  onState: (state: { busy: boolean; refusal: string | null }) => void
  /** The id policy; the seat owns one instance for its lifetime. */
  ids: ReturnType<typeof writeOperationIds<{ expectedStoreRevision: number }>>
}): MilestoneWriteChannel {
  const { client, sessionId, cwd, projectId, expectedStoreRevision: revision, reload, onState, ids } = seats
  // The factory's own mirror of the busy/refusal state; the hook overrides both
  // members with its React state, but a direct caller (a spec) reads these.
  let busy = false
  let refusal: string | null = null
  const run = (
    signature: string,
    request: { expectedStoreRevision: number },
    call: (operationId: string, expectedStoreRevision: number) => Promise<MilestoneWriteResult>,
  ): void => {
    if (busy) return
    void (async () => {
      busy = true
      refusal = null
      onState({ busy: true, refusal: null })
      // The retained request wins: an ambiguous retry must hash the SAME revision
      // the engine may already have committed, or it answers store.operation-conflict.
      const retained = ids.for(signature, request)
      const result = await call(retained.operationId, retained.request.expectedStoreRevision)
      const ambiguous = !result.ok && result.code === 'transport-error'
      // A terminal answer ends the logical write; an ambiguous transport failure
      // keeps the id AND the request so the retry replays the engine's receipt.
      if (!ambiguous) ids.settled()
      busy = false
      refusal = result.ok ? null : result.message
      onState({ busy, refusal })
      // Reloading on an ambiguous answer would refresh the read's revision and turn
      // the retry into a DIFFERENT request — exactly the duplicate write C1 forbids.
      if (!ambiguous) reload()
    })()
  }
  return {
    get busy(): boolean {
      return busy
    },
    get refusal(): string | null {
      return refusal
    },
    create(input: { name: string; target: string | null; ordinal: number }): void {
      run(
        `add:${input.name}:${input.target ?? ''}:${input.ordinal}`,
        { expectedStoreRevision: revision },
        (operationId, expectedStoreRevision) =>
          client.milestoneAdd({
            sessionId,
            cwd,
            projectId,
            input: { name: input.name, target: input.target, ordinal: input.ordinal },
            mutation: { operationId, expectedStoreRevision },
          }),
      )
    },
    update(milestoneId: string, patch: { name?: string; target?: string | null; status?: string }): void {
      run(
        `update:${milestoneId}:${JSON.stringify(patch)}`,
        { expectedStoreRevision: revision },
        (operationId, expectedStoreRevision) =>
          client.milestoneUpdate({
            sessionId,
            cwd,
            projectId,
            milestoneId,
            patch,
            mutation: { operationId, expectedStoreRevision },
          }),
      )
    },
    remove(milestoneId: string): void {
      run(
        `remove:${milestoneId}`,
        { expectedStoreRevision: revision },
        (operationId, expectedStoreRevision) =>
          client.milestoneRemove({
            sessionId,
            cwd,
            projectId,
            milestoneId,
            mutation: { operationId, expectedStoreRevision },
          }),
      )
    },
    assign(issueId: string, issueRevision: number, milestoneId: string | null): void {
      run(
        `assign:${issueId}:${milestoneId ?? ''}:${issueRevision}`,
        { expectedStoreRevision: revision },
        (operationId, expectedStoreRevision) =>
          client.milestoneAssign({
            sessionId,
            cwd,
            issueId,
            input: { projectId, milestoneId, reason: 'assigned from the project page' },
            mutation: { operationId, actor: 'project-manager', expectedRevision: issueRevision, expectedStoreRevision },
          }),
      )
    },
  }
}

/**
 * The React seam around the channel factory: one id-policy instance per seat,
 * the busy/refusal mirror as state. All behaviour lives in
 * {@link createMilestoneWrites}, which a spec drives without a renderer.
 */
function useMilestoneWrites(seats: {
  client: MstarPanelSnapshotClient | undefined
  sessionId: string | null
  cwd: string | null
  projectId: string | null
  expectedStoreRevision: number | null
  reload: () => void
}): MilestoneWriteChannel | undefined {
  const { client, sessionId, cwd, projectId, expectedStoreRevision, reload } = seats
  const [state, setState] = React.useState<{ busy: boolean; refusal: string | null }>({ busy: false, refusal: null })
  const ids = React.useRef(writeOperationIds<{ expectedStoreRevision: number }>())
  // Number.isInteger, not a null test: a schema-drifted envelope makes the member
  // `undefined`, and a channel armed with no revision would guarantee refusals.
  if (
    client === undefined ||
    sessionId === null ||
    cwd === null ||
    projectId === null ||
    !Number.isInteger(expectedStoreRevision)
  ) {
    return undefined
  }
  const channel = createMilestoneWrites({
    client,
    sessionId,
    cwd,
    projectId,
    expectedStoreRevision: expectedStoreRevision as number,
    reload,
    onState: setState,
    ids: ids.current,
  })
  // The factory's own busy flag is per-call-site state; the mirror the screen
  // reads is this component's state, so return the channel with the live mirror.
  return { ...channel, busy: state.busy, refusal: state.refusal }
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
  // Focus reads the shared `overview` view once: its three project panels are
  // members of that one read, never three calls (contract C3).
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
  // Focus's three project panels are members of ONE `overview` read, and that
  // read answers `not-applicable` for milestones/iteration with no `project`
  // filter — so the seat resolves the scope from the catalog project list first.
  const focusProjectsView = useMstarDashboardView({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    view: snapshot !== null && destination === 'focus' ? 'projects' : null,
  })
  const focusProject =
    focusProjectsView.state.kind === 'ok' ? focusOverviewProject(focusProjectsView.state.envelope.data) : null
  const focusOverviewView = useMstarDashboardView({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    view: snapshot !== null && destination === 'focus' ? 'overview' : null,
    ...(focusProject === null ? {} : { params: { project: focusProject } }),
  })
  const focusOverview = overviewMemberOf(focusOverviewView.state)
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

  // The milestone write channel (plan Task 4): one write at a time, driven by
  // the roadmap read's own store revision (contract C2). Only alive while a
  // project page is open.
  const expectedStoreRevision =
    detailView.state.kind === 'ok' && Number.isInteger(detailView.state.envelope.storeRevision)
      ? (detailView.state.envelope.storeRevision as number)
      : null
  const milestoneWrites = useMilestoneWrites({
    client: panelSnapshot,
    sessionId: wireSession,
    cwd,
    projectId: detail !== null && detail.view === 'project-detail' ? detail.id : null,
    expectedStoreRevision,
    reload: () => {
      detailView.reload()
      projectIssuesView.reload()
    },
  })
  // The assign picker's options: the project's OPEN, UNASSIGNED issues as the
  // scoped Issues read answers them (id, title, severity, revision for the CAS).
  const assignableIssues =
    projectIssuesView.state.kind === 'ok' && projectIssuesView.state.envelope.data !== null
      ? (
          projectIssuesView.state.envelope.data as {
            items: Array<{ id: string; title: string; severity: string; disposition: string; milestoneId: string | null; revision: number }>
          }
        ).items
          .filter((issue) => issue.disposition === 'open' && issue.milestoneId === null)
          .slice(0, ASSIGNABLE_ISSUE_LIMIT)
          .map((issue) => ({ id: issue.id, title: issue.title, severity: issue.severity, revision: issue.revision }))
      : undefined

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
    focusProjectsView.reload()
    focusOverviewView.reload()
    // A new commit is a new key; the first mount is not a commit.
  }, [pickReloadKey])

  // Every hook runs before the early returns (hooks rule).
  if (!visible) return null
  if (digest.kind === 'waiting') {
    return (
      <StateFrame scheme={scheme} panel="waiting">
        <div className={css.state}>
          <p data-mstar-empty="waiting">{t('empty.waiting')}</p>
        </div>
      </StateFrame>
    )
  }
  if (digest.kind === 'no-harness') {
    return (
      <StateFrame scheme={scheme} panel="no-harness" reason="no-harness">
        <NoHarness t={t} locale={locale} />
      </StateFrame>
    )
  }
  if (digest.kind === 'unavailable') {
    return (
      <StateFrame scheme={scheme} panel="unavailable" reason={digest.reason}>
        <div className={css.state}>
          <Notice reason={t(failureKey(digest.reason))} lead={t('state.failure.heading')} tone="warning" />
        </div>
      </StateFrame>
    )
  }
  if (snapshot === null) {
    return (
      <StateFrame scheme={scheme} panel="loading">
        <div className={css.state}>
          <p data-mstar-empty="loading">{t('empty.loading')}</p>
        </div>
      </StateFrame>
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
      overview={focusOverview.member}
      {...(focusOverview.phase === 'loading' ? { overviewPhase: focusOverview.phase } : {})}
      reads={{ [destination]: destinationRead }}
      issueQuery={issueQueryState}
      onIssueQueryChange={setIssueQueryState}
      detail={detail === null ? null : { ...detail, state: detailView.state }}
      onOpen={(view, id) => setDetail({ view, id })}
      onBack={() => setDetail(null)}
      projectIterations={projectIterationsView.state}
      projectIssues={projectIssuesView.state}
      {...(milestoneWrites === undefined ? {} : { writes: milestoneWrites })}
      {...(assignableIssues === undefined ? {} : { assignableIssues })}
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
