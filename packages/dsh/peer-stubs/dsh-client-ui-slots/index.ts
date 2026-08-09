/**
 * Dev-time stand-in for `@deepseek-ai/dsh-client-ui-slots` — the slot registry
 * pure core (SlotCore) and the shared type seats (SlotMap / LocaleNamespaceMap /
 * standard-props kits / ComposedProps machinery) consumed by the
 * `@mstar-harness/dsh` client panel plugin.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface pinned to dsh-private commit
 * 347a99b (2026-08-07 snapshot), with just enough runtime for dev-time
 * composition tests: `register` with the load-time validations the panel
 * depends on (undeclared target throws; list `id` uniqueness; ascending
 * `order` sort; children declaration with disposer cascade) and the
 * `SlotCore.subscribeDeclaration` seam the runtime stub's `SlotsService.inject`
 * rides. Keep in sync when the dsh-private baseline moves.
 *
 * Deliberate simplifications vs the real core (ui-slots/src/store.ts +
 * renderer.ts): no store seat, no chain `select`/`priority` enforcement, no
 * microtask-batched change flush (notifications fire synchronously). The
 * type-only seats (`SessionStandardProps` & co.) stay EMPTY exactly like the
 * real package — the runtime stub merges the real members.
 */

/** Slot contract table. Owners extend via declaration merging; entries are {@link SlotEntryDef}. */
export interface SlotMap {}

/**
 * Locale namespace table. Dictionary owners extend via declaration merging
 * (lexically in the augmented module, exactly like SlotMap): the key is the
 * namespace string, the value is the union of its dictionary keys.
 */
export interface LocaleNamespaceMap {}

/** Slot cardinality: single occupant, ordered list, key-dispatched, or selector-routed chain. */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** Slot data context: global, current-session-optional, or strict session-bound. */
export type SlotScope = 'root' | 'session-maybe' | 'session'

/** One SlotMap entry: kind/scope axes plus the optional owner-supplied props share. */
export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  owner?: object
}

/** Runtime dispatch spec for one slot, recorded from a register call's `children` value. */
export interface SlotSpec<E extends SlotEntryDef> { kind: E['kind']; scope: E['scope'] }

/** Child-slot declaration table for register(): declaring is claiming — only the declarer may render these keys. */
export type ChildrenDecl = { [P in keyof SlotMap & string]?: SlotSpec<SlotMap[P]> }

/** Owner-supplied props share for a slot key ({} for entries declaring no `owner`). */
export type OwnerOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { owner: infer O extends object } ? O : object

/** Scope axis of a slot key's SlotMap entry. */
export type ScopeOf<K extends keyof SlotMap & string> = SlotMap[K]['scope']

/**
 * Framework standard kit delivered to every session-scope slot component.
 * Declared EMPTY here (zero-dependency layer): the runtime package merges the
 * real members (useSession/sessionId/useProjection) exactly as consumers merge
 * SlotMap keys.
 */
export interface SessionStandardProps {}

/** Standard kit for slots that remain mounted while the current session changes. */
export interface SessionMaybeStandardProps {}

/** Props injected into every global slot component. */
export interface GlobalStandardProps {}

/** The session id type as the runtime's SessionStandardProps merge declares it; falls back to string. */
export type SessionIdOf = SessionStandardProps extends { sessionId: infer S } ? S : string

/**
 * Typed selector hook over a snapshot source. Canonical shape for the whole
 * slot system (web-react binds bare sources to this via uSES).
 */
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

/** Selector hook over a source that follows the current session (absent value while no session is current). */
export type MaybeSnapshotSelectorHook<T> =
  <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S | undefined

/** Bare observable snapshot source: getSnapshot + subscribe pair (uSES-compatible). */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/** Alias used by the runtime/test surfaces for the same bare-source shape. */
export type ObservableSnapshot<T> = HostObservable<T>

/** Conversation-session selector hook alias for props contracts (runtime narrows at its export seam). */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

/** Translate a dictionary key with optional `{name}` template params. */
export type Translate<K extends string = string> = (key: K, params?: Record<string, unknown>) => string

/** The shared `common` vocabulary keys as merged by the locale plugin; `never` without the merge. */
export type CommonKeyOf = LocaleNamespaceMap extends { common: infer C } ? C & string : never

/** Key domain of a namespace-bound translate: the namespace's dictionary union plus the common vocabulary. */
export type LocaleKeysOf<N extends keyof LocaleNamespaceMap & string> =
  (LocaleNamespaceMap[N] & string) | CommonKeyOf

/** Namespace-addressed translate — the type of the framework-injected `t` seat. */
export type TranslateNS<N extends keyof LocaleNamespaceMap & string> = Translate<LocaleKeysOf<N>>

/** Dictionary shape for a declared namespace: exactly the keys merged into LocaleNamespaceMap. */
export type LocaleDictOf<N extends keyof LocaleNamespaceMap & string> =
  Record<LocaleNamespaceMap[N] & string, string>

/** Locale share of the composed component props: the `t` seat, present when the entry declares `locale:`. */
export type PropsLocale<N> = N extends keyof LocaleNamespaceMap & string
  ? { t: TranslateNS<N> }
  : object

/** Runtime props share for a slot key: owner share + session/global standard kits. */
export type PropsRuntime<K extends keyof SlotMap & string> =
  OwnerOf<K> &
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/**
 * Registration-position component shape: the bare call signature, so composed
 * constraints check through clean parameter contravariance. The stub types the
 * return as `unknown` instead of the real `ReactNode` — a dev-time-only
 * simplification that keeps the stub dependency-free (any React component
 * return is assignable to `unknown`; the real `@types/react` surface arrives
 * with the panel package's own devDependencies in Task 2).
 */
export type SlotComponent<P> = (props: P) => unknown

/** A list-entry display label: a plain string, or a thunk re-evaluated per read (follows the active locale). */
export type SlotLabel = string | (() => string)

/** Resolve a possibly-thunked list label at read time. */
export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

/** Type-erased options view the stub implementation works with. */
export interface ErasedRegisterOptions {
  name: string
  key?: string | undefined
  id?: string | undefined
  order?: number | undefined
  label?: SlotLabel | undefined
  select?: ((owner: never) => unknown) | undefined
  priority?: number | undefined
  children?: Record<string, SlotSpec<SlotEntryDef>> | undefined
  locale?: string | undefined
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  registrant?: string | undefined
}

/**
 * Typed register options (the dev-time twin of the real `BaseOptions` +
 * `KindOptions`). `name` is checked against the merged `SlotMap`; `locale`
 * against the merged `LocaleNamespaceMap` (declaring it puts the typed `t`
 * seat on the component props).
 */
export type RegisterOptions<
  K extends keyof SlotMap & string,
  N extends (keyof LocaleNamespaceMap & string) | undefined = undefined,
> = {
  /** Target slot key (the entry contributes INTO this slot). */
  name: K
  /** Keyed-slot dispatch key. */
  key?: string
  /** List-slot entry id (unique within the slot; the view-ring tab id). */
  id?: string
  /** List-slot display order (ascending, default 0). */
  order?: number
  /** List-slot display label: a plain string or a thunk re-read per projection. */
  label?: SlotLabel
  /** Chain-slot routing selector (not consumed by the panel; kept for parity). */
  select?: (owner: never) => unknown
  /** Chain-slot explicit ordering override (ascending, default 0). */
  priority?: number
  /** Child-slot declaration table (declaring is claiming). */
  children?: ChildrenDecl
  /** Declared dictionary namespace (the render machinery synthesizes the `t` seat from it). */
  locale?: N
  /** Registrant business face factory (kept for parity; the panel is a pure reader). */
  inject?: (...args: never[]) => Record<string, unknown>
  /** Registrant identity label for diagnostics. */
  registrant?: string
}

/** One stored registration, as read by the render/test machinery. */
export interface StoredEntry {
  component: unknown
  options: { key?: string; id?: string; order?: number; label?: SlotLabel; priority?: number }
  children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>> | undefined
  locale?: string | undefined
  registrant?: string | undefined
}

/** Per-key registry record. Created on first touch; never removed. */
interface SlotRecord {
  spec: SlotSpec<SlotEntryDef> | undefined
  declaredBy: string | undefined
  declarationEpoch: number
  entries: readonly StoredEntry[]
  version: number
  listeners: Set<() => void>
  declarationListeners: Set<() => void>
}

const NO_ENTRIES: readonly StoredEntry[] = Object.freeze([])

/**
 * Pure slot registry (no cordis) — the stub twin of the real
 * `SlotCore.register` contract the panel depends on:
 *
 * - registering into an UNDECLARED slot throws
 *   (`slot "<name>" is not declared (a parent entry's children table must declare it)`)
 * - list kind requires a unique `id`; entries sort by ascending `order` (default 0)
 * - `children` declares (and thereby render-authorizes) child slots; the
 *   disposer removes the contribution AND collapses every declared child slot
 * - the a-priori `root` hole (single/root) is seeded at construction
 *
 * Notification simplifications (dev-time): `onMutate` fires synchronously per
 * mutation; `subscribe` notifications are synchronous (no microtask batch);
 * `subscribeDeclaration` fires synchronously per declaration lifetime boundary
 * (same as the real core).
 */
export class SlotCore {
  private records = new Map<string, SlotRecord>()
  private mutateListeners = new Set<(key: string) => void>()

  constructor() {
    const root = this.record('root')
    root.spec = { kind: 'single', scope: 'root' }
    root.declaredBy = '(built-in)'
    root.declarationEpoch = 1
  }

  /** Contribute a component to a declared slot and (optionally) declare child slots. */
  register<
    K extends keyof SlotMap & string,
    N extends (keyof LocaleNamespaceMap & string) | undefined = undefined,
  >(
    options: RegisterOptions<K, N>,
    component: SlotComponent<PropsRuntime<K> & PropsLocale<N>>,
  ): () => void {
    const erased: ErasedRegisterOptions = {
      ...options,
      ...(options.inject !== undefined ? { inject: options.inject } : {}),
    }
    const rec = this.records.get(erased.name)
    if (!rec?.spec) {
      throw new Error(`slot "${erased.name}" is not declared (a parent entry's children table must declare it)`)
    }
    const spec = rec.spec
    switch (spec.kind) {
      case 'single':
        if (rec.entries.length > 0) throw new Error(`single slot "${erased.name}" already has a registration`)
        break
      case 'keyed':
        if (erased.key === undefined) throw new Error(`keyed slot "${erased.name}" requires options.key`)
        if (rec.entries.some(e => e.options.key === erased.key)) {
          throw new Error(`keyed slot "${erased.name}" already has an entry for key "${erased.key}"`)
        }
        break
      case 'list':
        if (erased.id === undefined) throw new Error(`list slot "${erased.name}" requires options.id`)
        if (rec.entries.some(e => e.options.id === erased.id)) {
          throw new Error(`list slot "${erased.name}" already has an entry with id "${erased.id}"`)
        }
        break
      case 'chain':
        if (erased.select === undefined) throw new Error(`chain slot "${erased.name}" requires options.select`)
        break
    }
    if (erased.children) {
      for (const childKey of Object.keys(erased.children)) {
        const childRec = this.records.get(childKey)
        if (childRec?.spec) {
          throw new Error(`slot "${childKey}" is already declared (by ${childRec.declaredBy ?? 'an unknown entry'})`)
        }
      }
    }

    const entry: StoredEntry = {
      component,
      options: {
        ...(erased.key !== undefined ? { key: erased.key } : {}),
        ...(erased.id !== undefined ? { id: erased.id } : {}),
        ...(erased.order === undefined ? {} : { order: erased.order }),
        ...(erased.label !== undefined ? { label: erased.label } : {}),
        ...(erased.priority !== undefined ? { priority: erased.priority } : {}),
      },
      ...(erased.children !== undefined ? { children: erased.children } : {}),
      ...(erased.locale !== undefined ? { locale: erased.locale } : {}),
      ...(erased.registrant !== undefined ? { registrant: erased.registrant } : {}),
    }
    const next = [...rec.entries, entry]
    if (spec.kind === 'list') next.sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    rec.entries = next
    this.markDirty(erased.name, rec)
    if (erased.children) {
      const declarations: Array<[key: string, record: SlotRecord]> = []
      for (const [childKey, childSpec] of Object.entries(erased.children)) {
        const childRec = this.record(childKey)
        childRec.spec = childSpec
        childRec.declaredBy = `an entry in "${erased.name}"${erased.registrant ? ` (${erased.registrant})` : ''}`
        childRec.declarationEpoch += 1
        declarations.push([childKey, childRec])
      }
      for (const [childKey, childRec] of declarations) this.markDirty(childKey, childRec)
      for (const [, childRec] of declarations) this.notifyDeclaration(childRec)
    }
    return () => {
      if (!rec.entries.includes(entry)) return
      rec.entries = rec.entries.filter(e => e !== entry)
      this.markDirty(erased.name, rec)
      this.releaseEntry(entry)
    }
  }

  /** Snapshot the registered entries for a key (stable reference between mutations). */
  entries(key: string): readonly StoredEntry[] {
    return this.records.get(key)?.entries ?? NO_ENTRIES
  }

  /** Look up a slot's declared spec (dynamic-key form the render/test machinery uses). */
  specDynamic(key: string): SlotSpec<SlotEntryDef> | undefined {
    return this.records.get(key)?.spec
  }

  /** Monotonic declaration lifetime of a key (0 before the first declaration). */
  declarationEpoch(key: string): number {
    return this.records.get(key)?.declarationEpoch ?? 0
  }

  /** Subscribe to registration changes for a key (synchronous in this stub). */
  subscribe(key: string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.listeners.add(fn)
    return () => { rec.listeners.delete(fn) }
  }

  /** Subscribe to declaration lifetime boundaries (synchronous; the SlotsService.inject seam). */
  subscribeDeclaration(key: string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.declarationListeners.add(fn)
    return () => { rec.declarationListeners.delete(fn) }
  }

  /** Monotonic version for a key, bumped synchronously per mutation (uSES getSnapshot source). */
  getVersion(key: string): number {
    return this.records.get(key)?.version ?? 0
  }

  /** Hook every mutation (the runtime Service wrapper bridges this to ctx.emit). */
  onMutate(fn: (key: string) => void): () => void {
    this.mutateListeners.add(fn)
    return () => { this.mutateListeners.delete(fn) }
  }

  /** Cascade for a removed entry: collapse every child slot it declared. */
  private releaseEntry(entry: StoredEntry): void {
    if (!entry.children) return
    for (const childKey of Object.keys(entry.children)) {
      const childRec = this.records.get(childKey)
      if (!childRec) continue
      const doomed = childRec.entries
      childRec.spec = undefined
      childRec.declaredBy = undefined
      childRec.declarationEpoch += 1
      childRec.entries = NO_ENTRIES
      this.markDirty(childKey, childRec)
      this.notifyDeclaration(childRec)
      for (const dead of doomed) this.releaseEntry(dead)
    }
  }

  private record(key: string): SlotRecord {
    let rec = this.records.get(key)
    if (!rec) {
      rec = {
        spec: undefined,
        declaredBy: undefined,
        declarationEpoch: 0,
        entries: NO_ENTRIES,
        version: 0,
        listeners: new Set(),
        declarationListeners: new Set(),
      }
      this.records.set(key, rec)
    }
    return rec
  }

  private markDirty(key: string, rec: SlotRecord): void {
    rec.version += 1
    for (const fn of [...this.mutateListeners]) fn(key)
  }

  private notifyDeclaration(rec: SlotRecord): void {
    for (const fn of [...rec.declarationListeners]) fn()
  }
}
