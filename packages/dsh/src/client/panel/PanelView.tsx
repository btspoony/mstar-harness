/**
 * The workflow panel's right-Sidebar body — the host SEAT wrapper (plan
 * dsh-panel-unification Task 2), and nothing else.
 *
 * What stays here is what only this host can know:
 *
 * - the seat's transport states (`waiting` / `loading` / `no-harness` /
 *   `unavailable`), each with its own anchor, so a degraded read is never
 *   mistakable for an empty workspace;
 * - the container the product renders into: the shared nav at the top and ONE
 *   scroll area below it. The pane body's height is the host's, so nothing here
 *   reads the viewport, and the tab strip above this body is the panel's whole
 *   top edge — a titlebar here would be a second one;
 * - the adapter work: narrow the host snapshot into the shared view model, pick
 *   the product locale from the host's, and hand the picker's commit seat down.
 *
 * What must NOT come back: product markup, card framing, headers, per-screen
 * styling. Screens, copy, absence decisions and styles are `@mstar-harness/ui`,
 * the same implementation the dashboard mounts.
 *
 * Destinations: the product's five (`overview`, `issues`, `workflows`,
 * `iterations`, `projects`) plus this host's session landing (`focus`), which
 * is the default. Each destination mounts its shared screen in its own round; a
 * destination without one renders NO body rather than a fabricated empty state
 * — an absence arm would claim a read that never happened.
 */

import * as React from 'react'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
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
import css from './panel.module.css'
import type { IterationGateStep } from '@mstar-harness/engine'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import type { MstarWorkflowPickerClient } from './workflow-picker-client.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'
import { useMstarPanelSnapshot } from './use-mstar-panel-snapshot.ts'
import { useMstarWorkflowPicker, type UseSessions } from './use-mstar-workflow-picker.ts'
import { createPanelStore, type PanelDestination } from './panel-store.ts'

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

/** The sidebar body seat's props: runtime share, entry store, `t` seat and the plugin-bound clients. */
export interface MstarPanelBodyProps
  extends PropsRuntime<'sidebar.right.pane.tab'>,
    PropsStore<ReturnType<typeof createPanelStore>>,
    PropsLocale<'mstar-panel'> {
  /** Namespace-bound translate seat (`locale: 'mstar-panel'`). */
  t: TranslateNS<'mstar-panel'>
  /** Current session identity — the session standard kit's own prop. */
  sessionId?: SessionId
  /** Host session-list selector hook (the global standard seat). */
  useSessions?: UseSessions
  /** The workflow-pick client (the picker's WRITE; the read is `panelSnapshot`). */
  picker?: MstarWorkflowPickerClient
  /** The store-backed snapshot client, bound by the plugin entry. Absent only in a composition that injects no transport. */
  panelSnapshot?: MstarPanelSnapshotClient
  /** The host's locale runtime, so the product's copy follows the host language. */
  localeFace?: HostLocaleFace
}

/** The host's locale id → the product's two locales. */
export function productLocale(active: string): Locale {
  return /^zh/i.test(active) ? 'zh' : 'en'
}

/** The shared nav's items: the session landing first, then the five destinations. */
function navItems(copy: Copy): Array<{ id: string; label: string }> {
  return [
    { id: 'focus', label: copy.focus.pageTitle },
    ...PANEL_DESTINATIONS.map((id) => ({ id, label: copy[id].pageTitle })),
  ]
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

/** The session's delivery line: the iteration that holds one of the bound workflow's plans. */
function deliveryOf(snapshot: PanelSnapshot): { iterationId: string; gateStep: IterationGateStep | null } | null {
  const workflowRead = snapshot.workspace.workflow
  const iterationRead = snapshot.workspace.iteration
  if (workflowRead.state !== 'ok' || workflowRead.data === null) return null
  if (iterationRead.state !== 'ok' || iterationRead.data === null) return null
  const boundPlanIds = new Set(workflowRead.data.plans.map((plan) => plan.planId))
  if (!iterationRead.data.plans.some((plan) => boundPlanIds.has(plan.planId))) return null
  return { iterationId: iterationRead.data.iterationId, gateStep: iterationRead.data.gateStep }
}

/**
 * The pure shell: provider, nav, and the active destination's body.
 *
 * Extracted so a test can render a destination without a transport, and so a
 * second host seat (the main panel) mounts the same composition.
 */
export function PanelShell(props: {
  snapshot: PanelSnapshot
  destination: PanelDestination
  locale: Locale
  /** Accessible name for the nav landmark (the panel's own name). */
  navLabel: string
  onSelect: (destination: string) => void
  select: ((workflowId: string) => void) | null
}): React.ReactElement {
  const copy = copyFor(props.locale)
  const read = props.snapshot.workspace.workflow
  const workflow =
    read.state === 'ok'
      ? ({ state: 'read', data: read.data } as const)
      : ({ state: read.state, reason: read.reason } as const)
  const selection: SessionBinding | null = props.snapshot.retained.selection
  const model = focusModel({
    enforcement: props.snapshot.enforcement.hard ? 'hard' : 'soft',
    selection,
    workflow,
    iteration: deliveryOf(props.snapshot),
  })
  return (
    <LocaleProvider locale={props.locale}>
      <div className={css.nav}>
        <Nav
          items={navItems(copy)}
          activeId={props.destination}
          onSelect={props.onSelect}
          label={props.navLabel}
        />
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

/** The product locale, read from the host's own locale face (uSES-safe). */
function useProductLocale(face: HostLocaleFace | undefined): Locale {
  const read = (): string => (face === undefined ? 'en' : face.getSnapshot().active)
  const active = React.useSyncExternalStore(
    face === undefined ? NO_SUBSCRIBE : (listener) => face.subscribe(listener),
    read,
    // The server render path (and the host's own SSR-less tests) reads this one;
    // it must answer the SAME value as the client read, never a fixed default.
    read,
  )
  return productLocale(active)
}

/** Stable no-op subscribe (a seat composed without a locale face). */
const NO_SUBSCRIBE = (): (() => void) => () => {}

/** The session's workspace directory (the host cross-checks it against the session). */
function sessionCwd(useSessions: UseSessions | undefined, sessionId: SessionId | undefined): string | null {
  if (useSessions === undefined || sessionId === undefined) return null
  const cwd = useSessions((s) => s.byId[sessionId]?.cwd ?? null)
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

export function PanelView(props: MstarPanelBodyProps) {
  const { t, useSessions, sessionId, picker, panelSnapshot, localeFace, useTabInfo, useStore, actions } = props
  const tabInfo = useTabInfo()
  const tabId = tabInfo.tab.id
  const destination: PanelDestination = useStore((s) => s.byTab[tabId]) ?? 'focus'
  const locale = useProductLocale(localeFace)
  const cwd = sessionCwd(useSessions, sessionId)
  const snapshotView = useMstarPanelSnapshot({
    visible: tabInfo.tab.visible,
    client: panelSnapshot,
    sessionId: sessionId === undefined ? null : String(sessionId),
    cwd,
  })
  // The picker's WRITE half only: the selection it shows rides the snapshot.
  const { select } = useMstarWorkflowPicker({ useSessions, sessionId, picker })
  // A refresh keeps painting the last good snapshot; only the FIRST read has none.
  const snapshot = snapshotView.state === 'ok'
    ? snapshotView.snapshot
    : snapshotView.state === 'loading' ? snapshotView.previous : null

  // Every hook runs before the early returns (hooks rule).
  if (!tabInfo.tab.visible) return null
  if (snapshotView.state === 'waiting') {
    return (
      <div className={css.state} data-mstar-panel="waiting">
        <p data-mstar-empty="waiting">{t('empty.waiting')}</p>
      </div>
    )
  }
  if (snapshotView.state === 'no-harness') return <NoHarness t={t} />
  if (snapshotView.state === 'unavailable') {
    return (
      <div className={css.state} data-mstar-panel="unavailable">
        <p data-mstar-empty="unavailable" data-mstar-unavailable-reason={snapshotView.reason}>
          {t('empty.unavailable', { reason: snapshotView.reason })}
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
  if (snapshot.harnessDir === null) return <NoHarness t={t} />

  return (
    <div className={css.root} data-mstar-panel="panel">
      <PanelShell
        snapshot={snapshot}
        destination={destination}
        locale={locale}
        navLabel={t('view.mstar-workflow')}
        onSelect={(next) => actions.select(tabId, next as PanelDestination)}
        select={select}
      />
    </div>
  )
}
