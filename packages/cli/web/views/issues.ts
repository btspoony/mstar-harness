/**
 * Issues view (plan 20260918-dashboard D3): the default landing — list,
 * filters and the detail with the recorded history.
 *
 * The engine owns the list order and every DTO field (D17: open-only, all
 * projects, severity rank desc → last real activity desc → ID asc); this module
 * derives view state and renders text. History is exactly the recorded events:
 * an imported closed issue shows capture + closure with its migration label, an
 * absent date stays "Date unknown", and no intermediate status, duration or
 * finding is ever synthesized.
 */
import type { IssueDetail, IssueFlow, IssuePage } from "@mstar-harness/engine";
import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

import { Badge, DetailSection, EmptyState, Field, LiveRegion, Notice, useEnvelope } from "../components";
import { dispositionTone, evidenceText, externalLinkHref, formatDate, migrationNote, severityTone } from "../format";

/**
 * The issue row types as the read boundary publishes them: the contract exports
 * the page and detail DTOs, and every child row type is derived from those
 * rather than declared a second time (state-projection contract §6).
 */
type IssueSummary = IssuePage["items"][number];
type IssueOccurrence = IssueDetail["occurrences"][number];
type IssueTransition = IssueDetail["transitions"][number];
type IssueProvenance = IssueDetail["provenance"][number];

/**
 * Contract vocabulary the filters offer (issue contract §2). The records are
 * the single source; insertion order is the option order and doubles as the
 * accepted-value lookup, so a filter never asks the API for a value the
 * contract does not define.
 */
const DISPOSITION_VALUES: Record<string, true> = {
  open: true,
  resolved: true,
  waived: true,
  duplicate: true,
  superseded: true,
};
const KIND_VALUES: Record<string, true> = {
  bug: true,
  risk: true,
  improvement: true,
  request: true,
  decision: true,
  "review-obligation": true,
};
const SEVERITY_VALUES: Record<string, true> = { critical: true, high: true, medium: true, low: true, info: true };

export const DISPOSITIONS = Object.keys(DISPOSITION_VALUES);
export const ISSUE_KINDS = Object.keys(KIND_VALUES);
export const SEVERITIES = Object.keys(SEVERITY_VALUES);

/** Fixed page size; the contract's own default (issue contract §5). */
const PAGE_SIZE = 50;

/** Dated history lives behind the issue-flow view (state-projection contract §6). */
const ISSUE_FLOW_PATH = "/api/issue-flow";

const FILTER_FIELDS = ["project", "disposition", "kind", "severity", "q"] as const;

export type IssueFilters = { project: string; disposition: string; kind: string; severity: string; q: string };
export type IssueQuery = { filters: IssueFilters; offset: number };

/** List defaults: open-only, all projects (D17). */
export const DEFAULT_ISSUE_FILTERS: IssueFilters = Object.freeze({
  project: "",
  disposition: "open",
  kind: "",
  severity: "",
  q: "",
});

const CLOSED_QUERY: IssueQuery = { filters: DEFAULT_ISSUE_FILTERS, offset: 0 };

const ACCEPTED: Record<"disposition" | "kind" | "severity", Record<string, true>> = {
  disposition: DISPOSITION_VALUES,
  kind: KIND_VALUES,
  severity: SEVERITY_VALUES,
};

/**
 * The address bar → applied query. An unknown enum value (or a malformed
 * offset) falls back to the default instead of being sent to the API, where it
 * would only be refused.
 */
export function parseIssueQuery(search: string): IssueQuery {
  const params = new URLSearchParams(search);
  const filters: IssueFilters = { ...DEFAULT_ISSUE_FILTERS };
  const project = params.get("project");
  if (project !== null) filters.project = project;
  for (const field of ["disposition", "kind", "severity"] as const) {
    const value = params.get(field);
    if (value !== null && ACCEPTED[field][value] === true) filters[field] = value;
  }
  const q = params.get("q");
  if (q !== null) filters.q = q;
  const rawOffset = params.get("offset");
  const offset = rawOffset !== null && /^[0-9]+$/.test(rawOffset) ? Number(rawOffset) : 0;
  return { filters, offset };
}

/** The applied query → the API/address-bar query string, in a fixed field order. */
export function issueQuery(query: IssueQuery): string {
  const params = new URLSearchParams();
  params.set("disposition", query.filters.disposition);
  if (query.filters.project !== "") params.set("project", query.filters.project);
  if (query.filters.kind !== "") params.set("kind", query.filters.kind);
  if (query.filters.severity !== "") params.set("severity", query.filters.severity);
  if (query.filters.q !== "") params.set("q", query.filters.q);
  params.set("limit", String(PAGE_SIZE));
  if (query.offset > 0) params.set("offset", String(query.offset));
  return params.toString();
}

/** True while nothing beyond the D17 default (open, all projects) is applied. */
export function isDefaultFilters(filters: IssueFilters): boolean {
  return FILTER_FIELDS.every((field) => filters[field] === DEFAULT_ISSUE_FILTERS[field]);
}

/**
 * Every issue the store has ever captured, from the recorded dates plus the
 * issues whose capture date is unknown. Used only to tell an empty store apart
 * from an empty filter result — never to fill in a missing date.
 */
export function capturedTotal(flow: IssueFlow): number {
  const last = flow.buckets[flow.buckets.length - 1];
  return (last?.capturedCumulative ?? 0) + flow.unknownCaptureDates;
}

function timeOf(lexeme: string | null): number | null {
  if (lexeme === null || lexeme === "") return null;
  const parsed = Date.parse(lexeme);
  return Number.isNaN(parsed) ? null : parsed;
}

/** An unknown date is not a date: nulls sort last in either direction. */
function byTime(left: number | null, right: number | null, direction: 1 | -1): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return (left - right) * direction;
}

export type OccurrenceRow = {
  kind: "Capture" | "Recurrence";
  occurrence: IssueOccurrence;
  /** The historical date only; `null` means unknown. */
  at: string | null;
  migration: string | null;
};

export type TransitionRow = {
  summary: string;
  transition: IssueTransition;
  at: string | null;
  migration: string | null;
};

/** The earliest recorded occurrence is the capture; later ones are recurrences. */
export function captureOccurrence(detail: IssueDetail): IssueOccurrence | null {
  let capture: IssueOccurrence | null = null;
  for (const occurrence of detail.occurrences) {
    if (capture === null || occurrence.id < capture.id) capture = occurrence;
  }
  return capture;
}

/** Occurrences newest-first: discovered date, then recorded date, then ID. */
export function occurrenceRows(detail: IssueDetail): OccurrenceRow[] {
  const capture = captureOccurrence(detail);
  const note = migrationNote(detail.provenance);
  return [...detail.occurrences]
    .sort((left, right) => {
      const byDate = byTime(timeOf(left.discoveredAt), timeOf(right.discoveredAt), -1);
      if (byDate !== 0) return byDate;
      const byRecorded = byTime(timeOf(left.recordedAt), timeOf(right.recordedAt), -1);
      if (byRecorded !== 0) return byRecorded;
      return right.id - left.id;
    })
    .map((occurrence) => ({
      kind: occurrence.id === capture?.id ? "Capture" : "Recurrence",
      occurrence,
      at: occurrence.discoveredAt,
      migration: occurrence.imported ? note : null,
    }));
}

/** Disposition transitions oldest-first: occurred date, then recorded date, then ID. */
export function transitionRows(detail: IssueDetail): TransitionRow[] {
  const note = migrationNote(detail.provenance);
  return [...detail.transitions]
    .sort((left, right) => {
      const byDate = byTime(timeOf(left.occurredAt), timeOf(right.occurredAt), 1);
      if (byDate !== 0) return byDate;
      const byRecorded = byTime(timeOf(left.recordedAt), timeOf(right.recordedAt), 1);
      if (byRecorded !== 0) return byRecorded;
      return left.id - right.id;
    })
    .map((transition) => ({
      summary: `${transition.fromDisposition} → ${transition.toDisposition}`,
      transition,
      at: transition.occurredAt,
      migration: transition.imported ? note : null,
    }));
}

function issueHref(id: string): string {
  return `#issue/${encodeURIComponent(id)}`;
}

function IssueRow(props: { issue: IssueSummary; onOpenIssue: (id: string) => void }) {
  const issue = props.issue;
  return html`<tr>
    <td class="col-id mono">${issue.id}</td>
    <td class="col-title">
      <a
        id=${`issue-link-${issue.id}`}
        href=${issueHref(issue.id)}
        onClick=${() => props.onOpenIssue(issue.id)}
        >${issue.title}</a
      >
      <span class="row-meta">
        <span class="mono">${issue.projectId}</span> · ${issue.kind} · Last activity
        ${formatDate(issue.lastActivity)}
      </span>
    </td>
    <td><${Badge} tone=${severityTone(issue.severity)}>${issue.severity}</${Badge}></td>
    <td><${Badge} tone=${dispositionTone(issue.disposition)}>${issue.disposition}</${Badge}></td>
    <td class="col-secondary">${issue.kind}</td>
    <td class="col-secondary mono">${issue.projectId}</td>
    <td class="col-secondary mono">${formatDate(issue.lastActivity)}</td>
  </tr>`;
}

function FilterControls(props: { filters: IssueFilters; onChange: (event: Event) => void; onClear: () => void }) {
  const filters = props.filters;
  return html`<form class="filters" onChange=${props.onChange} onSubmit=${(event: Event) => event.preventDefault()}>
    <div class="filter-field">
      <label for="filter-project">Project</label>
      <input id="filter-project" name="project" type="text" value=${filters.project} placeholder="All projects" />
    </div>
    <div class="filter-field">
      <label for="filter-disposition">Disposition</label>
      <select id="filter-disposition" name="disposition">
        ${DISPOSITIONS.map(
          (value) => html`<option key=${value} value=${value} selected=${value === filters.disposition}>${value}</option>`,
        )}
      </select>
    </div>
    <div class="filter-field">
      <label for="filter-kind">Kind</label>
      <select id="filter-kind" name="kind">
        <option value="" selected=${filters.kind === ""}>Any kind</option>
        ${ISSUE_KINDS.map((value) => html`<option key=${value} value=${value} selected=${value === filters.kind}>${value}</option>`)}
      </select>
    </div>
    <div class="filter-field">
      <label for="filter-severity">Severity</label>
      <select id="filter-severity" name="severity">
        <option value="" selected=${filters.severity === ""}>Any severity</option>
        ${SEVERITIES.map(
          (value) => html`<option key=${value} value=${value} selected=${value === filters.severity}>${value}</option>`,
        )}
      </select>
    </div>
    <div class="filter-field filter-field-wide">
      <label for="filter-q">Title or evidence</label>
      <input
        id="filter-q"
        name="q"
        type="text"
        value=${filters.q}
        maxLength=${200}
        aria-describedby="filter-q-hint"
      />
      <span class="hint" id="filter-q-hint">Literal text, up to 200 characters. No patterns.</span>
    </div>
    <button type="button" class="button-secondary" onClick=${props.onClear}>Clear Filters</button>
  </form>`;
}

export function IssuesView(props: {
  focusIssueId: string | null;
  onFocusRestored: () => void;
  onOpenIssue: (id: string) => void;
}) {
  const [query, setQuery] = useState<IssueQuery>(() => parseIssueQuery(window.location.search));
  const list = useEnvelope<IssuePage>(`/api/issues?${issueQuery(query)}`);

  // An empty result under the default filters cannot say whether the store is
  // empty or every issue is retired; the dated history answers that honestly.
  const probeStore = list.status === "ready" && list.envelope.data.total === 0 && isDefaultFilters(query.filters);
  const flow = useEnvelope<IssueFlow>(probeStore ? ISSUE_FLOW_PATH : null);
  const storeIsEmpty = flow.status === "ready" && capturedTotal(flow.envelope.data) === 0;

  const apply = (next: IssueQuery): void => {
    setQuery(next);
    window.history.replaceState(null, "", `?${issueQuery(next)}${window.location.hash}`);
  };

  const applyField = (event: Event): void => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const field = target.name as keyof IssueFilters;
    if (!FILTER_FIELDS.includes(field)) return;
    apply({ filters: { ...query.filters, [field]: target.value }, offset: 0 });
  };

  useEffect(() => {
    if (props.focusIssueId === null || list.status !== "ready") return;
    const link = document.getElementById(`issue-link-${props.focusIssueId}`);
    if (link === null) return;
    link.focus();
    props.onFocusRestored();
  }, [props.focusIssueId, list.status]);

  const items = list.status === "ready" ? list.envelope.data.items : [];
  const total = list.status === "ready" ? list.envelope.data.total : 0;
  const announcement =
    list.status === "error"
      ? list.message
      : list.status === "loading"
        ? "Loading issues."
        : total === 0
          ? "No issues listed."
          : `${total} issue${total === 1 ? "" : "s"} listed.`;

  return html`<h1 class="heading-28">Issues</h1>
    <${FilterControls} filters=${query.filters} onChange=${applyField} onClear=${() => apply(CLOSED_QUERY)} />
    <p class="hint">Listed by severity, then latest real activity, then ID.</p>
    <${LiveRegion} message=${announcement} />
    ${list.status === "loading" ? html`<p class="hint">Loading issues…</p>` : null}
    ${list.status === "error" ? html`<${Notice} tone="error">${list.message}</${Notice}>` : null}
    ${list.status === "ready" && items.length === 0
      ? html`<${EmptyState}>
          ${storeIsEmpty
            ? html`<p class="prose">No issues captured. Use the CLI to record a confirmed finding.</p>`
            : html`<p class="prose">No issues match these filters.</p>
              <button type="button" class="button-secondary" onClick=${() => apply(CLOSED_QUERY)}>Clear Filters</button>`}
        </${EmptyState}>`
      : null}
    ${items.length === 0
      ? null
      : html`<div class="table-scroll" role="region" aria-label="Issue list" tabindex="0">
            <table class="issue-table">
              <caption>
                Issues matching the current filters (${total})
              </caption>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Title</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Disposition</th>
                  <th scope="col" class="col-secondary">Kind</th>
                  <th scope="col" class="col-secondary">Project</th>
                  <th scope="col" class="col-secondary">Last activity</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((issue) => html`<${IssueRow} key=${issue.id} issue=${issue} onOpenIssue=${props.onOpenIssue} />`)}
              </tbody>
            </table>
          </div>
          <div class="pager">
            <button
              type="button"
              class="button-secondary"
              disabled=${query.offset === 0}
              onClick=${() => apply({ ...query, offset: Math.max(0, query.offset - PAGE_SIZE) })}
            >
              Previous
            </button>
            <p class="pager-summary">
              Showing ${query.offset + 1}–${query.offset + items.length} of ${total}
            </p>
            <button
              type="button"
              class="button-secondary"
              disabled=${query.offset + items.length >= total}
              onClick=${() => apply({ ...query, offset: query.offset + PAGE_SIZE })}
            >
              Next
            </button>
          </div>`}`;
}

function OccurrenceItem(props: { row: OccurrenceRow }) {
  const row = props.row;
  const occurrence = row.occurrence;
  return html`<li class="history-item">
    <p class="history-head">
      <span class="history-kind">${row.kind}</span>
      <span class="mono">${formatDate(row.at)}</span>
      ${row.occurrence.imported ? html`<${Badge} tone="terminal">Imported</${Badge}>` : null}
    </p>
    ${row.migration === null ? null : html`<p class="history-migration">${row.migration}</p>`}
    <dl class="facts">
      <${Field} label="Source"><span class="mono">${occurrence.sourceKind} · ${occurrence.sourceIdentity}</span></${Field}>
      <${Field} label="Location"><span class="mono">${occurrence.location}</span></${Field}>
      <${Field} label="Observed"><span class="prose">${occurrence.observedBehavior}</span></${Field}>
      <${Field} label="Recorded"><span class="mono">${formatDate(occurrence.recordedAt)}</span></${Field}>
    </dl>
    ${occurrence.evidence.length === 0
      ? null
      : html`<ul class="evidence">
          ${occurrence.evidence.map((line, index) => html`<li key=${index} class="prose">${line}</li>`)}
        </ul>`}
  </li>`;
}

function TransitionItem(props: { row: TransitionRow }) {
  const row = props.row;
  const transition = row.transition;
  const evidence = evidenceText(transition.evidence);
  return html`<li class="history-item">
    <p class="history-head">
      <span class="history-kind">${row.summary}</span>
      <span class="mono">${formatDate(row.at)}</span>
      ${transition.imported ? html`<${Badge} tone="terminal">Imported</${Badge}>` : null}
    </p>
    ${row.migration === null ? null : html`<p class="history-migration">${row.migration}</p>`}
    <dl class="facts">
      <${Field} label="Reason"><span class="prose">${transition.reason}</span></${Field}>
      ${transition.actor === null ? null : html`<${Field} label="Actor">${transition.actor}</${Field}>`}
      <${Field} label="Recorded"><span class="mono">${formatDate(transition.recordedAt)}</span></${Field}>
      <${Field} label="Revision"><span class="mono">${String(transition.issueRevision)}</span></${Field}>
    </dl>
    ${evidence === null ? null : html`<pre class="legacy-json mono">${evidence}</pre>`}
  </li>`;
}

export function IssueDetailView(props: { id: string }) {
  const detail = useEnvelope<IssueDetail>(`/api/issues/${encodeURIComponent(props.id)}`);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      window.location.hash = "#issues";
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.id]);

  if (detail.status === "error") {
    return html`<p class="back-link"><a href="#issues">Back to Issues</a></p>
      <h1 class="heading-28">Issue ${props.id}</h1>
      <${LiveRegion} message=${detail.message} />
      <${Notice} tone="error">${detail.message}</${Notice}>`;
  }
  if (detail.status === "loading") {
    return html`<p class="back-link"><a href="#issues">Back to Issues</a></p>
      <h1 class="heading-28">Issue ${props.id}</h1>
      <p class="hint">Loading issue…</p>`;
  }

  const issue = detail.envelope.data;
  const capture = captureOccurrence(issue);
  const migration = migrationNote(issue.provenance);
  const occurrences = occurrenceRows(issue);
  const transitions = transitionRows(issue);
  const externalHref = externalLinkHref(issue.url);

  return html`<p class="back-link"><a href="#issues">Back to Issues</a></p>
    <${LiveRegion} message=${`Issue ${issue.id} loaded.`} />
    <h1 class="heading-28">${issue.title}</h1>
    <p class="detail-id mono">${issue.id}</p>
    ${migration === null ? null : html`<p class="hint">Migrated record — ${migration}</p>`}
    <${DetailSection} title="Identity">
      <dl class="facts">
        <${Field} label="Project"><span class="mono">${issue.projectId}</span></${Field}>
        <${Field} label="Severity"><${Badge} tone=${severityTone(issue.severity)}>${issue.severity}</${Badge}></${Field}>
        <${Field} label="Disposition"
          ><${Badge} tone=${dispositionTone(issue.disposition)}>${issue.disposition}</${Badge}></${Field}
        >
        <${Field} label="Kind">${issue.kind}</${Field}>
        ${issue.owner === null ? null : html`<${Field} label="Owner">${issue.owner}</${Field}>`}
        <${Field} label="Registered"><span class="mono">${formatDate(issue.registeredAt)}</span></${Field}>
        ${issue.disposition === "open"
          ? null
          : html`<${Field} label="Closed"><span class="mono">${formatDate(issue.closedAt)}</span></${Field}>`}
        ${issue.closureNote === null ? null : html`<${Field} label="Closure note"><span class="prose">${issue.closureNote}</span></${Field}>`}
        ${issue.externalId === null ? null : html`<${Field} label="External ID"><span class="mono">${issue.externalId}</span></${Field}>`}
        <${Field} label="Revision"><span class="mono">${String(issue.revision)}</span></${Field}>
      </dl>
      ${externalHref === null ? null : html`<p class="external"><a href=${externalHref} rel="noreferrer noopener">${issue.url}</a></p>`}
    </${DetailSection}>
    ${capture === null
      ? null
      : html`<${DetailSection} title="Source">
          <dl class="facts">
            <${Field} label="Source kind">${capture.sourceKind}</${Field}>
            <${Field} label="Source identity"><span class="mono">${capture.sourceIdentity}</span></${Field}>
            <${Field} label="Location"><span class="mono">${capture.location}</span></${Field}>
            <${Field} label="Root cause key"><span class="mono">${capture.rootCauseKey}</span></${Field}>
            <${Field} label="Acceptance key"><span class="mono">${capture.acceptanceKey}</span></${Field}>
          </dl>
        </${DetailSection}>`}
    <${DetailSection} title="Impact"><p class="prose">${issue.impact}</p></${DetailSection}>
    <${DetailSection} title="Acceptance"><p class="prose">${issue.acceptance}</p></${DetailSection}>
    <${DetailSection} title="Occurrences">
      ${occurrences.length === 0
        ? html`<p class="prose">No occurrences recorded for this issue.</p>`
        : html`<ul class="history">
            ${occurrences.map((row) => html`<${OccurrenceItem} key=${row.occurrence.id} row=${row} />`)}
          </ul>`}
    </${DetailSection}>
    <${DetailSection} title="Disposition history">
      ${transitions.length === 0
        ? html`<p class="prose">No disposition transitions recorded for this issue.</p>`
        : html`<ul class="history">
            ${transitions.map((row) => html`<${TransitionItem} key=${row.transition.id} row=${row} />`)}
          </ul>`}
    </${DetailSection}>
    <${DetailSection} title="Relations">
      ${issue.relations.length === 0
        ? html`<p class="prose">No relations recorded for this issue.</p>`
        : html`<ul class="relations">
            ${issue.relations.map(
              (relation) => html`<li key=${`${relation.fromIssue}\u0000${relation.relation}\u0000${relation.toIssue}`}>
                <a class="mono" href=${issueHref(relation.fromIssue)}>${relation.fromIssue}</a>
                ${relation.relation}
                <a class="mono" href=${issueHref(relation.toIssue)}>${relation.toIssue}</a>
              </li>`,
            )}
          </ul>`}
    </${DetailSection}>
    ${issue.provenance.length === 0
      ? null
      : html`<${DetailSection} title="Provenance">
          <ul class="relations">
            ${issue.provenance.map(
              (entry: IssueProvenance) => html`<li key=${entry.id}>
                <dl class="facts">
                  <${Field} label="Kind">${entry.kind}</${Field}>
                  <${Field} label="Target"><span class="mono">${entry.target}</span></${Field}>
                  <${Field} label="Source hash"><span class="mono">${entry.sourceHash}</span></${Field}>
                  ${entry.legacyProject === null ? null : html`<${Field} label="Legacy project">${entry.legacyProject}</${Field}>`}
                  ${entry.legacyBucket === null ? null : html`<${Field} label="Legacy bucket">${entry.legacyBucket}</${Field}>`}
                  ${entry.legacyEntryId === null ? null : html`<${Field} label="Legacy entry">${entry.legacyEntryId}</${Field}>`}
                  ${entry.importedAt === null
                    ? null
                    : html`<${Field} label="Imported"><span class="mono">${formatDate(entry.importedAt)}</span></${Field}>`}
                </dl>
                ${entry.legacyJson === null ? null : html`<pre class="legacy-json mono">${entry.legacyJson}</pre>`}
              </li>`,
            )}
          </ul>
        </${DetailSection}>`}`;
}
