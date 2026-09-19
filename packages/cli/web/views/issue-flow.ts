/**
 * Issue-flow chart panel — the one trend surface
 * the IA allows (DESIGN.md "History and chart honesty"; compass D17). It lives
 * inside the Issues destination; it is not a fifth destination.
 *
 * Honesty rules the engine's DTO already fixes (state-projection contract §6):
 * only real recorded timestamps contribute to the dated buckets; every terminal
 * disposition counts as retired; unknown dates are counted separately, never
 * imputed; the authoritative current open count is shown next to the known-data
 * gap; pre-store buckets carry the register-history label. This module derives
 * the panel model and renders the inline SVG plus its accessible table — no
 * second data source, no invented metric (no velocity, severity drift or
 * time-in-state).
 */
import type { IssueFlow, IssueFlowBucket } from "@mstar-harness/engine";
import { html } from "htm/preact";

import type { LoadState } from "../components";
import { DetailSection, EmptyState, Notice } from "../components";

/** The panel's two honest states: nothing was ever recorded, or there is data. */
export type FlowPanelState = { kind: "empty" } | { kind: "data" };

/**
 * "Empty" means the store has recorded nothing at all: no dated bucket, no
 * unknown-date capture and no currently open issue. An open issue whose
 * capture date is unknown still earns the data panel — its count is disclosed
 * there, never silently dropped.
 */
export function flowPanelState(flow: IssueFlow): FlowPanelState {
  const last = flow.buckets[flow.buckets.length - 1];
  const captured = (last?.capturedCumulative ?? 0) + flow.unknownCaptureDates;
  if (flow.buckets.length === 0 && captured === 0 && flow.currentOpen === 0) return { kind: "empty" };
  return { kind: "data" };
}

/** The table's origin vocabulary: a pre-store bucket is labelled, not hidden. */
export function originLabel(origin: IssueFlowBucket["origin"]): string {
  return origin === "register-history" ? "Register history" : "Store";
}

/**
 * The disclosure lines the chart cannot draw: the known-data gap between the
 * end of the dated history and the authoritative current open count, the
 * incomplete-history counts, and the register-history label explanation. Empty
 * when nothing needs disclosing — the chart then speaks for itself.
 */
export function flowNotes(flow: IssueFlow): string[] {
  const notes: string[] = [];
  const last = flow.buckets[flow.buckets.length - 1];
  const datedOpen = last === undefined ? null : last.openDifference;
  if (datedOpen !== null && datedOpen !== flow.currentOpen) {
    notes.push(
      `The dated history closes at ${datedOpen} open issue${datedOpen === 1 ? "" : "s"}; the store currently ` +
        `records ${flow.currentOpen} open. The difference is issues with no recorded date — they are counted, ` +
        `not placed on the timeline.`,
    );
  }
  if (flow.unknownCaptureDates > 0 || flow.unknownClosureDates > 0) {
    const parts: string[] = [];
    if (flow.unknownCaptureDates > 0) parts.push(`${flow.unknownCaptureDates} captured issue${flow.unknownCaptureDates === 1 ? " has" : "s have"} no recorded date`);
    if (flow.unknownClosureDates > 0)
      parts.push(`${flow.unknownClosureDates} retired issue${flow.unknownClosureDates === 1 ? " has" : "s have"} no recorded closure date`);
    notes.push(
      `History is incomplete: ${parts.join(" and ")}. Unknown dates stay out of the dated lines and are counted here, never imputed.`,
    );
  }
  if (flow.buckets.some((bucket) => bucket.origin === "register-history")) {
    notes.push("Buckets marked “register history” hold only imported records that predate the issue store.");
  }
  return notes;
}

/** One SVG step path per series, in viewBox coordinates. */
export type FlowChartModel = {
  capturedPath: string;
  retiredPath: string | null;
  /** Y axis ceiling (always >= 1, so a zero-valued axis never divides by zero). */
  yMax: number;
  yTicks: number[];
  /** At most three X labels (first, middle, last bucket) with their x position. */
  xLabels: { date: string; x: number }[];
  /** The drawn width/height, for the svg viewport. */
  width: number;
  height: number;
  /** Top of the plot area and its height, for gridlines/axes. */
  plotTop: number;
  plotHeight: number;
  /** Left edge of the plot area, for the y axis line. */
  plotLeft: number;
};

const CHART_WIDTH = 720;
const CHART_HEIGHT = 300;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 16;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 44;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** ~4 y ticks at a human step, always including 0. Counts stay on integers. */
export function yAxisTicks(yMax: number): number[] {
  const target = 4;
  const rawStep = yMax / target;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rawStep) ?? magnitude * 10);
  const ticks: number[] = [];
  for (let value = 0; value <= yMax; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] !== yMax && yMax - (ticks[ticks.length - 1] ?? 0) > step / 2) ticks.push(yMax);
  return ticks;
}

/**
 * The cumulative step geometry. Consecutive dated buckets are evenly spaced —
 * the x axis is the ordered sequence of days the store actually recorded, not
 * a padded calendar, so a silent month with no events never reads as data.
 * A single bucket still draws: a short flat step, labelled by the table.
 */
export function chartModel(flow: IssueFlow, width = CHART_WIDTH, height = CHART_HEIGHT): FlowChartModel {
  const buckets = flow.buckets;
  const plotWidth = width - PLOT_LEFT - PLOT_RIGHT;
  const plotHeight = height - PLOT_TOP - PLOT_BOTTOM;
  const lastCaptured = buckets.length === 0 ? 0 : buckets[buckets.length - 1]!.capturedCumulative;
  const yMax = Math.max(1, lastCaptured);
  const xOf = (index: number): number =>
    buckets.length === 1 ? PLOT_LEFT + plotWidth / 2 : PLOT_LEFT + (plotWidth * index) / (buckets.length - 1);
  const yOf = (value: number): number => PLOT_TOP + ((yMax - value) / yMax) * plotHeight;

  const stepPath = (valueOf: (bucket: IssueFlowBucket) => number): string => {
    if (buckets.length === 0) return "";
    if (buckets.length === 1) {
      const y = round2(yOf(valueOf(buckets[0]!)));
      const x = round2(xOf(0));
      return `M ${round2(x - 30)} ${y} H ${round2(x + 30)}`;
    }
    let path = `M ${round2(xOf(0))} ${round2(yOf(valueOf(buckets[0]!)))}`;
    for (let index = 1; index < buckets.length; index += 1) {
      path += ` H ${round2(xOf(index))} V ${round2(yOf(valueOf(buckets[index]!)))}`;
    }
    return path;
  };

  const lastRetired = buckets.length === 0 ? 0 : buckets[buckets.length - 1]!.retiredCumulative;
  const labelIndexes =
    buckets.length <= 3 ? buckets.map((_, index) => index) : [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1];

  return {
    capturedPath: stepPath((bucket) => bucket.capturedCumulative),
    retiredPath: lastRetired === 0 && buckets.every((bucket) => bucket.retiredCumulative === 0) ? null : stepPath((bucket) => bucket.retiredCumulative),
    yMax,
    yTicks: yAxisTicks(yMax),
    xLabels: labelIndexes.map((index) => ({ date: buckets[index]!.date, x: xOf(index) })),
    width,
    height,
    plotTop: PLOT_TOP,
    plotHeight,
    plotLeft: PLOT_LEFT,
  };
}

/** The short text alternative the SVG carries for assistive technology. */
export function chartSummary(flow: IssueFlow): string {
  const last = flow.buckets[flow.buckets.length - 1];
  if (last === undefined) {
    return flow.currentOpen === 0
      ? "No issues have been recorded, so there is no captured-versus-retired history to chart."
      : `No dated history exists, but the store currently records ${flow.currentOpen} open issue${flow.currentOpen === 1 ? "" : "s"}.`;
  }
  return (
    `Cumulative captured issues reach ${last.capturedCumulative} by ${last.date}; ` +
    `retired issues (any terminal disposition) reach ${last.retiredCumulative}. ` +
    `The store currently records ${flow.currentOpen} open issue${flow.currentOpen === 1 ? "" : "s"}.`
  );
}

function FlowChart(props: { flow: IssueFlow }) {
  const flow = props.flow;
  const model = chartModel(flow);
  const axisBottom = model.plotTop + model.plotHeight;
  return html`<svg
    class="flow-chart"
    viewBox=${`0 0 ${model.width} ${model.height}`}
    width=${model.width}
    height=${model.height}
    role="img"
    aria-labelledby="flow-chart-title flow-chart-desc"
  >
    <title id="flow-chart-title">Cumulative captured vs retired issues over dated history</title>
    <desc id="flow-chart-desc">${chartSummary(flow)}</desc>
    ${model.yTicks.map(
      (tick) => html`<g key=${tick}>
        <line
          class="flow-grid"
          x1=${model.plotLeft}
          x2=${model.width - PLOT_RIGHT}
          y1=${round2(model.plotTop + ((model.yMax - tick) / model.yMax) * model.plotHeight)}
          y2=${round2(model.plotTop + ((model.yMax - tick) / model.yMax) * model.plotHeight)}
        />
        <text class="flow-axis-label" x=${model.plotLeft - 8} y=${round2(model.plotTop + ((model.yMax - tick) / model.yMax) * model.plotHeight) + 4} text-anchor="end">${tick}</text>
      </g>`,
    )}
    <line class="flow-axis" x1=${model.plotLeft} x2=${model.plotLeft} y1=${model.plotTop} y2=${axisBottom} />
    <line class="flow-axis" x1=${model.plotLeft} x2=${model.width - PLOT_RIGHT} y1=${axisBottom} y2=${axisBottom} />
    ${model.retiredPath === null
      ? null
      : html`<path class="flow-line flow-line-retired" d=${model.retiredPath} fill="none" stroke-dasharray="6 4" />`}
    <path class="flow-line flow-line-captured" d=${model.capturedPath} fill="none" />
    ${model.xLabels.map(
      (label) => html`<text class="flow-axis-label" key=${label.date} x=${round2(label.x)} y=${axisBottom + 20} text-anchor="middle">${label.date}</text>`,
    )}
  </svg>`;
}

/**
 * The one chart panel. `flow` is fetched by the parent (the Issues view), so
 * the empty-store probe and the panel share one request; the parent also owns
 * the view's single polite live region.
 */
export function IssueFlowPanel(props: { flow: LoadState<IssueFlow> }) {
  const flow = props.flow;
  return html`<${DetailSection} title="Issue flow">
    <p class="hint">
      Cumulative captured vs retired issues by recorded day. Every terminal disposition counts as retired.
    </p>
    ${flow.status === "loading" ? html`<p class="hint">Loading issue flow…</p>` : null}
    ${flow.status === "error" ? html`<${Notice} tone="error">${flow.message}</${Notice}>` : null}
    ${flow.status === "ready" && flowPanelState(flow.envelope.data).kind === "empty"
      ? html`<${EmptyState}>
          <p class="prose">
            No issues have been recorded yet, so there is no captured-versus-retired history to chart. Use the CLI to
            record a confirmed finding.
          </p>
        <//${EmptyState}>`
      : null}
    ${flow.status === "ready" && flowPanelState(flow.envelope.data).kind === "data"
      ? (() => {
          const data = flow.envelope.data;
          const notes = flowNotes(data);
          const last = data.buckets[data.buckets.length - 1];
          return html`<p class="flow-open">
              Currently open (all recorded issues):
              <strong>${data.currentOpen}</strong>
              ${last === undefined || last.openDifference === data.currentOpen
                ? null
                : html`<span class="hint"> · dated history closes at ${last.openDifference} open</span>`}
            </p>
            <div class="table-scroll flow-scroll" role="region" aria-label="Issue flow chart" tabindex="0">
              <figure class="flow-figure">
                <${FlowChart} flow=${data} />
                <figcaption class="flow-legend">
                  <span class="flow-legend-item">
                    <svg width="28" height="6" aria-hidden="true"><line x1="0" y1="3" x2="28" y2="3" class="flow-line flow-line-captured" /></svg>
                    Captured (cumulative)
                  </span>
                  <span class="flow-legend-item">
                    <svg width="28" height="6" aria-hidden="true">
                      <line x1="0" y1="3" x2="28" y2="3" class="flow-line flow-line-retired" stroke-dasharray="6 4" />
                    </svg>
                    Retired (cumulative, any terminal disposition)
                  </span>
                </figcaption>
              </figure>
            </div>
            ${notes.map((note, index) => html`<p class="hint flow-note" key=${index}>${note}</p>`)}
            <div class="table-scroll" role="region" aria-label="Issue flow data" tabindex="0">
              <table class="data-table">
                <caption>
                  Issue flow by recorded day — the chart's data
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Captured (cumulative)</th>
                    <th scope="col">Retired (cumulative)</th>
                    <th scope="col">Open (dated)</th>
                    <th scope="col">Origin</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.buckets.map(
                    (bucket) => html`<tr key=${bucket.date}>
                      <td class="mono">${bucket.date}</td>
                      <td class="col-secondary">${bucket.capturedCumulative}</td>
                      <td class="col-secondary">${bucket.retiredCumulative}</td>
                      <td class="col-secondary">${bucket.openDifference}</td>
                      <td>${originLabel(bucket.origin)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`;
        })()
      : null}
  <//${DetailSection}>`;
}
