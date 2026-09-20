/**
 * Workflows view: the list plus the per-workflow
 * detail over the P6 read envelope.
 *
 * Two authorities meet here and stay separately labelled (state-projection
 * contract §1): the execution projection owns status, phase, progress, times,
 * branch anchors and leases; the catalog owns title, description, location,
 * lifecycle and plan membership. Nothing is derived across that boundary — a
 * catalog lifecycle is never read as progress, and a projected row is never read
 * as catalog registration — and the read boundary's own join badges are
 * disclosed instead of being resolved into a value the store did not give.
 *
 * A read with no valid projection generation lists nothing at all; it says so
 * (DESIGN.md "Unavailable initial projection") and never presents itself as an
 * empty workflow list (plan D4 STOP rule).
 */
import type { WorkflowDTO, WorkflowListDTO, WorkflowPlanDTO } from "@mstar-harness/engine";
import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

import type { Disclosure, Envelope } from "../components";
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

/** One page of the workflow list plus the freshness it was read at. */
export type WorkflowListState = {
  disclosure: Disclosure | null;
  content: { kind: "unavailable" } | { kind: "empty" } | { kind: "listed"; total: number };
};

/**
 * An envelope with no valid projection generation carries no workflow rows;
 * that is `unavailable`, never `empty` (contract §6: a first refresh with no
 * valid generation reports unavailable, not zero active work).
 */
export function workflowListState(envelope: Envelope<WorkflowListDTO>): WorkflowListState {
  const disclosure = projectionDisclosure(envelope.projection);
  if (projectionUnavailable(envelope.projection)) return { disclosure, content: { kind: "unavailable" } };
  return {
    disclosure,
    content: envelope.data.total === 0 ? { kind: "empty" } : { kind: "listed", total: envelope.data.total },
  };
}

/**
 * The workflow detail's own state. A workflow row is a projection fact: with no
 * valid generation there is nothing to render as work, so the page reports
 * `unavailable` — the envelope's own disclosure — instead of a missing record or
 * projected plan facts. `data === null` is the server's shape for exactly that
 * case (a row that cannot be read at all), never a claim that no such workflow
 * exists.
 */
export type WorkflowDetailState =
  | { kind: "unavailable"; disclosure: Disclosure | null }
  | { kind: "loaded"; workflow: WorkflowDTO; disclosure: Disclosure | null };

export function workflowDetailState(envelope: Envelope<WorkflowDTO | null>): WorkflowDetailState {
  const disclosure = projectionDisclosure(envelope.projection);
  if (envelope.data === null || projectionUnavailable(envelope.projection)) {
    return { kind: "unavailable", disclosure };
  }
  return { kind: "loaded", workflow: envelope.data, disclosure };
}

/**
 * One plan execution row: the projected status/phase/progress/lease values
 * under projected labels, the catalog identity under catalog labels, and the
 * prepared pin the execution row froze. A missing pin is disclosed as missing.
 */
function PlanRow(props: { plan: WorkflowPlanDTO }) {
  const plan = props.plan;
  const catalog = plan.catalog;
  const pin = pinState(plan.catalogPinRevision, catalog?.revision ?? null);
  return html`<li class="history-item">
    <p class="history-head">
      <span class="history-kind mono">${plan.planId}</span>
      <span class="mono">${catalog === null ? "No catalog row" : catalog.title}</span>
    </p>
    <${DataBadges} badges=${plan.badges} />
    <dl class="facts">
      <${Field} label="Projected status">${textOrAbsent(plan.status)}</${Field}>
      <${Field} label="Projected phase">${textOrAbsent(plan.phase)}</${Field}>
      <${Field} label="Projected progress">${textOrAbsent(plan.progress)}</${Field}>
      ${plan.doneAt === null
        ? null
        : html`<${Field} label="Projected done at"><span class="mono">${formatDate(plan.doneAt)}</span></${Field}>`}
      ${catalog === null
        ? null
        : html`<${Field} label="Catalog location"
              ><span class="mono">${`${catalog.rootKind}:${catalog.relativePath}`}</span></${Field}
            >
            <${Field} label="Catalog lifecycle"
              ><${Badge} tone=${catalogLifecycleTone(catalog.lifecycle)}>${catalog.lifecycle}</${Badge}></${Field}
            >`}
    </dl>
    <p class="hint">${pinText(pin)}</p>
    ${plan.leases.length === 0
      ? html`<p class="hint">No lease row is projected for this plan.</p>`
      : html`<ul class="relations">
          ${plan.leases.map(
            (lease) => html`<li key=${lease.kind} class="mono">
              ${lease.kind} lease · holder ${textOrAbsent(lease.holder)} · worktree ${textOrAbsent(lease.worktreePath)} ·
              ${lease.expiresAt === null ? " no recorded expiry" : ` expires ${lease.expiresAt}`}
            </li>`,
          )}
        </ul>`}
  </li>`;
}

function WorkflowRow(props: { workflow: WorkflowDTO }) {
  const workflow = props.workflow;
  const catalog = workflow.catalog;
  return html`<tr>
    <td class="col-id mono">
      <a href=${`#workflow/${encodeURIComponent(workflow.id)}`}>${workflow.id}</a>
    </td>
    <td class="col-title">
      ${catalog === null ? html`<span class="mono">${workflow.id}</span>` : catalog.title}
      <span class="row-meta">
        <span class="mono">${workflow.type}</span> · Projected status ${workflow.status} · Projected phase
        ${textOrAbsent(workflow.phase)}
      </span>
      <${DataBadges} badges=${workflow.badges} />
    </td>
    <td><${Badge} tone="neutral">${workflow.status}</${Badge}></td>
    <td class="col-secondary">${textOrAbsent(workflow.phase)}</td>
    <td class="col-secondary">
      ${catalog === null
        ? html`<${Badge} tone="warning">No catalog row</${Badge}>`
        : html`<${Badge} tone=${catalogLifecycleTone(catalog.lifecycle)}>${catalog.lifecycle}</${Badge}>`}
    </td>
    <td class="col-secondary">${workflow.activeRegistration ? "Listed as active" : "Not listed as active"}</td>
    <td class="col-secondary mono">${workflow.updatedAt === null ? "Not recorded" : formatDate(workflow.updatedAt)}</td>
  </tr>`;
}

export function WorkflowsView() {
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ limit: String(DASHBOARD_PAGE_SIZE) });
  if (offset > 0) query.set("offset", String(offset));
  const load = useEnvelope<WorkflowListDTO>(`/api/workflows?${query.toString()}`);

  const state = load.status === "ready" ? workflowListState(load.envelope) : null;
  const items = load.status === "ready" ? load.envelope.data.items : [];
  const total = load.status === "ready" ? load.envelope.data.total : 0;
  const announcement =
    load.status === "error"
      ? load.message
      : load.status === "loading"
        ? "Loading workflows."
        : state?.content.kind === "unavailable"
          ? "Execution data is unavailable."
          : state?.content.kind === "empty"
            ? "No workflows listed."
            : `${total} workflow${total === 1 ? "" : "s"} listed.`;

  return html`<h1 class="heading-28" id="workflows-heading" tabindex="-1">Workflows</h1>
    <p class="hint">
      Projected status, phase, progress, times and leases come from the execution projection, joined to the catalog by
      id. Titles, locations and lifecycle come from the catalog.
    </p>
    <${LiveRegion} message=${announcement} />
    ${load.status === "loading" ? html`<p class="hint">Loading workflows…</p>` : null}
    ${load.status === "error" ? html`<${Notice} tone="error">${load.message}</${Notice}>` : null}
    ${state === null || state.disclosure === null ? null : html`<${ProjectionNotice} disclosure=${state.disclosure} />`}
    ${state?.content.kind === "empty"
      ? html`<${EmptyState}><p class="prose">No workflows are registered in the execution projection.</p></${EmptyState}>`
      : null}
    ${state?.content.kind === "unavailable"
      ? html`<${EmptyState}
          ><p class="prose">
            Not available: no valid projection generation is published, so no workflow rows are listed here and
            nothing is claimed about registered work. That is not an empty workflow registry.
          </p></${EmptyState}
        >`
      : null}
    ${state?.content.kind !== "listed"
      ? null
      : html`<div class="table-scroll" role="region" aria-label="Workflow list" tabindex="0">
            <table class="data-table">
              <caption>
                Workflows in the current projection (${total})
              </caption>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Catalog title</th>
                  <th scope="col">Projected status</th>
                  <th scope="col" class="col-secondary">Projected phase</th>
                  <th scope="col" class="col-secondary">Catalog lifecycle</th>
                  <th scope="col" class="col-secondary">Root register</th>
                  <th scope="col" class="col-secondary">Projected updated</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((workflow) => html`<${WorkflowRow} key=${workflow.id} workflow=${workflow} />`)}
              </tbody>
            </table>
          </div>
          <${Pager} offset=${offset} count=${items.length} total=${total} onChange=${setOffset} />`}`;
}

export function WorkflowDetailView(props: { id: string }) {
  const load = useEnvelope<WorkflowDTO | null>(`/api/workflows/${encodeURIComponent(props.id)}`);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      window.location.hash = "#workflows";
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.id]);

  if (load.status === "error") {
    return html`<p class="back-link"><a href="#workflows">Back to Workflows</a></p>
      <h1 class="heading-28">Workflow ${props.id}</h1>
      <${LiveRegion} message=${load.message} />
      <${Notice} tone="error">${load.message}</${Notice}>`;
  }
  if (load.status === "loading") {
    return html`<p class="back-link"><a href="#workflows">Back to Workflows</a></p>
      <h1 class="heading-28">Workflow ${props.id}</h1>
      <p class="hint">Loading workflow…</p>`;
  }

  const state = workflowDetailState(load.envelope);
  if (state.kind === "unavailable") {
    return html`<p class="back-link"><a href="#workflows">Back to Workflows</a></p>
      <h1 class="heading-28">Workflow ${props.id}</h1>
      <${LiveRegion} message="Workflow data is unavailable." />
      ${state.disclosure === null ? null : html`<${ProjectionNotice} disclosure=${state.disclosure} />`}
      <${EmptyState}
        ><p class="prose">
          Not available: no valid projection generation is published, so this workflow's execution row, branch and
          plan rows cannot be read here and nothing is claimed about them. That is not a claim that no such workflow
          exists.
        </p></${EmptyState}
      >`;
  }

  const workflow = state.workflow;
  const disclosure = state.disclosure;
  const catalog = workflow.catalog;
  const branches: Array<[string, string | null]> = [
    ["Projected branch base", workflow.branch.base],
    ["Projected branch source", workflow.branch.source],
    ["Projected branch integration", workflow.branch.integration],
    ["Projected branch target", workflow.branch.target],
  ];

  return html`<p class="back-link"><a href="#workflows">Back to Workflows</a></p>
    <${LiveRegion} message=${`Workflow ${workflow.id} loaded.`} />
    <h1 class="heading-28">${catalog === null ? workflow.id : catalog.title}</h1>
    <p class="detail-id mono">${workflow.id}</p>
    ${disclosure === null ? null : html`<${ProjectionNotice} disclosure=${disclosure} />`}
    <${DataBadges} badges=${workflow.badges} />
    <${DetailSection} title="Execution (projected)">
      <p class="hint">
        Read from the execution projection, which mirrors the JSON execution authority. It is never refreshed from the
        catalog.
      </p>
      <dl class="facts">
        <${Field} label="Projected type">${workflow.type}</${Field}>
        <${Field} label="Projected status"><${Badge} tone="neutral">${workflow.status}</${Badge}></${Field}>
        <${Field} label="Projected phase">${textOrAbsent(workflow.phase)}</${Field}>
        <${Field} label="Root register"
          >${workflow.activeRegistration ? "Listed as an active workflow" : "Not listed as active"}</${Field}
        >
        ${workflow.startedAt === null
          ? null
          : html`<${Field} label="Projected started"
              ><span class="mono">${formatDate(workflow.startedAt)}</span></${Field}
            >`}
        ${workflow.endedAt === null
          ? null
          : html`<${Field} label="Projected ended"
              ><span class="mono">${formatDate(workflow.endedAt)}</span></${Field}
            >`}
        ${workflow.updatedAt === null
          ? null
          : html`<${Field} label="Projected updated"
              ><span class="mono">${formatDate(workflow.updatedAt)}</span></${Field}
            >`}
        ${branches.map(([label, value]) => html`<${Field} label=${label}>${textOrAbsent(value)}</${Field}>`)}
      </dl>
    </${DetailSection}>
    <${DetailSection} title="Catalog">
      ${catalog === null
        ? html`<${Notice} tone="warning"
            >No catalog row exists for ${workflow.id}: its title, description, location and lifecycle are not
            available. Nothing is inferred from the projected execution row.</${Notice}>`
        : html`<${CatalogFacts} catalog=${catalog} />`}
    </${DetailSection}>
    <${DetailSection} title="Plans">
      ${workflow.plans.length === 0
        ? html`<p class="prose">No plan execution rows are projected for this workflow.</p>`
        : html`<ul class="history">
            ${workflow.plans.map((plan) => html`<${PlanRow} key=${plan.planId} plan=${plan} />`)}
          </ul>`}
    </${DetailSection}>`;
}
