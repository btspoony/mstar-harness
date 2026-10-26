/**
 * One label/value pair of a fact block.
 *
 * A definition-list pair, not a card: the detail pages group facts with
 * hairlines and a label column, and the value is the only thing a reader reads.
 * The value slot accepts any node (a `StatusDot`, a `TruncatedText`, plain text).
 */
import type { ReactNode } from "react";


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
      <dt>{props.label}</dt>
      <dd className={props.mono === true ? "mono" : undefined}>{props.children}</dd>
    </div>
  );
}
