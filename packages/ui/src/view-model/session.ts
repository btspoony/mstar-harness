/**
 * The session facts the dsh host supplies.
 *
 * These are **not** the engine's contract: the engine owns the dashboard reads,
 * while a session digest is what the panel's transport adds on top (the
 * enforcement flag, and this session's workflow binding). They live in this
 * package because the `Focus` view model consumes them, and they are declared
 * structurally rather than imported so the shared layer never depends on a host
 * plugin — the host's adapter narrows its own type into this shape.
 *
 * The digest also carries a `knowledge` rollup that IA §8.1 removed from the UI.
 * It is deliberately **not** modelled here: a member this package cannot name is a
 * member no screen can render.
 */

/**
 * The session's workflow binding, mirroring the dsh `WorkflowSelectionView` union
 * (`packages/dsh/src/types.ts`). A host adapter narrows its own type into this.
 */
export type SessionBinding =
  | { readonly kind: "active"; readonly workflowId: string; readonly dir: string }
  | { readonly kind: "terminal"; readonly workflowId: string; readonly dir: string }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly activeWorkflowIds?: readonly string[];
    };

/** The session facts `Focus` reads. */
export type SessionDigest = {
  /** The harness enforcement flag (IA §7). */
  readonly enforcement: string;
  /** This session's binding, or `null` when nothing is bound. */
  readonly selection: SessionBinding | null;
};
