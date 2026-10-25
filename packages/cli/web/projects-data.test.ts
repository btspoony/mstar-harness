/**
 * The host's envelope handling for the Projects pair, and the two facts this pair
 * is the only place to get wrong:
 *
 *  - the feature set is the fixed three with `Roadmap` permanently default — never
 *    "the first non-empty";
 *  - a project with no roadmap authority row is `absent`: not an empty board, not a
 *    hidden row, and `_default` is a real row that can carry it.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectListDTO, RoadmapDTO } from "@mstar-harness/engine";
import {
  DEFAULT_PROJECT_FEATURE,
  PROJECT_FEATURES,
  ProjectDetail,
  Projects,
  copyFor,
  projectIdentity,
  roadmapBody,
  roadmapFeatureArm,
} from "@mstar-harness/ui";

import {
  projectDetailCopy,
  projectRoadmapPath,
  projectOptions,
  projectsCopy,
  projectsOutcome,
  readProjects,
  readRoadmap,
  roadmapOutcome,
} from "./projects-data";

const projection = {
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

const roadmap = (over: Partial<RoadmapDTO> = {}): RoadmapDTO => ({
  projectId: "engine",
  catalog: catalogEntry() as unknown as RoadmapDTO["catalog"],
  authority: { state: "present", revision: 7, contentHash: "sha256:abcd1234" },
  content: {
    contentMarkdown: "## Direction\n\nOne product, two hosts.",
    frontmatter: { project_id: "engine", title: "Engine roadmap", status: "active", created_at: "2026-08-09" },
    direction: "One product, two hosts.",
    goals: [{ ordinal: 1, parentOrdinal: null, checked: true, title: "One design system", body: "" }],
    milestones: [],
    sections: [],
  } as unknown as RoadmapDTO["content"],
  milestones: {
    projectId: "engine",
    milestones: [],
    issues: [],
    unassignedIssues: 0,
  },
  ...over,
}) as RoadmapDTO;

const renderList = (items: ProjectListDTO["items"], total = items.length, generation: number | null = 7): string => {
  const outcome = projectsOutcome({ status: "ready", envelope: listEnvelope(items, total, generation) });
  if (outcome.kind !== "ready") throw new Error("expected a ready list");
  return renderToStaticMarkup(createElement(Projects, { model: outcome.model, copy: projectsCopy(copyFor("en")) }));
};

describe("the projects list", () => {
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

describe("the roadmap read", () => {
  test("the path scopes to one project", () => {
    expect(projectRoadmapPath("engine")).toBe("/api/roadmap?project=engine");
    expect(projectRoadmapPath("a/b")).toBe("/api/roadmap?project=a%2Fb");
  });

  test("a project with a roadmap row resolves a populated body", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ data: roadmap(), projection }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readRoadmap(ok, "engine");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.identity.projectId).toBe("engine");
    expect(result.roadmap.kind).toBe("populated");
  });

  test("no roadmap authority row is ABSENT — and the head keeps the store's own facts", async () => {
    // An absent authority row still ships a catalog entry. The head must be built
    // from it: a synthesised title, `lifecycle: "unknown"` and a guessed path would
    // be three invented facts on a page whose subject is what the store knows.
    const absent = (async () =>
      new Response(
        JSON.stringify({
          data: roadmap({
            catalog: catalogEntry({ id: "_default", title: "Default", lifecycle: "staging" }) as never,
            authority: { state: "absent" } as never,
          }),
          projection,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await readRoadmap(absent, "_default");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.roadmap.kind).toBe("absent");
    // From the catalog, not from the route id.
    expect(result.identity.projectId).toBe("_default");
    expect(result.identity.title).toBe("Default");
    expect(result.identity.lifecycle).toBe("staging");
    expect(result.identity.path).toBe("projects:engine");
  });

  test("a roadmap with no content at all is empty, a different arm", () => {
    // Nothing to act on: no direction, no goals, no milestones, no stored markdown.
    const bare = roadmap({ content: null } as Partial<RoadmapDTO>);
    expect(roadmapBody(roadmapFeatureArm({ data: bare, projection })).kind).toBe("empty");
  });

  test("a roadmap that reads but is unprojected is still absent, not unavailable", async () => {
    // `data: null` is an absence whether or not a projection exists; the roadmap is
    // not a projected view, so a null generation must not turn absence into failure.
    const unprojected = (async () =>
      new Response(JSON.stringify({ data: null, projection: { ...projection, generation: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readRoadmap(unprojected, "engine");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.roadmap.kind).toBe("absent");
  });

  test("a 404 is absent, through the same outcome", async () => {
    const notFound = (async () =>
      new Response(JSON.stringify({ error: { code: "not-found", message: "no such project" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readRoadmap(notFound, "gone");
    expect(result.status).toBe("absent");
    const outcome = roadmapOutcome(result, "gone");
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.roadmap.kind).toBe("absent");
  });

  test("a refusal is a failure, not an absence", async () => {
    const refused = (async () =>
      new Response(JSON.stringify({ error: { code: "store.not-active", message: "the store is staged" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect(await readRoadmap(refused, "engine")).toEqual({ status: "error", message: "the store is staged" });
  });
});

describe("the detail's fixed feature set", () => {
  const render = (feature: (typeof PROJECT_FEATURES)[number] = DEFAULT_PROJECT_FEATURE): string => {
    const arm = roadmapBody(roadmapFeatureArm({ data: roadmap(), projection }));
    return renderToStaticMarkup(
      createElement(ProjectDetail, {
        identity: projectIdentity(roadmap().catalog),
        feature,
        onFeatureChange: () => {},
        roadmap: arm,
        onBack: () => {},
        issues: createElement("div", { "data-ms-scoped-list": "issues" }),
        iterations: createElement("div", { "data-ms-scoped-list": "iterations" }),
        copy: projectDetailCopy(copyFor("en")),
      }),
    );
  };

  test("three tabs, in the product's fixed order", () => {
    expect(PROJECT_FEATURES).toEqual(["roadmap", "issues", "iterations"]);
    const html = render();
    const order = ["Roadmap", "Issues", "Iterations"].map((label) => html.indexOf(label));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  test("Roadmap is the permanent default", () => {
    expect(DEFAULT_PROJECT_FEATURE).toBe("roadmap");
    // The default is a constant, not "the first tab that has content": selecting
    // `issues` moves the selection and leaves the default where it was.
    const issues = render("issues");
    expect(issues).toContain('data-ms-feature="issues"');
    const roadmapTab = render("roadmap");
    expect(roadmapTab).toContain('data-ms-feature="roadmap"');
    expect(roadmapTab).not.toContain('data-ms-feature="issues"');
  });

  test("the breadcrumb names the trail and the project", () => {
    const html = render();
    expect(html).toContain("Projects");
    expect(html).toContain("engine");
  });

  test("a project with no roadmap renders the absent arm, with a next step", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectDetail, {
        identity: projectIdentity(roadmap().catalog),
        feature: "roadmap",
        onFeatureChange: () => {},
        roadmap: { kind: "absent" },
        onBack: () => {},
        issues: createElement("div", {}),
        iterations: createElement("div", {}),
        copy: projectDetailCopy(copyFor("en")),
      }),
    );
    expect(html).toContain('data-ms-absence="absent"');
    expect(html).not.toContain('data-ms-absence="empty"');
  });

  test("no envelope counter, timestamp or catalog revision reaches the detail", () => {
    const html = render();
    for (const removed of ["1224", "storeRevision", "catalogRevision", "builtAt", "checkedAt", "sourceHash"]) {
      expect(html).not.toContain(removed);
    }
  });
});
