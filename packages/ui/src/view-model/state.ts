/**
 * The single absence-state resolver (IA `information-architecture.md` §5).
 *
 * Five arms, and every screen renders one of them for every member it shows —
 * screens never decide an absence themselves. The distinctions the arms protect:
 *
 *  - `not-applicable` — the subject does not resolve (no project, no binding).
 *  - `absent`          — the subject resolves but declares no such concept.
 *  - `empty`           — the read succeeded and the collection is genuinely empty.
 *  - `unavailable`     — the read failed; the reason is the store's own message.
 *  - `loading`         — a transport phase, NOT a subject state, and it borrows
 *                        none of the four copies.
 *
 * `populated` is the default case, not a fifth absence arm.
 */
import type { OverviewMember } from "./contracts.ts";

/** The arm a screen renders. */
export type Resolved<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "populated"; readonly value: T }
  | { readonly kind: "empty" }
  | { readonly kind: "absent" }
  | { readonly kind: "not-applicable"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** A read phase the transport reports; never one of the four subject states. */
export type ReadPhase = "loading" | "loaded";

/**
 * What `null` means for this subject when the read succeeded with no value.
 *
 * The read model says `read` + `data: null` is "the authority answered and it
 * has nothing here", which is `absent` when the subject *declares no such
 * concept* (an iteration with no compass row) and `empty` when the subject owns
 * a collection that happens to hold nothing. The caller states which, because
 * only the screen knows which concept it asked about.
 */
export type NullMeaning = "absent" | "empty";

/** How to resolve one member. */
export type ResolveOptions<T> = {
  /** The transport's read phase. `loading` wins over everything. */
  readonly phase?: ReadPhase;
  /** What a successful read carrying no value means for this subject. */
  readonly whenNull: NullMeaning;
  /**
   * Optional emptiness test for a non-null value: a list is `empty` when it has
   * no rows even though the read succeeded. Omit for a value that cannot be
   * empty (a single record).
   */
  readonly isEmpty?: (value: T) => boolean;
};

/**
 * Resolve one aggregate member. This is the only place the four absence states
 * are decided.
 *
 * `loading` is checked first and returns before the member is inspected: a
 * pending read has no subject state yet, and reporting `empty` while loading
 * would be a claim the transport has not made.
 */
export function resolveMember<T>(member: OverviewMember<T>, options: ResolveOptions<T>): Resolved<T> {
  if ((options.phase ?? "loaded") === "loading") return { kind: "loading" };

  switch (member.state) {
    case "not-applicable":
      return { kind: "not-applicable", reason: member.reason };
    case "unavailable":
      return { kind: "unavailable", reason: member.reason };
    case "read": {
      const value = member.data;
      // `read` with a null payload: the authority answered and holds nothing.
      if (value === null) return { kind: options.whenNull };
      if (options.isEmpty !== undefined && options.isEmpty(value)) return { kind: "empty" };
      return { kind: "populated", value };
    }
  }
}

/**
 * Resolve a plain envelope read (the `ReadEnvelope` views: issues, workflows,
 * iterations, projects, roadmap) into the same arms.
 *
 * This exists so a screen does not need two resolvers: a view that answers with
 * a DTO directly is expressed as a `read` member with its projection-derived
 * state, and everything downstream is identical. `projectionUnavailable`
 * promotes the whole read to `unavailable` — a projected view with no valid
 * generation has no rows to show, and reporting `empty` would claim the store
 * is idle (`workflowListState`'s rule, preserved).
 */
export function resolveRead<T>(
  read: { readonly data: T; readonly projection: { readonly generation: number | null } },
  options: ResolveOptions<T>,
): Resolved<T> {
  if ((options.phase ?? "loaded") === "loading") return { kind: "loading" };
  if (read.projection.generation === null) {
    return { kind: "unavailable", reason: "the execution projection has no valid generation" };
  }
  const value = read.data;
  if (value === null) return { kind: options.whenNull };
  if (options.isEmpty !== undefined && options.isEmpty(value)) return { kind: "empty" };
  return { kind: "populated", value };
}

/**
 * The copy key family one absent arm maps to. The four states own four families
 * (IA §5 rule 5) and `populated` owns none — a generic "no data" key is the exact
 * defect the families prevent, so there is no fallback arm here.
 */
export function absenceCopyFamily(arm: Resolved<unknown>["kind"]): string | null {
  switch (arm) {
    case "not-applicable":
      return "state.not-applicable";
    case "absent":
      return "state.absent";
    case "empty":
      return "state.empty";
    case "unavailable":
      return "state.unavailable";
    default:
      return null;
  }
}

/** Whether an arm is one of the four absence states (as opposed to data/loading). */
export function isAbsence(arm: Resolved<unknown>["kind"]): boolean {
  return absenceCopyFamily(arm) !== null;
}
