/**
 * A fact block: a definition list in one or two columns.
 *
 * Two columns above the two-column floor, one below — the container decides, not
 * the viewport. The block is separated from its neighbours by one hairline
 * (`DESIGN.md` § Spacing): no nested cards.
 */
import type { ReactNode } from "react";

import css from "./FieldGroup.module.css";

export type FieldGroupProps = {
  /** Localized group title. */
  title: string;
  children: ReactNode;
  /** Field columns above the floor; 1 for a block whose values are long. */
  columns?: 1 | 2;
};

export function FieldGroup(props: FieldGroupProps) {
  return (
    <section className="fields">
      <h3 className="muted">{props.title}</h3>
      <dl className="fields" data-ms-columns={props.columns ?? 2}>
        {props.children}
      </dl>
    </section>
  );
}
