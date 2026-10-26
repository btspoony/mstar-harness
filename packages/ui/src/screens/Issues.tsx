/**
 * `Issues` — the list (IA §8.2).
 *
 * Facts: id, title, severity, disposition, kind, project, milestone, last
 * activity; the existing filters (disposition, project, kind, severity, query,
 * paging). **No counters in a footer** — the totals that matter are the pager's
 * range and the filtered result line, both of which say what they count.
 *
 * The four absence states are the list's own state machine, and the two empty
 * ones are different facts (IA §5):
 *
 *   - `filtered-empty` — the filters matched nothing, and clearing them may help;
 *   - `store-empty`    — nothing exists at all, and clearing them will not help.
 *
 * Both come from `state.ts` / `listEmptyFamily`; the screen never picks an arm.
 */
import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { EmptyState, listEmptyFamily, type AbsenceArm } from "../components/EmptyState.tsx";
import { FilterBar, type AppliedFilter } from "../components/FilterBar.tsx";
import { LiveRegion } from "../components/LiveRegion.tsx";
import { Notice } from "../components/Notice.tsx";
import { Panel, PanelBody, PanelFoot, PanelHead } from "../components/Panel.tsx";
import { Pager } from "../components/Pager.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import {
  DEFAULT_ISSUE_FILTERS,
  activeIssueFilters,
  isDefaultIssueFilters,
  type IssueFilters,
  type IssueListModel,
  type IssueQuery,
  type IssueRow,
} from "../view-model/issues.ts";
import type { Tone } from "../view-model/status.ts";

/** The filter panel's accessible name; the head carries the id. */
const FILTERS_HEAD_ID = "ms-issues-filters";

/** Every visible string this screen needs. Task 5 supplies them. */
export type IssuesCopy = {
  pageTitle: string;
  /** The table's accessible caption. */
  tableCaption: string;
  columns: {
    id: string;
    title: string;
    severity: string;
    disposition: string;
    kind: string;
    project: string;
    milestone: string;
    lastActivity: string;
  };
  filters: {
    disposition: string;
    project: string;
    kind: string;
    severity: string;
    search: string;
    clear: string;
  };
  /** The option list for one filter; `""` is the "any" option, labelled here. */
  anyOption: string;
  /** The filter panel's head (`Filters`). */
  filtersHeading: string;
  /**
   * The result line in the screen head: `<disposition> across 4 projects`, or the
   * disposition alone when the page does not hold the whole set (see
   * `projectCount`). The disposition is the SELECTED one, so `resolved` is not
   * described as `open`.
   */
  scope: (disposition: string, projects: number | null) => string;
  /** The read's own ordering, stated so a reader knows what "first" means. */
  order: string;
  /** The result line: `26 issues`. */
  resultSummary: (total: number) => string;
  pager: { previous: string; next: string; range: (from: number, to: number, total: number) => string };
  /** The rows the current filter matched nothing for. */
  filteredEmpty: { labelWord: string; heading: string; body: string; hint: string };
  /** The store holds no issue at all. */
  storeEmpty: { labelWord: string; heading: string; body: string; hint: string };
  absent: { labelWord: string; heading: string; body: string; pointer: string };
  unavailable: { labelWord: string; heading: string; body: string };
};

export type IssuesProps = {
  model: IssueListModel;
  query: IssueQuery;
  copy: IssuesCopy;
  /** The value vocabularies the filter offers, in display order. */
  options: { disposition: readonly string[]; project: readonly string[]; kind: readonly string[]; severity: readonly string[] };
  /** Report a whole query change; the caller owns the address bar. */
  onQueryChange: (query: IssueQuery) => void;
  /** Open one issue; the caller owns routing. */
  onOpen?: (id: string) => void;
};

/** The filter fields, in the order the bar shows them. */
function filterFields(copy: IssuesCopy, options: IssuesProps["options"], filters: IssueFilters) {
  const build = (key: "disposition" | "project" | "kind" | "severity", values: readonly string[]) => ({
    key,
    label: copy.filters[key],
    value: filters[key],
    options: [{ value: "", label: copy.anyOption }, ...values.map((value) => ({ value, label: value }))],
  });
  return [
    build("disposition", options.disposition),
    build("project", options.project),
    build("kind", options.kind),
    build("severity", options.severity),
  ];
}

export function Issues(props: IssuesProps) {
  const { model, query, copy } = props;
  const filters = query.filters;
  const applied: AppliedFilter[] = activeIssueFilters(filters).map((entry) => ({
    key: entry.field,
    text: `${copy.filters[entry.field === "q" ? "search" : entry.field]}: ${entry.value}`,
  }));

  // The prototype's sequence (`design-v1.html:1199-1207`): ID, Title, Project, Kind,
  // Severity, Disposition, Last activity. The milestone is a product-only fact and
  // follows the project it belongs to; it is wide-only, so the 720px pane renders the
  // prototype's seven columns in the prototype's order.
  const columns: DataTableColumn<IssueRow>[] = [
    { key: "id", header: copy.columns.id, width: "10%", render: (row) => <span className={"mono t-12"}>{row.id}</span> },
    { key: "title", header: copy.columns.title, render: (row) => <TruncatedText text={row.title} /> },
    { key: "project", header: copy.columns.project, width: "15%", secondary: true, render: (row) => <span className={"mono t-12"}>{row.projectId}</span> },
    { key: "kind", header: copy.columns.kind, width: "13%", secondary: true, render: (row) => <span className={"mono t-12"}>{row.kind}</span> },
    {
      key: "severity",
      header: copy.columns.severity,
      width: "12%",
      secondary: true,
      render: (row) => <StatusDot label={row.severity} tone={row.severityTone} emphasis={row.severityEmphasised} mono />,
    },
    {
      key: "disposition",
      header: copy.columns.disposition,
      width: "12%",
      secondary: true,
      render: (row) => <StatusDot label={row.disposition} tone={row.dispositionTone} mono />,
    },
    {
      key: "milestone",
      header: copy.columns.milestone,
      width: "9%",
      secondary: true,
      wide: true,
      render: (row) => (row.milestoneId === null ? null : <span className={"mono t-12"}>{row.milestoneId}</span>),
    },
    {
      key: "lastActivity",
      header: copy.columns.lastActivity,
      width: "13%",
      secondary: true,
      align: "end",
      render: (row) => <span className={"mono t-12"}>{row.lastActivity}</span>,
    },
  ];

  /** The second line of a collapsed row: the facts the hidden columns carried. */
  const meta = (row: IssueRow) =>
    [row.projectId, row.kind, row.severity, row.disposition, row.milestoneId, row.lastActivity]
      .filter((part): part is string => part !== null && part !== "")
      .join(" · ");

  const filtered = !isDefaultIssueFilters(filters);
  const emptyCopy = filtered ? copy.filteredEmpty : copy.storeEmpty;
  const family = listEmptyFamily(filtered);

  return (
    <article className={"screen"} data-ms-screen="issues">
      <div className={"screen-head"}>
        <h1>{copy.pageTitle}</h1>
        {/* The prototype's screen meta: the count, its scope, and the ordering
            the read applies (`design-v1.html:1094-1101`). The count lives here
            AND in the filter row, so neither is the only place it appears. */}
        <div className={"screen-meta"} data-ms-summary="">
          <span className={"t-num"} data-ms-count={model.total}>
            {model.total}
          </span>
          <span data-ms-scope="">{copy.scope(filters.disposition, model.projectCount)}</span>
          <span aria-hidden="true">·</span>
          <span data-ms-order="">
            {copy.order}
          </span>
        </div>
      </div>

      <Panel labelledBy={FILTERS_HEAD_ID}>
        <PanelHead id={FILTERS_HEAD_ID} title={copy.filtersHeading} />
        <FilterBar
          fields={filterFields(copy, props.options, filters)}
          onFieldChange={(key, value) =>
            props.onQueryChange({
              // A filter change starts a new result set, so the offset resets.
              filters: { ...filters, [key]: value } as IssueFilters,
              offset: 0,
            })
          }
          search={{
            value: filters.q,
            placeholder: copy.filters.search,
            onChange: (value) => props.onQueryChange({ filters: { ...filters, q: value }, offset: 0 }),
          }}
          applied={applied}
          onClearFilter={(key) =>
            props.onQueryChange({
              filters: { ...filters, [key]: key === "disposition" ? DEFAULT_ISSUE_FILTERS.disposition : "" } as IssueFilters,
              offset: 0,
            })
          }
          onClearAll={() => props.onQueryChange({ filters: { ...DEFAULT_ISSUE_FILTERS }, offset: 0 })}
          clearLabel={copy.filters.clear}
          resultSummary={copy.resultSummary(model.total)}
        />
      </Panel>

      {/* The table is the second card, not a floating table under the first: the
          prototype's panel body with no padding of its own (`:215`, `.tight`), and
          its foot carrying the paging facts. */}
      <Panel>
        {model.rows.kind === "populated" ? (
          <>
            <PanelBody tight={true}>
              <DataTable
                caption={copy.tableCaption}
                columns={columns}
                rows={model.rows.value}
                rowKey={(row) => row.id}
                meta={meta}
                onRowActivate={props.onOpen === undefined ? undefined : (row) => props.onOpen?.(row.id)}
              />
            </PanelBody>
            <PanelFoot>
              <Pager
                total={model.total}
                offset={model.offset}
                pageSize={model.pageSize}
                onOffsetChange={(offset) => props.onQueryChange({ filters, offset })}
                previousLabel={copy.pager.previous}
                nextLabel={copy.pager.next}
                rangeLabel={copy.pager.range}
              />
            </PanelFoot>
            <LiveRegion message={copy.resultSummary(model.total)} />
          </>
        ) : model.rows.kind === "unavailable" ? (
          <PanelBody>
            <EmptyState
              arm="unavailable"
              labelWord={copy.unavailable.labelWord}
              heading={copy.unavailable.heading}
              body={copy.unavailable.body}
              reason={model.rows.reason}
            />
            <Notice reason={model.rows.reason} lead={copy.unavailable.heading} />
          </PanelBody>
        ) : (
          <PanelBody>
            <EmptyState
              arm={model.rows.kind as AbsenceArm}
              labelWord={emptyCopy.labelWord}
              heading={emptyCopy.heading}
              body={emptyCopy.body}
              hint={emptyCopy.hint}
              detail={model.rows.kind === "not-applicable" ? model.rows.reason : undefined}
              {...(model.rows.kind === "absent" ? { pointer: copy.absent.pointer } : {})}
            />
          </PanelBody>
        )}
      </Panel>

      {/* The family is exported so the dictionary pass can bind the two empties
          to different keys instead of flattening them into one. */}
      <span className={"visually-hidden"} data-ms-empty-family={family.family} />
    </article>
  );
}
