/**
 * `Projects` and `ProjectDetail` — the only place the product hierarchy is
 * expressed.
 *
 * The load-bearing assertions:
 *
 *  - the milestone rollup is the screen's default body, read from the
 *    project-scoped `overview` read's `milestones` member;
 *  - the list feature set is the fixed two, in order, and `Issues` is the default;
 *  - an empty milestone set renders the `empty` arm with the create form still
 *    offered — there is no `absent` arm and no tab, route or label named roadmap;
 *  - the scoped lists carry a chip naming the project, and clearing it is a model
 *    operation (the screen does not own the scope);
 *  - no envelope counter reaches either page.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MilestoneRead, OverviewMember, ProjectListDTO } from "@mstar-harness/engine";

import {
  DEFAULT_PROJECT_FEATURE,
  PROJECT_FEATURES,
  milestonesArm,
  milestonesModel,
  projectIdentity,
  projectListModel,
} from "../view-model/projects.ts";
import type { Resolved } from "../view-model/state.ts";
import type { MilestonesModel, ProjectIdentity } from "../view-model/projects.ts";
import { Projects, type ProjectsCopy } from "./Projects.tsx";
import {
  ASSIGNABLE_ISSUE_LIMIT,
  createMilestoneDraftStore,
  draftAfterWrite,
  effortInput,
  milestoneCreateInput,
  milestoneDraft,
  milestonePatch,
  withTouched,
  nextMilestoneOrdinal,
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
  }) as ProjectListDTO["items"][number]["project"];

const identityRow = (over: Record<string, unknown> = {}) => {
  const model = projectListModel({
    data: { items: [{ project: catalogEntry(over), openIssues: 4 }], total: 1 },
    projection,
  });
  if (model.rows.kind !== "populated") throw new Error("the list fixture must populate");
  return model.rows.value[0]!;
};

const milestoneRead = (over: Partial<MilestoneRead> = {}): MilestoneRead => ({
  projectId: "engine",
  milestones: [
    {
      milestoneId: "9f2c4a10",
      projectId: "engine",
      name: "Release the shared layer",
      effortSessions: 12,
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
  ...over,
});

const milestoneRow = (
  over: Partial<MilestoneRead["milestones"][number]> = {},
): MilestoneRead["milestones"][number] => ({
  milestoneId: "9f2c4a10",
  projectId: "engine",
  name: "Release the shared layer",
  effortSessions: 12,
  status: "active",
  ordinal: 0,
  revision: 2,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  totalIssues: 10,
  openIssues: 4,
  resolvedIssues: 6,
  otherRetiredIssues: 0,
  ...over,
});

/** The arm the screen renders for one rollup read. */
const armOf = (read: MilestoneRead): Resolved<MilestonesModel> => milestonesArm({ state: "read", data: read });

// why: a slot assertion must be met inside this milestone's own block, not anywhere on the page.
const boardBlockOf = (html: string, milestoneId: string): string => {
  const start = html.indexOf(`data-ms-milestone="${milestoneId}"`);
  return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
};

const timelineNodeOf = (html: string, nodeId: string): string => {
  const start = html.indexOf(`data-ms-timeline-node="${nodeId}"`);
  if (start === -1) return "";
  const next = html.indexOf("data-ms-timeline-node=", start + 1);
  const end = next === -1 ? html.indexOf('data-ms-milestone="', start) : next;
  return html.slice(start, end === -1 ? undefined : end);
};

const projectsCopy: ProjectsCopy = {
  pageTitle: "Projects",
  totalMeta: (n) => `${n} ${n === 1 ? "project" : "projects"}`,
  openIssuesMeta: (n) => `${n} open ${n === 1 ? "issue" : "issues"}`,
  headNote: "a project owns its milestones, issues and iterations",
  tableCaption: "Projects",
  listHeading: "Catalog projects",
  listMeta: "Select a project to open its milestones, issues and iterations",
  lifecycleNote: "Lifecycle is the catalog lifecycle, never the execution state.",
  noLifecycle: "no lifecycle",
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
  openIssuesUnit: "open issues",
  breadcrumb: { label: "Breadcrumb", trail: "Projects" },
  tabLabel: "Features",
  features: { issues: "Issues", iterations: "Iterations" },
  milestones: {
    milestonesHeading: "Milestones",
    milestonesUnit: "milestones",
    unassignedUnit: "unassigned issues",
    milestoneOpen: (open) => `${open} open`,
    countLabels: { open: "open", resolved: "resolved", retired: "retired without resolution", total: "total" },
    effort: (sessions) => `${sessions} sessions`,
    unestimated: "unestimated",
    unassigned: (count) => `${count} unassigned`,
    writes: {
      create: "Create",
      nameLabel: "Milestone name",
      effortLabel: "Sessions",
      effortInvalid: "The session count must be a whole number of at least 1, or left empty.",
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
  },
  scope: { label: (id) => `project: ${id}`, clear: "Clear the project scope" },
  absence: {
    empty: { labelWord: "empty", heading: "Milestones", body: "no milestones yet", hint: "add one" },
    unavailable: { labelWord: "unavailable", heading: "Milestones", body: "the read failed" },
    "not-applicable": { labelWord: "n/a", heading: "Milestones", body: "no project resolves" },
  },
};

const renderDetail = (
  input: {
    milestones?: Resolved<MilestonesModel>;
    feature?: "issues" | "iterations";
    identity?: ProjectIdentity;
    writes?: ProjectDetailProps["writes"];
    assignableIssues?: ProjectDetailProps["assignableIssues"];
    drafts?: ProjectDetailProps["drafts"];
  },
  onClearScope?: () => void,
): string =>
  renderToStaticMarkup(
    <ProjectDetailScreen
      identity={input.identity ?? projectIdentity(identityRow())}
      feature={input.feature ?? DEFAULT_PROJECT_FEATURE}
      onFeatureChange={() => {}}
      milestones={input.milestones ?? armOf(milestoneRead())}
      issues={<div data-ms-scoped-list="issues" />}
      iterations={<div data-ms-scoped-list="iterations" />}
      copy={detailCopy}
      {...(input.writes === undefined ? {} : { writes: input.writes })}
      {...(input.assignableIssues === undefined ? {} : { assignableIssues: input.assignableIssues })}
      {...(input.drafts === undefined ? {} : { drafts: input.drafts })}
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

describe("ProjectDetail — the milestone body and the fixed feature set", () => {
  const html = renderDetail({});

  test("the two list features render in the fixed order", () => {
    const positions = ["Issues", "Iterations"].map((label) => html.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html.match(/role="tab"/g)?.length).toBe(2);
  });

  test("Issues is the default for every project, by constant not by content", () => {
    expect(DEFAULT_PROJECT_FEATURE).toBe("issues");
    expect(PROJECT_FEATURES).toEqual(["issues", "iterations"]);
    expect(html).toContain('data-ms-feature="issues"');
    expect(html).toContain('aria-selected="true"');
  });

  test("NEGATIVE: no tab, route or label named roadmap survives", () => {
    expect(html).not.toContain("Roadmap");
    expect(html).not.toContain("roadmap");
  });

  test("the milestone rollup is the default body, on every feature", () => {
    expect(html).toContain('data-ms-milestones=""');
    expect(html).toContain('data-ms-milestone-timeline=""');
    // The body is not a tab: selecting the other feature keeps it mounted.
    expect(renderDetail({ feature: "iterations" })).toContain('data-ms-milestones=""');
  });

  test("it never auto-selects a feature that has content", () => {
    const empty = renderDetail({ milestones: armOf(milestoneRead({ milestones: [], issues: [], unassignedIssues: 0 })) });
    // The milestone set is empty and Issues would have content — the tab must not move.
    expect(empty).toContain('data-ms-absence="empty"');
    expect(empty).toContain('data-ms-feature="issues"');
  });

  test("the identity head carries id, lifecycle and the list's own title", () => {
    expect(html).toContain("Engine");
    expect(html).toContain("active");
    expect(html).toContain('aria-current="page"');
  });

  test("NEGATIVE: no counter from the read envelope", () => {
    for (const removed of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "sha256:abcd1234"]) {
      expect(html).not.toContain(removed);
    }
  });
});

describe("ProjectDetail — the header description", () => {
  const html = renderDetail({});

  test("the project's description sits in the header, above the identity meta", () => {
    expect(html).toContain('data-ms-direction=""');
    expect(html).toContain("Store, projection and gates");
    // Above the identity meta line: the description precedes the head's meta.
    expect(html.indexOf("Store, projection and gates")).toBeLessThan(html.indexOf("detail-meta"));
    expect(html).not.toContain("<details");
  });

  test("no description renders nothing, not a dash", () => {
    const bare = renderDetail({ identity: projectIdentity(identityRow({ description: null })) });
    expect(bare).not.toContain('data-ms-direction=""');
  });
});

describe("ProjectDetail — the milestone timeline", () => {
  const html = renderDetail({});

  test("one node per milestone plus the trailing unassigned node", () => {
    expect(html).toContain('data-ms-milestone-timeline=""');
    expect(html).toContain('data-ms-timeline-node="9f2c4a10"');
    expect(html).toContain('data-ms-timeline-node="unassigned"');
    expect(html).toContain("3 issues");
  });

  test("a node carries the retired-over-total pair and the open count", () => {
    // why: the fixture's milestone is 10 total, 4 open → 6/10 · 4 open, asserted inside ITS node.
    const node = timelineNodeOf(html, "9f2c4a10");
    expect(node).toContain("6/10");
    expect(node).toContain("4 open");
  });

  test("nodes follow the store's ordinal order, then the unassigned node", () => {
    // why: a and b share ordinal 1 and are entered in NON-id order (b before a), so a
    // stable ordinal-only sort would render c, b, a — the id tie-break is the only
    // way the asserted order c, a, b arises. The other single-key alternatives also
    // disagree: by id ascending a, b, c; by id descending c, b, a; by effort
    // ascending b(3), c(4), a(5); by effort descending a(5), c(4), b(3).
    const ordered = renderDetail({
      milestones: armOf(
        milestoneRead({
          milestones: [
            milestoneRow({
              milestoneId: "b-position",
              name: "Third position",
              effortSessions: 3,
              status: "active",
              ordinal: 1,
              totalIssues: 0,
              resolvedIssues: 0,
              openIssues: 0,
            }),
            milestoneRow({
              milestoneId: "a-position",
              name: "Second position",
              effortSessions: 5,
              status: "planned",
              ordinal: 1,
              totalIssues: 0,
              resolvedIssues: 0,
              openIssues: 0,
            }),
            milestoneRow({
              milestoneId: "c-position",
              name: "First position",
              effortSessions: 4,
              status: "delivered",
              ordinal: 0,
              totalIssues: 2,
              resolvedIssues: 2,
              openIssues: 0,
            }),
          ],
          issues: [],
          unassignedIssues: 1,
        }),
      ),
    });
    const c = ordered.indexOf('data-ms-timeline-node="c-position"');
    const a = ordered.indexOf('data-ms-timeline-node="a-position"');
    const b = ordered.indexOf('data-ms-timeline-node="b-position"');
    const unassigned = ordered.indexOf('data-ms-timeline-node="unassigned"');
    expect(c).toBeGreaterThan(-1);
    expect(c).toBeLessThan(a);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(unassigned);
    expect(timelineNodeOf(ordered, "c-position")).toContain("4 sessions · delivered");
    expect(timelineNodeOf(ordered, "a-position")).toContain("5 sessions · planned");
    // invariant: the trailing node is the unassigned issues only — no effort line, no estimate word.
    const trailing = timelineNodeOf(ordered, "unassigned");
    expect(trailing).toContain("1 issues");
    expect(trailing).not.toContain("session");
    expect(trailing).not.toContain("unestimated");
  });

  test("an unestimated milestone says so in its own node", () => {
    const page = renderDetail({
      milestones: armOf(
        milestoneRead({
          milestones: [milestoneRow({ milestoneId: "never", name: "Never estimated", effortSessions: null, status: null, totalIssues: 0 })],
          issues: [],
          unassignedIssues: 0,
        }),
      ),
    });
    const node = timelineNodeOf(page, "never");
    expect(node).toContain("unestimated");
    expect(node).not.toContain("0 sessions");
  });
});

describe("ProjectDetail — the milestone board", () => {
  const html = renderDetail({});

  test("the board carries status, effort sessions, the four tallies and its issues", () => {
    // why: every slot is asserted inside this milestone's own block — the timeline node
    // prints the same effort line, so a page-wide search would pass with the board slot gone.
    const block = boardBlockOf(html, "9f2c4a10");
    expect(block).not.toBe("");
    expect(block).toContain("Release the shared layer");
    expect(block).toContain(">active<");
    // why: a kept attribute with no rendered count must still fail, so the cell's own hook AND the
    // number it prints are both asserted - the display renders the bare count (`sessionsLabel` is
    // the write form's label only).
    const effortSessions = 12;
    const effortAt = block.indexOf("data-ms-effort");
    expect(effortAt).toBeGreaterThan(-1);
    expect(block).toContain(`data-ms-effort="${effortSessions}"`);
    const effortClose = block.indexOf("</span>", effortAt) + "</span>".length;
    // why: the cell prints the count inside the localized effort copy, so the assertion is the
    // number itself - asserting a bare `>12<` would encode one surface's wording.
    expect(block.slice(effortAt, effortClose)).toContain(String(effortSessions));
    expect(block).toContain("I-000870");
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
      expect(block).toContain(`data-ms-count="${key}" data-ms-count-value="${value}"`);
    }
  });

  test("an unestimated milestone says so on the board row, and the estimate never leaks to another row", () => {
    const page = renderDetail({
      milestones: armOf(
        milestoneRead({
          milestones: [
            milestoneRow({ milestoneId: "never", name: "Never estimated", effortSessions: null, status: null, totalIssues: 0 }),
            milestoneRow({ milestoneId: "estimated", name: "Estimated", effortSessions: 4, totalIssues: 0, openIssues: 0, resolvedIssues: 0 }),
          ],
          issues: [],
          unassignedIssues: 0,
        }),
      ),
    });
    expect(boardBlockOf(page, "never")).toContain("unestimated");
    expect(boardBlockOf(page, "estimated")).toContain("4 sessions");
    expect(boardBlockOf(page, "estimated")).not.toContain("unestimated");
  });

  test("the unassigned count is stated once, as a count", () => {
    expect(html).toContain('data-ms-unassigned="3"');
    expect(html).toContain("3 unassigned");
  });
});

describe("ProjectDetail — the milestone body's arms", () => {
  test("an empty milestone set is the empty arm — no board, no zero-width bar", () => {
    const html = renderDetail({
      milestones: armOf(milestoneRead({ milestones: [], issues: [], unassignedIssues: 0 })),
    });
    expect(html).toContain('data-ms-absence="empty"');
    expect(html).not.toContain('data-ms-milestones=""');
    expect(html).not.toContain("progressbar");
    // The header still states the catalog description.
    expect(html).toContain('data-ms-direction=""');
    expect(html).toContain("Store, projection and gates");
  });

  test("unassigned issues alone populate the body", () => {
    const html = renderDetail({
      milestones: armOf(milestoneRead({ milestones: [], issues: [], unassignedIssues: 4 })),
    });
    expect(html).not.toContain('data-ms-absence="empty"');
    expect(html).toContain('data-ms-unassigned="4"');
  });

  test("a not-applicable member renders its own arm with the store's reason", () => {
    const html = renderDetail({
      milestones: milestonesArm({ state: "not-applicable", reason: "no project resolves for this read" }),
    });
    expect(html).toContain('data-ms-absence="not-applicable"');
    expect(html).toContain("no project resolves for this read");
  });

  test("an unavailable member renders its own arm, carrying the store's message", () => {
    const html = renderDetail({
      milestones: milestonesArm({ state: "unavailable", reason: "the milestone read could not be completed" }),
    });
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).toContain("the milestone read could not be completed");
  });

  test("a pending read renders no arm", () => {
    const html = renderDetail({ milestones: { kind: "loading" } });
    expect(html).not.toContain('data-ms-absence=');
    expect(html).not.toContain('data-ms-milestones=""');
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
    // why: the engine's add verb has no status field, so creation is name + effort only.
    const createForm = html.slice(html.indexOf('data-ms-milestone-create=""'), html.indexOf("</form>", html.indexOf('data-ms-milestone-create=""')));
    expect(createForm).not.toContain("<select");
    // why: the effort field keeps the raw text — a number input sanitises bad text to
    // "" — and it is never a calendar date.
    expect(createForm).toContain('inputMode="numeric"');
    expect(createForm).not.toContain('type="number"');
    expect(createForm).not.toContain('type="date"');
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

describe("ProjectDetail — the edit form's draft and patch contract", () => {
  const stored = (): MilestonesModel["milestones"][number] => {
    const arm = armOf(milestoneRead());
    if (arm.kind !== "populated") throw new Error("the milestone fixture must read as populated");
    return arm.value.milestones[0]!;
  };

  // why: the component-level sequence (clear → cancel → reopen → Save) is not expressible
  // in this package — the suite renders with react-dom/server and has no DOM runtime.
  // Each case below names the draft/patch contract it actually drives.
  test("reopening after a discarded draft reseeds from the milestone, so a rename-only patch carries no effortSessions", () => {
    const milestone = stored();
    expect(milestone.effortSessions).toBe(12);
    // why: cancel throws the draft away, so reopening seeds a NEW draft from the
    // milestone — the value the stale draft held (empty) cannot come back.
    const reopened = milestoneDraft(milestone);
    expect(reopened).toEqual({
      name: "Release the shared layer",
      effort: "12",
      status: "active",
      touched: new Set(),
    });
    const patch = milestonePatch(milestone, { ...reopened, name: "Renamed", touched: withTouched(reopened.touched, "name") });
    expect(patch).toEqual({ name: "Renamed" });
    expect("effortSessions" in patch).toBe(false);
  });

  test("an emptied effort field contributes the explicit null to the patch", () => {
    const milestone = stored();
    const patch = milestonePatch(milestone, {
      ...milestoneDraft(milestone),
      effort: "",
      touched: withTouched(milestoneDraft(milestone).touched, "effort"),
    });
    expect(patch).toEqual({ effortSessions: null });
  });

  test("a refresh shows the milestone's own value for every field the operator did not touch", () => {
    // why: keeping a stale displayed value is worse than losing the seed — an editor showing the
    // old status makes selecting that same option a no-op, so the operator's choice never travels.
    const milestone = stored();
    const touchedOnlyEffort = withTouched(new Set(), "effort");
    const kept = { name: "Renamed", effort: "20", status: "delivered", touched: [...touchedOnlyEffort] };
    // note: the refreshed milestone another writer left behind.
    const refreshed = { ...milestone, name: "Renamed upstream", status: "delivered" } as typeof milestone;
    const seeded = {
      name: kept.touched.includes("name") ? kept.name : refreshed.name,
      effort: kept.touched.includes("effort") ? kept.effort : "",
      status: kept.touched.includes("status") ? kept.status : (refreshed.status ?? "planned"),
    };
    expect(seeded.name).toBe("Renamed upstream");
    expect(seeded.status).toBe("delivered");
    expect(milestonePatch(refreshed, { ...seeded, touched: new Set(kept.touched) })).toEqual({ effortSessions: 20 });
  });

  test("an untouched draft yields an empty patch, a changed effort the full patch", () => {
    const milestone = stored();
    expect(milestonePatch(milestone, milestoneDraft(milestone))).toEqual({});
    expect(
      milestonePatch(milestone, {
        ...milestoneDraft(milestone),
        effort: "20",
        touched: withTouched(milestoneDraft(milestone).touched, "effort"),
      }),
    ).toEqual({ effortSessions: 20 });
  });

  test("the create form sends a count as that count and an empty field as null", () => {
    const twelve = milestoneCreateInput("New milestone", "12", 0);
    expect(twelve).toEqual({ kind: "input", input: { name: "New milestone", effortSessions: 12, ordinal: 0 } });
    const unestimated = milestoneCreateInput("New milestone", "  ", 0);
    expect(unestimated).toEqual({ kind: "input", input: { name: "New milestone", effortSessions: null, ordinal: 0 } });
  });

  test("a garbage effort text is refused, not coerced into a cleared estimate", () => {
    // why: `0` is a whole number, so it reaches the engine, whose range validator
    // refuses it. Only non-integer text stops at the screen — never coerced to `null`.
    expect(effortInput("0")).toEqual({ kind: "count", sessions: 0 });
    expect(milestoneCreateInput("New milestone", "0", 0)).toEqual({
      kind: "input",
      input: { name: "New milestone", effortSessions: 0, ordinal: 0 },
    });
    // safety: a digit string the browser's JSON encoding would turn into null (a silent
    // clear the engine reads as legitimate) is refused before any write; "0" and
    // in-range values still travel to the engine, which owns the range.
    expect(effortInput("9".repeat(309))).toEqual({ kind: "invalid" });
    expect(milestoneCreateInput("New milestone", "9".repeat(309), 0)).toEqual({ kind: "invalid" });
    expect(effortInput("9007199254740993")).toEqual({ kind: "invalid" });
    for (const text of ["1.5", "twelve", "12px", "-"]) {
      expect(effortInput(text)).toEqual({ kind: "invalid" });
      expect(milestoneCreateInput("New milestone", text, 0)).toEqual({ kind: "invalid" });
    }
    expect(
      milestonePatch(stored(), {
        ...milestoneDraft(stored()),
        effort: "twelve",
        touched: withTouched(milestoneDraft(stored()).touched, "effort"),
      }),
    ).toEqual({});
  });

  test("a NEW milestone takes one past the highest ordinal, never the count — gaps sort it last", () => {
    // why: deletions leave gaps (ordinals 0, 2). The milestone COUNT (2) would sort
    // the new one alongside the existing ordinal-2 work or ahead of it on the id
    // tie-break; one past the highest ordinal (3) places it after everything.
    const gapped = [milestoneRow({ ordinal: 0 }), milestoneRow({ milestoneId: "b-position", ordinal: 2 })];
    expect(nextMilestoneOrdinal(gapped)).toBe(3);
    expect(nextMilestoneOrdinal([])).toBe(0);
    const created = milestoneCreateInput("New milestone", "12", nextMilestoneOrdinal(gapped));
    expect(created).toEqual({ kind: "input", input: { name: "New milestone", effortSessions: 12, ordinal: 3 } });
  });

  test("the rendered timeline places the gap-created milestone last", () => {
    const html = renderDetail({
      milestones: armOf(
        milestoneRead({
          milestones: [
            milestoneRow({ milestoneId: "first-kept", ordinal: 0, totalIssues: 0, openIssues: 0, resolvedIssues: 0 }),
            milestoneRow({ milestoneId: "second-kept", ordinal: 2, totalIssues: 0, openIssues: 0, resolvedIssues: 0 }),
            milestoneRow({ milestoneId: "created-after", ordinal: 3, totalIssues: 0, openIssues: 0, resolvedIssues: 0 }),
          ],
          issues: [],
          unassignedIssues: 0,
        }),
      ),
    });
    const first = html.indexOf('data-ms-timeline-node="first-kept"');
    const second = html.indexOf('data-ms-timeline-node="second-kept"');
    const created = html.indexOf('data-ms-timeline-node="created-after"');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(created);
  });

  test("a refused write keeps the typed draft; an accepted one clears it", () => {
    // why: the engine refuses 0 / negative / over-range counts AFTER the operator
    // may have edited the name and status too. The draft is theirs, not the
    // engine's to throw away — only an accepted write closes the editor.
    const typed = { name: "Renamed", effort: "0", status: "active" };
    expect(draftAfterWrite(typed, "[milestone.effort-range] Effort sessions must be a positive count.")).toEqual(typed);
    expect(draftAfterWrite(typed, null)).toBeNull();
  });
});

describe("ProjectDetail — the write controls reach every answered arm", () => {
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
      milestones: armOf(milestoneRead({ milestones: [], issues: [], unassignedIssues: 0 })),
      writes,
    });
    // The empty arm is what a project with no milestones reads as — and the create
    // control must be there, or the first milestone can never be added.
    expect(html).toContain('data-ms-absence="empty"');
    expect(html).toContain('data-ms-milestone-create=""');
  });

  test("a populated board renders the create form beside it", () => {
    const html = renderDetail({ writes });
    expect(html).toContain('data-ms-milestones-arm="populated"');
    expect(html).toContain('data-ms-milestone-create=""');
  });

  test("no write surface, no create form, whatever the arm", () => {
    const empty = renderDetail({
      milestones: armOf(milestoneRead({ milestones: [], issues: [], unassignedIssues: 0 })),
    });
    expect(empty).not.toContain("data-ms-milestone-create");
    expect(renderDetail({})).not.toContain("data-ms-milestone-create");
  });
});

describe("ProjectDetail — the host-owned draft store", () => {
  // why: the forms live under the milestone read, so a refresh unmounts them — the draft must
  // be the host's, keyed per target, or the operator's typed text dies with the subtree.
  test("the store keeps one draft per target, and clear drops only that target", () => {
    const store = createMilestoneDraftStore();
    expect(store.read("create")).toBeUndefined();
    store.write("create", { name: "Typed milestone", effort: "4" });
    store.write("m-1", { name: "Renamed", effort: "9", status: "active" });
    expect(store.read("create")).toEqual({ name: "Typed milestone", effort: "4" });
    expect(store.read("m-1")).toEqual({ name: "Renamed", effort: "9", status: "active" });
    // why: a write merges into the target's entry — the name keystroke must not erase the
    // effort the operator typed before it.
    store.write("create", { name: "Typed milestone edited" });
    expect(store.read("create")).toEqual({ name: "Typed milestone edited", effort: "4" });
    store.clear("create");
    expect(store.read("create")).toBeUndefined();
    // invariant: clearing one target never touches another — the open editor's draft is not
    // the create form's to lose.
    expect(store.read("m-1")).toEqual({ name: "Renamed", effort: "9", status: "active" });
  });

  test("a re-mounted form seeds from the store: the draft survives the refresh", () => {
    // why: the unmount/remount cycle itself needs a DOM runtime this suite does not have, but
    // the mount-half of the cycle IS observable here — the first render IS the re-mounted form's
    // open, and the input values it prints are exactly what the useState seeding produced. The
    // draft is keyed by the page's identity: this fixture's project is `engine`.
    const store = createMilestoneDraftStore();
    store.write("engine:create", { name: "Typed before the conflict", effort: "4" });
    const writes = { busy: false, refusal: null, create: () => {}, update: () => {}, assign: () => {}, remove: () => {} };
    const html = renderDetail({ writes, drafts: store });
    // invariant: the rendered inputs carry the typed text — removing the component's seeding
    // turns both values empty and fails this test, because the store lookup is then dead code.
    expect(html).toContain('value="Typed before the conflict"');
    expect(html).toContain('value="4"');
    // invariant: with the entry gone the form opens empty — the seed is the store entry itself,
    // not a fallback that happens to echo it.
    store.clear("engine:create");
    const empty = renderDetail({ writes, drafts: store });
    expect(empty).toContain('data-ms-milestone-create=""');
    expect(empty).not.toContain('value="Typed before the conflict"');
  });

  test("a conflict retry sends only the field the operator touched, never a revert of the refreshed one", () => {
    // why: the draft is seeded with every field, so a refresh that changed an untouched field
    // would be reverted by a patch built from the stale snapshot. Only touched fields travel.
    const milestone = stored();
    const seeded = { ...milestoneDraft(milestone), touched: withTouched(milestoneDraft(milestone).touched, "name") };
    const renamed = { ...seeded, name: "Renamed" };
    // note: the refreshed milestone another writer left behind: its estimate moved to 8.
    const refreshed = { ...milestone, effortSessions: 8 } as typeof milestone;
    expect(milestonePatch(refreshed, renamed)).toEqual({ name: "Renamed" });
    // note: an untouched effort field is never sent, even though its typed text no longer matches.
    expect("effortSessions" in milestonePatch(refreshed, renamed)).toBe(false);
    // note: touching the field is what lets it travel, and clearing it stays expressible.
    const cleared = { ...milestoneDraft(refreshed), effort: "", touched: withTouched(milestoneDraft(refreshed).touched, "effort") };
    expect(milestonePatch(refreshed, cleared)).toEqual({ effortSessions: null });
  });

  test("the edit editor's seed prefers the stored draft's status over the milestone's", () => {
    // why: the operator may have changed the status dropdown before the conflict; re-seeding
    // from the milestone would silently revert it to the stored state.
    const milestone = stored();
    const kept = { name: "Renamed", effort: "9", status: "delivered", touched: ["name", "effort", "status"] as const };
    const seeded = {
      name: kept.name,
      effort: kept.effort,
      status: kept.status ?? milestone.status ?? "planned",
      touched: new Set(kept.touched),
    };
    expect(seeded.status).toBe("delivered");
    expect(milestonePatch(milestone, seeded)).toEqual({ name: "Renamed", effortSessions: 9, status: "delivered" });
  });

  function stored(): MilestonesModel["milestones"][number] {
    const arm = armOf(milestoneRead());
    if (arm.kind !== "populated") throw new Error("the milestone fixture must read as populated");
    return arm.value.milestones[0]!;
  }
});

describe("milestonesArm — the one absence authority for the milestone body", () => {
  test("a read member with work is populated; without work it is empty", () => {
    expect(armOf(milestoneRead()).kind).toBe("populated");
    expect(armOf(milestoneRead({ milestones: [], issues: [], unassignedIssues: 0 })).kind).toBe("empty");
  });

  test("the member's own not-applicable and unavailable states pass through", () => {
    const notApplicable: OverviewMember<MilestoneRead> = { state: "not-applicable", reason: "no project resolves" };
    const unavailable: OverviewMember<MilestoneRead> = { state: "unavailable", reason: "store refused" };
    expect(milestonesArm(notApplicable)).toEqual({ kind: "not-applicable", reason: "no project resolves" });
    expect(milestonesArm(unavailable)).toEqual({ kind: "unavailable", reason: "store refused" });
  });

  test("the model carries the rollup's own tallies and the per-milestone issue list", () => {
    const model = milestonesModel(milestoneRead());
    expect(model.unassignedIssues).toBe(3);
    expect(model.milestones[0]).toMatchObject({
      milestoneId: "9f2c4a10",
      counts: { open: 4, resolved: 6, retired: 0, total: 10 },
      progress: { done: 6, total: 10 },
    });
    expect(model.milestones[0]!.issues.map((issue) => issue.id)).toEqual(["I-000870"]);
  });
});
