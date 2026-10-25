/**
 * The unified product's shell for this host: the ONE implementation both seats
 * mount (plan dsh-panel-unification Task 3).
 *
 * The right-Sidebar tab and the keyed `main` panel are the same product at two
 * sizes — same nav, same destination ids, same screens, same copy, same absence
 * decisions. Everything they share lives here, so a prop only one seat can
 * supply becomes a prop of this module instead of a second call site:
 *
 * - `PANEL_DESTINATIONS` is the destination set, in IA §8.2 order. The nav, the
 *   entry store's vocabulary and both seats read it; no seat writes its own list.
 * - `PanelSeat` owns the transport states and the adapter work (snapshot →
 *   shared view model, host locale → product locale, picker commit). A seat adds
 *   only what it alone owns: the sidebar gates on tab visibility and keeps the
 *   destination in its entry store; the main panel is always visible and keeps
 *   the destination in component state.
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
import type { IterationGateStep } from '@mstar-harness/engine'
import css from './panel.module.css'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import type { MstarWorkflowPickerClient } from './workflow-picker-client.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'
import { useMstarPanelSnapshot } from './use-mstar-panel-snapshot.ts'
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
 * A destination whose screen lands in its own round renders NO body — an absence
 * arm here would claim a read that never happened.
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
    // The server render path must answer the SAME value as the client read,
    // never a fixed default.
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
 * One seat's body: the transport states, the adapter and the shell.
 *
 * `visible` is the seat's own gate: the sidebar collapses its column (nothing
 * may render or poll), while the main panel is always visible. Everything else
 * is identical by construction, which is what keeps the two seats one
 * implementation.
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
  const snapshotView = useMstarPanelSnapshot({
    visible,
    client: panelSnapshot,
    sessionId: sessionId === undefined ? null : String(sessionId),
    cwd,
  })
  const locale = useProductLocale(localeFace)
  // The picker's WRITE half only: the selection it shows rides the snapshot.
  const { select } = useMstarWorkflowPicker({ useSessions, sessionId, picker })
  // A refresh keeps painting the last good snapshot; only the FIRST read has none.
  const snapshot = snapshotView.state === 'ok'
    ? snapshotView.snapshot
    : snapshotView.state === 'loading' ? snapshotView.previous : null

  // Every hook runs before the early returns (hooks rule).
  if (!visible) return null
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
    <PanelShell
      snapshot={snapshot}
      destination={destination}
      locale={locale}
      navLabel={t('view.mstar-workflow')}
      onSelect={onSelect}
      select={select}
    />
  )
}
