/**
 * A reason, in place — never a page.
 *
 * `Notice` is how a degraded member explains itself (IA §5 `unavailable`): the
 * panel keeps its place and its neighbours, and this line carries the read's own
 * message verbatim. It is distinct from `EmptyState` on purpose — a failed read
 * is not an absence, and the two must never share a component.
 */
import type { ReactNode } from "react";

import css from "./Notice.module.css";

export type NoticeProps = {
  /** The reason, verbatim from the store or the transport. */
  reason: string;
  /** A caller-supplied lead (for example "Could not read the roadmap"). */
  lead?: string;
  tone?: "warning" | "danger";
  children?: ReactNode;
};

export function Notice(props: NoticeProps) {
  return (
    <p className={css.notice} data-ms-notice-tone={props.tone ?? "warning"} role="status">
      <span className={css.mark} aria-hidden="true" />
      <span className={css.body}>
        {props.lead === undefined ? null : <span className={css.lead}>{props.lead}</span>}
        <span className={css.reason} data-ms-reason="">
          {props.reason}
        </span>
        {props.children}
      </span>
    </p>
  );
}
