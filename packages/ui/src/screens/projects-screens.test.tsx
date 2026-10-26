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
import { ProjectDetail as ProjectDetailScreen, type ProjectDetailCopy } from "./ProjectDetail.tsx";

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
  breadcrumb: { label: "Breadcrumb", trail: "Projects" },
  fields: { title: "Identity", id: "ID", lifecycle: "Lifecycle", path: "Path", description: "Description", noDescription: "—" },
  tabLabel: "Features",
  features: { roadmap: "Roadmap", issues: "Issues", iterations: "Iterations" },
  roadmap: {
    directionHeading: "Direction",
    goalsHeading: "Goals",
    milestonesHeading: "Milestones",
    markdownHeading: "Stored document",
    noDirection: "no direction recorded",
    goalChecked: "done",
    goalUnchecked: "open",
    milestoneProgress: (done, total) => `${done}/${total}`,
    milestoneOpen: (open) => `${open} open`,
    noTarget: "no target",
    unassigned: (count) => `${count} unassigned`,
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

  test("NEGATIVE: no envelope counter, catalog revision or source hash", () => {
    for (const removed of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "sha256:abcd1234", "2026-10-23T09:42:00.000Z"]) {
      expect(html).not.toContain(removed);
    }
  });
});

describe("ProjectDetail — the Roadmap feature", () => {
  const html = renderDetail({});

  test("direction is collapsed, goals carry their check state", () => {
    expect(html).toContain("<details");
    expect(html).toContain("One product, two hosts.");
    expect(html).toContain('data-ms-goal-checked="true"');
    expect(html).toContain('data-ms-goal-checked="false"');
    expect(html).toContain("One design system");
  });

  test("a sub-goal is indented by depth, not nested", () => {
    expect(html).toContain('data-ms-goal-depth="1"');
    expect(html).toContain('data-ms-goal-depth="0"');
  });

  test("the milestone board carries status, target, progress, open count and its issues", () => {
    expect(html).toContain('data-ms-milestone="9f2c4a10"');
    expect(html).toContain("Release the shared layer");
    expect(html).toContain("2026-11-07");
    expect(html).toContain("6/10");
    expect(html).toContain("4 open");
    expect(html).toContain("I-000870");
  });

  test("the unassigned count is stated once, as a count", () => {
    expect(html).toContain('data-ms-unassigned="3"');
    expect(html).toContain("3 unassigned");
  });

  test("the stored markdown is available collapsed", () => {
    expect(html).toContain("Stored document");
    expect(html).toContain('data-ms-roadmap-markdown=""');
  });
});

describe("ProjectDetail — no roadmap row is absent, an empty milestone set is empty", () => {
  test("a project with no roadmap authority row renders the absent arm", () => {
    const html = renderDetail({
      roadmap: roadmapBody(roadmapFeatureArm({ data: roadmap({ authority: { state: "absent" } }), projection })),
    });
    expect(html).toContain('data-ms-absence="absent"');
    // Structure: no empty direction body, no empty board, no zero-width bar.
    expect(html).not.toContain('data-ms-direction=""');
    expect(html).not.toContain('data-ms-milestones=""');
    expect(html).not.toContain("progressbar");
    // The continuation is offered: the two features that do have content.
    expect(html).toContain("Issues · Iterations");
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

  test("a roadmap with only a stored document keeps rendering it (E)", () => {
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
    expect(html).toContain('data-ms-roadmap-markdown=""');
    expect(html).toContain("Stored direction lives here.");
    expect(html).not.toContain('data-ms-absence="empty"');
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
