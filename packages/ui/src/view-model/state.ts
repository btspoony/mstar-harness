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

/** How to resolve a member whose subject may not exist at all. */
export type SubjectResolveOptions<T> = ResolveOptions<T> & {
  /**
   * Whether the subject this member belongs to resolves. `false` means "there is
   * no such subject here" — an unbound session, a project that does not exist —
   * and it is what separates `not-applicable` from `absent`.
   */
  readonly subjectResolves: boolean;
  /** The subject-level reason, used when it does not resolve. */
  readonly unresolvedReason: string;
};

/**
 * Resolve a member whose subject may be missing entirely.
 *
 * This exists so `not-applicable` has exactly ONE decision point. It is not a
 * null meaning (`NullMeaning` is `absent` / `empty`): a read that answers `null`
 * says nothing about whether the subject exists, and a caller that decided that
 * question itself would become a second authority — which is how the same screen
 * ends up calling the same state two different things.
 *
 * Precedence, and the reason for it:
 *
 *   1. `loading` — a pending read has no subject state yet, so it borrows none.
 *   2. the member's own arm — when the read itself says `not-applicable` or
 *      `unavailable`, that answer wins; the subject test cannot override a
 *      statement the store already made.
 *   3. the subject test — an un-resolved subject is `not-applicable` for a
 *      *successful* read, because "there is nothing here" and "this thing does
 *      not exist" are different facts.
 *   4. the ordinary null / emptiness rules.
 */
export function resolveSubjectMember<T>(
  member: OverviewMember<T>,
  options: SubjectResolveOptions<T>,
): Resolved<T> {
  if ((options.phase ?? "loaded") === "loading") return { kind: "loading" };
  if (member.state !== "read") return resolveMember(member, options);
  if (!options.subjectResolves) return { kind: "not-applicable", reason: options.unresolvedReason };
  return resolveMember(member, options);
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

/** How to resolve a single-record read. */
export type RecordResolveOptions = {
  /** The transport's read phase. */
  readonly phase?: ReadPhase;
  /**
   * The reason to state when the record cannot be read. A `null` record is
   * **never** "no such record" — the read boundary does not distinguish "absent"
   * from "unreadable", so claiming absence would be a guess.
   */
  readonly unreadableReason: string;
};

/**
 * Resolve a single-record read (`data: T | null` plus the projection disclosure).
 *
 * This exists because a record read has a different `null` meaning from a list:
 * a list that comes back empty is genuinely empty, while a record that comes
 * back `null` means the read could not produce it. Both the dashboard and the
 * panel treat that as `unavailable`, and the screens must not each decide it —
 * the same reason the aggregate resolver exists.
 */
export function resolveRecord<T>(
  read: { readonly data: T | null; readonly projection: { readonly generation: number | null } },
  options: RecordResolveOptions,
): Resolved<T> {
  if ((options.phase ?? "loaded") === "loading") return { kind: "loading" };
  if (read.projection.generation === null) return { kind: "unavailable", reason: options.unreadableReason };
  if (read.data === null) return { kind: "unavailable", reason: options.unreadableReason };
  return { kind: "populated", value: read.data };
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
