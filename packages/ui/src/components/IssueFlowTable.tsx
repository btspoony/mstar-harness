import type { IssueFlowSeries } from "../view-model/overview.ts";

/**
 * The issue-flow series as the prototype's `mini-table`.
 *
 * The overview draws this same series as a chart. The issues screen shows it as a table,
 * because that screen is for reading exact counts: five numbers per bucket, which a 132px
 * sparkline cannot state. `product.css` already carries `.mini-table` (the compass
 * milestones use it), so this adds markup, not styling.
 */
export type IssueFlowTableCopy = {
  readonly columns: {
    readonly date: string;
    readonly captured: string;
    readonly retired: string;
    readonly open: string;
    readonly origin: string;
  };
};

export function IssueFlowTable(props: {
  series: IssueFlowSeries;
  copy: IssueFlowTableCopy;
}): React.ReactElement {
  return (
    <table className="mini-table" data-ms-issue-flow-table="">
      <thead>
        <tr>
          <th scope="col">{props.copy.columns.date}</th>
          <th scope="col">{props.copy.columns.captured}</th>
          <th scope="col">{props.copy.columns.retired}</th>
          <th scope="col">{props.copy.columns.open}</th>
          <th scope="col">{props.copy.columns.origin}</th>
        </tr>
      </thead>
      <tbody>
        {props.series.points.map((point) => (
          <tr key={`${point.date}-${point.origin}`} data-ms-flow-row={point.date}>
            <td className="mono">{point.date}</td>
            <td className="mono t-num">{point.captured}</td>
            <td className="mono t-num">{point.retired}</td>
            <td className="mono t-num">{point.open}</td>
            <td className="trunc">{point.origin}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
