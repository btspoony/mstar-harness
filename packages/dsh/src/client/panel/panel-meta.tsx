/**
 * Sidebar bottom meta dock: the durable identity line — the snapshot's mstar
 * version + its harness dir — in a small muted panel pinned below the
 * scrolling digest (hairline-separated, does NOT scroll with the sidebar).
 *
 * The `watermark.*` locale values (reused from the removed header) render the
 * two lines; `data-mstar-watermark` is preserved here so existing degradation
 * anchors keep working. Degradation stays total: missing version → `unknown`,
 * null harness dir → `none` (never a crash, never a guessed value).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import css from './panel.module.css'
import { str } from './guards.ts'

export interface PanelMetaProps {
  t: TranslateNS<'mstar-panel'>
  snapshot: PanelSnapshot
}

export function PanelMeta({ t, snapshot }: PanelMetaProps) {
  return (
    <footer className={css.meta} data-mstar-meta data-mstar-watermark>
      <p className={css.metaLine} data-mstar-meta-version>
        {t('watermark.version', { version: str(snapshot.version) ?? t('panel.unknown') })}
      </p>
      <p className={css.metaLine} data-mstar-meta-harness>
        {t('watermark.harness', { dir: snapshot.harnessDir ?? t('watermark.none') })}
      </p>
    </footer>
  )
}
