/**
 * The four absence arms of IA §5 — ONE component, four structures.
 *
 * Not a generic "no data" box, and not four ad-hoc implementations: the four
 * states are distinguished by **copy family and structure**, and each carries
 * its own label word in text so the states stay distinguishable in greyscale and
 * under forced colors (IA §5 rule 2).
 *
 * | arm | means | structure |
 * | --- | --- | --- |
 * | `not-applicable` | the subject does not resolve | heading + one sentence naming the undetermined subject (`detail`) |
 * | `absent` | the concept is not declared | heading + absence line + a pointer to where it does exist |
 * | `empty` | the read succeeded, nothing there | heading + explanatory line + the point-of-entry hint |
 * | `unavailable` | the read failed | heading + the read's own reason, warning tone, panel keeps its place |
 *
 * `unavailable` does not live here in spirit — `Notice` carries a reason for a
 * member that degrades. This component renders it only when the whole subject is
 * unavailable and needs the label word and the heading with it; a member-level
 * failure uses `Notice`.
 */
import type { ReactNode } from "react";

import css from "./EmptyState.module.css";

/** The four absence arms. `populated` and `loading` are not absences. */
export type AbsenceArm = "not-applicable" | "absent" | "empty" | "unavailable";

export type EmptyStateProps = {
  arm: AbsenceArm;
  /**
   * The state's own label word, rendered as text (IA §5 rule 2). The caller
   * passes the localized word; Task 5 owns the strings.
   */
  labelWord: string;
  /** The panel heading stays even when the body is absent (IA §5 structure). */
  heading: string;
  /** The one explanatory line for this arm. */
  body: string;
  /** The read's own reason — `unavailable` only. */
  reason?: string;
  /**
   * Which subject the answer is undetermined FOR — `not-applicable` only. It is
   * not the read's failure (`reason`) and not a pointer to another screen: it is
   * the fact the read could not scope, stated so the reader knows what is
   * missing rather than only that something is.
   */
  detail?: string;
  /** Where the concept DOES exist — `absent` only. */
  pointer?: ReactNode;
  /** The operation that would create a record — `empty` only. */
  hint?: ReactNode;
};

export function EmptyState(props: EmptyStateProps) {
  return (
    <section className={css.wrap} data-ms-absence={props.arm}>
      <p className={css.head}>
        <span className={css.labelWord} data-ms-label-word="">
          {props.labelWord}
        </span>
        <span className={css.heading}>{props.heading}</span>
      </p>
      <p className={css.body}>{props.body}</p>
      {props.arm === "unavailable" ? (
        <p className={css.reason} data-ms-reason="">
          {props.reason ?? props.body}
        </p>
      ) : null}
      {props.arm === "not-applicable" && props.detail !== undefined ? (
        <p className={css.detail} data-ms-detail="">
          {props.detail}
        </p>
      ) : null}
      {props.arm === "absent" && props.pointer !== undefined ? (
        <p className={css.pointer} data-ms-pointer="">
          {props.pointer}
        </p>
      ) : null}
      {props.arm === "empty" && props.hint !== undefined ? (
        <p className={css.hint} data-ms-hint="">
          {props.hint}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Which `empty` a filtered list earns.
 *
 * An empty result under non-default filters is **not** the same fact as an empty
 * store: one says "nothing matches", the other says "nothing exists". They get
 * different copy families so a translation pass cannot flatten them (IA §5 rule
 * 5), and Task 4 picks between them with this helper instead of re-deriving it.
 */
export function listEmptyFamily(filtersActive: boolean): {
  arm: Extract<AbsenceArm, "empty">;
  family: "state.empty.filtered" | "state.empty.store";
} {
  return { arm: "empty", family: filtersActive ? "state.empty.filtered" : "state.empty.store" };
}
