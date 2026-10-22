/**
 * The durable form of the adopted control root: one `defineDomain` spec over a
 * single KV table, plus the seam the plugin installs over the open handle.
 *
 * The declaration is inert — importing this module touches no medium and
 * registers no service; only `ctx.storageDomain.open(executionBindingRootsDomain)`
 * in the plugin's `apply` materializes it. The record value IS the adopted
 * harness root; the key is the `(sessionId, cwd)` identity pair computed by
 * `keyOf` in the sibling module, so the in-process overlay and the durable
 * table never spell a key differently.
 *
 * The seam degrades: before an install every read is absent and every write is
 * a resolved no-op, which leaves the sibling module answering exactly as it did
 * with no durable channel at all.
 */
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/**
 * The host's record-schema parameter type: its zod copy, not this package's.
 * The host (`@deepseek-ai/dsh-storage-domain`) pins zod `4.4.3` while this
 * package resolves the `^4.2.0` range (4.6.x); both are zod v4 and the host
 * only calls `parse` on the schema, so the runtime schema is interchangeable —
 * only the vendored `_zod.version` literal makes the two types structurally
 * distinct.
 *
 * shortcut: cast the schema until this package and the host resolve one zod
 * version; upgrade by dropping the cast.
 */
type DomainRecordSchema = Parameters<typeof domainTable<string, string>>[0]

/** The record IS the adopted harness root; its key is the shared `keyOf` pair. */
const rootSchema = z.string().min(1) as unknown as DomainRecordSchema

/**
 * Domain and table names must match the host's `UNIT_NAME_RE`
 * (`/^[a-z][a-z0-9_]*$/`) — `defineDomain` throws at module load otherwise.
 */
export const executionBindingRootsDomain = defineDomain({
  name: 'mstar_execution_binding_roots',
  version: 1,
  tables: { roots: domainTable<string, string>(rootSchema) },
})

/** The durable surface the seam reads and writes — one open domain's table. */
export interface ExecutionBindingRootStore {
  /** Synchronous read of one `keyOf` key; the domain table serves it from memory. */
  get(key: string): string | undefined
  /** Durable write, resolved after the backend acknowledged it. */
  put(key: string, value: string): Promise<void>
  /** Durable delete, resolved after the backend acknowledged it. */
  delete(key: string): Promise<boolean>
}

/** The installed seam; `undefined` while no store is open (today's behaviour). */
let installedStore: ExecutionBindingRootStore | undefined

/**
 * The overlay replay the sibling module registers at load and every install
 * runs once: a receipt recorded while no store existed reaches the table then,
 * so an adoption made before the facility's `open` resolved is not lost.
 */
let replayObservedRoots: (() => void) | undefined

/** Register the replay `installExecutionBindingRootStore` runs (module-load wiring in the sibling). */
export function registerExecutionBindingRootReplay(replay: () => void): void {
  replayObservedRoots = replay
}

/** Logger label for the durable seam (dsh logger naming: `<scope>/<subject>`). */
export const EXECUTION_BINDING_ROOTS_LOGGER = 'mstar/execution-binding-roots'

/** Module-level warning sink — bound by `apply` to `ctx.logger(EXECUTION_BINDING_ROOTS_LOGGER)` (module-sink pattern). */
export type ExecutionBindingRootsLogSink = (message: string) => void

/** The unbound default: the warning still reaches the host's own console, with the label no logger scope supplies. */
const defaultLogSink: ExecutionBindingRootsLogSink = (message) => console.warn(`${EXECUTION_BINDING_ROOTS_LOGGER}: ${message}`)

let logSink: ExecutionBindingRootsLogSink = defaultLogSink

/**
 * Bind the module warning sink (the entry `apply` binds it to
 * `ctx.logger(EXECUTION_BINDING_ROOTS_LOGGER)`). Returns the PRIOR sink so a
 * caller can restore it (the package's module-sink pattern).
 */
export function setExecutionBindingRootsLogger(sink: ExecutionBindingRootsLogSink): ExecutionBindingRootsLogSink {
  const prior = logSink
  logSink = sink
  return prior
}

/**
 * Log one contained durable failure. Never-throws invariant: the whole sink call
 * is inside the guard, so neither the default console write nor a throwing bound
 * sink can re-enter the caller — a contained read failure stays a read failure
 * and a contained write rejection stays a resolved promise. The message carries
 * no label: the sink owns it — the default console sink prefixes it, while the
 * bound `ctx.logger(EXECUTION_BINDING_ROOTS_LOGGER)` scope already labels it.
 */
function warn(message: string, error: unknown): void {
  try {
    logSink(`${message}: ${error instanceof Error ? error.message : String(error)}`)
  } catch {
    // Never-throws invariant (module log-sink pattern).
  }
}

/**
 * Install the durable reader/writer and return its disposer. One seam per
 * process: a second install replaces the first, and a disposer restores the
 * seam that was installed before it (tests boot several apps in one process).
 * Installing never drops an in-process receipt this host already holds: it
 * replays them into the new store, so an adoption made before the seam existed
 * becomes durable here.
 */
export function installExecutionBindingRootStore(store: ExecutionBindingRootStore): () => void {
  const previous = installedStore
  installedStore = store
  replayObservedRoots?.()
  return () => {
    if (installedStore === store) installedStore = previous
  }
}

/** Wrap one open domain handle in the store shape; a store failure is contained like any other. */
export function executionBindingRootStoreOf(domain: Domain<typeof executionBindingRootsDomain>): ExecutionBindingRootStore {
  const roots = domain.table('roots')
  return {
    get: (key) => roots.get(key),
    put: (key, value) => roots.put(key, value),
    delete: (key) => roots.delete(key),
  }
}

/** The durable root recorded for one `keyOf` key: absent with no seam, no record, or a failed read. */
export function durableExecutionBindingRootOf(key: string): string | undefined {
  if (installedStore === undefined) return undefined
  try {
    return installedStore.get(key)
  } catch (error) {
    warn('durable read failed', error)
    return undefined
  }
}

/**
 * Queue the durable record for one `keyOf` key. Never rejects: a failed write
 * is logged with its cause and the caller's in-process receipt still answers.
 */
export function putDurableExecutionBindingRoot(key: string, harnessRoot: string): Promise<void> {
  const store = installedStore
  if (store === undefined) return Promise.resolve()
  try {
    return store.put(key, harnessRoot).then(
      () => undefined,
      (error: unknown) => warn('durable record failed', error),
    )
  } catch (error) {
    warn('durable record failed', error)
    return Promise.resolve()
  }
}

/**
 * Queue the durable delete for one `keyOf` key. Never rejects: a failed delete
 * is logged with its cause and the caller's synchronous tombstone still hides
 * the cleared root.
 */
export function deleteDurableExecutionBindingRoot(key: string): Promise<void> {
  const store = installedStore
  if (store === undefined) return Promise.resolve()
  try {
    return store.delete(key).then(
      () => undefined,
      (error: unknown) => warn('durable clear failed', error),
    )
  } catch (error) {
    warn('durable clear failed', error)
    return Promise.resolve()
  }
}
