/**
 * A disclosure for text a reader asks for: roadmap direction, stored markdown.
 *
 * A native `<details>`, deliberately: it is keyboard-operable, findable and
 * announced without a line of JavaScript, and the product does not need a
 * richer animation than the platform gives it. The summary carries the whole
 * affordance; the body is the caller's node.
 *
 * The class is `.disc` — the prototype's own name for this disclosure. It used to
 * wear `.chart-note`, which is the trend chart's label row and carries `display: flex`;
 * borrowing it made every disclosure's body a flex row.
 */
import type { ReactNode } from "react";

export type CollapsibleProps = {
  /** Localized summary text. */
  summary: string;
  children: ReactNode;
  /** Open on first paint (for a block the reader almost always wants). */
  defaultOpen?: boolean;
};

export function Collapsible(props: CollapsibleProps) {
  return (
    <details className="disc" open={props.defaultOpen}>
      <summary>{props.summary}</summary>
      <div>{props.children}</div>
    </details>
  );
}
