/**
 * Panel header (spec panel-layout-graph §1.1): the three basics — mstar
 * version / harness dir / enforcement — spread evenly across a 3-column grid
 * (`repeat(3, minmax(0, 1fr))`), one caption label + value per cell, separated
 * by 1px hairlines, bottom hairline. `data-mstar-watermark` is preserved from
 * the pre-layout header so existing degradation anchors keep working.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarEngineStatusSource } from '../../types.ts'
import css from './panel.module.css'
import { bool, str } from './guards.ts'

export interface PanelHeaderProps {
  t: TranslateNS<'mstar-panel'>
  source: MstarEngineStatusSource
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

export function PanelHeader({ t, source }: PanelHeaderProps) {
  return (
    <header className={css.header} data-mstar-header data-mstar-watermark>
      <div className={css.headerCell} data-mstar-header-cell="version">
        <span className={css.headerLabel}>{t('header.version')}</span>
        <span className={css.headerValue}>{t('watermark.version', { version: str(source.version) ?? t('panel.unknown') })}</span>
      </div>
      <div className={css.headerCell} data-mstar-header-cell="harness">
        <span className={css.headerLabel}>{t('header.harness')}</span>
        <span className={css.headerValue}>{t('watermark.harness', { dir: source.harnessDir ?? t('watermark.none') })}</span>
      </div>
      <div className={css.headerCell} data-mstar-header-cell="enforcement">
        <span className={css.headerLabel}>{t('header.enforcement')}</span>
        <span className={css.headerValue}>{t('watermark.enforcement', { value: enforcementLabel(t, source.enforcement) })}</span>
      </div>
    </header>
  )
}
