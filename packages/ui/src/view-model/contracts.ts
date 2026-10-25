/**
 * The aggregate read shapes this package transforms.
 *
 * WHY these live here and not in an import: `OverviewDTO`, its `OverviewMember<T>`,
 * `ResidualCounts`, `IterationDTO.gateStep` and `IterationListDTO.attribution`
 * are owned by the engine read-model track (`{ITERATION_DIR}/
 * iter-20261025-frontend-unification/specs/read-model-contracts.md` §1–§4) and are
 * not exported by `@mstar-harness/engine` yet on this branch.
 *
 * They are written here as the spec writes them — same member names, same arms,
 * same literals — so the engine's eventual declarations are **structurally
 * identical** and swapping this file for `import type { … } from
 * "@mstar-harness/engine"` is a type-only edit with no call-site change. Nothing
 * in this package re-shapes them: the transforms below take these inputs and
 * produce the view models the screens render.
 *
 * Every other DTO is imported from the engine directly (see the per-module
 * imports); only the aggregate wrappers the engine has not published yet are
 * mirrored here.
 */

/** One member of an aggregate read (read-model-contracts §1). */
export type OverviewMember<T> =
  | { readonly state: "read"; readonly data: T }
  | { readonly state: "not-applicable"; readonly reason: string }
  | { readonly state: "unavailable"; readonly reason: string };

/**
 * The five closed severity literals, always all present (contract §2, D20); the
 * `open` total is their sum and is never a second query.
 */
export type ResidualCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  nit: number;
};

/** The open-residual member of the aggregate read (contract §2). */
export type ResidualSummary = { open: number; bySeverity: ResidualCounts };

/** The furthest iteration step the store proves; step 5 has no source (§3). */
export type IterationGateStep = 1 | 2 | 3 | 4;

/** Whether this store attributes any iteration to a project (§4). */
export type IterationAttribution = "present" | "absent";

/**
 * The aggregated read (contract §2). `issueFlow` is deliberately **carried and
 * never transformed** — IA §8.1 removes the trend from the UI, and this package
 * therefore exposes no view model for it (the DTO member stays the engine's).
 */
export type OverviewRead = {
  workflows: OverviewMember<import("@mstar-harness/engine").WorkflowListDTO>;
  residuals: OverviewMember<ResidualSummary>;
  milestones: OverviewMember<import("@mstar-harness/engine").RoadmapDTO["milestones"]>;
  latestIteration: OverviewMember<import("@mstar-harness/engine").IterationDTO | null>;
  issueFlow: OverviewMember<unknown>;
};

/**
 * The session digest the dsh host supplies (contract §6). `knowledge` is carried
 * by the transport but is **never transformed**: IA §8.1 removes the knowledge
 * rollup from `Focus`, so there is no view model for it and a screen cannot
 * render it by accident.
 */
export type SessionDigest = {
  readonly enforcement: string;
  readonly knowledge: unknown;
  readonly selection: SessionBinding | null;
};

/**
 * The session's workflow binding, mirroring the dsh `WorkflowSelectionView`
 * union (`packages/dsh/src/types.ts`). It is re-declared rather than imported
 * because this package may not depend on a host plugin — the host adapter
 * narrows its own type into this shape when it supplies the digest.
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
