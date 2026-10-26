/**
 * A disclosure for text a reader asks for: roadmap direction, stored markdown.
 *
 * A native `<details>`, deliberately: it is keyboard-operable, findable and
 * announced without a line of JavaScript, and the product does not need a
 * richer animation than the platform gives it. The summary carries the whole
 * affordance; the body is the caller's node.
 */
import type { ReactNode } from "react";

import css from "./Collapsible.module.css";

export type CollapsibleProps = {
  /** Localized summary text. */
  summary: string;
  children: ReactNode;
  /** Open on first paint (for a block the reader almost always wants). */
  defaultOpen?: boolean;
};

export function Collapsible(props: CollapsibleProps) {
  return (
    <details className="chart-note" open={props.defaultOpen}>
      <summary className="chart-note">{props.summary}</summary>
      <div className="chart-note">{props.children}</div>
    </details>
  );
}
