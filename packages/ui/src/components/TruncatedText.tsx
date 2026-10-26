/**
 * The single truncation affordance (compass D24).
 *
 * A cell that clips its value must still be readable, and hover is not enough:
 * a keyboard user never sees a `title`. So the affordance is three things at
 * once —
 *
 *  1. the element holds the FULL text as its content (the CSS clips it, the DOM
 *     does not), so selection, screen readers and find-in-page all work;
 *  2. it is focusable (`tabIndex={0}`), and on `:focus-visible` the full text
 *     appears from `attr(data-ms-full)` — the same string, kept in one place;
 *  3. `title` exists for hover, as a convenience and not as the only path.
 *
 * Both hosts use this one component; a second truncation affordance is a defect
 * (plan Technical decisions §2). It is applied only where a cell truncates by an
 * explicit max-inline-size or line clamp — not to text that happens to be short.
 */

export type TruncatedTextProps = {
  /** The whole value. Rendered as content, as `data-ms-full`, and as `title`. */
  text: string;
  /** Rendered as a block, for a cell whose whole content truncates. */
  block?: boolean;
};

export function TruncatedText(props: TruncatedTextProps) {
  return (
    <span
      className={props.block === true ? "trunc" : "trunc"}
      data-ms-full={props.text}
      title={props.text}
      tabIndex={0}
    >
      {props.text}
    </span>
  );
}
