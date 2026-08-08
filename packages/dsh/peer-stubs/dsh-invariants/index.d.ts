/**
 * Type-only shim for the `@deepseek-ai/dsh-invariants` seam consumed by `@mstar-harness/dsh`.
 *
 * The real package is private and ships from the composed dsh app at runtime; its published
 * types (`lib/types/*.d.ts`) are not built in the local dsh-private checkout. This declaration
 * mirrors exactly the consumed surface of the seam — `InvariantFailure`, `InvariantInstaller`,
 * and the `Context.invariants` service slot (module augmentation) — pinned to dsh-private commit
 * 9451be2 (2026-08-07 snapshot). Keep in sync when the dsh-private baseline moves.
 */
import type { Context, Inject } from 'cordis'

/** Throw a package-attributed invariant failure. */
export type InvariantFailure = (message: string) => never

/** Install one package's checks into the registration's child context. */
export interface InvariantInstaller {
  /**
   * Install the package contribution.
   * @param ctx - child context owned by this invariant registration.
   * @param fail - reporter bound to the registering package name.
   * @returns nothing, or a promise settling after asynchronous checks finish.
   */
  (ctx: Context, fail: InvariantFailure): void | Promise<void>
  /** Services the child installer fiber may access. */
  readonly inject?: Inject
}

declare module 'cordis' {
  interface Context {
    /** Package-owned invariant registry provided by the composed dsh app. */
    invariants: {
      /** Reserve package ownership; returns the registration's disposer. */
      register(packageName: string, installer: InvariantInstaller): () => void
    }
  }
}
