/**
 * Roadmap view: a read-only presentation of the authoritative Markdown document.
 * The address bar selects one explicit project; no project is inferred.
 */
import type { RoadmapDTO } from "@mstar-harness/engine";
import { html } from "htm/preact";

import type { Disclosure, Envelope } from "../components";
import {
  CatalogFacts,
  DetailSection,
  EmptyState,
  LiveRegion,
  Notice,
  useEnvelope,
} from "../components";

/** The project the address bar selects; absent and blank both mean "none". */
export function roadmapProject(search: string): string | null {
  const value = new URLSearchParams(search).get("project");
  return value === null || value.trim() === "" ? null : value;
}

/** Authority presence, not execution-projection freshness, determines roadmap state. */
export type RoadmapContent =
  | { kind: "not-found" }
  | { kind: "absent"; roadmap: RoadmapDTO }
  | { kind: "ready"; roadmap: RoadmapDTO };

export type RoadmapState = { disclosure: Disclosure | null; content: RoadmapContent };

export function roadmapState(envelope: Envelope<RoadmapDTO | null>): RoadmapState {
  const roadmap = envelope.data;
  return {
    disclosure: null,
    content: roadmap === null
      ? { kind: "not-found" }
      : roadmap.authority.state === "absent" ? { kind: "absent", roadmap } : { kind: "ready", roadmap },
  };
}

export function RoadmapView() {
  const project = roadmapProject(window.location.search);
  const load = useEnvelope<RoadmapDTO | null>(
    project === null ? null : `/api/roadmap?${new URLSearchParams({ project }).toString()}`,
  );
  const state = load.status === "ready" ? roadmapState(load.envelope) : null;

  const heading = html`<h1 class="heading-28" id="roadmap-heading" tabindex="-1">Roadmap</h1>`;

  if (project === null) {
    return html`${heading}
      <p class="hint">The roadmap view reads one project's authoritative roadmap document. Direction, goals, milestones and complete source text are shown read-only.</p>
      <${LiveRegion} message="No project selected." />
      <${EmptyState}>
        <p class="prose">
          No project is selected. Add the project to the dashboard URL — for example
          <span class="mono">/?project=engine#roadmap</span> — then reload.
        </p>
      </${EmptyState}>`;
  }

  const roadmap = state === null || state.content.kind === "not-found" ? null : state.content.roadmap;
  const announcement =
    load.status === "error"
      ? load.message
      : load.status === "loading"
        ? "Loading roadmap."
        : state?.content.kind === "not-found"
          ? `Project ${project} was not found in the catalog.`
          : state?.content.kind === "absent"
            ? "No roadmap content is stored for this project."
            : "Roadmap loaded.";

  return html`${heading}
    <p class="hint">Project ${project} · authoritative stored roadmap content. Read-only: use the roadmap CLI to import or replace it.</p>
    <${LiveRegion} message=${announcement} />
    ${load.status === "loading" ? html`<p class="hint">Loading roadmap…</p>` : null}
    ${load.status === "error" ? html`<${Notice} tone="error">${load.message}</${Notice}>` : null}
    ${state?.content.kind === "not-found"
      ? html`<${EmptyState}><p class="prose">Project ${project} was not found in the catalog. Check the project id and try again.</p></${EmptyState}>`
      : null}
    ${state?.content.kind === "absent"
      ? html`<${DetailSection} title="Roadmap">
          <p class="prose">No roadmap content is stored for project ${project}. This is distinct from a store read failure.</p>
        </${DetailSection}>`
      : null}
    ${state?.content.kind === "ready" && roadmap?.content !== null
      ? html`<${DetailSection} title="Direction">
            ${roadmap.content.direction === null
              ? html`<p class="prose">No direction text is recorded in the roadmap document.</p>`
              : html`<p class="prose">${roadmap.content.direction}</p>`}
          </${DetailSection}>
          <${DetailSection} title="Goals">
            ${roadmap.content.goals.length === 0
              ? html`<p class="prose">No goals are recorded in the roadmap document.</p>`
              : html`<ul class="history">
                  ${roadmap.content.goals.map((goal, index) => html`<li key=${index} class="history-item">
                    <p class="history-head"><span class="history-kind">${goal.checked ? "Done" : "Not done"}</span></p>
                    <p class="prose">${goal.title}</p>
                  </li>`)}
                </ul>`}
          </${DetailSection}>
          <${DetailSection} title="Milestones">
            ${roadmap.content.milestones.length === 0
              ? html`<p class="prose">No milestones are named in the roadmap document frontmatter.</p>`
              : html`<ul class="relations">${roadmap.content.milestones.map((milestone, index) => html`<li key=${index} class="mono">${milestone}</li>`)}</ul>`}
          </${DetailSection}>
          <${DetailSection} title="Complete roadmap document"><pre class="prose">${roadmap.content.contentMarkdown}</pre></${DetailSection}>`
      : null}`;
}

