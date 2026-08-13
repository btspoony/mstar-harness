/**
 * Loader shim for the REAL dsh client packages' browser bundles in the bun
 * test runtime.
 *
 * The real `@deepseek-ai/dsh-client-runtime/client` and
 * `@deepseek-ai/dsh-client-locale/client` subpath entries are
 * `window.__ModuleLoader__.load({ id, factory })` BROWSER bundles (the dsh
 * web loader module-table format) — they are not Node/bun ESM modules, so a
 * static named import fails to link. This helper installs a minimal
 * `window.__ModuleLoader__` that captures each bundle's factory, then
 * executes the factory with a `require` shim that resolves the bundle's
 * dependencies (the vendor cordis, the Node-ESM main entries of the
 * @deepseek-ai client packages, and npm react) — returning the SAME
 * module.exports the dsh web loader would produce.
 *
 * Specs import this helper INSTEAD of value-importing the `/client`
 * subpaths (type-only imports of the real packages stay untouched — the
 * plugin's panel types come from `lib/types/client/*`).
 */
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

type BundleFactory = (require: (id: string) => unknown) => { exports: unknown }

const factories = new Map<string, BundleFactory>()

;(globalThis as unknown as Record<string, unknown>).window = globalThis
const windowObj = globalThis as unknown as { __ModuleLoader__: { load(entry: { id: string; factory: BundleFactory }): void } }
windowObj.__ModuleLoader__ = {
  load(entry: { id: string; factory: BundleFactory }) {
    factories.set(entry.id, entry.factory)
  },
}
// The real LocaleRuntime resolves the initial locale from the browser
// `navigator` (bun exposes a global navigator whose `language` is undefined)
// and persists the preference to `localStorage` — provide both so the
// browser bundles run headless. zh-CN matches the panel specs' initial-locale
// expectations (the removed peer-stub LocaleRuntime defaulted to the
// first-registered locale, zh; the real one follows the browser).
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', languages: ['zh-CN'] },
  configurable: true,
  writable: true,
})
if ((globalThis as unknown as Record<string, unknown>).localStorage === undefined) {
  const store = new Map<string, string>()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  }
}

/**
 * Execute one captured browser bundle factory with the resolve shim. The
 * bundles declare their PACKAGE id (`@deepseek-ai/dsh-client-runtime`,
 * `@deepseek-ai/dsh-client-locale`) — the same keys the dsh web loader's
 * module table uses — not the `/client` subpath.
 */
export function clientExports(id: string): Record<string, unknown> {
  const factory = factories.get(id)
  if (factory === undefined) throw new Error(`no captured client bundle for ${id} (import the bundle through this module first)`)
  return factory(bundleRequire) as unknown as Record<string, unknown>
}

/** Resolve one browser-bundle dependency: bundles recurse, everything else resolves as Node ESM. */
function bundleRequire(id: string): unknown {
  if (factories.has(id)) return clientExports(id)
  // The vendor cordis (shim), the client packages' Node-ESM main entries
  // (ui-slots, ui-primitives), and npm react — all resolvable via the repo's
  // node_modules (bun's require() of an ESM module returns its namespace).
  return nodeRequire(nodeRequire.resolve(id))
}

// Self-registering browser bundles (the /client subpath files run
// `window.__ModuleLoader__.load(...)` at import time).
await import('@deepseek-ai/dsh-client-runtime/client')
await import('@deepseek-ai/dsh-client-locale/client')
