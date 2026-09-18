/**
 * Roadmap view (plan 20260918-dashboard D4): one project's direction document,
 * read-only.
 *
 * The roadmap DTO carries the catalog's project identity — authoritative — plus
 * the projected direction, goals and milestones read from the catalog-linked
 * roadmap document. With no valid projection generation the direction content is
 * `unavailable`, and a valid generation with no projected roadmap row for the
 * project is `absent`; neither is rendered as an empty document. Goals are
 * direction-document checkboxes shown as text: this view has no editor and no
 * mutation affordance (plan D4, DESIGN.md "Roadmap shows project direction/goals
 * as text, not editable checkboxes").
 *
 * The route is per project (`/api/roadmap?project=`), so the project comes from
 * the address bar; without one the view discloses that instead of guessing a
 * project.
 */
import type { RoadmapDTO } from "@mstar-harness/engine";
import { html } from "htm/preact";

import type { Disclosure, Envelope } from "../components";
import {
  CatalogFacts,
  DataBadges,
  DetailSection,
  EmptyState,
  LiveRegion,
  Notice,
  ProjectionNotice,
  projectionDisclosure,
  projectionUnavailable,
  useEnvelope,
} from "../components";

/** The project the address bar selects; absent and blank both mean "none". */
export function roadmapProject(search: string): string | null {
  const value = new URLSearchParams(search).get("project");
  return value === null || value.trim() === "" ? null : value;
}

/**
 * What the view can honestly show. `unavailable` means no valid generation has
 * been published; `absent` means a valid generation simply carries no roadmap
 * row for this project (the read boundary's own `execution-unavailable` badge);
 * only `ready` claims the document's own content.
 */
export type RoadmapContent =
  | { kind: "unavailable"; roadmap: RoadmapDTO }
  | { kind: "absent"; roadmap: RoadmapDTO }
  | { kind: "ready"; roadmap: RoadmapDTO };

export type RoadmapState = { disclosure: Disclosure | null; content: RoadmapContent };

export function roadmapState(envelope: Envelope<RoadmapDTO>): RoadmapState {
  const disclosure = projectionDisclosure(envelope.projection);
  const roadmap = envelope.data;
  if (projectionUnavailable(envelope.projection)) return { disclosure, content: { kind: "unavailable", roadmap } };
  return {
    disclosure,
    content: roadmap.badges.includes("execution-unavailable")
      ? { kind: "absent", roadmap }
      : { kind: "ready", roadmap },
  };
}

export function RoadmapView() {
  const project = roadmapProject(window.location.search);
  const load = useEnvelope<RoadmapDTO>(
    project === null ? null : `/api/roadmap?${new URLSearchParams({ project }).toString()}`,
  );
  const state = load.status === "ready" ? roadmapState(load.envelope) : null;

  const heading = html`<h1 class="heading-28" id="roadmap-heading" tabindex="-1">Roadmap</h1>`;

  if (project === null) {
    return html`${heading}
      <p class="hint">
        The roadmap view reads one project at a time: direction, goals and milestones come from that project's roadmap
        document.
      </p>
      <${LiveRegion} message="No project selected." />
      <${EmptyState}>
        <p class="prose">
          No project is selected. Add the project to the dashboard URL — for example
          <span class="mono">/?project=engine#roadmap</span> — then reload.
        </p>
      </${EmptyState}>`;
  }

  const roadmap = state === null ? null : state.content.roadmap;
  const announcement =
    load.status === "error"
      ? load.message
      : load.status === "loading"
        ? "Loading roadmap."
        : state?.content.kind === "unavailable"
          ? "Roadmap content is unavailable."
          : state?.content.kind === "absent"
            ? "No projected roadmap content for this project."
            : "Roadmap loaded.";

  return html`${heading}
    <p class="hint">
      Project ${project} · projected from the catalog-linked roadmap document. Read-only: goals are shown as text and
      every change goes through the CLI.
    </p>
    <${LiveRegion} message=${announcement} />
    ${load.status === "loading" ? html`<p class="hint">Loading roadmap…</p>` : null}
    ${load.status === "error" ? html`<${Notice} tone="error">${load.message}</${Notice}>` : null}
    ${state === null || state.disclosure === null ? null : html`<${ProjectionNotice} disclosure=${state.disclosure} />`}
    ${roadmap === null
      ? null
      : html`<${DataBadges} badges=${roadmap.badges} />
          <${DetailSection} title="Catalog">
            ${roadmap.catalog === null
              ? html`<${Notice} tone="warning"
                  >No catalog row exists for project ${project}: its title, description, location and lifecycle are
                  not available. Nothing is inferred from the projected roadmap content.</${Notice}>`
              : html`<${CatalogFacts} catalog=${roadmap.catalog} />`}
          </${DetailSection}>`}
    ${state?.content.kind === "unavailable"
      ? html`<${DetailSection} title="Direction (projected)">
          <p class="prose">
            Not available: no valid projection generation is published, so nothing is claimed about this project's
            roadmap document. The catalog identity above is unaffected.
          </p>
        </${DetailSection}>`
      : null}
    ${state?.content.kind === "absent"
      ? html`<${DetailSection} title="Direction (projected)">
          <p class="prose">
            No projected roadmap content: the current projection carries no roadmap row for this project, so its
            direction, goals and milestones are not available. That is not an empty roadmap document.
          </p>
        </${DetailSection}>`
      : null}
    ${state?.content.kind === "ready"
      ? html`<${DetailSection} title="Direction (projected)">
            ${state.content.roadmap.direction === null
              ? html`<p class="prose">No direction text is recorded in the roadmap document.</p>`
              : html`<p class="prose">${state.content.roadmap.direction}</p>`}
          </${DetailSection}>
          <${DetailSection} title="Goals (projected)">
            <p class="hint">Direction-document checkboxes, shown as text. Not editable here.</p>
            ${state.content.roadmap.goals.length === 0
              ? html`<p class="prose">No goals are recorded in the roadmap document.</p>`
              : html`<ul class="history">
                  ${state.content.roadmap.goals.map(
                    (goal, index) => html`<li key=${index} class="history-item">
                      <p class="history-head"><span class="history-kind">${goal.checked ? "Done" : "Not done"}</span></p>
                      <p class="prose">${goal.text}</p>
                    </li>`,
                  )}
                </ul>`}
          </${DetailSection}>
          <${DetailSection} title="Milestones (projected)">
            ${state.content.roadmap.milestones.length === 0
              ? html`<p class="prose">No milestones are named in the roadmap document frontmatter.</p>`
              : html`<ul class="relations">
                  ${state.content.roadmap.milestones.map((milestone) => html`<li key=${milestone} class="mono">${milestone}</li>`)}
                </ul>`}
          </${DetailSection}>`
      : null}`;
}
