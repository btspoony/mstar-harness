/**
 * A measured fraction, never a series.
 *
 * The issue-flow trend was removed with the surface it existed for (compass
 * D30), so there is no sparkline primitive: what survives is a bar for
 * `done/total` on a milestone, a plan or a plan board column.
 *
 * The bar is decoration on top of the text: `aria-valuenow`/`aria-valuemax`
 * carry the same numbers for a screen reader, and the caller renders the
 * `3/6` label beside it (the product never shows a bar alone).
 */
import css from "./ProgressBar.module.css";

export type ProgressBarProps = {
  done: number;
  total: number;
  /** `success` once the fraction is complete; `accent` while it is moving. */
  tone?: "accent" | "success";
  label?: string;
};

/** The clamped percentage a bar paints, so an out-of-range input cannot overflow. */
export function progressPercent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  const ratio = (done / total) * 100;
  return Math.min(100, Math.max(0, Math.round(ratio)));
}

export function ProgressBar(props: ProgressBarProps) {
  const percent = progressPercent(props.done, props.total);
  const complete = percent === 100 && props.total > 0;
  return (
    <span
      className="bar"
      role="progressbar"
      aria-valuenow={props.done}
      aria-valuemin={0}
      aria-valuemax={props.total}
      aria-label={props.label}
      data-ms-progress-tone={complete ? "success" : (props.tone ?? "accent")}
    >
      <span className="bar-fill" style={{ inlineSize: `${percent}%` }} />
    </span>
  );
}
