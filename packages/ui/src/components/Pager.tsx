/**
 * One page of a list, with its bounds stated.
 *
 * A pager that offers "next" past the end of the data is a lie the reader pays
 * for in a round trip, so both directions are computed, not guessed: `previous`
 * exists only above offset 0, `next` only when the page is full. The label says
 * the range *and* the total, so a filtered list cannot look like the whole store.
 */
import css from "./Pager.module.css";

export type PagerProps = {
  total: number;
  offset: number;
  pageSize: number;
  /** Called with the next offset; the caller owns the URL. */
  onOffsetChange: (offset: number) => void;
  /** Localized labels; Task 5 owns the strings. */
  previousLabel: string;
  nextLabel: string;
  /** Localized `X–Y of N` builder. */
  rangeLabel: (from: number, to: number, total: number) => string;
};

/** Whether a previous page exists. */
export function hasPrevious(offset: number): boolean {
  return offset > 0;
}

/** Whether a next page exists — only when the current page is full. */
export function hasNext(offset: number, pageSize: number, total: number): boolean {
  return pageSize > 0 && offset + pageSize < total;
}

/** The 1-based `[from, to]` range this page covers. */
export function pageRange(offset: number, pageSize: number, total: number): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  const from = Math.min(offset + 1, total);
  const to = Math.min(offset + pageSize, total);
  return { from, to };
}

export function Pager(props: PagerProps) {
  const { from, to } = pageRange(props.offset, props.pageSize, props.total);
  const previous = hasPrevious(props.offset);
  const next = hasNext(props.offset, props.pageSize, props.total);
  return (
    <div className="pager">
      <span className="muted t-12" data-ms-page-range="">
        {props.rangeLabel(from, to, props.total)}
      </span>
      <button
        type="button"
        className="btn"
        disabled={!previous}
        onClick={() => props.onOffsetChange(Math.max(0, props.offset - props.pageSize))}
      >
        {props.previousLabel}
      </button>
      <button
        type="button"
        className="btn"
        disabled={!next}
        onClick={() => props.onOffsetChange(props.offset + props.pageSize)}
      >
        {props.nextLabel}
      </button>
    </div>
  );
}
