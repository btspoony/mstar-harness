/**
 * The compact table, and the container-width collapse it owns.
 *
 * Above the declared floor every column shows. Below it (`reflow-table`, 620px of
 * **container**, never viewport) the secondary columns drop and the primary cell
 * grows a second line: the primary content stays as content, and the facts the
 * hidden columns carried arrive as `meta`. That keeps one row = one record, at
 * two lines instead of five columns squeezed to nothing.
 *
 * The collapse is CSS (`@container`), not a resize listener: the same markup
 * renders correctly in the dashboard at 1440px and inside a 400px dsh pane
 * without a second implementation or a re-render on drag.
 *
 * Column order is the caller's; `secondary: true` marks what the narrow form
 * moves into the meta line, and `width` is the column's share in px — the ONE
 * flexible column (the title) declares none and absorbs the slack.
 *
 * The widths are not decoration. `table-layout: fixed` splits an undeclared
 * column set evenly, which at 720px of pane gives eight columns ~90px each: the
 * id shows `I-…`, the title `d…`, and a status word is cut mid-syllable. The
 * collapse below the floor then re-declared two of them 20/80 BY POSITION, which
 * put the third primary column at zero width — the `● runningplan…` the owner
 * reported. Declared widths plus one flexible column is the same answer in both
 * bands and needs no per-screen positional rule.
 */
import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";

import css from "./DataTable.module.css";

export type DataTableColumn<T> = {
  /** Stable key, used for the column hook and the React key. */
  key: string;
  /** Header text. Localized by the caller (Task 5 owns strings). */
  header: string;
  render: (row: T) => ReactNode;
  /**
   * Below the container floor this column yields. In `list` mode its fact must
   * reappear in `meta`; in `detail` mode it is simply dropped, because a detail
   * page has no second line to move it to and the reader can widen the pane.
   */
  secondary?: boolean;
  /**
   * A column the wide presentation carries and the pane's width does not. Below
   * 900px of container it is hidden outright — no second line restates it — because
   * the prototype's sidebar shows seven columns, not eight, at this width. Only use
   * it for a fact the record's own screen also carries (an issue's milestone is on
   * the issue), never for the only place a fact appears.
   */
  wide?: boolean;
  /** Right-aligns the cell: counts, fractions, timestamps. */
  align?: "start" | "end";
  /**
   * The column's width in px, for every band. Leave it off exactly one column —
   * the flexible one (a title) — which then takes the remaining space. Below the
   * scroll floor the table scrolls instead of squeezing this column to an ellipsis.
   */
  width?: number;
};

/**
 * How the table behaves below the container floor.
 *
 * `list` — the record's identity stays on the first line and the yielded columns
 * become a second line from the same row data, so one row stays one record.
 *
 * `detail` — the table sits inside a page that already carries the record, so a
 * yielded column is dropped instead of restated; a detail table never grows a
 * meta line.
 */
export type DataTableVariant = "list" | "detail";

export type DataTableProps<T> = {
  /** Localized table caption, also the accessible name. */
  caption: string;
  /** Defaults to `list`. */
  variant?: DataTableVariant;
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /**
   * The second line of a collapsed row: the facts the hidden columns carried.
   * `list` mode only; required in spirit whenever a column is `secondary` there,
   * and ignored in `detail` mode by contract.
   */
  meta?: (row: T) => ReactNode;
  /** Called on click/Enter/Space on a row; the caller owns navigation. */
  onRowActivate?: (row: T) => void;
  /** Rendered instead of a body when there are no rows (an absence arm). */
  emptyBody?: ReactNode;
};

/**
 * The narrowest the table may become before it scrolls instead of squeezing.
 * Declared columns plus this much for the flexible one: ~13 characters at 13px,
 * which is a title's first words rather than its first letter.
 *
 * 88 rather than 96 for one measured reason: the dsh seat scrolls with
 * `overflow-y: auto`, so on a classic-scrollbar platform the vertical bar takes ~15px
 * of the 720px pane and the iterations card holds 663px, not 678px. Its declared set
 * is 568px, so a 96px floor is 664 — one pixel past the cliff, and the card would
 * scroll sideways at exactly the width the owner approved.
 */
const FLEXIBLE_FLOOR = 88;

export function DataTable<T>(props: DataTableProps<T>) {
  const interactive = props.onRowActivate !== undefined;
  const detail = props.variant === "detail";
  // The collapse hides exactly the `secondary` columns, so the second line's span is
  // the primary count — not the column count, which would re-open the hidden columns
  // in `table-layout: fixed` and squeeze the title.
  const primaryCount = props.columns.filter((column) => column.secondary !== true && column.wide !== true).length;
  // The floor is the declared widths plus the flexible column's measure. It is a
  // custom property, not `min-inline-size`, because the collapsed band below the
  // floor has to switch it off and an inline style cannot be overridden.
  // Wide-only columns are not part of the floor: below 900px they are not in the
  // table at all, and counting them would make the floor force a scrollbar at a
  // width where the pane's own seven columns fit.
  const declared = props.columns.reduce(
    (sum, column) => sum + (column.wide === true ? 0 : column.width ?? 0),
    0,
  );
  const floor = declared === 0 ? 0 : declared + FLEXIBLE_FLOOR;
  return (
    /* The scroller: the table keeps its floor and the card body scrolls, so no
       column becomes unreachable when the pane is narrower than the floor. */
    <div className={css.scroller} data-ms-table-scroller="">
    <table
      className={css.table}
      aria-label={props.caption}
      data-ms-table={detail ? "detail" : "list"}
      style={floor === 0 ? undefined : ({ "--ms-table-floor": `${floor}px` } as CSSProperties)}
    >
      <thead>
        <tr>
          {props.columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              data-ms-col={column.wide === true ? "wide" : column.secondary === true ? "secondary" : "primary"}
              data-ms-col-key={column.key}
              data-ms-align={column.align ?? "start"}
              style={column.width === undefined ? undefined : { inlineSize: `${column.width}px` }}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 && props.emptyBody !== undefined ? (
          <tr>
            <td className={css.emptyCell} colSpan={props.columns.length}>
              {props.emptyBody}
            </td>
          </tr>
        ) : (
          props.rows.map((row) => {
            const key = props.rowKey(row);
            return (
              <Fragment key={key}>
              <tr
                data-ms-row-main=""
                data-ms-row-key={key}
                className={interactive ? css.rowInteractive : css.row}
                tabIndex={interactive ? 0 : undefined}
                onClick={interactive ? () => props.onRowActivate?.(row) : undefined}
                onKeyDown={
                  interactive
                    ? (event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        props.onRowActivate?.(row);
                      }
                    : undefined
                }
              >
                {props.columns.map((column) => (
                  <td
                    key={column.key}
                    data-ms-col={column.wide === true ? "wide" : column.secondary === true ? "secondary" : "primary"}
                    data-ms-align={column.align ?? "start"}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
              {/* The collapsed row's second line is a row of its own, spanning every
                  column. In the first cell it only ever had that cell's width — 68px
                  of an 80px id column, which truncated `critical · open` to
                  `critical · op…`. A spanning row gives the facts the row's width and
                  leaves the column policy (and the header) untouched. */}
              {!detail && props.meta !== undefined ? (
                <tr
                  className={interactive ? `${css.metaRow} ${css.metaRowInteractive}` : css.metaRow}
                  data-ms-row-meta-row=""
                  data-ms-row-meta-activate={interactive ? "" : undefined}
                  // The facts ARE the record: at the width the product lives in, this row
                  // is roughly half of the record's painted area, so a tap on it navigates
                  // like a tap on the row above. Keyboard stays one stop per record — the
                  // main row keeps the tab stop and the Enter/Space handler.
                  onClick={interactive ? () => props.onRowActivate?.(row) : undefined}
                >
                  {/* The collapse hides exactly the `secondary` columns, so the
                      spanning row is the primary count: a colspan over all columns
                      would force `table-layout: fixed` to re-open the hidden ones
                      and squeeze the title to 29px. */}
                  <td className={css.metaCell} colSpan={primaryCount}>
                    <span className={css.rowMeta} data-ms-row-meta="">
                      {props.meta(row)}
                    </span>
                  </td>
                </tr>
              ) : null}
              </Fragment>
            );
          })
        )}
      </tbody>
    </table>
    </div>
  );
}
