/**
 * `Projects` — the list (IA §8.2).
 *
 * Facts: title, id, catalog lifecycle, open-issue count, description when there
 * is one.
 *
 * `_default` is a real row with a real state. It is the project the store assigns
 * unattributed records to (compass D12), it has no roadmap row, and hiding it
 * would hide the fact that the harness keeps a default bucket at all. The
 * "no roadmap row" condition belongs to the roadmap feature's arm, not to this
 * list — a list has no feature body to degrade.
 */
import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { Panel, PanelBody } from "../components/Panel.tsx";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { ProjectListModel, ProjectRow } from "../view-model/projects.ts";
import type { Tone } from "../view-model/status.ts";
import css from "./Projects.module.css";

/** Every visible string this screen needs. Task 5 supplies them. */
export type ProjectsCopy = {
  pageTitle: string;
  tableCaption: string;
  columns: { title: string; id: string; lifecycle: string; openIssues: string; description: string };
  openIssues: (count: number) => string;
  noDescription: string;
  empty: { labelWord: string; heading: string; body: string; hint: string };
  unavailable: { labelWord: string; heading: string; body: string };
  absent: { labelWord: string; heading: string; body: string; pointer: string };
};

export type ProjectsProps = {
  model: ProjectListModel;
  copy: ProjectsCopy;
  onOpen?: (projectId: string) => void;
};

export function Projects(props: ProjectsProps) {
  const { model, copy } = props;

  const columns: DataTableColumn<ProjectRow>[] = [
    {
      key: "title",
      header: copy.columns.title,
      render: (row) => <TruncatedText text={row.title} />,
    },
    { key: "id", header: copy.columns.id, render: (row) => <span className={css.mono}>{row.projectId}</span> },
    {
      key: "lifecycle",
      header: copy.columns.lifecycle,
      secondary: true,
      render: (row) => <StatusDot label={row.lifecycle} tone={row.lifecycleTone} mono />,
    },
    {
      key: "openIssues",
      header: copy.columns.openIssues,
      secondary: true,
      align: "end",
      render: (row) => <span className={css.mono}>{copy.openIssues(row.openIssues)}</span>,
    },
    {
      key: "description",
      header: copy.columns.description,
      secondary: true,
      render: (row) =>
        row.description === null ? (
          <span className={css.muted}>{copy.noDescription}</span>
        ) : (
          <TruncatedText text={row.description} />
        ),
    },
  ];

  const meta = (row: ProjectRow) =>
    [row.lifecycle, copy.openIssues(row.openIssues), row.description ?? copy.noDescription].join(" · ");

  return (
    <article className={css.page} data-ms-screen="projects">
      <h1 className={css.title}>{copy.pageTitle}</h1>

      {model.rows.kind === "populated" ? (
        <Panel>
          <PanelBody tight={true}>
            <DataTable
              caption={copy.tableCaption}
              columns={columns}
              rows={model.rows.value}
              rowKey={(row) => row.projectId}
              meta={meta}
              onRowActivate={props.onOpen === undefined ? undefined : (row) => props.onOpen?.(row.projectId)}
            />
          </PanelBody>
        </Panel>
      ) : model.rows.kind === "unavailable" ? (
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
    </article>
  );
}
