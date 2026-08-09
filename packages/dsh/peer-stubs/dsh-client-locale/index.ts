/**
 * Dev-time stand-in for `@deepseek-ai/dsh-client-locale/client` — the browser
 * locale registry consumed by the `@mstar-harness/dsh` client panel plugin.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface pinned to dsh-private commit
 * 347a99b (2026-08-07 snapshot):
 *
 * - `ctx.locale.register(ns, { zh, en })` — typed dictionary registration
 *   (dictionaries checked against the namespace's `LocaleNamespaceMap` key
 *   union; every shipped locale required);
 * - `ctx.locale.bind(ns)` — the namespace-addressed translate used by the
 *   panel's view-tab label thunk (`label: () => t('view.mstar-workflow')`);
 * - `LocaleId = 'zh' | 'en'` and the cordis `Context.locale` merge (the
 *   runtime stub carries `slots`/`sessions`; `locale` merges here — same
 *   split as the real packages).
 *
 * Deliberate simplifications vs the real `LocaleService`: no persisted
 * preference, no `locale/change` event, no LocaleFace revision observable —
 * dev-time composition only needs register/bind/getLocale/setLocale semantics
 * (active-locale lookup with the zh fallback chain).
 */

import type { Context } from 'cordis'
import type { LocaleDictOf, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale dictionary: flat key to template string ({name} placeholders). */
export type LocaleDict = Record<string, string>

/** Locale identifier: the two shipped locales. */
export type LocaleId = 'zh' | 'en'

/** One selectable locale: id plus its self-described display name. */
export interface LocaleDefinition {
  id: LocaleId
  label: string
}

/** Immutable locale state published on every change. */
export interface LocaleSnapshot {
  active: LocaleId
  locales: readonly LocaleDefinition[]
  revision: number
}

declare module 'cordis' {
  interface Context {
    locale: LocaleService
  }
}

/** Fallback locale consulted after the active locale misses. */
export const FALLBACK_LOCALE: LocaleId = 'zh'

/** The two shipped locales. */
const LOCALES: readonly LocaleDefinition[] = Object.freeze([
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
])

/**
 * Dictionary registry plus locale preference — the stub twin of the real
 * `LocaleService`. Lookup chain per key: the entry's namespace in the active
 * locale -> that namespace's zh fallback -> the key itself (missing text stays
 * visible).
 */
export class LocaleService {
  private dicts = new Map<string, Map<string, LocaleDict>>()
  private bound = new Map<string, TranslateNS<never>>()
  private snapshot: LocaleSnapshot

  constructor() {
    this.snapshot = Object.freeze({ active: FALLBACK_LOCALE, locales: LOCALES, revision: 0 })
  }

  /** Read the current immutable locale snapshot. */
  getLocale(): LocaleSnapshot {
    return this.snapshot
  }

  /** LocaleFace getSnapshot (stable reference between changes). */
  getSnapshot(): LocaleSnapshot {
    return this.snapshot
  }

  /** LocaleFace subscribe (notified on every snapshot change). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private listeners = new Set<() => void>()

  /** Switch the active locale — the only preference write entry; unknown ids throw. */
  setLocale(id: string): void {
    const match = this.snapshot.locales.find(l => l.id === id)
    if (match === undefined) throw new Error(`locale "${id}" is not registered`)
    if (this.snapshot.active === match.id) return
    this.publish(match.id)
  }

  /**
   * Register a declared namespace's dictionaries, all locales in one call —
   * the typed form (dictionary keys checked against the namespace's
   * `LocaleNamespaceMap` union; every shipped locale required). Duplicate
   * (ns, locale) throws.
   */
  register<N extends keyof import('@deepseek-ai/dsh-client-ui-slots').LocaleNamespaceMap & string>(
    ns: N,
    dicts: Record<LocaleId, LocaleDictOf<N>>,
  ): () => void
  /** Single-locale untyped form for namespaces outside the merge table. */
  register(ns: string, locale: LocaleId, dict: LocaleDict): () => void
  register(ns: string, localeOrDicts: LocaleId | Record<LocaleId, LocaleDict>, dict?: LocaleDict): () => void {
    const pairs: Array<[LocaleId, LocaleDict]> = typeof localeOrDicts === 'string'
      ? [[localeOrDicts, dict as LocaleDict]]
      : Object.entries(localeOrDicts) as Array<[LocaleId, LocaleDict]>
    let locales = this.dicts.get(ns)
    if (!locales) {
      locales = new Map()
      this.dicts.set(ns, locales)
    }
    for (const [locale] of pairs) {
      if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
    }
    for (const [locale, entries] of pairs) locales.set(locale, entries)
    this.publish(this.snapshot.active)
    return () => {
      const owner = this.dicts.get(ns)
      if (!owner) return
      let removed = false
      for (const [locale, entries] of pairs) {
        if (owner.get(locale) === entries) {
          owner.delete(locale)
          removed = true
        }
      }
      if (removed) this.publish(this.snapshot.active)
    }
  }

  /**
   * Bind a declared namespace to a translate function typed to its dictionary
   * key union — the same key domain the framework-injected `t` seat carries.
   * The returned reference is stable per namespace.
   */
  bind<N extends keyof import('@deepseek-ai/dsh-client-ui-slots').LocaleNamespaceMap & string>(ns: N): TranslateNS<N>
  bind(ns: string): TranslateNS<never>
  bind(ns: string): TranslateNS<never> {
    let t = this.bound.get(ns)
    if (!t) {
      t = ((key: string, params?: Record<string, unknown>) => this.translate(ns, key, params)) as TranslateNS<never>
      this.bound.set(ns, t)
    }
    return t
  }

  private translate(ns: string, key: string, params?: Record<string, unknown>): string {
    const template = this.lookup(ns, key) ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }

  private lookup(ns: string, key: string): string | undefined {
    const locales = this.dicts.get(ns)
    return locales?.get(this.snapshot.active)?.[key] ?? locales?.get(FALLBACK_LOCALE)?.[key]
  }

  private publish(active: LocaleId): void {
    this.snapshot = Object.freeze({
      active,
      locales: this.snapshot.locales,
      revision: this.snapshot.revision + 1,
    })
    for (const fn of [...this.listeners]) fn()
  }
}

/** The shared `common` vocabulary namespace id (registered by the real locale plugin; unused by the panel). */
export const COMMON_NS = 'common'
