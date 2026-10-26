/**
 * A compact list row for the surfaces that are NOT a table: the plan board, the
 * project list, the milestone rows.
 *
 * Slots rather than a schema, because the four callers lead with different
 * things; what they share is the rhythm — 26–32px, a hairline between rows, and
 * the trailing value pushed to the end. A row never grows to fit a badge.
 */
import type { ReactNode } from "react";


export type RowProps = {
  /** The dot or glyph that leads the row (usually a `StatusDot`'s dot). */
  leading?: ReactNode;
  /** The row's own identity: an id, a title, a name. */
  primary: ReactNode;
  /** Secondary facts, on the same line where they fit. */
  meta?: ReactNode;
  /** Right-aligned value: a fraction, a date, a count. */
  trailing?: ReactNode;
  /** Called on click/Enter/Space; the caller owns navigation. */
  onActivate?: () => void;
  /** Extra height for a two-line row. */
  tall?: boolean;
};

export function Row(props: RowProps) {
  const interactive = props.onActivate !== undefined;
  return (
    <div
      className={props.tall === true ? "row row-tall" : "row"}
      data-ms-row=""
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            onClick: props.onActivate,
            onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              props.onActivate?.();
            },
          }
        : {})}
    >
      {props.leading === undefined ? null : <span className="row-leading">{props.leading}</span>}
      <span className="row-primary">{props.primary}</span>
      {props.meta === undefined ? null : <span className="row-meta-inline">{props.meta}</span>}
      {props.trailing === undefined ? null : <span className="row-trailing">{props.trailing}</span>}
    </div>
  );
}
