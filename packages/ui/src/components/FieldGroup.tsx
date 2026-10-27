/**
 * A fact block: a definition list in one or two columns.
 *
 * Two columns above the two-column floor, one below — the container decides, not
 * the viewport. The block is separated from its neighbours by one hairline
 * (`DESIGN.md` § Spacing): no nested cards.
 */
import type { ReactNode } from "react";


export type FieldGroupProps = {
  /** Localized group title. */
  title: string;
  children: ReactNode;
  /** Field columns above the floor; 1 for a block whose values are long. */
  columns?: 1 | 2;
};

export function FieldGroup(props: FieldGroupProps) {
  return (
    // `.sec` is the prototype's fact block: a hairline, a title, then the fields. It is
    // deliberately NOT `.fields` — that class is a two-column grid, and putting it on the
    // section made the title take the first column and pushed every field into the second.
    <section className="sec">
      {/* `h2`, as the prototype's own fact blocks are. The heading level is invisible with
          `.sec-title`'s styling, but it is what a screen reader announces. */}
      <h2 className="sec-title">{props.title}</h2>
      <dl className="fields" data-ms-columns={props.columns ?? 2}>
        {props.children}
      </dl>
    </section>
  );
}
