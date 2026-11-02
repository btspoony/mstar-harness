/**
 * The Linear OAuth card registered into the host Plugins page's
 * `plugins.row.config` seat, keyed `@mstar-harness/dsh#linear-mcp`.
 *
 * Four visible states, matching the confirmed r3 prototype:
 *
 * 1. row disabled — explains that the host's own toggle comes first, and
 *    offers NO Authorize control (never invite consent for a row that cannot
 *    consume it);
 * 2. row enabled, unauthorized — one explicit Authorize click starts the
 *    host-owned attempt; there is no automatic consent;
 * 3. authorizing — the host holds the attempt and the PKCE verifier, the card
 *    can cancel, and it stores no secret;
 * 4. authorized — scope and expiry only, never an account, email or token.
 *    A valid grant whose scope cannot create or update issues stays
 *    `authorized` and additionally offers Authorize: validity and push
 *    capability are separate facts, and a refresh never widens a grant.
 *
 * A browser that is not on the host machine stays on the recovery text: the
 * loopback callback cannot return there, so the card never flips to
 * authorized on its own. Recovery names a same-machine browser or the host
 * CLI (`mstar linear auth`).
 *
 * The card polls `linearAuthorizeStatus` under its own short RPC deadline;
 * the multi-minute consent is never held inside one RPC.
 */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  LinearCredentialView,
  LinearSettingsOutcome,
  LinearSettingsState,
  LinearSettingsStore,
  LinearStatusRead,
} from './linear-settings-store.ts'
import type { LinearSettingsKey } from './linear-settings-locale.ts'
import css from './linear-settings-card.module.css'

/** The keyed slot entry: `<package>#<row id>` exactly as the bundle patch declares it. */
export const LINEAR_SETTINGS_ROW_KEY = '@mstar-harness/dsh#linear-mcp'

/** The props the slot renderer composes (owner view + locale seat + injected store). */
export interface LinearSettingsCardProps {
  readonly view: 'summary' | 'page'
  readonly t: TranslateNS<'ui-mstar-linear-settings'>
  readonly controller: LinearSettingsStore
  /** Bound from the registration's `hooks.snapshot` source. */
  readonly useSnapshot: <S>(selector: (state: LinearSettingsState) => S) => S
}

/** The outcome banner for a failed/terminal attempt, or null. */
function outcomeCopy(
  outcome: LinearSettingsOutcome | null,
  t: TranslateNS<'ui-mstar-linear-settings'>,
): { key: LinearSettingsKey; params?: Record<string, unknown> } | null {
  if (outcome === null) return null
  switch (outcome.status) {
    case 'denied':
      return outcome.reason === 'attempt-active'
        ? { key: 'outcome.attempt-active' }
        : { key: 'outcome.denied', params: { reason: outcome.reason } }
    case 'timeout':
      return { key: 'outcome.timeout' }
    case 'cancelled':
      return { key: 'outcome.cancelled' }
    case 'not-found':
      return { key: 'outcome.not-found' }
    case 'unavailable':
      return { key: 'outcome.unavailable', params: { reason: outcome.reason } }
    case 'unreachable':
      return { key: 'outcome.unreachable' }
  }
}

function scopeText(credential: LinearCredentialView, t: TranslateNS<'ui-mstar-linear-settings'>): string {
  return credential.scope ?? t('scope.unknown')
}

function expiryText(expiresAt: number | null, t: TranslateNS<'ui-mstar-linear-settings'>): string {
  return expiresAt === null ? t('expiry.unknown') : new Date(expiresAt).toLocaleString()
}

/** The one-line fallback the page renders when the entry has no description. */
function summaryText(
  facts: LinearStatusRead | null,
  state: LinearSettingsState,
  t: TranslateNS<'ui-mstar-linear-settings'>,
): string {
  if (facts === null) return t('state.loading')
  if (facts.status === 'unavailable') return t('state.unavailable', { reason: facts.reason })
  if (!facts.rowEnabled) return t('state.disabled.title')
  if (state.attempt !== null) return t('state.authorizing.title')
  switch (facts.credential.display) {
    case 'authorized':
      return facts.credential.canWrite ? t('state.authorized.title') : t('state.scope-insufficient.title')
    case 'expired': return t('state.expired.summary')
    case 'unreadable': return t('state.unauthorized.title')
    case 'absent': return t('state.unauthorized.title')
  }
}

/** One credential fact row (label + value). */
function metaRow(label: string, value: string, attribute?: string): ReactNode {
  return (
    <div className={css.metaRow}>
      <span className={css.metaLabel}>{label}</span>
      <span className={css.metaValue} {...(attribute === undefined ? {} : { 'data-ms-linear-expiry': attribute })}>
        {value}
      </span>
    </div>
  )
}

/** The Authorize control (only ever rendered for an enabled row). */
function authorizeButton(controller: LinearSettingsStore, t: TranslateNS<'ui-mstar-linear-settings'>): ReactNode {
  return (
    <button
      type="button"
      className={css.button}
      data-ms-linear-action="authorize"
      onClick={() => { void controller.begin() }}
    >
      {t('action.authorize')}
    </button>
  )
}

export function LinearSettingsCard(props: LinearSettingsCardProps): ReactNode {
  const { view, t, controller, useSnapshot } = props
  const state = useSnapshot(snapshot => snapshot)
  // Every render is the host boundary this slot exposes (owner props carry only
  // `view` and a config form — no row-change event), so the row bit and the
  // credential facts are taken from `factsForRender`, which answers only facts
  // this render cycle verified and queues the read otherwise. The card never
  // offers Authorize from a bit it did not verify here: an unknown answer
  // renders the loading state, and the queued read is coalesced.
  const facts = controller.factsForRender()
  if (view === 'summary') return summaryText(facts, state, t)

  if (!controller.loopback) {
    return (
      <section className={css.card} data-ms-linear-state="recovery" aria-live="polite">
        <p className={css.title}>{t('state.recovery.title')}</p>
        <p className={css.body}>{t('state.recovery.body')}</p>
      </section>
    )
  }

  if (facts === null) {
    return (
      <section className={css.card} data-ms-linear-state="loading" aria-live="polite">
        <p className={css.body}>{t('state.loading')}</p>
      </section>
    )
  }

  if (facts.status === 'unavailable') {
    return (
      <section className={css.card} data-ms-linear-state="unavailable" aria-live="polite">
        <p className={css.body} role="alert">{t('state.unavailable', { reason: facts.reason })}</p>
      </section>
    )
  }

  if (!facts.rowEnabled) {
    return (
      <section className={css.card} data-ms-linear-state="disabled" aria-live="polite">
        <p className={css.title}>{t('state.disabled.title')}</p>
        <p className={css.body}>{t('state.disabled.body')}</p>
      </section>
    )
  }

  if (state.attempt !== null) {
    return (
      <section className={css.card} data-ms-linear-state="authorizing" aria-live="polite">
        <p className={css.title}>
          <span className={`${css.pill} ${css.warn}`} role="status">{t('state.authorizing.title')}</span>
        </p>
        <p className={css.body}>{t('state.authorizing.body')}</p>
        <div className={css.actions}>
          <button
            type="button"
            className={css.buttonSecondary}
            data-ms-linear-action="cancel"
            onClick={() => { void controller.cancel() }}
          >
            {t('action.cancel')}
          </button>
        </div>
      </section>
    )
  }

  const credential = facts.credential
  const banner = outcomeCopy(state.outcome, t)

  if (credential.display === 'authorized') {
    // A valid but read-only grant is authorized and cannot push. Both facts
    // are rendered, and Authorize stays reachable: a refresh only echoes the
    // original scope, so reauthorization is the only widening path.
    const canWrite = credential.canWrite
    return (
      <section
        className={css.card}
        data-ms-linear-state="authorized"
        data-ms-linear-push={canWrite ? 'ready' : 'scope-insufficient'}
        aria-live="polite"
      >
        <p className={css.title}>
          <span className={`${css.pill} ${canWrite ? css.ok : css.warn}`} role="status">
            {canWrite ? t('state.authorized.title') : t('state.scope-insufficient.title')}
          </span>
        </p>
        {canWrite ? null : <p className={css.notice} role="alert">{t('state.scope-insufficient.body')}</p>}
        {metaRow(t('scope.label'), scopeText(credential, t))}
        {metaRow(
          t('expiry.label'),
          expiryText(credential.expiresAt, t),
          credential.expiresAt === null ? undefined : new Date(credential.expiresAt).toISOString(),
        )}
        {canWrite ? null : <div className={css.actions}>{authorizeButton(controller, t)}</div>}
        <p className={css.note}>{t('note.no-secret')}</p>
      </section>
    )
  }

  const bodyKey: LinearSettingsKey = credential.display === 'expired'
    ? 'state.expired.body'
    : credential.display === 'unreadable'
      ? 'state.unreadable.body'
      : 'state.absent.body'
  return (
    <section
      className={css.card}
      data-ms-linear-state="unauthorized"
      data-ms-linear-outcome={state.outcome?.status ?? credential.display}
      aria-live="polite"
    >
      <p className={css.title}>
        <span className={`${css.pill} ${css.bad}`} role="status">{t('state.unauthorized.title')}</span>
      </p>
      {banner === null
        ? null
        : <p className={css.notice} role="alert">{t(banner.key, banner.params)}</p>}
      <p className={css.body}>
        {credential.display === 'expired'
          ? t('state.expired.body', { expiry: expiryText(credential.expiresAt, t) })
          : t(bodyKey)}
      </p>
      {credential.expiresAt === null ? null : metaRow(
        t('expiry.label'),
        expiryText(credential.expiresAt, t),
        new Date(credential.expiresAt).toISOString(),
      )}
      {credential.scope === null && credential.expiresAt === null
        ? null
        : metaRow(t('scope.label'), scopeText(credential, t))}
      <div className={css.actions}>{authorizeButton(controller, t)}</div>
    </section>
  )
}
