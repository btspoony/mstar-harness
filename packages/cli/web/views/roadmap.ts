/**
 * Roadmap view: the project's authoritative Direction, the stored historical
 * source text, and the structured milestone grouping this project's issues are
 * actually grouped by (read-envelope contract §6, plan §4).
 *
 * With no project in the address bar the view is the catalog's project list:
 * registered projects, each linking into that project's own roadmap. That entry
 * is a catalog read (`needsProjection: false`), so it never depends on a
 * published projection generation, and it is read-only — no create, edit or
 * archive control.
 *
 * Two store-owned authorities meet here and stay separately labelled: the
 * migration-6 content authority owns Direction and the stored source text, and
 * the milestone tables own grouping, target, status, counts and issue
 * membership. Nothing is derived across them — frontmatter milestone names and
 * checked goal lines are historical document text, never a live status — and
 * the execution projection's freshness is disclosed without being read as
 * milestone freshness: the counts come from the store revision, so stale or
 * unavailable execution data never invalidates them.
 */
import type {
  MilestoneIssueDTO,
  MilestoneRead,
  ProjectListDTO,
  ProjectListItem,
  ProjectMilestoneDTO,
  ReadProjection,
  RoadmapDTO,
} from "@mstar-harness/engine";
import { html } from "htm/preact";
import type { ComponentChildren } from "preact";

import type { Disclosure, Envelope, LoadState } from "../components";
import {
  Badge,
  CatalogFacts,
  DetailSection,
  EmptyState,
  Field,
  LiveRegion,
  Notice,
  ProjectionNotice,
  catalogLifecycleTone,
  projectionDisclosure,
  useEnvelope,
} from "../components";
import { dispositionTone } from "../format";

/** The project the address bar selects; absent and blank both mean "none". */
export function roadmapProject(search: string): string | null {
  const value = new URLSearchParams(search).get("project");
  return value === null || value.trim() === "" ? null : value;
}

// ---------------------------------------------------------------------------
// Milestone grouping (§4: ordinal/ID order, counts, linked issues, unassigned)
// ---------------------------------------------------------------------------

/** One milestone with the issues assigned to it, in the read's own order. */
export type MilestoneGroup = {
  milestone: ProjectMilestoneDTO;
  issues: Array<MilestoneIssueDTO & { milestoneId: string }>;
};

/** The store's milestone grouping for one project. */
export type MilestoneGroups = { groups: MilestoneGroup[]; unassignedIssues: number };

/**
 * Group the flat issue rows under their milestones, in the §4 render order:
 * ordinal first, ties by milestone id. The read boundary orders the same way;
 * the view enforces it here so a transport cannot repaint out of order.
 * Unassigned issues are never folded into a group — they are counted on their
 * own and can only disappear into their own count.
 */
export function milestoneGroups(read: MilestoneRead): MilestoneGroups {
  const assigned = new Map<string, Array<MilestoneIssueDTO & { milestoneId: string }>>();
  for (const issue of read.issues) {
    const bucket = assigned.get(issue.milestoneId);
    if (bucket === undefined) assigned.set(issue.milestoneId, [issue]);
    else bucket.push(issue);
  }
  const byRenderOrder = (left: ProjectMilestoneDTO, right: ProjectMilestoneDTO): number =>
    left.ordinal - right.ordinal || (left.milestoneId < right.milestoneId ? -1 : 1);
  return {
    groups: [...read.milestones].sort(byRenderOrder).map((milestone) => ({
      milestone,
      issues: assigned.get(milestone.milestoneId) ?? [],
    })),
    unassignedIssues: read.unassignedIssues,
  };
}

/** A nullable planned target (§4 "no target"): an absent one says so, never the read time. */
export function milestoneTargetText(target: string | null): string {
  return target === null ? "No target" : target;
}

/**
 * The counts one milestone shows. Resolved and other-retired stay separate
 * (§4): waived, duplicate and superseded issues are retired obligations, never
 * delivered work.
 */
export function milestoneCountRows(milestone: ProjectMilestoneDTO): Array<{ label: string; value: string }> {
  return [
    { label: "Open issues", value: String(milestone.openIssues) },
    { label: "Resolved issues", value: String(milestone.resolvedIssues) },
    { label: "Retired without resolution (waived, duplicate, superseded)", value: String(milestone.otherRetiredIssues) },
    { label: "Linked issues total", value: String(milestone.totalIssues) },
  ];
}

/** The unassigned count is always named, on the empty branch too. */
export function unassignedIssuesLine(count: number): string {
  return count === 1
    ? "1 issue in this project is not assigned to any milestone."
    : `${count} issues in this project are not assigned to any milestone.`;
}

// ---------------------------------------------------------------------------
// Read freshness (§4/§6: store revisions authoritative, projection disclosed)
// ---------------------------------------------------------------------------

/** What the roadmap read was served at: the store revisions plus the projection block. */
export type RoadmapFreshness = {
  storeRevision: number;
  catalogRevision: number;
  projection: ReadProjection;
};

/**
 * The execution projection's state, named explicitly in every state (§4),
 * including `current`. Unknown timestamps are named, never replaced with the
 * current time.
 */
export function projectionStateLine(projection: ReadProjection): string {
  const generation = projection.generation === null ? "none" : String(projection.generation);
  const builtAt = projection.builtAt === null ? "none recorded" : projection.builtAt;
  const checkedAt = projection.checkedAt === "" ? "check time unknown" : projection.checkedAt;
  if (projection.freshness === "current") {
    return `current — generation ${generation} is published (last successful build ${builtAt}, last checked ${checkedAt}).`;
  }
  if (projection.freshness === "stale") {
    return `stale — retained generation ${generation} (last successful build ${builtAt}, last checked ${checkedAt}).`;
  }
  return "unavailable — no valid generation is published, so nothing is claimed about execution data.";
}

/**
 * The one line that keeps the two authorities apart (§4): milestone counts are
 * store data, so a stale or unavailable execution projection never invalidates
 * them.
 */
export function milestoneCountsLine(storeRevision: number): string {
  return `Milestone grouping and counts come from store revision ${storeRevision}; execution projection freshness does not change them.`;
}

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

/** Authority presence, not execution-projection freshness, determines roadmap state. */
export type RoadmapContent =
  | { kind: "not-found" }
  | { kind: "absent"; roadmap: RoadmapDTO }
  | { kind: "ready"; roadmap: RoadmapDTO };

export type RoadmapState = {
  content: RoadmapContent;
  /** The structured grouping, present whenever the project itself exists. */
  milestones: MilestoneGroups | null;
  freshness: RoadmapFreshness;
};

export function roadmapState(envelope: Envelope<RoadmapDTO | null>): RoadmapState {
  const roadmap = envelope.data;
  return {
    content: roadmap === null
      ? { kind: "not-found" }
      : roadmap.authority.state === "absent" ? { kind: "absent", roadmap } : { kind: "ready", roadmap },
    milestones: roadmap === null ? null : milestoneGroups(roadmap.milestones),
    freshness: {
      storeRevision: envelope.storeRevision,
      catalogRevision: envelope.catalogRevision,
      projection: envelope.projection,
    },
  };
}

/** The panel's whole state, including the two load branches a plain envelope cannot carry. */
export type RoadmapPanel =
  | { kind: "no-project" }
  | { kind: "loading" }
  | { kind: "refused"; message: string }
  | { kind: "ready"; state: RoadmapState };

/**
 * A refusal stays a refusal: the view never reads a structured store or schema
 * refusal (`store.*`, `milestone.schema-outdated`, …) as an empty roadmap.
 */
export function roadmapPanel(project: string | null, load: LoadState<RoadmapDTO | null>): RoadmapPanel {
  if (project === null) return { kind: "no-project" };
  if (load.status === "loading") return { kind: "loading" };
  if (load.status === "error") return { kind: "refused", message: load.message };
  return { kind: "ready", state: roadmapState(load.envelope) };
}

// ---------------------------------------------------------------------------
// Project entry (no project selected): the catalog's registered projects
// ---------------------------------------------------------------------------

/** The project list's content state, mirroring `iterationListState`. */
export type ProjectListState = { content: { kind: "empty" } | { kind: "listed"; total: number } };

/**
 * The project list is a catalog read (`needsProjection: false`), so it carries
 * no projection disclosure: the envelope's always-present projection health
 * block is not part of this list state, and a stale projection never empties
 * the catalog. The read is unpaged and complete, so `total` is the rendered
 * row count.
 */
export function projectListState(envelope: Envelope<ProjectListDTO>): ProjectListState {
  return { content: envelope.data.total === 0 ? { kind: "empty" } : { kind: "listed", total: envelope.data.total } };
}

/** The row's own link into that project's roadmap: the address-bar selection. */
function projectRoadmapHref(id: string): string {
  return `/?project=${encodeURIComponent(id)}#roadmap`;
}

/** The count-and-choice announcement; singular when there is exactly one. */
function projectListAnnouncement(total: number): string {
  return total === 1 ? "1 project. Choose it to view its roadmap." : `${total} projects. Choose one to view its roadmap.`;
}

const PROJECT_LIST_HINT = "Choose a project to view its stored roadmap. This list is read-only; make changes with the CLI.";
const EMPTY_CATALOG_COPY =
  "No projects are registered in the catalog. Use the CLI to register a project; this dashboard cannot create one.";

/** One project row: catalog identity plus the open-issue count, all read-only. */
function ProjectRow(props: { item: ProjectListItem }) {
  const item = props.item;
  const project = item.project;
  return html`<li class="history-item">
    <p class="history-head">
      <a href=${projectRoadmapHref(project.id)} aria-label=${`View roadmap for ${project.title}`}>${project.title}</a>
      <span class="mono">${project.id}</span>
    </p>
    <dl class="facts">
      <${Field} label="Catalog lifecycle"
        ><${Badge} tone=${catalogLifecycleTone(project.lifecycle)}>${project.lifecycle}</${Badge}></${Field}
      >
      <${Field} label="Open issues">${item.openIssues}</${Field}>
    </dl>
  </li>`;
}

/**
 * The no-project panel's whole render, hook-free so the copy contract and the
 * rendered rows are checkable from a `LoadState` alone (the `MilestoneCard`
 * precedent); `ProjectEntry` is only the read that feeds it.
 *
 * A refusal is never an empty catalog, and the loading state never borrows the
 * empty-catalog sentence.
 */
export function ProjectListPanel(props: { load: LoadState<ProjectListDTO> }) {
  const load = props.load;
  const state = load.status === "ready" ? projectListState(load.envelope) : null;
  const items = load.status === "ready" ? load.envelope.data.items : [];
  const announcement =
    load.status === "error"
      ? load.message
      : load.status === "loading"
        ? "Loading projects."
        : state?.content.kind === "empty"
          ? "No projects are registered in the catalog."
          : projectListAnnouncement(state?.content.kind === "listed" ? state.content.total : 0);

  return html`<${LiveRegion} message=${announcement} />
    ${load.status === "loading" ? html`<p class="hint">Loading projects…</p>` : null}
    ${load.status === "error" ? html`<${Notice} tone="error">${load.message}</${Notice}>` : null}
    ${state?.content.kind === "empty"
      ? html`<${EmptyState}><p class="prose">${EMPTY_CATALOG_COPY}</p></${EmptyState}>`
      : null}
    ${state?.content.kind !== "listed"
      ? null
      : html`<p class="hint">${PROJECT_LIST_HINT}</p>
          <ul class="history">
            ${items.map((item) => html`<${ProjectRow} key=${item.project.id} item=${item} />`)}
          </ul>`}`;
}

/** The no-project entry: one catalog read (`needsProjection: false`). */
function ProjectEntry() {
  return html`<${ProjectListPanel} load=${useEnvelope<ProjectListDTO>("/api/projects")} />`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function MilestoneIssues(props: { issues: MilestoneGroup["issues"] }) {
  const issues = props.issues;
  if (issues.length === 0) return html`<p class="hint">No issue is assigned to this milestone.</p>`;
  return html`<ul class="relations">
    ${issues.map(
      (issue) => html`<li key=${issue.id}>
        <p class="history-head">
          <span class="history-kind mono">${issue.id}</span>
          <${Badge} tone=${dispositionTone(issue.disposition)}>${issue.disposition}</${Badge}>
        </p>
        <p class="prose">${issue.title}</p>
      </li>`,
    )}
  </ul>`;
}

/** The four stored counts, compact enough to sit in one board column. */
function MilestoneCounts(props: { milestone: ProjectMilestoneDTO }) {
  return html`<ul class="board-counts">
    ${milestoneCountRows(props.milestone).map(
      (row) => html`<li key=${row.label} class="board-count">
        <span class="board-count-label">${row.label}</span>
        <span class="mono">${row.value}</span>
      </li>`,
    )}
  </ul>`;
}

/**
 * One board column: the milestone's stored name and id, its status, its
 * nullable target, its counts and — as the items — the issues assigned to it.
 * The milestone's status and an issue's disposition are store vocabulary, so
 * neither is derived from the historical document below the board.
 *
 * Hook-free so the column order, the item shape and the rendered text are
 * checkable from a group alone (`view-model.test.ts`, the panel precedent).
 */
export function MilestoneCard(props: { group: MilestoneGroup }) {
  const milestone = props.group.milestone;
  return html`<li class="board-column">
    <p class="board-column-head">
      <span class="history-kind">${milestone.name}</span>
      <span class="mono">${milestone.milestoneId}</span>
    </p>
    <dl class="facts">
      <${Field} label="Milestone status"><${Badge} tone="neutral">${milestone.status}</${Badge}></${Field}>
      <${Field} label="Target">${milestoneTargetText(milestone.target)}</${Field}>
    </dl>
    <${MilestoneCounts} milestone=${milestone} />
    <${MilestoneIssues} issues=${props.group.issues} />
  </li>`;
}

/**
 * The milestone board (issue 306): one column per milestone in the read's §4
 * ordinal order, plus the project's explicitly named unassigned column. The
 * unassigned count is the only unassigned data the envelope carries, so that
 * column names the count and never invents rows.
 *
 * Read-only by construction: the board renders stored data and nothing else —
 * no control, no link, no derivation across the two authorities.
 */
export function MilestoneBoard(props: MilestoneGroups) {
  return html`<ul class="board">
    ${props.groups.map((group) => html`<${MilestoneCard} key=${group.milestone.milestoneId} group=${group} />`)}
    <li class="board-column board-column-unassigned">
      <p class="board-column-head"><span class="history-kind">Unassigned issues</span></p>
      <p class="hint">${unassignedIssuesLine(props.unassignedIssues)}</p>
    </li>
  </ul>`;
}

/**
 * A section demoted below the board: the content authority's prose, kept
 * collapsed so the board stays the page's core visual. Native
 * `<details>`/`<summary>` keeps it keyboard-accessible with no script and no
 * custom control (DESIGN.md "Controls, focus and accessibility").
 */
function CollapsibleSection(props: { title: string; children: ComponentChildren }) {
  return html`<details class="collapsible detail-section">
    <summary class="collapsible-summary"><h2 class="heading-20">${props.title}</h2></summary>
    ${props.children}
  </details>`;
}

/**
 * The roadmap panel's body for a selected project, hook-free so the board, the
 * demoted content sections and the refusal render are checkable from a panel
 * alone. `RoadmapView` owns the no-project branch (`ProjectEntry` is the read).
 */
export function RoadmapBody(props: { project: string; panel: Exclude<RoadmapPanel, { kind: "no-project" }> }) {
  const project = props.project;
  const panel = props.panel;
  const state = panel.kind === "ready" ? panel.state : null;
  const roadmap = state === null || state.content.kind === "not-found" ? null : state.content.roadmap;
  const disclosure = state === null ? null : projectionDisclosure(state.freshness.projection);
  const groups = state === null ? null : state.milestones;
  const milestoneCount = groups === null ? 0 : groups.groups.length;
  const announcement =
    panel.kind === "refused"
      ? panel.message
      : panel.kind === "loading"
        ? "Loading roadmap."
        : state?.content.kind === "not-found"
          ? `Project ${project} was not found in the catalog.`
          : `${milestoneCount} milestones loaded.`;

  return html`<p class="hint">Project ${project} · Direction and the store's milestone grouping. Read-only: import or replace content with the roadmap CLI, add or update milestones with the milestone CLI.</p>
    <${LiveRegion} message=${announcement} />
    ${panel.kind === "loading" ? html`<p class="hint">Loading roadmap…</p>` : null}
    ${panel.kind === "refused" ? html`<${Notice} tone="error">${panel.message}</${Notice}>` : null}
    ${state?.content.kind === "not-found"
      ? html`<${EmptyState}><p class="prose">Project ${project} was not found in the catalog. Check the project id and try again.</p></${EmptyState}>`
      : null}
    ${state !== null && roadmap !== null
      ? html`<${DetailSection} title="Catalog"><${CatalogFacts} catalog=${roadmap.catalog} /></${DetailSection}>`
      : null}
    ${state !== null && groups !== null
      ? html`<${DetailSection} title="Milestones">
          <p class="hint">Milestones are stored records grouped with the issues assigned to them; a milestone's status and an issue's disposition come from the store, never from the historical document.</p>
          ${groups.groups.length === 0
            ? html`<p class="hint">No milestones are recorded for this project.</p>`
            : null}
          <div class="table-scroll" role="region" aria-label="Milestone board" tabindex="0">
            <${MilestoneBoard} groups=${groups.groups} unassignedIssues=${groups.unassignedIssues} />
          </div>
        </${DetailSection}>`
      : null}
    ${roadmap?.content != null
      ? html`<${CollapsibleSection} title="Direction">
            ${roadmap.content.direction === null
              ? html`<p class="prose">No direction text is recorded in the roadmap document.</p>`
              : html`<p class="prose">${roadmap.content.direction}</p>`}
          </${CollapsibleSection}>
          <${CollapsibleSection} title="Stored document (historical)">
            <p class="hint">Historical source text, kept verbatim: its goal checkboxes and frontmatter milestone names are not a live status source. Milestone status and issue counts come from the store, shown above.</p>
            <pre class="prose">${roadmap.content.contentMarkdown}</pre>
          </${CollapsibleSection}>`
      : null}
    ${roadmap === null && state?.content.kind === "absent"
      ? html`<${DetailSection} title="Stored document">
          <p class="prose">No roadmap content is stored for project ${project}. The milestone grouping above is stored independently and is unaffected. This is distinct from a store read failure.</p>
        </${DetailSection}>`
      : null}
    ${state !== null
      ? html`<${DetailSection} title="Store and projection freshness">
          <dl class="facts">
            <${Field} label="Store revision">${state.freshness.storeRevision}</${Field}>
            <${Field} label="Catalog revision">${state.freshness.catalogRevision}</${Field}>
            <${Field} label="Execution projection">${projectionStateLine(state.freshness.projection)}</${Field}>
          </dl>
          <p class="hint">${milestoneCountsLine(state.freshness.storeRevision)}</p>
          ${disclosure === null ? null : html`<${ProjectionNotice} disclosure=${disclosure} />`}
        </${DetailSection}>`
      : null}`;
}

export function RoadmapView() {
  const project = roadmapProject(window.location.search);
  const load = useEnvelope<RoadmapDTO | null>(
    project === null ? null : `/api/roadmap?${new URLSearchParams({ project }).toString()}`,
  );
  const panel = roadmapPanel(project, load);

  const heading = html`<h1 class="heading-28" id="roadmap-heading" tabindex="-1">Roadmap</h1>`;

  // No project selected: the catalog's project list. `ProjectEntry` is the read,
  // so it stays outside the hook-free body.
  if (project === null || panel.kind === "no-project") {
    return html`${heading}<${ProjectEntry} />`;
  }

  return html`${heading}<${RoadmapBody} project=${project} panel=${panel} />`;
}
