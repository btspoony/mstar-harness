/**
 * `Workflows` — the list (IA §8.2).
 *
 * Facts: id, catalog title, projected status · phase, the root-register fact
 * (`rootKind:relativePath`), the projected updated time, plan `done/total`, and
 * `execution-unavailable` **as a reason** where it applies.
 *
 * Not rendered, and asserted negatively: plan leases, terminal-adoption audit
 * rows and the catalog-pin badges (`catalog-missing`, `catalog-pin-missing`,
 * `catalog-pin-conflict`). §8.1 removes them as join bookkeeping — a plan's status
 * already says whether it is being worked, and the only badge that survives is
 * the one that explains a degradation.
 *
 * **Truncation is disclosed from `total`**, never from the page length: the store
 * reports an unpaged count, and a page that reported its own length as the total
 * would claim a truncated page is the whole store.
 */
import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { Panel, PanelBody, PanelFoot, PanelHead } from "../components/Panel.tsx";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { FilterBar, type AppliedFilter } from "../components/FilterBar.tsx";
import { Notice } from "../components/Notice.tsx";
import { DEFAULT_WORKFLOW_FILTERS, type WorkflowFilters } from "../view-model/workflows.ts";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { WorkflowListModel, WorkflowRow } from "../view-model/workflows.ts";
import type { Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type WorkflowsCopy = {
  pageTitle: string;
  /** The head's own count: `4 workflows`. */
  totalMeta: (n: number) => string;
  /** And how many the store still counts as a registration. */
  activeRegistrationsMeta: (n: number) => string;
  /** The head's closing segment: `projected from store rev 1224`. */
  projectedFrom: (revision: number) => string;
  tableCaption: string;
  columns: {
    id: string;
    title: string;
    status: string;
    root: string;
    updated: string;
    plans: string;
    /** The prototype's `Join badges` column. */
    badges: string;
  };
  plansProgress: (done: number, total: number) => string;
  /** The filter card's own head. */
  filters: {
    status: string;
    type: string;
    search: string;
    clear: string;
    any: string;
    results: (shown: number, total: number) => string;
  };
  /** The prototype's footer: how many rows the registry does not carry. */
  registryNote?: (terminal: number) => string;
  /** The disclosure when `total` exceeds the rows shown. */
  truncated: (shown: number, total: number) => string;
  noCatalogTitle: string;
  noRoot: string;
  /** `execution-unavailable` rendered as a reason, not as a chip. */
  executionUnavailable: string;
  empty: { labelWord: string; heading: string; body: string; hint: string };
  unavailable: { labelWord: string; heading: string; body: string };
  /** Used both for the `not-applicable` arm (with `detail`) and for `absent`. */
  absent: { labelWord: string; heading: string; body: string; pointer: string };
};

export type WorkflowsProps = {
  model: WorkflowListModel;
  copy: WorkflowsCopy;
  onOpen?: (id: string) => void;
  /** The current filter state; absent means unfiltered (a host without filters). */
  filters?: WorkflowFilters;
  onFiltersChange?: (filters: WorkflowFilters) => void;
  /**
   * The store revision this page was projected from — the prototype's head ends with it.
   * Absent when the host cannot state it, and then the segment is left out rather than
   * guessed.
   */
  storeRevision?: number;
};

/** The filter panel's accessible name; the head carries the id. */
const FILTERS_HEAD_ID = "ms-workflows-filters";

/** The two selects, built from the values the current rows carry. */
function filterFields(copy: WorkflowsCopy, options: WorkflowListModel["options"], filters: WorkflowFilters) {
  const build = (key: "status" | "type", values: readonly string[]) => ({
    key,
    label: copy.filters[key],
    value: filters[key],
    options: [{ value: "", label: copy.filters.any }, ...values.map((value) => ({ value, label: value }))],
  });
  return [build("status", options.status), build("type", options.type)];
}

/** The chips for whatever is narrowing the list, so clearing is one click. */
function appliedFilters(copy: WorkflowsCopy, filters: WorkflowFilters): AppliedFilter[] {
  const out: AppliedFilter[] = [];
  if (filters.status !== "") out.push({ key: "status", text: `${copy.filters.status}: ${filters.status}` });
  if (filters.type !== "") out.push({ key: "type", text: `${copy.filters.type}: ${filters.type}` });
  if (filters.q.trim() !== "") out.push({ key: "q", text: filters.q });
  return out;
}

export function Workflows(props: WorkflowsProps) {
  const { model, copy } = props;
  const filters = props.filters ?? DEFAULT_WORKFLOW_FILTERS;
  // `null` when the rows could not be read: a count of an unread list is not a fact.
  const activeRegistrations =
    model.rows.kind === "populated"
      ? model.rows.value.filter((row) => row.activeRegistration).length
      : null;

  const columns: DataTableColumn<WorkflowRow>[] = [
    { key: "id", header: copy.columns.id, width: "282px", render: (row) => <span className={"mono t-12"}>{row.id}</span> },
    {
      key: "title",
      header: copy.columns.title,
      render: (row) => <TruncatedText text={row.title ?? copy.noCatalogTitle} />,
    },
    {
      key: "status",
      header: copy.columns.status,
      width: "200px",
      render: (row) => (
        <span>
          <StatusDot label={row.status} tone={row.statusTone} mono />
          {row.phase === null ? null : <span className={"chip"}>{row.phase}</span>}
        </span>
      ),
    },
    {
      key: "root",
      header: copy.columns.root,
      width: "150px",
      secondary: true,
      render: (row) =>
        row.root === null ? <span className={"muted"}>{copy.noRoot}</span> : <span className={"mono t-12"}>{row.root}</span>,
    },
    {
      key: "updated",
      header: copy.columns.updated,
      width: "140px",
      secondary: true,
      align: "end",
      render: (row) => <span className={"mono t-12"}>{row.updatedAt}</span>,
    },
    {
      // The prototype's `Join badges`: the store's own join bookkeeping, said in words.
      key: "badges",
      header: copy.columns.badges,
      width: "190px",
      secondary: true,
      render: (row) =>
        row.badges.length === 0 ? (
          <span className={"muted"}>—</span>
        ) : (
          <span className={"chips"}>
            {row.badges.map((badge) => (
              // The prototype's two tones: a conflict is the store disagreeing with
              // itself, a missing pin is an absence. The word is always present.
              <span key={badge} className={badge.includes("conflict") ? "badge conflict" : "badge missing"}>
                {badge}
              </span>
            ))}
          </span>
        ),
    },
  ];

  const meta = (row: WorkflowRow) =>
    [row.phase, row.root ?? copy.noRoot, row.updatedAt, copy.plansProgress(row.plansDone, row.plansTotal)]
      .filter((part): part is string => part !== null)
      .join(" · ");

  return (
    <article className={"screen"} data-ms-screen="workflows">
      {/* The prototype heads every screen with `.screen-head`; `.screen-head h1`
          carries the 16/24/600 title rule, and a bare h1 falls back to the
          document heading instead. */}
      <div className="screen-head">
        <h1>{copy.pageTitle}</h1>
        {/* The prototype's head states the store's count, not the page's, then how many of
            these rows the store still counts as a registration. */}
        <div className="screen-meta">
          <span data-ms-count="">{copy.totalMeta(model.total)}</span>
          {activeRegistrations === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span data-ms-active-registrations="">{copy.activeRegistrationsMeta(activeRegistrations)}</span>
            </>
          )}
          {props.storeRevision === undefined ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span data-ms-projected-from="">{copy.projectedFrom(props.storeRevision)}</span>
            </>
          )}
        </div>
      </div>

      {model.rows.kind === "populated" ? (
        <>
          <Panel labelledBy={FILTERS_HEAD_ID}>
            <PanelHead id={FILTERS_HEAD_ID}>
            <FilterBar
              fields={filterFields(copy, model.options, filters)}
              onFieldChange={(key, value) => props.onFiltersChange?.({ ...filters, [key]: value })}
              search={{
                value: filters.q,
                placeholder: copy.filters.search,
                onChange: (value) => props.onFiltersChange?.({ ...filters, q: value }),
              }}
              applied={appliedFilters(copy, filters)}
              onClearFilter={(key) =>
                props.onFiltersChange?.({ ...filters, [key]: "" } as WorkflowFilters)
              }
              onClearAll={() => props.onFiltersChange?.({ ...DEFAULT_WORKFLOW_FILTERS })}
              clearLabel={copy.filters.clear}
              resultSummary={copy.filters.results(model.shown, model.total)}
            />
            </PanelHead>
            {/* No PanelBody around the table: the prototype's `.table-wrap` is a direct
                child of `.panel`, so the table draws its own full-bleed surface. */}
            <DataTable
              caption={copy.tableCaption}
              columns={columns}
              rows={model.rows.value}
              rowKey={(row) => row.id}
              meta={meta}
              onRowActivate={props.onOpen === undefined ? undefined : (row) => props.onOpen?.(row.id)}
            />
            {model.terminalUnregistered === 0 ? null : (
              // The prototype's footer states what the registry does not carry, so a
              // reader knows the four rows are not the whole store.
              <PanelFoot>
                <span className="muted t-11" data-ms-terminal-unregistered={model.terminalUnregistered}>
                  {copy.registryNote?.(model.terminalUnregistered) ??
                    `${model.terminalUnregistered} terminal workflows not in the active registry`}
                </span>
              </PanelFoot>
            )}
          </Panel>
          {model.truncated ? (
            <p data-ms-truncated={model.total}>
              {copy.truncated(model.shown, model.total)}
            </p>
          ) : null}
          {/* A degradation reason, stated once per row that carries it. */}
          {/* `flatMap`, not `filter().map()`: the narrowing survives inside the
              callback, so the reason is a string here rather than a cast. */}
          {model.rows.value.flatMap((row) =>
            row.executionUnavailableReason === null
              ? []
              : [<Notice key={row.id} reason={row.executionUnavailableReason} lead={row.id} />],
          )}
        </>
      ) : (
        <Panel>
          <PanelBody>
            {model.rows.kind === "unavailable" ? (
              <EmptyState
                arm="unavailable"
                labelWord={copy.unavailable.labelWord}
                heading={copy.unavailable.heading}
                body={copy.unavailable.body}
                reason={model.rows.reason}
              />
            ) : model.rows.kind === "not-applicable" ? (
              <EmptyState
                arm="not-applicable"
                labelWord={copy.absent.labelWord}
                heading={copy.absent.heading}
                body={copy.absent.body}
                detail={model.rows.reason}
              />
            ) : (
              <EmptyState
                arm={model.rows.kind as AbsenceArm}
                labelWord={copy.empty.labelWord}
                heading={copy.empty.heading}
                body={copy.empty.body}
                hint={model.rows.kind === "empty" ? copy.empty.hint : undefined}
                pointer={model.rows.kind === "absent" ? copy.absent.pointer : undefined}
              />
            )}
          </PanelBody>
        </Panel>
      )}
    </article>
  );
}
