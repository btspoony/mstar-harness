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
import { Panel, PanelBody, PanelFoot, PanelHead } from "../components/Panel.tsx";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { ProjectListModel, ProjectRow } from "../view-model/projects.ts";
import type { Tone } from "../view-model/status.ts";
import type { KeyboardEvent } from "react";

/** The project list card's own head. */
const LIST_HEAD_ID = "ms-projects-list";

/** Every visible string this screen needs. Task 5 supplies them. */
export type ProjectsCopy = {
  pageTitle: string;
  tableCaption: string;
  /** The list card's head and its one-line instruction. */
  listHeading: string;
  listMeta: string;
  /** The prototype's footer: lifecycle is catalog, not execution. */
  lifecycleNote: string;
  /** Said instead of a lifecycle when the catalog records none. */
  noLifecycle: string;
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

  // The prototype's sequence (`design-v1.html:1752-1758`): the id first, then the
  // catalog title, then the lifecycle.
  const columns: DataTableColumn<ProjectRow>[] = [
    { key: "id", header: copy.columns.id, width: "24%", render: (row) => <span className={"mono t-12"}>{row.projectId}</span> },
    {
      key: "title",
      header: copy.columns.title,
      render: (row) => <TruncatedText text={row.title} />,
    },
    {
      key: "lifecycle",
      header: copy.columns.lifecycle,
      width: "9%",
      secondary: true,
      render: (row) => <StatusDot label={row.lifecycle} tone={row.lifecycleTone} mono />,
    },
    {
      key: "openIssues",
      header: copy.columns.openIssues,
      width: "15%",
      secondary: true,
      align: "end",
      render: (row) => <span className={"mono t-12"}>{row.openIssuesText}</span>,
    },
    {
      key: "description",
      header: copy.columns.description,
      width: "8%",
      secondary: true,
      render: (row) =>
        row.description === null ? (
          <span className={"muted"}>{copy.noDescription}</span>
        ) : (
          <TruncatedText text={row.description} />
        ),
    },
  ];

  const meta = (row: ProjectRow) =>
    [row.lifecycle, copy.openIssues(row.openIssues), row.description ?? copy.noDescription].join(" · ");

  return (
    <article className={"screen"} data-ms-screen="projects">
      {/* The prototype heads every screen with `.screen-head`; `.screen-head h1`
          carries the 16/24/600 title rule, and a bare h1 falls back to the
          document heading instead. */}
      <div className="screen-head">
        <h1>{copy.pageTitle}</h1>
      </div>

      {model.rows.kind === "populated" ? (
        <Panel labelledBy={LIST_HEAD_ID}>
          <PanelHead id={LIST_HEAD_ID} title={copy.listHeading} meta={copy.listMeta} />
          <PanelBody tight={true}>
            {/* The prototype lists projects as rows, not as a table: a dot, the name,
                the store's id, the description, then the open count and the arrow. */}
            {model.rows.value.map((row) => {
              const activate = props.onOpen === undefined ? undefined : () => props.onOpen?.(row.projectId);
              return (
                <div
                  key={row.projectId}
                  className="rm-project-row"
                  data-ms-project={row.projectId}
                  {...(activate === undefined
                    ? {}
                    : {
                        role: "link",
                        tabIndex: 0,
                        onClick: activate,
                        onKeyDown: (event: KeyboardEvent) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            activate();
                          }
                        },
                      })}
                >
                  <StatusDot label={row.lifecycle === "" ? copy.noLifecycle : row.lifecycle} tone={row.lifecycleTone} />
                  <span className="rm-project-name">{row.title}</span>
                  <span className="mono t-11 muted">{row.projectId}</span>
                  <span className="rm-project-desc trunc" title={row.description ?? copy.noDescription}>
                    {row.description ?? copy.noDescription}
                  </span>
                  <span className="mono t-12">{copy.openIssues(row.openIssues)}</span>
                  <span className="muted" aria-hidden="true">→</span>
                </div>
              );
            })}
          </PanelBody>
          <PanelFoot>
            <span className="muted t-11" data-ms-project-note="">{copy.lifecycleNote}</span>
          </PanelFoot>
        </Panel>
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
