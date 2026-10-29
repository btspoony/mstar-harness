/**
 * `Projects` and `ProjectDetail` — the only place the product hierarchy is
 * expressed.
 *
 * The load-bearing assertions:
 *
 *  - the feature set is the fixed three, in order, and `Roadmap` is the default;
 *  - a project with no roadmap row renders the `absent` arm, not an empty board —
 *    and a project that *has* a roadmap with no milestones renders `empty`, which
 *    the two tests keep from collapsing into one string;
 *  - the scoped lists carry a chip naming the project, and clearing it is a model
 *    operation (the screen does not own the scope);
 *  - no envelope counter reaches either page.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectListDTO, RoadmapDTO } from "@mstar-harness/engine";

import {
  DEFAULT_PROJECT_FEATURE,
  PROJECT_FEATURES,
  projectIdentity,
  projectListModel,
  roadmapBody,
  roadmapFeatureArm,
} from "../view-model/projects.ts";
import type { Resolved } from "../view-model/state.ts";
import type { RoadmapModel } from "../view-model/projects.ts";
import { Projects, type ProjectsCopy } from "./Projects.tsx";
import {
  ASSIGNABLE_ISSUE_LIMIT,
  ProjectDetail as ProjectDetailScreen,
  type ProjectDetailCopy,
  type ProjectDetailProps,
} from "./ProjectDetail.tsx";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

const catalogEntry = (over: Record<string, unknown> = {}) =>
  ({
    kind: "project",
    id: "engine",
    title: "Engine",
    description: "Store, projection and gates",
    rootKind: "projects",
    relativePath: "engine",
    documentKind: null,
    lifecycle: "active",
    revision: 12,
    registeredAt: "2026-08-09T02:00:00.000Z",
    updatedAt: "2026-10-23T09:42:00.000Z",
    ...over,
  }) as NonNullable<RoadmapDTO["catalog"]>;

const roadmap = (over: Partial<RoadmapDTO> = {}): RoadmapDTO => ({
  projectId: "engine",
  catalog: catalogEntry(),
  authority: { state: "present", revision: 7, contentHash: "sha256:abcd1234" },
  content: {
    contentMarkdown: "## Direction\n\nOne product, two hosts.",
    frontmatter: { project_id: "engine", title: "Engine roadmap", status: "active" as const, created_at: "2026-08-09" },
    direction: "One product, two hosts.",
    goals: [
      { ordinal: 1, parentOrdinal: null, checked: true, title: "One design system", body: "" },
      { ordinal: 2, parentOrdinal: 1, checked: false, title: "One token contract", body: "" },
      { ordinal: 3, parentOrdinal: null, checked: false, title: "Two hosts", body: "" },
    ],
    milestones: ["Release the shared layer"],
    sections: [],
  },
  milestones: {
    projectId: "engine",
    milestones: [
      {
        milestoneId: "9f2c4a10",
        projectId: "engine",
        name: "Release the shared layer",
        target: "2026-11-07",
        status: "active",
        ordinal: 0,
        revision: 2,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        totalIssues: 10,
        openIssues: 4,
        resolvedIssues: 6,
        otherRetiredIssues: 0,
      },
    ],
    issues: [
      { id: "I-000870", title: "Tone disagrees", acceptance: "", disposition: "open", revision: 1, milestoneId: "9f2c4a10" },
      { id: "I-000871", title: "Unassigned one", acceptance: "", disposition: "open", revision: 1, milestoneId: "" },
    ],
    unassignedIssues: 3,
  },
  ...over,
});

const projectsCopy: ProjectsCopy = {
  pageTitle: "Projects",
  totalMeta: (n) => `${n} ${n === 1 ? "project" : "projects"}`,
  openIssuesMeta: (n) => `${n} open ${n === 1 ? "issue" : "issues"}`,
  headNote: "a project owns its roadmap, issues and iterations",
  tableCaption: "Projects",
  columns: { title: "Title", id: "ID", lifecycle: "Lifecycle", openIssues: "Open", description: "Description" },
  openIssues: (count) => `${count} open`,
  noDescription: "—",
  empty: { labelWord: "empty", heading: "No projects", body: "none registered", hint: "register one" },
  unavailable: { labelWord: "unavailable", heading: "Projects", body: "the read failed" },
  absent: { labelWord: "absent", heading: "Projects", body: "not declared", pointer: "see the store" },
};

const renderList = (items: ProjectListDTO["items"], total = items.length, generation: number | null = 7): string =>
  renderToStaticMarkup(
    <Projects
      model={projectListModel({ data: { items, total }, projection: { ...projection, generation } })}
      copy={projectsCopy}
    />,
  );

const detailCopy: ProjectDetailCopy = {
  roadmapState: "roadmap present",
  revisionLabel: "Revision",
  openIssuesUnit: "open issues",
  breadcrumb: { label: "Breadcrumb", trail: "Projects" },
  tabLabel: "Features",
  features: { roadmap: "Roadmap", issues: "Issues", iterations: "Iterations" },
  roadmap: {
    milestonesHeading: "Milestones",
    milestonesUnit: "milestones",
    unassignedUnit: "unassigned issues",
    milestoneProgress: (done, total) => `${done}/${total}`,
    milestoneOpen: (open) => `${open} open`,
    countLabels: { open: "open", resolved: "resolved", retired: "retired without resolution", total: "total" },
    noTarget: "no target",
    unassigned: (count) => `${count} unassigned`,
    writes: {
      create: "Create",
      nameLabel: "Milestone name",
      targetLabel: "Target",
      statusLabel: "Status",
      edit: "Edit",
      save: "Save",
      cancel: "Cancel",
      assign: "Assign issues",
      unassign: "Unassign",
      assignCap: "Showing the first 50 unassigned open issues.",
      remove: "Remove",
      removeConfirm: "Remove this milestone?",
      refusalLead: "The store refused the change:",
    },
    timelineUnassigned: "unassigned",
    timelineUnassignedIssues: (count) => `${count} issues`,
    absentNextStep: (features) => `Available: ${features}`,
  },
  scope: { label: (id) => `project: ${id}`, clear: "Clear the project scope" },
  absence: {
    absent: { labelWord: "absent", heading: "Roadmap", body: "this project declares no roadmap", pointer: "x" },
    empty: { labelWord: "empty", heading: "Milestones", body: "the roadmap has no milestones", hint: "add one" },
    unavailable: { labelWord: "unavailable", heading: "Roadmap", body: "the read failed" },
    "not-applicable": { labelWord: "n/a", heading: "Roadmap", body: "no project resolves" },
  },
};

const renderDetail = (
  input: {
    roadmap?: Resolved<RoadmapModel>;
    feature?: "roadmap" | "issues" | "iterations";
    identity?: ReturnType<typeof projectIdentity>;
    writes?: ProjectDetailProps["writes"];
    assignableIssues?: ProjectDetailProps["assignableIssues"];
  },
  onClearScope?: () => void,
): string =>
  renderToStaticMarkup(
    <ProjectDetailScreen
      identity={input.identity ?? projectIdentity(catalogEntry())}
      feature={input.feature ?? DEFAULT_PROJECT_FEATURE}
      onFeatureChange={() => {}}
      roadmap={input.roadmap ?? roadmapBody(roadmapFeatureArm({ data: roadmap(), projection }))}
      issues={<div data-ms-scoped-list="issues" />}
      iterations={<div data-ms-scoped-list="iterations" />}
      copy={detailCopy}
      {...(input.writes === undefined ? {} : { writes: input.writes })}
      {...(input.assignableIssues === undefined ? {} : { assignableIssues: input.assignableIssues })}
      onBack={() => {}}
      onClearScope={onClearScope}
    />,
  );

describe("Projects list — the facts of §8.2", () => {
  const items = [
    { project: catalogEntry(), openIssues: 14 },
    { project: catalogEntry({ id: "_default", title: "_default", description: null, lifecycle: "active" }), openIssues: 0 },
  ];
  const html = renderList(items);

  test("title, id, lifecycle, open count and description", () => {
    for (const expected of ["Engine", "engine", "active", "14 open", "Store, projection and gates"]) {
      expect(html).toContain(expected);
    }
  });

  test("a project without a description says so rather than rendering an empty cell", () => {
    expect(html).toContain("_default");
    expect(html).toContain("—");
  });

  test("_default is a real row, not a hidden one", () => {
    // It is the store's bucket for unattributed records (D12). Hiding it would
    // hide that the harness keeps one at all.
    // The list is the prototype's row list now, not a DataTable: the same hook rides
    // the row element rather than a `data-ms-row-key`.
    expect(html).toContain('data-ms-project="_default"');
  });

  test("NEGATIVE: no counter from the read envelope", () => {
    for (const counter of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "revision", "sourceHash"]) {
      expect(html).not.toContain(counter);
    }
  });
});

describe("ProjectDetail — the fixed feature set", () => {
  const html = renderDetail({});

  test("the three features render in the fixed order", () => {
    const positions = ["Roadmap", "Issues", "Iterations"].map((label) => html.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html.match(/role="tab"/g)?.length).toBe(3);
  });

  test("Roadmap is the default for every project, by constant not by content", () => {
    expect(DEFAULT_PROJECT_FEATURE).toBe("roadmap");
    expect(PROJECT_FEATURES).toEqual(["roadmap", "issues", "iterations"]);
    // The default renders the roadmap body even though Issues has more content.
    expect(html).toContain('data-ms-feature="roadmap"');
    expect(html).toContain('aria-selected="true"');
  });

  test("it never auto-selects a feature that has content", () => {
    const withEmptyRoadmap = renderDetail({
      roadmap: roadmapBody(roadmapFeatureArm({ data: roadmap({ authority: { state: "absent" } }), projection })),
    });
    // The roadmap is absent and Issues would have content — the tab must not move.
    expect(withEmptyRoadmap).toContain('data-ms-absence="absent"');
    expect(withEmptyRoadmap).not.toContain('data-ms-scoped-list="issues"');
  });

  test("the identity head carries id, lifecycle and the harness-relative path", () => {
    expect(html).toContain("projects:engine");
    expect(html).toContain("Engine");
    expect(html).toContain('aria-current="page"');
  });

  test("NEGATIVE: no counter from the read envelope and no document block", () => {
    // The counters belong to the read envelope, not the record; the authority row
    // (with its content hash) is one of the document blocks Task 3 removed.
    for (const removed of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "sha256:abcd1234"]) {
      expect(html).not.toContain(removed);
    }
  });
});

describe("ProjectDetail — the header direction and the removed document blocks (plan Task 3)", () => {
  const html = renderDetail({});

  test("the roadmap's direction sits in the header, above the identity meta", () => {
    expect(html).toContain('data-ms-direction=""');
    // Above the identity meta line: the direction precedes the head's meta.
    expect(html.indexOf("One product, two hosts.")).toBeLessThan(html.indexOf("Revision"));
    expect(html).not.toContain("<details");
  });

  test("no roadmap direction falls back to the catalog description; neither renders nothing", () => {
    const fallback = renderDetail({
      roadmap: roadmapBody(
        roadmapFeatureArm({
          data: roadmap({ content: { ...roadmap().content!, direction: null } }),
          projection,
        }),
      ),
    });
    expect(fallback).toContain('data-ms-direction=""');
    expect(fallback).toContain("Store, projection and gates");
  });

  test("NEGATIVE: the catalog-identity, roadmap-authority, stored-markdown and stored-facts blocks are gone", () => {
    for (const gone of ["Catalog identity", "Roadmap authority", "Stored facts", "data-ms-roadmap-markdown", "Content hash"]) {
      expect(html).not.toContain(gone);
    }
    // The roadmap-presence chip and location line stay.
    expect(html).toContain("roadmap present");
    expect(html).toContain("projects:engine");
  });
});

describe("ProjectDetail — the milestone timeline (plan Task 3)", () => {
  const html = renderDetail({});

  test("one node per milestone plus the trailing unassigned node", () => {
    expect(html).toContain('data-ms-milestone-timeline=""');
    expect(html).toContain('data-ms-timeline-node="9f2c4a10"');
    expect(html).toContain('data-ms-timeline-node="unassigned"');
    expect(html).toContain("3 issues");
  });

  test("a node carries the retired-over-total pair and the open count", () => {
    // The fixture's milestone: 10 total, 4 open → 6/10 · 4 open.
    expect(html).toContain("6/10");
  });

  test("missing targets sort last, before the unassigned node", () => {
    const withLateTarget = renderDetail({
      roadmap: roadmapBody(
        roadmapFeatureArm({
          data: roadmap({
            milestones: {
              projectId: "engine",
              milestones: [
                {
                  milestoneId: "no-target",
                  projectId: "engine",
                  name: "No target milestone",
                  target: null,
                  status: "planned",
                  ordinal: 1,
                  revision: 1,
                  createdAt: "2026-10-01T00:00:00.000Z",
                  updatedAt: "2026-10-01T00:00:00.000Z",
                  totalIssues: 0,
                  openIssues: 0,
                  resolvedIssues: 0,
                  otherRetiredIssues: 0,
                },
                {
                  milestoneId: "early",
                  projectId: "engine",
                  name: "Early milestone",
                  target: "2026-10-01",
                  status: "delivered",
                  ordinal: 0,
                  revision: 1,
                  createdAt: "2026-10-01T00:00:00.000Z",
                  updatedAt: "2026-10-01T00:00:00.000Z",
                  totalIssues: 2,
                  openIssues: 0,
                  resolvedIssues: 2,
                  otherRetiredIssues: 0,
                },
              ],
              issues: [],
              unassignedIssues: 1,
            },
          }),
          projection,
        }),
      ),
    });
    const early = withLateTarget.indexOf('data-ms-timeline-node="early"');
    const late = withLateTarget.indexOf('data-ms-timeline-node="no-target"');
    const unassigned = withLateTarget.indexOf('data-ms-timeline-node="unassigned"');
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThan(unassigned);
    // A milestone with no issues still renders its node, as the planned status shows.
    expect(withLateTarget).toContain("No target milestone");
  });
});

describe("ProjectDetail — the Roadmap feature", () => {
  const html = renderDetail({});

  test("the direction is header text, not a disclosure", () => {
    expect(html).toContain("One product, two hosts.");
    expect(html).not.toContain("<details");
  });

  test("the milestone board carries status, target, the four tallies and its issues", () => {
    expect(html).toContain('data-ms-milestone="9f2c4a10"');
    expect(html).toContain("Release the shared layer");
    expect(html).toContain("2026-11-07");
    expect(html).toContain("I-000870");
    // The prototype's row states four tallies, each its own number-and-label pair. Assert
    // the numbers through their own hooks: labels alone would pass even if every count
    // rendered as zero, and `retired without resolution` contains `resolved`.
    // The fixture's milestone: 10 total, 4 open, 6 resolved, 0 otherwise retired.
    for (const [key, value] of [
      ["open", "4"],
      ["resolved", "6"],
      ["retired", "0"],
      ["total", "10"],
    ] as const) {
      expect(html).toContain(`data-ms-count="${key}" data-ms-count-value="${value}"`);
    }
  });

  test("the unassigned count is stated once, as a count", () => {
    expect(html).toContain('data-ms-unassigned="3"');
    expect(html).toContain("3 unassigned");
  });

});

describe("ProjectDetail — no roadmap row is absent, an empty milestone set is empty", () => {
  test("a project with no roadmap authority row renders the absent arm", () => {
    const html = renderDetail({
      roadmap: roadmapBody(roadmapFeatureArm({ data: roadmap({ authority: { state: "absent" } }), projection })),
    });
    expect(html).toContain('data-ms-absence="absent"');
    // Structure: no empty board, no zero-width bar.
    expect(html).not.toContain('data-ms-milestones=""');
    expect(html).not.toContain('data-ms-milestones=""');
    expect(html).not.toContain("progressbar");
    // The continuation is offered: the two features that do have content.
    expect(html).toContain("Issues · Iterations");
    // Greptile 5: with no roadmap direction available, the header states the
    // CATALOG description — an absent roadmap does not erase what the project is.
    expect(html).toContain('data-ms-direction=""');
    expect(html).toContain("Store, projection and gates");
  });

  test("a null roadmap read is absent too — never unreadable", () => {
    // The contract's answer: a failed read answers `unavailable`, so a null
    // payload can only mean the project declares no roadmap.
    const html = renderDetail({ roadmap: roadmapBody(roadmapFeatureArm({ data: null, projection })) });
    expect(html).toContain('data-ms-absence="absent"');
    expect(html).not.toContain('data-ms-absence="unavailable"');
  });

  test("a roadmap that exists with no milestones and no goals is empty, not absent", () => {
    const html = renderDetail({
      roadmap: roadmapBody(
        roadmapFeatureArm({
          data: roadmap({
            content: null,
            milestones: { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0 },
          }),
          projection,
        }),
      ),
    });
    expect(html).toContain('data-ms-absence="empty"');
    expect(html).toContain("the roadmap has no milestones");
    expect(html).not.toContain('data-ms-absence="absent"');
  });

  test("a roadmap with only a direction keeps rendering it (E)", () => {
    // Before the fix this answered `empty` because goals and milestones were both
    // absent — hiding content the reader can act on behind "nothing here".
    const onlyDirection = roadmap({
      content: {
        contentMarkdown: "",
        frontmatter: { project_id: "engine", title: "Engine roadmap", status: "active", created_at: "2026-08-09" },
        direction: "One product, two hosts.",
        goals: [],
        milestones: [],
        sections: [],
      },
      milestones: { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0 },
    });
    const html = renderDetail({ roadmap: roadmapBody(roadmapFeatureArm({ data: onlyDirection, projection })) });
    expect(html).toContain('data-ms-feature="roadmap"');
    expect(html).toContain("One product, two hosts.");
    expect(html).not.toContain('data-ms-absence="empty"');
  });

  test("a roadmap whose only content was the stored document is now the empty arm (Task 3)", () => {
    // The stored markdown panel is gone; with nothing rendered the page says empty.
    const onlyMarkdown = roadmap({
      content: {
        contentMarkdown: "## Notes\n\nStored direction lives here.",
        frontmatter: { project_id: "engine", title: "Engine roadmap", status: "active", created_at: "2026-08-09" },
        direction: null,
        goals: [],
        milestones: [],
        sections: [],
      },
      milestones: { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0 },
    });
    const html = renderDetail({ roadmap: roadmapBody(roadmapFeatureArm({ data: onlyMarkdown, projection })) });
    expect(html).not.toContain('data-ms-roadmap-markdown=""');
    expect(html).toContain('data-ms-absence="empty"');
  });

  test("a truly empty roadmap is still the empty arm (E)", () => {
    const nothing = roadmap({
      content: null,
      milestones: { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0 },
    });
    const html = renderDetail({ roadmap: roadmapBody(roadmapFeatureArm({ data: nothing, projection })) });
    expect(html).toContain('data-ms-absence="empty"');
  });

  test("a failed read is unavailable, carrying the store's message", () => {
    // A real failure: the payload is missing, not merely unprojected.
    const html = renderDetail({
      roadmap: roadmapBody(roadmapFeatureArm({ data: undefined as never, projection: { ...projection, generation: null } })),
    });
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).toContain("could not be completed");
  });

  test("a roadmap with no published generation still renders its content", () => {
    // The roadmap is store-backed: `generation: null` on a successful read is not a
    // failure, and treating it as one emptied the Roadmap feature.
    const html = renderDetail({
      roadmap: roadmapBody(roadmapFeatureArm({ data: roadmap(), projection: { ...projection, generation: null } })),
    });
    expect(html).not.toContain('data-ms-absence="unavailable"');
    expect(html).toContain("One product, two hosts");
  });
});

describe("ProjectDetail — the scoped features carry a removable scope chip", () => {
  test("the chip's × only exists when the host can handle it", () => {
    // It was rendered with no handler and no prop to attach one: a control that looks
    // removable and does nothing.
    const withHandler = renderDetail({ feature: "issues" }, () => {});
    expect(withHandler).toContain('data-ms-scope-clear="engine"');
    const withoutHandler = renderDetail({ feature: "issues" });
    expect(withoutHandler).toContain('data-ms-scope-chip="engine"');
    expect(withoutHandler).not.toContain("data-ms-scope-clear");
  });
  test("the Issues feature shows the project chip and the scoped list", () => {
    const html = renderDetail({ feature: "issues" }, () => {});
    expect(html).toContain('data-ms-scope-chip="engine"');
    expect(html).toContain("project: engine");
    expect(html).toContain('data-ms-scope-clear="engine"');
    expect(html).toContain('data-ms-scoped-list="issues"');
  });

  test("the Iterations feature does the same, and its attribution arm comes from the model", () => {
    const html = renderDetail({ feature: "iterations" });
    expect(html).toContain('data-ms-scope-chip="engine"');
    expect(html).toContain('data-ms-scoped-list="iterations"');
    // The scope is a prop of the list component, so the list's own attribution
    // arm decides absent-vs-empty; this screen never re-derives it.
    expect(html).not.toContain('data-ms-absence="empty"');
  });

  test("clearing the scope is reported to the model, not handled in the screen", () => {
    // The clear affordance is a labelled button carrying the project id; the host
    // turns it into a store-wide list. Asserting the hook is what keeps the
    // screen from owning the scope.
    const html = renderDetail({ feature: "issues" }, () => {});
    expect(html).toContain('aria-label="Clear the project scope"');
  });
});

describe("ProjectDetail — the milestone write controls (plan Task 4, minus remove)", () => {
  const writes = (over: Partial<NonNullable<ProjectDetailProps["writes"]>> = {}): NonNullable<ProjectDetailProps["writes"]> => ({
    busy: false,
    refusal: null,
    create: () => {},
    update: () => {},
    assign: () => {},
    remove: () => {},
    ...over,
  });

  test("the create form, edit controls, assign picker and unassign buttons render", () => {
    const html = renderDetail({
      writes: writes(),
      assignableIssues: [{ id: "I-000900", title: "Loose end", severity: "low", revision: 3 }],
    });
    expect(html).toContain('data-ms-milestone-create=""');
    expect(html).toContain('data-ms-milestone-edit=""');
    expect(html).toContain('data-ms-milestone-assign=""');
    expect(html).toContain('data-ms-assign-issue="I-000900"');
    expect(html).toContain('data-ms-unassign-issue="I-000870"');
    // Creation is name + target only: the engine's add verb has no status field.
    const createForm = html.slice(html.indexOf('data-ms-milestone-create=""'), html.indexOf("</form>", html.indexOf('data-ms-milestone-create=""')));
    expect(createForm).not.toContain("<select");
    expect(html).not.toContain('data-ms-assign-cap');
  });

  test("the assign picker's summary is the control, and the cap is stated when it applies", () => {
    const html = renderDetail({
      writes: writes(),
      assignableIssues: [{ id: "I-000900", title: "Loose end", severity: "low", revision: 3 }],
    });
    // The summary itself carries the label and the list's only interactive role: a
    // nested button swallowed activation, which left the visible trigger inert.
    expect(html).toContain('<summary class="link" data-ms-milestone-assign-toggle="9f2c4a10">Assign issues</summary>');
    expect(html).not.toMatch(/<summary[^>]*>\s*<button/);
    expect(html).not.toContain('tabindex="-1"');

    const capped = renderDetail({
      writes: writes(),
      assignableIssues: Array.from({ length: ASSIGNABLE_ISSUE_LIMIT }, (_, index) => ({
        id: `I-0009${String(index).padStart(2, "0")}`,
        title: `Issue ${index}`,
        severity: "low",
        revision: 1,
      })),
    });
    expect(capped).toContain(`data-ms-assign-cap="${ASSIGNABLE_ISSUE_LIMIT}"`);
    expect(capped).toContain("Showing the first 50 unassigned open issues.");
  });

  test("no write surface, no controls: the read-only page stays read-only", () => {
    const html = renderDetail({});
    expect(html).not.toContain('data-ms-milestone-create=""');
    expect(html).not.toContain("data-ms-unassign-issue");
  });

  test("a refusal is surfaced verbatim and a busy write disables the controls", () => {
    const refused = renderDetail({ writes: writes({ refusal: "[milestone.revision-conflict] Store revision changed since it was observed." }) });
    expect(refused).toContain('data-ms-write-refusal=""');
    expect(refused).toContain("[milestone.revision-conflict] Store revision changed since it was observed.");
    const busy = renderDetail({ writes: writes({ busy: true }) });
    expect((busy.match(/disabled=""/g) ?? []).length).toBeGreaterThan(2);
  });

  test("the remove control arms a two-step confirm, not a direct delete", () => {
    const html = renderDetail({ writes: writes(), assignableIssues: [] });
    // The first render arms the confirm; the removal itself is a separate click.
    expect((html.match(/data-ms-milestone-remove=""/g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-ms-milestone-remove="9f2c4a10"');
  });

  test("NEGATIVE: no write surface, no remove control", () => {
    const html = renderDetail({});
    expect(html).not.toContain("data-ms-milestone-remove");
  });
});

describe("ProjectDetail — the write controls reach every roadmap state (Greptile 2)", () => {
  const writes: NonNullable<ProjectDetailProps["writes"]> = {
    busy: false,
    refusal: null,
    create: () => {},
    update: () => {},
    assign: () => {},
    remove: () => {},
  };

  test("an EMPTY milestone set still renders the create form, so the first one is creatable", () => {
    const html = renderDetail({
      roadmap: roadmapBody(
        roadmapFeatureArm({
          data: roadmap({ content: null, milestones: { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0 } }),
          projection,
        }),
      ),
      writes,
    });
    // The empty arm is what a project with no milestones reads as — and the create
    // control must be there, or the first milestone can never be added.
    expect(html).toContain('data-ms-absence="empty"');
    expect(html).toContain('data-ms-milestone-create=""');
  });

  test("an ABSENT roadmap row still renders the create form", () => {
    const html = renderDetail({
      roadmap: roadmapBody(roadmapFeatureArm({ data: roadmap({ authority: { state: "absent" } }), projection })),
      writes,
    });
    expect(html).toContain('data-ms-absence="absent"');
    expect(html).toContain('data-ms-milestone-create=""');
    expect(html).toContain('data-ms-roadmap-arm="absent"');
  });

  test("no write surface, no create form, whatever the arm", () => {
    const empty = renderDetail({
      roadmap: roadmapBody(
        roadmapFeatureArm({
          data: roadmap({ content: null, milestones: { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0 } }),
          projection,
        }),
      ),
    });
    expect(empty).not.toContain("data-ms-milestone-create");
    expect(renderDetail({})).not.toContain("data-ms-milestone-create");
  });
});

describe("ProjectDetail — the catalog description survives the absent/empty arms (Greptile 5)", () => {
  test("an empty roadmap shows the description the roadmap does not supply", () => {
    const html = renderDetail({
      roadmap: roadmapBody(
        roadmapFeatureArm({
          data: roadmap({ content: null, milestones: { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0 } }),
          projection,
        }),
      ),
    });
    expect(html).toContain('data-ms-direction=""');
    expect(html).toContain("Store, projection and gates");
  });

  test("a populated roadmap's own direction still wins over the description", () => {
    const html = renderDetail({});
    expect(html).toContain("One product, two hosts.");
    expect(html).not.toContain("Store, projection and gates");
  });
});
