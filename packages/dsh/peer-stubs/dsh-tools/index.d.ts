/**
 * Type-only shim for the `@deepseek-ai/dsh-tools` seam consumed by `@mstar-harness/dsh`.
 *
 * The real package is private and ships from the composed dsh app at runtime; its
 * published types are not built in the local dsh-private checkout. This declaration
 * mirrors exactly the consumed surface of the seam — `PreToolDecision`, the pending
 * `ToolExecution` pipeline view, and the `tools/pre-execute` waterfall event — pinned
 * to dsh-private commit 9451be2 (2026-08-07 snapshot). Keep in sync when the dsh-private
 * baseline moves. (`Branded` is mirrored locally so the stub stays standalone, same as
 * the dsh-fs stub.)
 */

/** Mirror of `@deepseek-ai/dsh-brand` `Branded<T>` (kept local so the stub stays standalone). */
export type Branded<B extends string> = string & { readonly __brand: B }

/** Call identity of one pending tool call (`@deepseek-ai/dsh-session` `CallId`). */
export type CallId = Branded<'CallId'>

/**
 * Pre-dispatch decision for `tools/pre-execute`. `allow` runs the call; `deny`
 * materializes an error and blocks it; `ask` defers to the approval channel
 * (missing approval support turns `ask` into denial).
 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/**
 * Caller-supplied description of one tool call (`ToolRegistry.execute` adds the
 * registry-owned token to form a pipeline `ToolExecution`).
 */
export interface ToolExecutionInput {
  readonly callId: CallId
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: unknown
  /** Opaque token of the enclosing transport execution, when one exists. */
  readonly parent?: symbol
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}

/** One pending tool call inside the registry pipeline, as seen by `tools/pre-execute`. */
export interface ToolExecution extends ToolExecutionInput {
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: symbol
}

declare module 'cordis' {
  interface Events {
    /**
     * Allow, deny, or ask before dispatch. `next()` delegates to allow; a
     * listener that returns `{ kind: 'deny'; reason }` without calling `next()`
     * owns the decision and blocks the call. Async gates must observe
     * `exec.signal`; the registry rechecks cancellation after they settle but
     * never abandons their promise.
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @param next - the remaining chain; its value is the delegated decision.
     * @mode waterfall
     */
    'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
  }
}
