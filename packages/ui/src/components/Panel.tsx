/**
 * The card: a surface with a hairline border and the prototype's radius.
 *
 * The prototype's list screens are panels, not bare content on the canvas — one
 * card with a head (title, optional meta), a body, and an optional foot. This is
 * that card, so a screen composes a panel instead of re-deriving the same three
 * rules in its own module.
 *
 * Values are the prototype's own (`design-v1.html:215-224`): the surface, the
 * hairline border and `--ms-radius-md`; a head of `min-height: 32px` with
 * `padding: 0 12px` and its bottom rule; a body of `padding: 10px 12px` (or none,
 * for a table that draws its own cell padding); a foot of `padding: 6px 12px`
 * with its top rule.
 */
import type { ReactNode } from "react";


export type PanelProps = {
  children: ReactNode;
  /** An accessible name when no `PanelHead` inside provides one. */
  labelledBy?: string;
  className?: string;
};

export function Panel(props: PanelProps) {
  return (
    <section
      className={props.className === undefined ? "panel" : `panel ${props.className}`}
      data-ms-panel=""
      {...(props.labelledBy === undefined ? {} : { "aria-labelledby": props.labelledBy })}
    >
      {props.children}
    </section>
  );
}

export type PanelHeadProps = {
  /** The head's own id, so `Panel` can point at it. */
  id?: string;
  /**
   * The heading. Optional because the prototype's two list screens carry a head with
   * no title at all — just the filter row — and a head is the row, not the heading in it.
   */
  title?: string;
  /** Trailing facts: a count, a range, a state. */
  meta?: ReactNode;
  /**
   * The head's own content, for a head that is a row rather than a heading — the two list
   * screens put their filter row here, exactly where the prototype has `.panel-head >
   * .filters`.
   */
  children?: ReactNode;
};

export function PanelHead(props: PanelHeadProps) {
  // The head is the labelled element when it has no title: the prototype's list
  // screens carry a bare filter row, and `aria-labelledby` still needs a node.
  return (
    <div
      className="panel-head"
      data-ms-panel-head=""
      {...(props.title === undefined && props.id !== undefined ? { id: props.id } : {})}
    >
      {props.title === undefined ? null : (
        <h2 className="panel-title" id={props.id} data-ms-panel-title="">
          {props.title}
        </h2>
      )}
      {props.meta === undefined ? null : (
        <span className="panel-meta" data-ms-panel-meta="">
          {props.meta}
        </span>
      )}
      {props.children}
    </div>
  );
}

export type PanelBodyProps = {
  children: ReactNode;
  /** No padding: for a table that draws its own cell padding. */
  tight?: boolean;
};

export function PanelBody(props: PanelBodyProps) {
  return (
    <div className={props.tight === true ? "panel-body tight" : "panel-body"} data-ms-panel-body="">
      {props.children}
    </div>
  );
}

export function PanelFoot(props: { children: ReactNode }) {
  return (
    <div className="panel-foot" data-ms-panel-foot="">
      {props.children}
    </div>
  );
}
