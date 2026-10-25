/**
 * The trail back out of a detail view: `Projects / engine`.
 *
 * A detail that cannot say where it came from traps the reader, and the dsh pane
 * has no address bar to fall back on. The last crumb is the current record and is
 * not a link; everything before it is.
 */
import type { ReactNode } from "react";

import css from "./Breadcrumb.module.css";

export type Crumb = {
  /** Stable id for React keys; the caller's route id. */
  id: string;
  /** Localized label. */
  label: string;
};

export type BreadcrumbProps = {
  trail: readonly Crumb[];
  onSelect: (id: string) => void;
  /** Accessible name for the trail. */
  label: string;
  /** The current record's own label, rendered last and not as a link. */
  current: ReactNode;
};

export function Breadcrumb(props: BreadcrumbProps) {
  return (
    <nav className={css.trail} aria-label={props.label}>
      {props.trail.map((crumb) => (
        <span key={crumb.id} className={css.item}>
          <button type="button" className={css.link} onClick={() => props.onSelect(crumb.id)}>
            {crumb.label}
          </button>
          <span className={css.separator} aria-hidden="true">
            /
          </span>
        </span>
      ))}
      <span className={css.current} aria-current="page">
        {props.current}
      </span>
    </nav>
  );
}
