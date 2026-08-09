/**
 * Morning Star workflow panel page — the `conversation.view` tab component
 * (spec §4.2): pure render of the latest `mstar-engine-status` catalog row.
 *
 * Inputs: the session standard kit (`ConvViewProps`) and the typed `t` seat
 * (`locale: 'mstar-panel'`). The catalog row + message time come from the
 * `useMstarEngineStatus()` hook riding the kit's `useSession` selector (spec
 * §5) — the render body is a pure function of (source, lastUpdated, t).
 *
 * Empty states (spec §3): no catalog row → waiting hint; harness missing
 * (`harnessDir` null + `state` null + no `iteration`) → no-harness hint;
 * gate missing (`iteration` key absent) → no-compass note while the state
 * section still renders. The no-session case is shell-handled by the
 * strict-session view ring.
 */

import * as React from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarEngineStatusSource } from '../../types.ts'
import { cls } from './classes.ts'
import { bool, str } from './guards.ts'
import { IterationSection } from './iteration-section.tsx'
import { StateSection } from './state-section.tsx'
import { useMstarEngineStatus } from './use-mstar-engine-status.ts'

export interface MstarPanelViewProps extends ConvViewProps {
  /** Namespace-bound translate seat (`locale: 'mstar-panel'`). */
  t: TranslateNS<'mstar-panel'>
}

/** Enforcement flag label: hard/soft (+ provenance source), unknown when missing (spec §2.1). */
function enforcementLabel(
  t: TranslateNS<'mstar-panel'>,
  enforcement: MstarEngineStatusSource['enforcement'],
): string {
  if (enforcement === null || enforcement === undefined || typeof enforcement !== 'object') {
    return t('panel.unknown')
  }
  const hard = bool((enforcement as { hard?: unknown }).hard)
  const source = str((enforcement as { source?: unknown }).source)
  const flag = hard === null ? t('panel.unknown') : hard ? t('watermark.hard') : t('watermark.soft')
  return source === null ? flag : `${flag} (${source})`
}

/** Freshness timestamp: local HH:MM:SS (spec §5). */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB')
}

export function PanelView({ t, useSession }: MstarPanelViewProps) {
  const { source, lastUpdated } = useMstarEngineStatus(useSession)
  if (source === null || source === undefined) {
    return (
      <div className={cls('root')} data-mstar-panel="waiting">
        <p className={cls('empty')} data-mstar-empty="waiting">{t('empty.waiting')}</p>
      </div>
    )
  }
  const noHarness = source.harnessDir === null && source.state === null && source.iteration === undefined
  return (
    <div className={cls('root')} data-mstar-panel={noHarness ? 'no-harness' : 'panel'}>
      <header className={cls('watermark')} data-mstar-watermark>
        <span>{t('watermark.version', { version: str(source.version) ?? t('panel.unknown') })}</span>
        <span>{t('watermark.harness', { dir: source.harnessDir ?? t('watermark.none') })}</span>
        <span>{t('watermark.enforcement', { value: enforcementLabel(t, source.enforcement) })}</span>
      </header>
      {noHarness
        ? <p className={cls('empty')} data-mstar-empty="no-harness">{t('empty.no-harness')}</p>
        : (
          <>
            {source.iteration === undefined
              ? <p className={cls('empty')} data-mstar-empty="no-gate">{t('iteration.no-compass')}</p>
              : <IterationSection t={t} iteration={source.iteration} />}
            {source.state === null
              ? <p className={cls('empty')} data-mstar-empty="no-state">{t('state.none')}</p>
              : <StateSection t={t} state={source.state} />}
          </>
        )}
      <footer className={cls('freshness')} data-mstar-freshness>
        {typeof lastUpdated === 'number'
          ? <span>{t('freshness.last-updated', { time: formatTime(lastUpdated) })}</span>
          : null}
        <span>{t('freshness.refresh-note')}</span>
      </footer>
    </div>
  )
}
