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
 *
 * Both elements carry `data-ms-tone`: the wrapper so a surface can key on the tone
 * without knowing the hashed class, and the dot so the tone's fill can find it. That
 * shared attribute is why every PAINTING rule must qualify itself with `.dot` (or the
 * dot's own `data-ms-dot` in the plain-CSS sheet) — a bare `[data-ms-tone="…"]`
 * matches the wrapper too and fills the whole label instead of the 6px box.
 */
import type { Tone } from "../view-model/status.ts";

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
      className={`status tone-${props.tone}${props.emphasis === true ? " is-strong" : ""}`}
      data-ms-tone={props.tone}
      data-ms-emphasis={props.emphasis === true ? "true" : undefined}
    >
      <span className="dot" data-ms-tone={props.tone} data-ms-dot="" aria-hidden="true" />
      <span className={props.mono === true ? "label mono" : "label"}>{props.label}</span>
    </span>
  );
}
