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
 * moves into the meta line.
 */
import type { ReactNode } from "react";

import css from "./DataTable.module.css";

export type DataTableColumn<T> = {
  /** Stable key, used for the column hook and the React key. */
  key: string;
  /** Header text. Localized by the caller (Task 5 owns strings). */
  header: string;
  render: (row: T) => ReactNode;
  /** Hidden below the container floor; its fact must appear in `meta`. */
  secondary?: boolean;
  /** Right-aligns the cell: counts, fractions, timestamps. */
  align?: "start" | "end";
};

export type DataTableProps<T> = {
  /** Localized table caption, also the accessible name. */
  caption: string;
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /**
   * The second line of a collapsed row: the facts the hidden columns carried.
   * Required in spirit whenever a column is `secondary` — the caller composes it
   * from the same row data, so there is still one source per fact.
   */
  meta?: (row: T) => ReactNode;
  /** Called on click/Enter/Space on a row; the caller owns navigation. */
  onRowActivate?: (row: T) => void;
  /** Rendered instead of a body when there are no rows (an absence arm). */
  emptyBody?: ReactNode;
};

export function DataTable<T>(props: DataTableProps<T>) {
  const interactive = props.onRowActivate !== undefined;
  return (
    <table className={css.table} aria-label={props.caption}>
      {/* The colgroup carries widths only: the collapse hides cells, and a
          colgroup entry is not a cell. */}
      <colgroup>
        {props.columns.map((column) => (
          <col key={column.key} data-ms-col-key={column.key} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {props.columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              data-ms-col={column.secondary === true ? "secondary" : "primary"}
              data-ms-align={column.align ?? "start"}
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
              <tr
                key={key}
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
                {props.columns.map((column, index) => (
                  <td
                    key={column.key}
                    data-ms-col={column.secondary === true ? "secondary" : "primary"}
                    data-ms-align={column.align ?? "start"}
                  >
                    {column.render(row)}
                    {index === 0 && props.meta !== undefined ? (
                      <span className={css.rowMeta} data-ms-row-meta="">
                        {props.meta(row)}
                      </span>
                    ) : null}
                  </td>
                ))}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
