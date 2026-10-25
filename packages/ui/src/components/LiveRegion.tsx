/**
 * The one place the product speaks to assistive technology.
 *
 * `polite`, because nothing here interrupts: a filtered result count changing is
 * information, not an alarm. The region is always mounted and its content swaps,
 * which is what makes the announcement reliable.
 */
import css from "./LiveRegion.module.css";

export type LiveRegionProps = {
  /** The sentence to announce. Empty string clears the region. */
  message: string;
};

export function LiveRegion(props: LiveRegionProps) {
  return (
    <p className={css.region} role="status" aria-live="polite" aria-atomic="true">
      {props.message}
    </p>
  );
}
