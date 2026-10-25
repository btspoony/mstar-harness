/**
 * The one status renderer (DESIGN.md § Status treatments).
 *
 * A status is **three** channels, and colour is the least important of them:
 * the literal enum text, a weight, and a 6px dot whose tone is a secondary cue.
 * `label` is therefore a REQUIRED prop — a dot-only usage does not type-check,
 * which is what makes "status never depends on colour" a property of the API
 * rather than a convention someone has to remember.
 *
 * The label is not translated: enum values are identifier text (`open`,
 * `InProgress`, `running`, …) and the dictionary never touches them.
 */
import type { Tone } from "../view-model/status.ts";
import css from "./StatusDot.module.css";

export type StatusDotProps = {
  /** The literal enum value. Required, and rendered verbatim. */
  label: string;
  tone: Tone;
  /** `critical` and `high` carry the emphasis weight; everything else does not. */
  emphasis?: boolean;
  /** Monospace variant, for rows whose status sits in an aligned column. */
  mono?: boolean;
};

export function StatusDot(props: StatusDotProps) {
  return (
    <span
      className={css.status}
      data-ms-tone={props.tone}
      data-ms-emphasis={props.emphasis === true ? "true" : undefined}
    >
      <span className={css.dot} data-ms-tone={props.tone} aria-hidden="true" />
      <span className={props.mono === true ? css.labelMono : css.label}>{props.label}</span>
    </span>
  );
}
