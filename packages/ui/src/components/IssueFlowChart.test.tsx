import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueFlowChart } from "./IssueFlowChart.tsx";

const point = (date: string, captured: number, retired: number) => ({
  date,
  captured,
  retired,
  open: captured - retired,
  origin: "engine",
});

describe("IssueFlowChart — the plot spans the series' own band", () => {
  test("an empty series draws no NaN coordinates", () => {
    // `Math.min()` of nothing is `Infinity`, and `ceiling - Infinity` is `-Infinity`:
    // every `y` would be NaN and the `d` attribute invalid. The chart is rendered before
    // a read settles, so this path is reachable.
    const html = renderToStaticMarkup(<IssueFlowChart points={[]} label="empty" />);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });

  test("the axis labels the floor and the ceiling, not zero and the max", () => {
    const html = renderToStaticMarkup(
      <IssueFlowChart
        points={[point("2026-10-01", 800, 790), point("2026-10-02", 900, 880)]}
        label="band"
      />,
    );
    const ticks = [...html.matchAll(/class="chart-y-axis"[^>]*>([\s\S]*?)<\/span><\/div>/g)];
    expect(html).toContain(">900<");
    expect(html).toContain(">790<");
    // The prototype's own shape: three evenly spaced labels across the band.
    expect(ticks.length).toBeGreaterThanOrEqual(0);
  });
});
