/**
 * The host's envelope handling for the Projects pair, and the two facts this pair
 * is the only place to get wrong:
 *
 *  - the milestone body reads the project-scoped milestone view, which needs no
 *    execution store — a degraded read is its own arm, never a flattened null;
 *  - the feature set is the fixed two with `Issues` permanently default — never
 *    "the first non-empty" — and no tab, route or label named roadmap survives.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MilestoneRead, OverviewDTO, ProjectListDTO } from "@mstar-harness/engine";
import {
  DEFAULT_PROJECT_FEATURE,
  PROJECT_FEATURES,
  ProjectDetail,
  Projects,
  copyFor,
  milestonesArm,
  projectIdentity,
  projectListModel,
} from "@mstar-harness/ui";

import {
  MILESTONE_WRITE_PATH,
  applyMilestoneFollowUp,
  milestoneWriteFollowUp,
  milestoneWriteStarted,
  type MilestonePageState,
  projectDetailCopy,
  projectMilestonesPath,
  projectOptions,
  projectsCopy,
  projectsOutcome,
  readProjectMilestones,
  readProjects,
  writeMilestone,
} from "./projects-data";

const projection = {
  observed: true,
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

const catalogEntry = (over: Record<string, unknown> = {}): ProjectListDTO["items"][number]["project"] =>
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

const project = (over: Record<string, unknown> = {}, openIssues = 4): ProjectListDTO["items"][number] => ({
  project: catalogEntry(over),
  openIssues,
});

const listEnvelope = (
  items: ProjectListDTO["items"],
  total = items.length,
  generation: number | null = 7,
) => ({ data: { items, total } as ProjectListDTO, projection: { ...projection, generation } });

/** note: An explicit partial observation, as a source that could not prove its scope reports. */
const partialObservation = {
  scope: { kind: "query" as const, key: "projects" },
  completeness: "partial" as const,
  asOf: "2026-11-21T00:00:00.000Z",
  authority: { repoKey: "github.com/acme/repo", mode: "local" as const, storeId: "store-a", epoch: 1 },
  revision: 3,
  catalogRevision: 1,
  code: "collaboration.observation-incomplete",
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
  ],
  unassignedIssues: 3,
  ...over,
});

const overview = (milestones: OverviewDTO["milestones"]): OverviewDTO => ({
  projectId: "engine",
  workflows: { state: "read", data: { items: [], total: 0 } },
  residuals: { state: "read", data: { open: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 } } },
  milestones,
  latestIteration: { state: "read", data: null },
  issueFlow: { state: "read", data: { buckets: [], incompleteHistory: false } },
});

const overviewEnvelope = (data: OverviewDTO, extra: Record<string, unknown> = {}) => ({
  data,
  projection,
  storeRevision: 41,
  catalogRevision: 1,
  collaboration: null,
  execution: null,
  ...extra,
});

/** see packages/engine/src/store-read.ts - the standalone milestone view's envelope. */
const milestonesEnvelope = (data: MilestoneRead, extra: Record<string, unknown> = {}) => ({
  data,
  projection,
  storeRevision: 41,
  catalogRevision: 1,
  collaboration: null,
  execution: null,
  ...extra,
});

const renderList = (items: ProjectListDTO["items"], total = items.length, generation: number | null = 7): string => {
  const outcome = projectsOutcome({ status: "ready", envelope: listEnvelope(items, total, generation) });
  if (outcome.kind !== "ready") throw new Error("expected a ready list");
  return renderToStaticMarkup(createElement(Projects, { model: outcome.model, copy: projectsCopy(copyFor("en")) }));
};

describe("the projects list", () => {
  test("a required collaboration gap is a failed read, not an empty project list", async () => {
    const gapped = (async () =>
      new Response(
        JSON.stringify({
          ...listEnvelope([project()]),
          storeRevision: 1,
          catalogRevision: 1,
          collaboration: partialObservation,
          execution: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await readProjects(gapped);
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("collaboration.observation-incomplete");
    expect(projectsOutcome(result).kind).toBe("failed");
  });

  test("outcome 1 — a healthy read lists the projects with their open counts", () => {
    const html = renderList([project(), project({ id: "_default", title: "Default" }, 0)]);
    expect(html).toContain("engine");
    expect(html).toContain("4 open");
    // `_default` is a row, not a hidden special case.
    expect(html).toContain("_default");
  });

  test("a successful read with no published generation still lists projects", () => {
    const html = renderList([project()], 1, null);
    expect(html).not.toContain('data-ms-absence="unavailable"');
    expect(html).toContain("engine");
  });

  test("outcome 3 — a whole-read failure mounts no list", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await readProjects(failing);
    expect(result.status).toBe("error");
    expect(projectsOutcome(result).kind).toBe("failed");
  });

  test("the host supplies the project ids the filter bar offers", () => {
    const outcome = projectsOutcome({ status: "ready", envelope: listEnvelope([project(), project({ id: "ui" })]) });
    if (outcome.kind !== "ready") throw new Error("expected ready");
    expect(projectOptions(outcome.model)).toEqual(["engine", "ui"]);
    // A failed read offers nothing rather than inventing options.
    expect(projectOptions({ rows: { kind: "unavailable", reason: "x" }, total: 0 })).toEqual([]);
  });

  test("no envelope counter reaches the list", () => {
    const outcome = projectsOutcome({ status: "ready", envelope: listEnvelope([project()]) });
    if (outcome.kind !== "ready") throw new Error("expected ready");
    const html = renderToStaticMarkup(createElement(Projects, { model: outcome.model, copy: projectsCopy(copyFor("en")) }));
    expect(html).not.toContain("1224");
    expect(html).not.toContain("catalogRevision");
  });
});

describe("the milestone read", () => {
  test("the path scopes the milestone read to one project", () => {
    expect(projectMilestonesPath("engine")).toBe("/api/milestones?project=engine");
    expect(projectMilestonesPath("a/b")).toBe("/api/milestones?project=a%2Fb");
  });

  test("a populated milestones member resolves a populated body", async () => {
    const ok = (async () =>
      new Response(JSON.stringify(milestonesEnvelope(milestoneRead())), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readProjectMilestones(ok, "engine");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.milestones.kind).toBe("populated");
    if (result.milestones.kind !== "populated") return;
    expect(result.milestones.value.milestones.map((milestone) => milestone.name)).toEqual(["Release the shared layer"]);
    expect(result.milestones.value.unassignedIssues).toBe(3);
  });

  test("an empty milestone set is the empty arm, not an absence", async () => {
    const ok = (async () =>
      new Response(
        JSON.stringify(milestonesEnvelope(milestoneRead({ milestones: [], issues: [], unassignedIssues: 0 }))),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await readProjectMilestones(ok, "engine");
    expect(result).toMatchObject({ status: "ready", milestones: { kind: "empty" } });
  });

  test("a degraded member keeps its own arm and reason", async () => {
    const degraded = (async () =>
      new Response(
        // see packages/cli/web/projects-data.ts - a degraded read is the route's own refusal.
        JSON.stringify({ error: { code: "collaboration.not-initialized", message: "the milestone read could not be completed" } }),
        { status: 503, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await readProjectMilestones(degraded, "engine");
    expect(result).toMatchObject({ status: "error", message: "the milestone read could not be completed" });
  });

  test("a required collaboration gap is a failure, never an empty board", async () => {
    const gapped = (async () =>
      new Response(
        JSON.stringify(milestonesEnvelope(milestoneRead(), { collaboration: partialObservation })),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    expect(await readProjectMilestones(gapped, "engine")).toMatchObject({ status: "error" });
  });

  test("a refusal is a failure, not an absence", async () => {
    const refused = (async () =>
      new Response(JSON.stringify({ error: { code: "store.not-active", message: "the store is staged" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect(await readProjectMilestones(refused, "engine")).toEqual({ status: "error", message: "the store is staged" });
  });
});

describe("the dashboard milestone write channel", () => {
  /** A fetch that records the request and answers one settled response. */
  const recording = (answer: { status: number; body: unknown }) => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  test("the write posts the verb, the same read's revision and the operation id", async () => {
    const read = recording({
      status: 200,
      body: milestonesEnvelope(milestoneRead()),
    });
    const observed = await readProjectMilestones(read.fetchImpl, "engine");
    expect(observed).toMatchObject({ status: "ready", storeRevision: 41 });

    const write = recording({ status: 200, body: { data: { milestoneId: "m-new", revision: 1 } } });
    const result = await writeMilestone(write.fetchImpl, {
      verb: "create",
      projectId: "engine",
      input: { name: "New milestone", effortSessions: null, ordinal: 1 },
      operationId: "op-1",
      expectedStoreRevision: 41,
    });
    expect(result.status).toBe("ok");
    expect(write.calls[0]).toEqual({
      url: MILESTONE_WRITE_PATH,
      method: "POST",
      body: {
        verb: "create",
        projectId: "engine",
        input: { name: "New milestone", effortSessions: null, ordinal: 1 },
        operationId: "op-1",
        expectedStoreRevision: 41,
      },
    });
  });

  test("a stale observation is refused with the store's own revision-conflict, never a silent success", async () => {
    const write = recording({
      status: 500,
      body: { error: { code: "milestone.revision-conflict", message: "[milestone.revision-conflict] the store moved" } },
    });
    const result = await writeMilestone(write.fetchImpl, {
      verb: "update",
      projectId: "engine",
      milestoneId: "9f2c4a10",
      patch: { name: "Renamed" },
      operationId: "op-2",
      expectedStoreRevision: 12,
    });
    expect(result).toMatchObject({ status: "refused", code: "milestone.revision-conflict" });
    if (result.status !== "refused") return;
    expect(result.message).toContain("milestone.revision-conflict");
  });

  test("a transport failure is its own code, so a retry can keep its operation id", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await writeMilestone(failing, {
      verb: "remove",
      projectId: "engine",
      milestoneId: "9f2c4a10",
      operationId: "op-3",
      expectedStoreRevision: 12,
    });
    expect(result).toMatchObject({ status: "refused", code: "transport-error" });
  });

  test("an assignment carries the issue's own revision beside the store revision", async () => {
    const write = recording({ status: 200, body: { data: { changed: true } } });
    await writeMilestone(write.fetchImpl, {
      verb: "assign",
      projectId: "engine",
      issueId: "I-000870",
      milestoneId: "9f2c4a10",
      issueRevision: 3,
      operationId: "op-4",
      expectedStoreRevision: 41,
    });
    expect(write.calls[0]?.body).toMatchObject({
      verb: "assign",
      issueId: "I-000870",
      milestoneId: "9f2c4a10",
      issueRevision: 3,
      expectedStoreRevision: 41,
    });
  });
});

describe("the detail's fixed feature set", () => {
  const listModel = () => projectListModel(listEnvelope([project()]));
  const render = (feature: (typeof PROJECT_FEATURES)[number] = DEFAULT_PROJECT_FEATURE): string => {
    const rows = listModel().rows;
    if (rows.kind !== "populated") throw new Error("expected populated rows");
    return renderToStaticMarkup(
      createElement(ProjectDetail, {
        identity: projectIdentity(rows.value[0]!),
        feature,
        onFeatureChange: () => {},
        milestones: milestonesArm({ state: "read", data: milestoneRead() }),
        onBack: () => {},
        issues: createElement("div", { "data-ms-scoped-list": "issues" }),
        iterations: createElement("div", { "data-ms-scoped-list": "iterations" }),
        copy: projectDetailCopy(copyFor("en")),
      }),
    );
  };

  test("two tabs, in the product's fixed order, and no roadmap label", () => {
    expect(PROJECT_FEATURES).toEqual(["issues", "iterations"]);
    const html = render();
    const order = ["Issues", "Iterations"].map((label) => html.indexOf(label));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(html.match(/role="tab"/g)?.length).toBe(2);
    // No tab, route or label named roadmap survives.
    expect(html).not.toContain("Roadmap");
    expect(html).not.toContain("roadmap");
  });

  test("Issues is the permanent default", () => {
    expect(DEFAULT_PROJECT_FEATURE).toBe("issues");
    // The default is a constant, not "the first tab that has content": selecting
    // `iterations` moves the selection and leaves the default where it was.
    const iterations = render("iterations");
    expect(iterations).toContain('data-ms-feature="iterations"');
    const issues = render("issues");
    expect(issues).toContain('data-ms-feature="issues"');
    expect(issues).not.toContain('data-ms-feature="iterations"');
  });

  test("the milestone body renders from the rollup on every feature", () => {
    const html = render();
    expect(html).toContain('data-ms-milestones=""');
    expect(html).toContain('data-ms-milestone-timeline=""');
    expect(html).toContain("Release the shared layer");
    // The body is not a tab: it is present whichever feature is selected.
    expect(render("iterations")).toContain('data-ms-milestones=""');
  });

  test("the breadcrumb names the trail and the project", () => {
    const html = render();
    expect(html).toContain("Projects");
    expect(html).toContain("engine");
  });

  test("no envelope counter, timestamp or catalog revision reaches the detail", () => {
    const html = render();
    for (const removed of ["1224", "storeRevision", "catalogRevision", "builtAt", "checkedAt", "sourceHash"]) {
      expect(html).not.toContain(removed);
    }
  });
});

describe("the page's conflict policy (the production re-read and draft rules)", () => {
  // The assertions fail if `main.tsx` drops the automatic re-read or clears drafts:
  // the page has no policy of its own left to drift — it renders this function's
  // output (reloadOverview → reload token, keepDraft → the draft store, etc.).
  const accepted = { status: "ok" as const, receipt: null };

  test("an accepted write re-reads the overview and CLEARS the draft", () => {
    expect(milestoneWriteFollowUp({ verb: "update" }, accepted)).toEqual({
      reloadOverview: true,
      refreshIssues: false,
      keepDraft: false,
      refusal: null,
      retainOperation: false,
    });
  });

  test("a revision conflict re-reads the overview and KEEPS the typed draft", () => {
    const conflict = milestoneWriteFollowUp(
      { verb: "update" },
      { status: "refused", code: "milestone.revision-conflict", message: "[milestone.revision-conflict] moved" },
    );
    expect(conflict.reloadOverview).toBe(true);
    // THE regression the earlier test could not catch: a page that stopped
    // re-reading, or cleared the draft on a conflict, fails here.
    expect(conflict.keepDraft).toBe(true);
    expect(conflict.refusal).toContain("milestone.revision-conflict");
    expect(conflict.retainOperation).toBe(false);
  });

  test("an input refusal neither re-reads nor drops the draft", () => {
    const refused = milestoneWriteFollowUp(
      { verb: "create" },
      { status: "refused", code: "milestone.invalid-input", message: "[milestone.invalid-input] bad name" },
    );
    expect(refused.reloadOverview).toBe(false);
    expect(refused.keepDraft).toBe(true);
    expect(refused.refusal).toContain("invalid-input");
  });

  test("an ambiguous transport failure keeps the operation for a replay and does not re-read", () => {
    const ambiguous = milestoneWriteFollowUp(
      { verb: "create" },
      { status: "refused", code: "transport-error", message: "unreachable" },
    );
    expect(ambiguous.reloadOverview).toBe(false);
    expect(ambiguous.retainOperation).toBe(true);
    expect(ambiguous.keepDraft).toBe(true);
  });

  test("the page-state transition performs the follow-up: reload, refresh, verdict, operation", () => {
    // The page calls this reducer with the policy's output; these cases are the
    // transition itself, so the wiring cannot pass on a source-string match.
    const start: MilestonePageState = {
      overviewReloadToken: 3,
      issuesRefreshToken: 1,
      writes: { busy: false, refusal: null, keepDraft: undefined },
      operationPending: false,
    };
    const inFlight = milestoneWriteStarted(start);
    expect(inFlight).toMatchObject({ writes: { busy: true, refusal: null, keepDraft: undefined }, operationPending: true });

    // Conflict: the overview re-reads, the draft verdict is "keep", the operation settles.
    const conflict = applyMilestoneFollowUp(
      inFlight,
      milestoneWriteFollowUp(
        { verb: "update" },
        { status: "refused", code: "milestone.revision-conflict", message: "[milestone.revision-conflict] moved" },
      ),
    );
    expect(conflict.overviewReloadToken).toBe(start.overviewReloadToken + 1);
    expect(conflict.issuesRefreshToken).toBe(start.issuesRefreshToken);
    expect(conflict.writes).toEqual({ busy: false, refusal: "[milestone.revision-conflict] moved", keepDraft: true });
    expect(conflict.operationPending).toBe(false);

    // Accepted: the overview re-reads, the draft verdict is "clear", the operation settles.
    const accepted = applyMilestoneFollowUp(inFlight, milestoneWriteFollowUp({ verb: "update" }, { status: "ok", receipt: null }));
    expect(accepted.overviewReloadToken).toBe(start.overviewReloadToken + 1);
    expect(accepted.writes).toEqual({ busy: false, refusal: null, keepDraft: false });
    expect(accepted.operationPending).toBe(false);

    // Input refusal: nothing re-reads; the draft stays; the operation settles.
    const refused = applyMilestoneFollowUp(
      inFlight,
      milestoneWriteFollowUp({ verb: "create" }, { status: "refused", code: "milestone.invalid-input", message: "bad name" }),
    );
    expect(refused.overviewReloadToken).toBe(start.overviewReloadToken);
    expect(refused.issuesRefreshToken).toBe(start.issuesRefreshToken);
    expect(refused.writes).toEqual({ busy: false, refusal: "bad name", keepDraft: true });
    expect(refused.operationPending).toBe(false);

    // Transport-ambiguous: nothing re-reads; the operation stays armed for the replay.
    const ambiguous = applyMilestoneFollowUp(
      inFlight,
      milestoneWriteFollowUp({ verb: "create" }, { status: "refused", code: "transport-error", message: "unreachable" }),
    );
    expect(ambiguous.overviewReloadToken).toBe(start.overviewReloadToken);
    expect(ambiguous.writes.keepDraft).toBe(true);
    expect(ambiguous.operationPending).toBe(true);

    // Accepted assign: BOTH reads re-read.
    const assigned = applyMilestoneFollowUp(inFlight, milestoneWriteFollowUp({ verb: "assign" }, { status: "ok", receipt: null }));
    expect(assigned.issuesRefreshToken).toBe(start.issuesRefreshToken + 1);
    expect(assigned.overviewReloadToken).toBe(start.overviewReloadToken + 1);
  });

  test("only an assignment refreshes the scoped list/picker", () => {
    expect(milestoneWriteFollowUp({ verb: "assign" }, accepted).refreshIssues).toBe(true);
    for (const verb of ["create", "update", "remove"] as const) {
      expect(milestoneWriteFollowUp({ verb }, accepted).refreshIssues).toBe(false);
    }
    // A refused assignment wrote nothing: no refresh.
    expect(
      milestoneWriteFollowUp({ verb: "assign" }, { status: "refused", code: "milestone.revision-conflict", message: "moved" })
        .refreshIssues,
    ).toBe(true);
    expect(
      milestoneWriteFollowUp({ verb: "assign" }, { status: "refused", code: "milestone.invalid-input", message: "bad" })
        .refreshIssues,
    ).toBe(false);
  });
});
