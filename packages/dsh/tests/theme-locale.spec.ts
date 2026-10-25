/**
 * Task 5: the two host bridges — locale (`ctx.locale` → the shared dictionary,
 * one documented mapping) and theme (only the SCHEME is inherited; the product
 * keeps its own `--ms-*` palette and flips it through `data-ms-theme`).
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { copyFor, en as uiEn, zh as uiZh } from '@mstar-harness/ui'
import { PanelShell, productLocale } from '../src/client/panel/panel-shell.tsx'
import { createHostThemeFace, resolveScheme } from '../src/client/panel/theme.ts'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'

const PKG_DIR = join(import.meta.dir, '..')

const SNAPSHOT = {
  enforcement: { hard: true, source: 'compass' },
  knowledge: { docCount: 41, categories: ['specs'] },
  selection: { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' },
  iteration: { state: 'not-applicable', reason: 'standalone' },
} as unknown as PanelSnapshot

const WORKFLOW = {
  id: 'wf-1',
  type: 'plan',
  status: 'running',
  phase: 'phase-2-execute',
  branch: { base: 'main', source: 'feature/x', integration: null, target: 'main' },
  plans: [{ planId: 'p-1', status: 'InProgress', progress: 'writing the bridge' }],
}

function render(over: {
  snapshot?: PanelSnapshot
  scheme?: 'light' | 'dark'
  select?: ((workflowId: string) => void) | null
} = {}): string {
  const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
  return renderToStaticMarkup(
    createElement(PanelShell, {
      snapshot: over.snapshot ?? SNAPSHOT,
      workflow: { state: 'read', data: WORKFLOW as never },
      destination: 'focus',
      locale: 'en',
      ...(over.scheme === undefined ? {} : { scheme: over.scheme }),
      navLabel: 'Morning Star Workflow',
      onSelect: () => {},
      select: over.select ?? null,
    }),
  )
}

/* ---------------------------- Task 5 — locale ---------------------------- */

describe('locale bridge — one mapping, one dictionary', () => {
  it('maps every host locale id onto the two product locales', () => {
    expect(productLocale('zh')).toBe('zh')
    expect(productLocale('zh-CN')).toBe('zh')
    expect(productLocale('zh-Hans')).toBe('zh')
    expect(productLocale('en')).toBe('en')
    expect(productLocale('en-US')).toBe('en')
    // An unsupported host language falls back to English, never to Chinese.
    expect(productLocale('de-DE')).toBe('en')
    expect(productLocale('')).toBe('en')
  })

  it('the product copy comes from the shared dictionary for both locales', () => {
    expect(copyFor('en').focus.pageTitle).toBe(uiEn.focus.pageTitle)
    expect(copyFor('zh').focus.pageTitle).toBe(uiZh.focus.pageTitle)
    expect(uiZh.focus.pageTitle).not.toBe(uiEn.focus.pageTitle)
  })
})

/* ---------------------------- Task 5 — theme ---------------------------- */

describe('theme bridge — resolve the scheme, never alias the palette', () => {
  it('resolves the host scheme, defaulting an unknown one to light', () => {
    expect(resolveScheme({ active: { colorScheme: 'dark' } })).toBe('dark')
    expect(resolveScheme({ active: { colorScheme: 'light' } })).toBe('light')
    expect(resolveScheme({ active: { colorScheme: 'sepia' } })).toBe('light')
    expect(resolveScheme({ active: {} })).toBe('light')
    expect(resolveScheme(null)).toBe('light')
    expect(resolveScheme(undefined)).toBe('light')
  })

  it('reports the host scheme and re-notifies on theme/change', () => {
    let scheme = 'light'
    const listeners: Array<() => void> = []
    const face = createHostThemeFace(
      { getTheme: () => ({ active: { colorScheme: scheme } }) },
      (listener) => {
        listeners.push(listener)
        return () => { listeners.splice(listeners.indexOf(listener), 1) }
      },
    )
    expect(face.face.getSnapshot()).toBe('light')
    let notifications = 0
    const stop = face.face.subscribe(() => { notifications += 1 })
    scheme = 'dark'
    for (const listener of [...listeners]) listener()
    expect(face.face.getSnapshot()).toBe('dark')
    expect(notifications).toBe(1)
    stop()
    scheme = 'light'
    for (const listener of [...listeners]) listener()
    expect(notifications).toBe(1)
  })

  it('disposal unsubscribes from the host and drops every listener', () => {
    let hostListeners = 0
    const face = createHostThemeFace(
      { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
      () => {
        hostListeners += 1
        return () => { hostListeners -= 1 }
      },
    )
    expect(hostListeners).toBe(1)
    const stop = face.face.subscribe(() => {})
    face.dispose()
    expect(hostListeners).toBe(0)
    stop()
  })

  it('the shell applies the scheme as data-ms-theme, light by default', () => {
    expect(render({ scheme: 'dark' })).toContain('data-ms-theme="dark"')
    expect(render({ scheme: 'light' })).toContain('data-ms-theme="light"')
    expect(render()).toContain('data-ms-theme="light"')
  })

  it('no product component or stylesheet aliases the host palette', () => {
    // The host-seat stylesheet and every client source: `--dsw-*` belongs to the
    // host's chrome, never to the product (compass constraint 4).
    const files = [
      ...readdirSync(join(PKG_DIR, 'src/client/panel/')).filter((file) => file.endsWith('.css') || file.endsWith('.tsx') || file.endsWith('.ts')),
    ]
    for (const file of files) {
      const text = readFileSync(join(PKG_DIR, 'src/client/panel', file), 'utf8')
      expect(text).not.toContain('--dsw-')
    }
  })
})

