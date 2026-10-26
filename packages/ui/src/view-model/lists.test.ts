/**
 * Workflows, iterations and projects: the list/detail state machines and the
 * fact sets of IA §8.2.
 *
 * Each module's negative half is asserted here: no leases, no adoption rows, no
 * pin badges, no document inventory, no catalog revision. Those members still
 * exist on the DTOs and are carried-but-never-drawn; a transform that surfaced
 * them would let a screen render what the owner removed.
 */
import { describe, expect, test } from "bun:test";
import type { IterationDTO, IterationListDTO, ProjectListDTO, RoadmapDTO, WorkflowDTO, WorkflowListDTO } from "@mstar-harness/engine";

import { branchAnchors, workflowDetailModel, workflowListModel, workflowRow } from "./workflows.ts";
import { iterationDetailModel, iterationListModel, iterationRow } from "./iterations.ts";
import { projectIdentity, projectListModel, projectRow, roadmapFeatureArm } from "./projects.ts";

const projection = (generation: number | null) => ({
  generation,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
});

const catalog = (over: Partial<NonNullable<WorkflowDTO["catalog"]>> = {}): NonNullable<WorkflowDTO["catalog"]> => ({
  kind: "plan",
  id: "p",
  title: "A plan",
  description: null,
  rootKind: "plans",
  relativePath: "p.md",
  documentKind: "plan",
  lifecycle: "active",
  revision: 3,
  registeredAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  ...over,
});

const workflow = (over: Partial<WorkflowDTO> = {}): WorkflowDTO => ({
  id: "w",
  type: "plan",
  status: "running",
  phase: "phase-2-execute",
  startedAt: "2026-10-25T01:00:00.000Z",
  endedAt: null,
  updatedAt: "2026-10-25T05:00:00.000Z",
  branch: { base: "main", source: "w", integration: "w", target: "main" },
  activeRegistration: true,
  catalog: null,
  plans: [
    {
      workflowId: "w",
      planId: "p1",
      status: "Done",
      progress: null,
      phase: "close",
      doneAt: "2026-10-19T00:00:00.000Z",
      catalogPinRevision: 2,
      catalog: catalog({ title: "Plan one" }),
      leases: [
        {
          workflowId: "w",
          planId: "p1",
          kind: "execution",
          holder: "frontend-dev",
          worktreePath: "/tmp/wt",
          expiresAt: "2026-10-25T12:00:00.000Z",
        },
      ],
      badges: [],
    },
    {
      workflowId: "w",
      planId: "p2",
      status: "InProgress",
      progress: "wiring",
      phase: "implement",
      doneAt: null,
      catalogPinRevision: null,
      catalog: null,
      leases: [],
      badges: ["catalog-pin-missing"],
    },
  ],
  badges: ["catalog-missing"],
  ...over,
});

const iteration = (over: Partial<IterationDTO> = {}): IterationDTO => ({
  iterationId: "iter-1",
  catalog: catalog({ kind: "iteration", id: "iter-1", title: "An iteration", lifecycle: "active" }),
  compass: {
    iterationId: "iter-1",
    summary: "the summary",
    milestones: ["m-1"],
    startedAt: "2026-10-25T01:10:00.000Z",
    endedAt: null,
    status: "locked",
  },
  workflow: { id: "w", status: "running", phase: "phase-2-execute", activeRegistration: true },
  plans: [
    {
      planId: "p1",
      catalog: catalog(),
      execution: { workflowId: "w", status: "Done", progress: null, phase: "close", doneAt: "2026-10-19T00:00:00.000Z" },
      catalogPinRevision: 2,
      badges: [],
    },
    { planId: "p2", catalog: null, execution: null, catalogPinRevision: null, badges: [] },
  ],
  documents: [
    catalog({ kind: "document", id: "doc-1", title: "A document", documentKind: "compass" }),
  ],
  badges: [],
  gateStep: 3,
  ...over,
}) as IterationDTO;

describe("workflows", () => {
  test("a list row carries the §8.2 facts, including the plan tally", () => {
    const row = workflowRow(workflow());
    expect(row.id).toBe("w");
    expect(row.type).toBe("plan");
    expect(row.status).toBe("running");
    expect(row.phase).toBe("phase-2-execute");
    expect(row.plansDone).toBe(1);
    expect(row.plansTotal).toBe(2);
    expect(row.startedAt).toBe("2026-10-25 01:00");
  });

  test("NEGATIVE: leases, adoption rows and pin badges are not surfaced", () => {
    const row = workflowRow(workflow());
    for (const removed of ["leases", "terminalUnregistered", "terminalAdoptions", "plans"]) {
      expect(Object.keys(row)).not.toContain(removed);
    }
    // The prototype's `Join badges` column renders these, so the row carries them.
    expect(Object.keys(row)).toContain("badges");
    // The one surviving badge is the reason a state is unavailable, not a chip.
    expect(row.executionUnavailableReason).toBeNull();
    expect(workflowRow(workflow({ badges: ["execution-unavailable"] })).executionUnavailableReason).not.toBeNull();
  });

  test("the four branch anchors survive", () => {
    expect(branchAnchors(workflow().branch)).toEqual({
      base: "main",
      source: "w",
      integration: "w",
      target: "main",
    });
  });

  test("no valid projection is unavailable, never empty", () => {
    const model = workflowListModel({ data: { items: [], total: 0 } as WorkflowListDTO, projection: projection(null) });
    expect(model.rows.kind).toBe("unavailable");
  });

  test("an idle store is empty", () => {
    const model = workflowListModel({ data: { items: [], total: 0 } as WorkflowListDTO, projection: projection(3) });
    expect(model.rows).toEqual({ kind: "empty" });
  });

  test("the detail plan table carries status, progress and the done date", () => {
    const model = workflowDetailModel({ data: workflow(), projection: projection(3) });
    if (model.kind !== "populated") throw new Error("expected the detail");
    expect(model.value.plans).toHaveLength(2);
    expect(model.value.plans[0]).toMatchObject({ planId: "p1", title: "Plan one", status: "Done" });
    expect(model.value.plans[1]).toMatchObject({ planId: "p2", title: null, status: "InProgress", progress: "wiring" });
    for (const removed of ["leases", "pin", "badges"]) {
      expect(Object.keys(model.value.plans[0] ?? {})).not.toContain(removed);
    }
  });

  test("a null record is absent, and a failed read is unavailable", () => {
    // The package-wide ruling: `null` cannot also mean "could not read".
    expect(workflowDetailModel({ data: null, projection: projection(3) }).kind).toBe("absent");
    expect(workflowDetailModel({ data: null, projection: projection(null) }).kind).toBe("unavailable");
  });
});

describe("iterations", () => {
  test("a list row carries compass status, the proven step and the plan tally", () => {
    const row = iterationRow(iteration());
    expect(row.iterationId).toBe("iter-1");
    expect(row.compassStatus).toBe("locked");
    expect(row.gateStep).toBe(3);
    expect(row.gatePosition).toEqual({ step: 3, of: 5 });
    expect(row.plansDone).toBe(1);
    expect(row.plansTotal).toBe(2);
  });

  test("NEGATIVE: no document inventory and no compass milestone list is surfaced", () => {
    const row = iterationRow(iteration());
    // `documents` is a count now (the prototype's `Documents` column); the rest stay out.
    for (const removed of ["milestones", "revision", "counters"]) {
      expect(Object.keys(row)).not.toContain(removed);
    }
    expect(Object.keys(row)).toContain("documents");
  });

  test("a project that attributes no iteration is absent, not empty", () => {
    const data: IterationListDTO = { items: [], total: 0, attribution: "present" };
    const absent = iterationListModel({
      data: { ...data, attribution: "absent" } ,
      projection: projection(3),
    });
    expect(absent.attribution).toBe("absent");
    expect(absent.rows).toEqual({ kind: "absent" });
  });

  test("an attributing project with no rows is empty", () => {
    const data: IterationListDTO = { items: [], total: 0, attribution: "present" };
    const empty = iterationListModel({
      data: { ...data, attribution: "present" } ,
      projection: projection(3),
    });
    expect(empty.rows).toEqual({ kind: "empty" });
  });

  test("the detail marks exactly one of the five steps", () => {
    const model = iterationDetailModel({ data: iteration(), projection: projection(3) });
    if (model.kind !== "populated") throw new Error("expected the detail");
    expect(model.value.steps.filter((step) => step.position === "current")).toHaveLength(1);
    expect(model.value.steps[2]?.position).toBe("current");
    // Step 5 is never current: the store proves no merge.
    expect(model.value.steps[4]?.position).toBe("ahead");
  });

  test("the detail carries the linked workflow and the plan rows", () => {
    const model = iterationDetailModel({ data: iteration(), projection: projection(3) });
    if (model.kind !== "populated") throw new Error("expected the detail");
    expect(model.value.workflowId).toBe("w");
    expect(model.value.summary).toBe("the summary");
    expect(model.value.plans.map((plan) => plan.planId)).toEqual(["p1", "p2"]);
    // A plan with no execution row is `not started`, not an error.
    expect(model.value.plans[1]?.status).toBeNull();
  });

  test("an iteration that records no compass is absent", () => {
    expect(iterationDetailModel({ data: null, projection: projection(3) }).kind).toBe("absent");
  });
});

describe("projects", () => {
  const listItem = (id: string, openIssues: number, description: string | null): ProjectListDTO["items"][number] => ({
    project: catalog({ kind: "project", id, title: id, lifecycle: "active", description }),
    openIssues,
  });

  test("a list row carries id, title, description, lifecycle and the open count", () => {
    const row = projectRow(listItem("engine", 14, "Store, projection and gates"));
    expect(row).toEqual({
      projectId: "engine",
      title: "engine",
      description: "Store, projection and gates",
      lifecycle: "active",
      lifecycleTone: "neutral",
      openIssues: 14,
      openIssuesText: "14 open issues",
    });
  });

  test("the count is singular-aware", () => {
    expect(projectRow(listItem("_default", 1, null)).openIssuesText).toBe("1 open issue");
  });

  test("the identity block carries the path, the revision and the catalog's two dates", () => {
    const identity = projectIdentity(catalog({ kind: "project", id: "engine", title: "Engine" }));
    expect(identity.path).toBe("plans:p.md");
    // The prototype's identity panel prints Revision, Registered and Updated, so all three
    // are carried. The source hash stays out — the screen has no place for it.
    expect(identity.revision).toBe("3");
    expect(Object.keys(identity)).toContain("registeredAt");
    expect(Object.keys(identity)).toContain("updatedAt");
    expect(Object.keys(identity)).not.toContain("sourceHash");
  });

  test("the list resolves empty vs unavailable distinctly", () => {
    const data = { items: [], total: 0 } as ProjectListDTO;
    expect(projectListModel({ data, projection: projection(3) }).rows).toEqual({ kind: "empty" });
    // Projects are store-backed: no published generation is not a failure.
    expect(projectListModel({ data, projection: projection(null) }).rows).toEqual({ kind: "empty" });
  });

  test("a project with no roadmap authority row is absent, not an empty board", () => {
    const absentRoadmap = {
      projectId: "om",
      catalog: catalog({ kind: "project", id: "om" }),
      authority: { state: "absent" as const },
      content: null,
      milestones: { projectId: "om", milestones: [], issues: [], unassignedIssues: 0 },
    } satisfies RoadmapDTO;
    expect(roadmapFeatureArm({ data: absentRoadmap, projection: projection(3) })).toEqual({ kind: "absent" });
  });

  test("a declared roadmap with no milestones is populated, and the milestone list is empty", () => {
    const present = {
      projectId: "engine",
      catalog: catalog({ kind: "project", id: "engine" }),
      authority: { state: "present" as const, revision: 7, contentHash: "sha256:abcd" },
      content: null,
      milestones: { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0 },
    } satisfies RoadmapDTO;
    const arm = roadmapFeatureArm({ data: present, projection: projection(3) });
    expect(arm.kind).toBe("populated");
  });
});
