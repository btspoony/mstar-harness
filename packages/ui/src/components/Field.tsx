/**
 * One label/value pair of a fact block.
 *
 * A definition-list pair, not a card: the detail pages group facts with
 * hairlines and a label column, and the value is the only thing a reader reads.
 * The value slot accepts any node (a `StatusDot`, a `TruncatedText`, plain text).
 */
import type { ReactNode } from "react";

import css from "./Field.module.css";

export type FieldProps = {
  /** Localized field label (Task 5 owns the string). */
  label: string;
  children: ReactNode;
  /** Monospace value — ids, paths, timestamps, enum values. */
  mono?: boolean;
};

export function Field(props: FieldProps) {
  return (
    <div className="field">
      <dt className="field-label">{props.label}</dt>
      <dd className={props.mono === true ? css.valueMono : css.value}>{props.children}</dd>
    </div>
  );
}
