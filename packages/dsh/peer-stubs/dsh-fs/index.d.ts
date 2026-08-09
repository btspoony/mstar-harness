/**
 * Type-only shim for the `@deepseek-ai/dsh-fs` seam consumed by `@mstar-harness/dsh`.
 *
 * The real package is private and ships from the composed dsh app at runtime; its
 * published types are not built in the local dsh-private checkout. This declaration
 * mirrors exactly the consumed surface of the seam — the `FsTarget`/`FsVersion`/
 * `FsWriteIntent` vocabulary and the three `fs/*` events (single-slot decision
 * waterfalls + the observation recorder) — pinned to dsh-private commit 9451be2
 * (2026-08-07 snapshot). Keep in sync when the dsh-private baseline moves.
 */

/** Mirror of `@deepseek-ai/dsh-brand` `Branded<T>` (kept local so the stub stays standalone). */
export type Branded<B extends string> = string & { readonly __brand: B }

/** Opaque key for stale guards and target lookup. Consumers MUST NOT parse it. */
export type FsTargetKey = Branded<'FsTargetKey'>

/** Brand a string as an {@link FsTargetKey}. For backend use only. */
export function FsTargetKey(key: string): FsTargetKey {
  return key as FsTargetKey
}

/** Opaque file-version token — the freshness token a write/edit guards against. */
export type FsVersion = Branded<'FsVersion'>

/** Brand a string as an {@link FsVersion}. For backend use only. */
export function FsVersion(v: string): FsVersion {
  return v as FsVersion
}

/** A path resolved by a backend into a stable identity. */
export interface FsTarget {
  /** Opaque key for stale guards and target lookup. */
  targetKey: FsTargetKey
  /** Path for model/UI-facing output (absolute path, relative path, or remote URI). */
  displayPath: string
}

/**
 * Guarded write intent. `createIfAbsent` rejects an existing target with
 * `FS_NOT_OBSERVED`; `replaceIfVersion` rejects absence or mismatch with
 * `FS_STALE_VERSION`. Omitting the intent from `writeText` means unconditional
 * create-or-overwrite, not a third union arm.
 */
export type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }

declare module 'cordis' {
  interface Events {
    /**
     * Single-slot decision for the next `FileSystem.writeText`. Calling
     * `next()` yields the bare provider's unconditional write; the first listener
     * that returns an intent owns the decision rather than composing with peers.
     * @param target - the resolved target about to be written.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/write-intent'(
      target: FsTarget,
      actor: object | undefined,
      next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>,
    ): Promise<FsWriteIntent | undefined>
    /**
     * Single-slot decision for the next `FileSystem.editText`. Calling
     * `next()` yields an unconditional edit; the first returned guard wins.
     * @param target - the resolved target about to be edited.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/edit-intent'(
      target: FsTarget,
      actor: object | undefined,
      next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>,
    ): Promise<{ version: FsVersion } | undefined>
    /**
     * Record a successful observation. Listeners must be synchronous recorders:
     * throws fail the tool call and returned promises are not awaited.
     * @param target - the target that was read/written/edited.
     * @param version - the version the actor now holds as its observation.
     * @param actor - the observing tool-execution context; undefined records nothing useful.
     * @mode emit
     */
    'fs/observed'(target: FsTarget, version: FsVersion, actor: object | undefined): void
  }
}
