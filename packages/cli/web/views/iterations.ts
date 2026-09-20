/**
 * Iterations view: the catalog-driven list plus the
 * per-iteration detail over the P6 read envelope.
 *
 * Catalog membership is authoritative and independent of execution
 * (state-projection contract §1): an iteration's plans and documents come from
 * catalog links, so they render even when no execution row exists. The
 * execution overlay — compass, workflow status/phase, plan status/progress and
 * the prepared pins — is a projection and is labelled as one. Neither side is
 * derived from the other, and "no execution row" is never claimed while the
 * projection itself is unavailable.
 */
import type { CatalogIdentityDTO, DashboardBadge, IterationDTO, IterationListDTO, IterationPlanDTO, ReadProjection } from "@mstar-harness/engine";
import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

import type { Disclosure, Envelope, PinState } from "../components";
import {
  Badge,
  CatalogFacts,
  DASHBOARD_PAGE_SIZE,
  DataBadges,
  DetailSection,
  EmptyState,
  Field,
  LiveRegion,
  Notice,
  Pager,
  ProjectionNotice,
  catalogLifecycleTone,
  pinState,
  pinText,
  projectionDisclosure,
  projectionUnavailable,
  textOrAbsent,
  useEnvelope,
} from "../components";
import { formatDate } from "../format";

/** One page of the iteration list plus the freshness it was read at. */
export type IterationListState = {
  disclosure: Disclosure | null;
  content: { kind: "empty" } | { kind: "listed"; total: number };
};

/**
 * The iteration list is driven by the catalog, so an unavailable projection
 * does not empty it: it only removes the execution overlay, which the envelope's
 * own disclosure reports.
 */
export function iterationListState(envelope: Envelope<IterationListDTO>): IterationListState {
  return {
    disclosure: projectionDisclosure(envelope.projection),
    content: envelope.data.total === 0 ? { kind: "empty" } : { kind: "listed", total: envelope.data.total },
  };
}

/**
 * Whether an iteration has an execution row is a projection fact. With no valid
 * generation the honest state is `unavailable` — never `not-started`, which
 * would claim the iteration has no execution row at all.
 */
export type IterationExecutionState =
  | { kind: "unavailable" }
  | { kind: "not-started" }
  | { kind: "row"; workflow: NonNullable<IterationDTO["workflow"]> };

export function iterationExecutionState(
  iteration: IterationDTO,
  projection: ReadProjection,
): IterationExecutionState {
  if (projectionUnavailable(projection)) return { kind: "unavailable" };
  return iteration.workflow === null ? { kind: "not-started" } : { kind: "row", workflow: iteration.workflow };
}

/**
 * One plan row's execution side: the projected row with the prepared pin it
 * froze, no row at all, or unknown because no valid generation is published.
 */
export type IterationPlanExecution =
  | { kind: "row"; row: NonNullable<IterationPlanDTO["execution"]>; pin: PinState }
  | { kind: "not-started" }
  | { kind: "unknown" };

export type IterationPlanRow = {
  planId: string;
  catalog: CatalogIdentityDTO | null;
  badges: readonly DashboardBadge[];
  execution: IterationPlanExecution;
};

/**
 * A catalog plan row plus its execution overlay. Catalog membership holds
 * whether or not an execution row exists, and the pin is only claimed when an
 * execution row is there to carry it.
 */
export function iterationPlanRow(plan: IterationPlanDTO, projectionAvailable: boolean): IterationPlanRow {
  const execution: IterationPlanExecution =
    plan.execution === null
      ? { kind: projectionAvailable ? "not-started" : "unknown" }
      : { kind: "row", row: plan.execution, pin: pinState(plan.catalogPinRevision, plan.catalog?.revision ?? null) };
  return { planId: plan.planId, catalog: plan.catalog, badges: plan.badges, execution };
}

/** The plan row's projected values under projected labels, or the honest absence. */
function PlanRow(props: { row: IterationPlanRow }) {
  const row = props.row;
  const catalog = row.catalog;
  return html`<li class="history-item">
    <p class="history-head">
      <span class="history-kind mono">${row.planId}</span>
      <span class="mono">${catalog === null ? "No catalog row" : catalog.title}</span>
    </p>
    <${DataBadges} badges=${row.badges} />
    <dl class="facts">
      ${catalog === null
        ? null
        : html`<${Field} label="Catalog location"
              ><span class="mono">${`${catalog.rootKind}:${catalog.relativePath}`}</span></${Field}
            >
            <${Field} label="Catalog lifecycle"
              ><${Badge} tone=${catalogLifecycleTone(catalog.lifecycle)}>${catalog.lifecycle}</${Badge}></${Field}
            >`}
      ${row.execution.kind === "row"
        ? html`<${Field} label="Projected status">${textOrAbsent(row.execution.row.status)}</${Field}>
            <${Field} label="Projected phase">${textOrAbsent(row.execution.row.phase)}</${Field}>
            <${Field} label="Projected progress">${textOrAbsent(row.execution.row.progress)}</${Field}>
            <${Field} label="Projected workflow"><span class="mono">${row.execution.row.workflowId}</span></${Field}>
            ${row.execution.row.doneAt === null
              ? null
              : html`<${Field} label="Projected done at"
                  ><span class="mono">${formatDate(row.execution.row.doneAt)}</span></${Field}>`}`
        : null}
    </dl>
    ${row.execution.kind === "row"
      ? html`<p class="hint">${pinText(row.execution.pin)}</p>`
      : html`<p class="hint">
          ${row.execution.kind === "unknown"
            ? "Execution unknown: no valid projection generation is published, so no execution row is claimed for this plan."
            : "No execution row: this plan has no row in the projection, so it carries no phase, progress or prepared pin."}
        </p>`}
  </li>`;
}

function IterationRow(props: { iteration: IterationDTO; projection: ReadProjection }) {
  const iteration = props.iteration;
  const catalog = iteration.catalog;
  const execution = iterationExecutionState(iteration, props.projection);
  const executionText =
    execution.kind === "unavailable"
      ? "Execution data unavailable"
      : execution.kind === "not-started"
        ? "No execution row"
        : `${execution.workflow.status}${execution.workflow.phase === null ? "" : ` · ${execution.workflow.phase}`}`;
  return html`<tr>
    <td class="col-id mono">
      <a href=${`#iteration/${encodeURIComponent(iteration.iterationId)}`}>${iteration.iterationId}</a>
    </td>
    <td class="col-title">
      ${catalog === null ? html`<span class="mono">${iteration.iterationId}</span>` : catalog.title}
      <span class="row-meta">
        Projected execution ${executionText} · Catalog plans ${iteration.plans.length} · Catalog documents
        ${iteration.documents.length}
      </span>
      <${DataBadges} badges=${iteration.badges} />
    </td>
    <td class="col-secondary">
      ${catalog === null
        ? html`<${Badge} tone="warning">No catalog row</${Badge}>`
        : html`<${Badge} tone=${catalogLifecycleTone(catalog.lifecycle)}>${catalog.lifecycle}</${Badge}>`}
    </td>
    <td>${executionText}</td>
    <td class="col-secondary">${String(iteration.plans.length)}</td>
    <td class="col-secondary">${String(iteration.documents.length)}</td>
  </tr>`;
}

export function IterationsView() {
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ limit: String(DASHBOARD_PAGE_SIZE) });
  if (offset > 0) query.set("offset", String(offset));
  const load = useEnvelope<IterationListDTO>(`/api/iterations?${query.toString()}`);

  const state = load.status === "ready" ? iterationListState(load.envelope) : null;
  const projection = load.status === "ready" ? load.envelope.projection : null;
  const items = load.status === "ready" ? load.envelope.data.items : [];
  const total = load.status === "ready" ? load.envelope.data.total : 0;
  const announcement =
    load.status === "error"
      ? load.message
      : load.status === "loading"
        ? "Loading iterations."
        : state?.content.kind === "empty"
          ? "No iterations listed."
          : `${total} iteration${total === 1 ? "" : "s"} listed.`;

  return html`<h1 class="heading-28" id="iterations-heading" tabindex="-1">Iterations</h1>
    <p class="hint">
      Iteration, plan and document membership comes from the catalog and is shown whether or not execution has started.
      Execution status, phase and progress are the projection.
    </p>
    <${LiveRegion} message=${announcement} />
    ${load.status === "loading" ? html`<p class="hint">Loading iterations…</p>` : null}
    ${load.status === "error" ? html`<${Notice} tone="error">${load.message}</${Notice}>` : null}
    ${state === null || state.disclosure === null ? null : html`<${ProjectionNotice} disclosure=${state.disclosure} />`}
    ${state?.content.kind === "empty"
      ? html`<${EmptyState}><p class="prose">No iterations are registered in the catalog.</p></${EmptyState}>`
      : null}
    ${projection === null || items.length === 0
      ? null
      : html`<div class="table-scroll" role="region" aria-label="Iteration list" tabindex="0">
            <table class="data-table">
              <caption>
                Catalog iterations (${total})
              </caption>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Catalog title</th>
                  <th scope="col" class="col-secondary">Catalog lifecycle</th>
                  <th scope="col">Projected execution</th>
                  <th scope="col" class="col-secondary">Catalog plans</th>
                  <th scope="col" class="col-secondary">Catalog documents</th>
                </tr>
              </thead>
              <tbody>
                ${items.map(
                  (iteration) => html`<${IterationRow} key=${iteration.iterationId} iteration=${iteration} projection=${projection} />`,
                )}
              </tbody>
            </table>
          </div>
          <${Pager} offset=${offset} count=${items.length} total=${total} onChange=${setOffset} />`}`;
}

/**
 * The compass is a projection document: with no valid generation it is
 * `unknown` even when a compass value was handed in, never silently rendered as
 * projected content. `absent` is the honest state of a valid generation that
 * simply carries no compass for this iteration.
 */
export type CompassState =
  | { kind: "unknown" }
  | { kind: "absent" }
  | { kind: "document"; compass: NonNullable<IterationDTO["compass"]> };

export function compassState(compass: IterationDTO["compass"], projectionAvailable: boolean): CompassState {
  if (!projectionAvailable) return { kind: "unknown" };
  return compass === null ? { kind: "absent" } : { kind: "document", compass };
}

function CompassSection(props: { compass: IterationDTO["compass"]; projectionAvailable: boolean }) {
  const state = compassState(props.compass, props.projectionAvailable);
  if (state.kind === "unknown") {
    return html`<${DetailSection} title="Compass (projected)">
      <p class="prose">
        Not available: no valid projection generation is published, so nothing is claimed about this iteration's
        compass.
      </p>
    </${DetailSection}>`;
  }
  if (state.kind === "absent") {
    return html`<${DetailSection} title="Compass (projected)">
      <p class="prose">No compass document is projected for this iteration.</p>
    </${DetailSection}>`;
  }
  const compass = state.compass;
  return html`<${DetailSection} title="Compass (projected)">
    <dl class="facts">
      ${compass.summary === null
        ? null
        : html`<${Field} label="Projected summary"><span class="prose">${compass.summary}</span></${Field}>`}
      <${Field} label="Projected compass status">${textOrAbsent(compass.status)}</${Field}>
      ${compass.startedAt === null
        ? null
        : html`<${Field} label="Projected started"><span class="mono">${formatDate(compass.startedAt)}</span></${Field}>`}
      ${compass.endedAt === null
        ? null
        : html`<${Field} label="Projected ended"><span class="mono">${formatDate(compass.endedAt)}</span></${Field}>`}
    </dl>
    ${compass.milestones.length === 0
      ? html`<p class="hint">No milestones are recorded in the compass document.</p>`
      : html`<ul class="relations">
          ${compass.milestones.map(
            (milestone) => html`<li key=${milestone.milestone} class="mono">
              ${milestone.milestone} · target ${textOrAbsent(milestone.target)} · status
              ${textOrAbsent(milestone.status)}
            </li>`,
          )}
        </ul>`}
  </${DetailSection}>`;
}

export function IterationDetailView(props: { id: string }) {
  const load = useEnvelope<IterationDTO>(`/api/iterations/${encodeURIComponent(props.id)}`);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      window.location.hash = "#iterations";
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.id]);

  if (load.status === "error") {
    return html`<p class="back-link"><a href="#iterations">Back to Iterations</a></p>
      <h1 class="heading-28">Iteration ${props.id}</h1>
      <${LiveRegion} message=${load.message} />
      <${Notice} tone="error">${load.message}</${Notice}>`;
  }
  if (load.status === "loading") {
    return html`<p class="back-link"><a href="#iterations">Back to Iterations</a></p>
      <h1 class="heading-28">Iteration ${props.id}</h1>
      <p class="hint">Loading iteration…</p>`;
  }

  const iteration = load.envelope.data;
  const projection = load.envelope.projection;
  const disclosure = projectionDisclosure(projection);
  const available = !projectionUnavailable(projection);
  const execution = iterationExecutionState(iteration, projection);
  const catalog = iteration.catalog;

  return html`<p class="back-link"><a href="#iterations">Back to Iterations</a></p>
    <${LiveRegion} message=${`Iteration ${iteration.iterationId} loaded.`} />
    <h1 class="heading-28">${catalog === null ? iteration.iterationId : catalog.title}</h1>
    <p class="detail-id mono">${iteration.iterationId}</p>
    ${disclosure === null ? null : html`<${ProjectionNotice} disclosure=${disclosure} />`}
    <${DataBadges} badges=${iteration.badges} />
    <${DetailSection} title="Catalog">
      ${catalog === null
        ? html`<${Notice} tone="warning"
            >No catalog row exists for ${iteration.iterationId}: its title, description, location and lifecycle are not
            available. Plan and document membership below comes from catalog links, not from the execution
            projection.</${Notice}>`
        : html`<${CatalogFacts} catalog=${catalog} />`}
    </${DetailSection}>
    <${DetailSection} title="Execution (projected)">
      ${execution.kind === "unavailable"
        ? html`<p class="prose">
            Execution unknown: no valid projection generation is published, so nothing is claimed about this
            iteration's execution row. Its catalog membership below is unaffected.
          </p>`
        : execution.kind === "not-started"
          ? html`<p class="prose">
              No execution row: this iteration has not started execution in the projection. Its catalog membership
              below is unaffected.
            </p>`
          : html`<dl class="facts">
              <${Field} label="Projected workflow"><span class="mono">${execution.workflow.id}</span></${Field}>
              <${Field} label="Projected status"
                ><${Badge} tone="neutral">${execution.workflow.status}</${Badge}></${Field}
              >
              <${Field} label="Projected phase">${textOrAbsent(execution.workflow.phase)}</${Field}>
              <${Field} label="Root register"
                >${execution.workflow.activeRegistration ? "Listed as an active workflow" : "Not listed as active"}</${Field}
              >
            </dl>`}
    </${DetailSection}>
    <${CompassSection} compass=${iteration.compass} projectionAvailable=${available} />
    <${DetailSection} title="Plans">
      <p class="hint">Catalog membership, with the projection's execution overlay when one exists.</p>
      ${iteration.plans.length === 0
        ? html`<p class="prose">No plans are linked to this iteration in the catalog.</p>`
        : html`<ul class="history">
            ${iteration.plans.map(
              (plan) => html`<${PlanRow} key=${plan.planId} row=${iterationPlanRow(plan, available)} />`,
            )}
          </ul>`}
    </${DetailSection}>
    <${DetailSection} title="Documents">
      <p class="hint">Catalog membership: the document bodies stay files and are never read here.</p>
      ${iteration.documents.length === 0
        ? html`<p class="prose">No documents are linked to this iteration in the catalog.</p>`
        : html`<ul class="history">
            ${iteration.documents.map(
              (document) => html`<li key=${document.id} class="history-item">
                <p class="history-head">
                  <span class="history-kind">${document.title}</span>
                  <${Badge} tone=${catalogLifecycleTone(document.lifecycle)}>${document.lifecycle}</${Badge}>
                  ${document.documentKind === null
                    ? null
                    : html`<${Badge} tone="neutral">${document.documentKind}</${Badge}>`}
                </p>
                <dl class="facts">
                  <${Field} label="Catalog location"
                    ><span class="mono">${`${document.rootKind}:${document.relativePath}`}</span></${Field}
                  >
                  <${Field} label="Catalog revision"><span class="mono">${String(document.revision)}</span></${Field}>
                </dl>
                ${document.description === null
                  ? null
                  : html`<p class="prose">${document.description}</p>`}
              </li>`,
            )}
          </ul>`}
    </${DetailSection}>`;
}
