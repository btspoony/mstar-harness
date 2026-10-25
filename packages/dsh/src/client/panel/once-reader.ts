/**
 * One-shot read state, render-safe and timer-free.
 *
 * WHY a tiny external store instead of `useState` + `useEffect`: a read effect
 * never runs under server rendering (`renderToStaticMarkup`), so a seat mounted
 * in a test stayed in its "waiting" arm forever and the transport states were
 * untestable. This reader starts the read on first use (a microtask, never
 * during render), notifies subscribers when the answer lands, and does nothing
 * else: no interval, no visibility gate, no re-read unless the identity changes
 * or `reload()` is called.
 *
 * @module @mstar-harness/dsh/client/panel/once-reader
 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'

/** The three states of one requested read, plus the closed answer kinds. */
export type OnceState<T extends { kind: string }> =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'loading' }
  | T

/** A render-safe one-shot read over one identity. */
export class OnceReader<T extends { kind: string }> {
  private state: OnceState<T> = { kind: 'waiting' }
  private key: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly read: (client: MstarPanelSnapshotClient) => Promise<T>) {}

  /** Current snapshot (stable reference until an answer lands). */
  readonly getSnapshot = (): OnceState<T> => this.state

  /** Subscribe to answers; stable identity for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Start the read for `key` unless it is already the current identity.
   *
   * Safe in a render body: the first call for a key only writes the `loading`
   * arm (no listener exists yet) and schedules the request as a microtask.
   * @param key - the identity string; a new key is a new read.
   * @param client - the transport face, or undefined when none is injected.
   */
  begin(key: string | null, client: MstarPanelSnapshotClient | undefined): void {
    if (key === null || client === undefined) {
      if (this.state.kind !== 'waiting') this.write({ kind: 'waiting' })
      this.key = null
      return
    }
    if (key === this.key) return
    this.key = key
    this.write({ kind: 'loading' })
    queueMicrotask(() => {
      const requested = key
      void this.read(client).then((answer) => {
        // A superseded answer (the identity moved) never lands.
        if (this.key === requested) this.write(answer)
      })
    })
  }

  /** Read the current identity again (an explicit retry, a pick). */
  reload(): void {
    this.key = null
  }

  private write(state: OnceState<T>): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

/**
 * Readers are cached per (transport face, identity): a re-render, an unmount and
 * a later remount of the same seat reuse one answer instead of re-reading, which
 * is also what lets a server-rendered tree observe a settled read. A new client
 * (a reloaded plugin, a test) starts from an empty cache.
 */
const READERS = new WeakMap<object, Map<string, OnceReader<{ kind: string }>>>()

/**
 * The reader for one identity, created on first use.
 * @param client - the transport face the read goes through (the cache key owner).
 * @param key - the identity string.
 * @param make - the reader's read function.
 * @returns the shared reader instance.
 */
export function cachedReader<T extends { kind: string }>(
  client: object | undefined,
  key: string | null,
  make: (read: (face: MstarPanelSnapshotClient) => Promise<T>) => OnceReader<T>,
  read: (face: MstarPanelSnapshotClient) => Promise<T>,
): OnceReader<T> {
  if (client === undefined || key === null) return make(read)
  let byKey = READERS.get(client)
  if (byKey === undefined) {
    byKey = new Map()
    READERS.set(client, byKey)
  }
  const found = byKey.get(key)
  if (found !== undefined) return found as OnceReader<T>
  const reader = make(read)
  byKey.set(key, reader as OnceReader<{ kind: string }>)
  return reader
}

/**
 * Subscribe one component to a one-shot reader.
 * @param reader - the per-identity reader instance.
 * @param key - the identity (null asks for nothing).
 * @param client - the transport face.
 * @returns the state and the reload function.
 */
export function useOnceReader<T extends { kind: string }>(
  reader: OnceReader<T>,
  key: string | null,
  client: MstarPanelSnapshotClient | undefined,
): { readonly state: OnceState<T>; readonly reload: () => void } {
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => {
    reader.reload()
    setNonce((value) => value + 1)
  }, [reader])
  // The call belongs in the render path: it must also run under SSR, and it is
  // idempotent per identity (see `begin`).
  reader.begin(nonce === 0 ? key : `${key ?? ''}#${nonce}`, client)
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot)
  return { state, reload }
}
