/**
 * The issue-flow chart: two cumulative step lines over the dated buckets.
 *
 * A viewBox in a fixed 100 × 40 coordinate system with `preserveAspectRatio="none"`,
 * so the SVG needs no measurement: it fills its box at any width, server-rendered.
 * The prototype measures `clientWidth` and redraws in a ResizeObserver; that is
 * only necessary because it draws text inside the SVG, which this one does not.
 *
 * **Greyscale-safe by construction.** Captured is a solid line, retired is dashed,
 * and the legend spells both out. Hue is never the only difference.
 *
 * The numbers the lines encode exist as text beside the chart (the legend's two open
 * counts, the gap note, the dated-history table), so the figure is `role="img"` with its
 * date range as the label — an assistive reader gets the same facts without it. The
 * cumulative totals are deliberately not printed anywhere: the table's last row is
 * where they are stated.
 */
import type { IssueFlowPoint } from "../view-model/overview.ts";

/** The plot box: wide, short, and deliberately not to scale with the pixels. */
const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 40;
/** Vertical breathing room so the lines are not clipped by the top gridline. */
const PAD = 2;

export type IssueFlowChartProps = {
  points: readonly IssueFlowPoint[];
  /** The accessible name: the series and its date range. */
  label: string;
};

/** A cumulative step path: hold each value, then rise to the next. */
function stepPath(values: readonly number[], max: number): string {
  const n = values.length;
  const plotH = VIEW_HEIGHT - PAD * 2;
  const x = (index: number): number => (n <= 1 ? 0 : (index / (n - 1)) * VIEW_WIDTH);
  const y = (value: number): number => PAD + plotH - (value / max) * plotH;
  let path = `M${x(0).toFixed(2)},${y(values[0] ?? 0).toFixed(2)}`;
  for (let index = 1; index < n; index += 1) {
    path += `H${x(index).toFixed(2)}V${y(values[index] ?? 0).toFixed(2)}`;
  }
  return path;
}

export function IssueFlowChart(props: IssueFlowChartProps) {
  const points = props.points;
  // A flat all-zero series still needs a scale: 1 keeps the baseline at the bottom
  // instead of dividing by zero.
  const max = Math.max(
    1,
    ...points.map((point) => Math.max(point.captured, point.retired)),
  );
  const baseline = VIEW_HEIGHT - PAD;
  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
      data-ms-flow-chart=""
    >
      <title>{props.label}</title>
      <line className="grid" x1={0} x2={VIEW_WIDTH} y1={PAD} y2={PAD} />
      <line className="grid" x1={0} x2={VIEW_WIDTH} y1={baseline} y2={baseline} />
      <path
        className="line-captured"
        d={stepPath(
          points.map((point) => point.captured),
          max,
        )}
      />
      <path
        className="line-retired"
        d={stepPath(
          points.map((point) => point.retired),
          max,
        )}
      />
    </svg>
  );
}
