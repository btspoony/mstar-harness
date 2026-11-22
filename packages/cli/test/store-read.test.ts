/**
 * CLI store-read transport -- the dashboard API surface (P6).
 *
 * Every case runs the real adapter against the real engine read boundary and a
 * real temporary store (`node:sqlite`), asserting observable contracts: the
 * route table, the query-parameter refusals, and the envelopes each view
 * answers with. No mocked database exists anywhere in this proof.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import * as storeDb from "@mstar-harness/engine";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { applyStoreMigration, activateStore, captureIssue, closeIssue, ensureCollaborationAuthority, getCatalog, getIssue, initializeCollaborationStore, initializeStore, listCatalog, listIssues, openCollaborationStore, openStore, planStoreMigration, readExecutionAuthority, refreshProjections, registerCatalogEntity, replaceRoadmapAuthority, resolveCollaborationLocation, ACTIVATION_PROTOCOL_VERSION, type ActivationAttestation, type CaptureInput, type IssueDetail, type IssueFlow, type IssuePage, type IterationListDTO, type RoadmapDTO, type StoreContext, type StoreDb, type WorkflowListDTO } from "@mstar-harness/engine";
import {
  dashboardFailure,
  dashboardFilters,
  readDashboardView,
  resolveDashboardRoute,
} from "../../commands/src/dashboard/store-read";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-read-cli-"));
const RECORDED_AT = "2026-09-18T02:00:00.000Z";

/** note: The user-level collaboration lane is resolved through `homedir`; isolate it. */
const LANE_HOME = join(ROOT, "lane-home");
mkdirSync(LANE_HOME, { recursive: true });
let laneHomeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  laneHomeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => LANE_HOME);
});
afterAll(() => {
  laneHomeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

let repoSequence = 0;

/**
 * why: A real checkout: issue and catalog authority is the collaboration lane, so a
 * fixture without a repository identity has no issue store at all.
 */
async function workspace(name: string, initialize = true, lane = true): Promise<{ dir: string; harness: string; context: StoreContext }> {
  const dir = mkdtempSync(join(ROOT, name));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(dir, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=fixture-${repoSequence++}\n`);
  const harness = join(dir, ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: harness, checkoutRoot: dir };
  if (lane) await ensureCollaborationAuthority(context);
  if (initialize) {
    const handle = await initializeStore(context);
    handle.close();
  }
  return { dir, harness, context };
}

/** note: The lane's own revision: the issue/catalog authority the reads report. */
async function laneRevision(context: StoreContext): Promise<number> {
  const handle = await openCollaborationStore(context, "read");
  try {
    const row = handle.db.prepare("select revision from collaboration_meta where id = 1").get();
    if (row === null || typeof row !== "object" || !("revision" in row) || typeof row.revision !== "number") {
      throw new Error("the fixture lane records no readable collaboration_meta singleton");
    }
    return row.revision;
  } finally {
    handle.close();
  }
}

/** note: A conforming installed-consumer attestation: one upgraded CLI on node. */
function activationAttestation(): ActivationAttestation {
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-09-18T00:00:00.000Z",
    operator: { actor: "fixture-operator", authorizationRef: "store-read fixture" },
    consumers: [
      {
        entryId: "coordinator-omp",
        kind: "coordinator",
        entrypoint: "/Users/op/.omp/plugins/mstar/packages/cli/dist/index.js",
        runtime: "node",
        runtimeVersion: "99.0.0",
        version: "0.0.0-synthetic",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: [],
  };
}

async function withWrite(context: StoreContext, fn: (db: StoreDb) => void): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    fn(handle.db);
  } finally {
    handle.close();
  }
}

async function seedIssue(context: StoreContext, title: string, severity: CaptureInput["severity"], disposition: "open" | "resolved" = "open"): Promise<void> {
  const captured = await captureIssue(context, {
    projectId: "proj-a", title, severity, kind: "bug",
    impact: "Dashboard consumer observes this issue", acceptance: "Dashboard returns its stored disposition",
    sourceIdentity: title, rootCauseKey: title, acceptanceKey: title, occurrenceKey: title,
    sourceKind: "test", location: "store-read.test.ts", observedBehavior: title,
    evidence: ["isolated fixture"], discoveredAt: RECORDED_AT,
  }, { actor: "project-manager", operationId: `capture-${title}` });
  if (disposition === "resolved") {
    await closeIssue(context, captured.issueId, disposition, {
      reason: "Fixture acceptance met", references: ["fixture"], alignmentRef: "QA gate: Approve — fixture",
    }, { actor: "project-manager", operationId: `close-${title}`, expectedRevision: captured.revision });
  }
}

describe("route table", () => {
  test("resolves exactly the fixed API routes", () => {
    expect(resolveDashboardRoute("/api/issues")).toEqual({ view: "issues" });
    expect(resolveDashboardRoute("/api/issue-flow")).toEqual({ view: "issue-flow" });
    expect(resolveDashboardRoute("/api/workflows")).toEqual({ view: "workflows" });
    expect(resolveDashboardRoute("/api/iterations")).toEqual({ view: "iterations" });
    expect(resolveDashboardRoute("/api/roadmap")).toEqual({ view: "roadmap" });
    expect(resolveDashboardRoute("/api/projects")).toEqual({ view: "projects" });
    // The aggregated read is a list-shaped route with a `project` filter: it has
    // no detail form, so its path takes no id decode.
    expect(resolveDashboardRoute("/api/overview")).toEqual({ view: "overview" });
    expect(resolveDashboardRoute("/api/issues/I-000001")).toEqual({ view: "issue-detail", id: "I-000001" });
    expect(resolveDashboardRoute("/api/issues/I%2D1")).toEqual({ view: "issue-detail", id: "I-1" });
    expect(resolveDashboardRoute("/api/workflows/wf-read")).toEqual({ view: "workflow-detail", id: "wf-read" });
    expect(resolveDashboardRoute("/api/iterations/iter-read")).toEqual({ view: "iteration-detail", id: "iter-read" });
  });

  test("refuses or ignores everything else instead of guessing a view", () => {
    for (const pathname of [
      "/",
      "/api",
      "/api/",
      "/api/issues/",
      "/api/issue-flow/I-1",
      "/api/roadmap/deep/path",
      "/api/overview/proj-a",
      "/api/project",
      "/api/issues/../../etc/passwd",
      "//api/issues",
    ]) {
      expect(resolveDashboardRoute(pathname)).toBeNull();
    }
    // A single segment that decodes to a traversal id is refused, not mapped.
    expect(() => resolveDashboardRoute("/api/issues/%2e%2e")).toThrow(/single safe id/);
    expect(() => resolveDashboardRoute("/api/issues/a%2Fb")).toThrow(/single safe id/);
  });
});

describe("query-parameter refusals", () => {
  test("accepts the contract's fields with the contract's defaults", () => {
    expect(dashboardFilters("issues")).toEqual({ issue: {} });
    expect(dashboardFilters("issues", { project: "proj-a", disposition: "open", kind: "bug", severity: "high", q: "race", limit: "10", offset: "5" })).toEqual({
      issue: { projectId: "proj-a", disposition: "open", kind: "bug", severity: "high", query: "race", limit: 10, offset: 5 },
    });
    expect(dashboardFilters("workflows", { project: "proj-a", limit: "2", offset: "0" })).toEqual({ projectId: "proj-a", limit: 2, offset: 0 });
    expect(dashboardFilters("iteration-detail", {}, "iter-read")).toEqual({ id: "iter-read" });
    expect(dashboardFilters("roadmap", { project: "proj-a" })).toEqual({ projectId: "proj-a" });
    expect(dashboardFilters("projects", {})).toEqual({});
    for (const params of [{ limit: "2" }, { offset: "0" }, { project: "p" }]) {
      expect(() => dashboardFilters("projects", params)).toThrow(/not a supported projects query parameter/);
    }
    expect(dashboardFilters("issue-flow", {})).toEqual({});
  });

  test("rejects unknown enums, bad pages, excessive search and unknown fields", () => {
    const cases: Array<[() => unknown, RegExp]> = [
      [() => dashboardFilters("issues", { disposition: "fixed" }), /disposition must be one of/],
      [() => dashboardFilters("issues", { kind: "toString" }), /kind must be one of/],
      [() => dashboardFilters("issues", { severity: "blocker" }), /severity must be one of/],
      [() => dashboardFilters("issues", { limit: "201" }), /limit must be an integer between 1 and 200/],
      [() => dashboardFilters("issues", { limit: "0" }), /limit must be an integer between 1 and 200/],
      [() => dashboardFilters("issues", { limit: "1.5" }), /limit must be a nonnegative integer/],
      [() => dashboardFilters("issues", { offset: "-1" }), /offset must be a nonnegative integer/],
      [() => dashboardFilters("issues", { q: "x".repeat(201) }), /at most 200 characters/],
      [() => dashboardFilters("issues", { unknown: "1" }), /not a supported issues query parameter/],
      [() => dashboardFilters("issues", { project: "../elsewhere" }), /single safe id/],
      [() => dashboardFilters("issue-detail"), /requires an id/],
      [() => dashboardFilters("roadmap"), /requires a project query parameter/],
      [() => dashboardFilters("roadmap", { disposition: "open" }), /not a supported roadmap query parameter/],
    ];
    for (const [run, message] of cases) {
      expect(run).toThrow(message);
    }
    // Exactly at the limit is accepted.
    expect(dashboardFilters("issues", { q: "x".repeat(200) })).toEqual({ issue: { query: "x".repeat(200) } });
  });
});

describe("dashboard views over a real store", () => {
  test("issues answers the default open-only page with the envelope and the issue domain's own reader", async () => {
    const { context } = await workspace("issues-");
    await seedIssue(context, "critical open", "critical");
    await seedIssue(context, "medium open", "medium");
    await seedIssue(context, "resolved", "high", "resolved");

    const envelope = await readDashboardView({ context, view: "issues" });
    const page = envelope.data as IssuePage;
    // why: The direct domain read carries its own observation; the page itself keeps
    // the existing DTO keys the dashboard answers with (asserted against the
    // lane counters below).
    const direct = await listIssues(context, {});
    const { collaboration: pageEvidence, ...directPage } = direct;
    expect(page).toEqual(directPage);
    expect(pageEvidence).toMatchObject({ completeness: "complete", revision: direct.storeRevision });
    expect(page.items.map((item) => item.id)).toEqual(["I-000001", "I-000002"]);
    // note: The reported revision is the LANE's: issue/catalog authority lives there.
    expect(envelope.storeRevision).toBe(await laneRevision(context));
    expect(envelope.catalogRevision).toBe(0);
    expect(envelope.projection.freshness).toBe("unavailable");

    const filtered = await readDashboardView({
      context,
      view: "issues",
      params: { disposition: "resolved", severity: "high", q: "resolv" },
    });
    expect((filtered.data as IssuePage).items.map((item) => item.id)).toEqual(["I-000003"]);
  });

  test("issue-detail answers the issue domain's own reader and refuses an unknown id", async () => {
    const { context } = await workspace("detail-");
    await seedIssue(context, "detail row", "low");

    const envelope = await readDashboardView({ context, view: "issue-detail", id: "I-000001" });
    const direct = await getIssue(context, "I-000001");
    const { collaboration: detailEvidence, ...directDetail } = direct;
    expect(envelope.data as IssueDetail).toEqual(directDetail);
    expect(detailEvidence).toMatchObject({
      completeness: "complete",
      revision: envelope.storeRevision,
      scope: { kind: "query", key: "issue:I-000001" },
    });

    const failure = await readDashboardView({ context, view: "issue-detail", id: "I-999999" }).catch((error: unknown) => error);
    expect(dashboardFailure(failure)).toMatchObject({ code: "issue.not-found" });
  });

  test("issue-flow returns the dated buckets, the unknown-date counts and the current open total", async () => {
    // note: Missing capture dates are genuine legacy history, imported by the public
    // migration boundary rather than forged into an active issue store: a
    // file-era checkout has no lane, the reviewed apply stages one, and the
    // activation publishes it.
    const { context, harness } = await workspace("flow-", false, false);
    const projectDir = join(harness, "projects", "proj-a");
    mkdirSync(projectDir, { recursive: true });
    const entry = (overrides: Record<string, unknown>) => ({
      source: "fixture", scope: "plan-scope", decision: "defer", owner: "pm",
      target: "next-iteration", tracking: "issue", source_plan: "plan-fixture",
      ...overrides,
    });
    writeFileSync(join(projectDir, "residuals.json"), JSON.stringify({ entries: { "plan-fixture": [
      entry({ id: "R1", title: "dated", severity: "high", registered_at: "2026-09-01" }),
      entry({ id: "R2", title: "undated", severity: "high" }),
      entry({ id: "R3", title: "retired", severity: "low", lifecycle: "wont-fix", registered_at: "2026-09-02", closed_at: "2026-09-03" }),
    ] } }));
    const manifest = await planStoreMigration(context);
    const applied = await applyStoreMigration(context, manifest);
    await activateStore(context, applied, activationAttestation());

    const envelope = await readDashboardView({ context, view: "issue-flow" });
    const flow = envelope.data as IssueFlow;
    expect(flow.unknownCaptureDates).toBe(1);
    expect(flow.unknownClosureDates).toBe(0);
    expect(flow.currentOpen).toBe(2);
    expect(flow.incompleteHistory).toBe(true);
    expect(flow.buckets.map((bucket) => bucket.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(flow.buckets[flow.buckets.length - 1]).toEqual({
      date: "2026-09-03",
      capturedCumulative: 2,
      retiredCumulative: 1,
      openDifference: 1,
      origin: "register-history",
    });

    const scoped = await readDashboardView({ context, view: "issue-flow", params: { project: "proj-a" } });
    expect(scoped.data).toEqual(envelope.data);
    const other = (await readDashboardView({ context, view: "issue-flow", params: { project: "proj-other" } })).data as IssueFlow;
    expect(other.currentOpen).toBe(0);
    expect(other.buckets).toEqual([]);
  });

  test("roadmap is read from authority and does not depend on a projection generation", async () => {
    const { context } = await workspace("roadmap-authority-");
    const registration = await registerCatalogEntity(context, {
      kind: "project", id: "proj-roadmap", title: "Roadmap", rootKind: "projects", relativePath: "proj-roadmap",
    }, { operationId: "register-roadmap", actor: "store-read-test" });
    const contentMarkdown = "---\nproject_id: proj-roadmap\ntitle: Authority\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nStored independently.\n";
    await replaceRoadmapAuthority(context, {
      projectId: "proj-roadmap",
      expectedProjectRevision: registration.revision,
      expectedRoadmapRevision: "absent",
      contentMarkdown,
    }, { operationId: "create-roadmap" });

    const result = await readDashboardView({ context, view: "roadmap", params: { project: "proj-roadmap" } });
    const dto = result.data as RoadmapDTO;
    expect(dto.authority.state).toBe("present");
    expect(dto.content?.contentMarkdown).toBe(contentMarkdown);
    expect(dto.content?.direction).toContain("Stored independently.");
    expect(result.projection.freshness).toBe("unavailable");
    const missing = await readDashboardView({ context, view: "roadmap", params: { project: "proj-unknown" } });
    expect(missing.data).toBeNull();
  });

  test("projection views answer the published generation and disclose it", async () => {
    const { context } = await workspace("projection-");
    await readExecutionAuthority(context);
    const report = await refreshProjections(context);
    expect(report.freshness).toBe("current");

    const workflows = await readDashboardView({ context, view: "workflows" });
    expect(workflows.projection.freshness).toBe("current");
    // A projection view refreshes before it reads, so this request publishes
    // the current generation itself. The disclosure must match the generation
    // the store holds now, not the fixture's earlier count.
    const reader = await openStore(context, "read");
    let published: number | null;
    try {
      const row = reader.db.prepare("select generation from projection_meta where id = 1").get();
      published = typeof row === "object" && row !== null && "generation" in row && typeof row.generation === "number"
        ? row.generation
        : null;
    } finally {
      reader.close();
    }
    expect(workflows.projection.generation).toBe(published);
    expect(workflows.data as WorkflowListDTO).toEqual({ items: [], total: 0 });

    const iterations = await readDashboardView({ context, view: "iterations" });
    expect(iterations.data as IterationListDTO).toEqual({ items: [], total: 0, attribution: "absent" });

    const roadmap = await readDashboardView({ context, view: "roadmap", params: { project: "proj-absent" } });
    expect(roadmap.data as RoadmapDTO | null).toBeNull();
    // note: Roadmap authority is the lane's, so this view has no execution projection.
    expect(roadmap.projection.freshness).toBe("unavailable");
  });

  test("a missing or staged authority fails with a structured code, never an empty page", async () => {
    // invariant: No repository identity at all: the scope itself cannot be resolved.
    const identified = await workspace("no-lane-", true);
    await rmSync(resolveCollaborationLocation(identified.context).dbPath, { force: true });
    const uninitialized = await readDashboardView({ context: identified.context, view: "issues" }).catch((error: unknown) => error);
    expect(dashboardFailure(uninitialized)).toMatchObject({ code: "collaboration.not-initialized" });

    // invariant: A lane that exists but was never published serves no issue page either.
    const stagedFixture = await workspace("staged-", true, false);
    await initializeCollaborationStore(resolveCollaborationLocation(stagedFixture.context));
    const staged = await readDashboardView({ context: stagedFixture.context, view: "issue-flow" }).catch((error: unknown) => error);
    expect(dashboardFailure(staged)).toMatchObject({ code: "collaboration.not-active" });
  });

  test("failures are reported as code/message, usage separately, and never as raw payloads", async () => {
    expect(dashboardFailure(new Error("boom"))).toEqual({ code: "internal-error", message: "boom" });
    const caught = (() => {
      try {
        dashboardFilters("issues", { disposition: "fixed" });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(dashboardFailure(caught)).toEqual({
      code: "usage",
      message: expect.stringContaining("disposition must be one of"),
    });
    expect(Object.keys(dashboardFailure(caught)).sort()).toEqual(["code", "message"]);
  });

  test("collaboration command evidence: direct domain reads carry the lane observation", async () => {
    const { context } = await workspace("command-evidence-");
    await seedIssue(context, "evidence row", "low");
    await registerCatalogEntity(context, {
      kind: "project", id: "proj-a", title: "Project", rootKind: "projects", relativePath: "proj-a",
    }, { operationId: "register-evidence", actor: "store-read-test" });
    const revision = await laneRevision(context);

    const page = await listIssues(context, {});
    expect(page.collaboration).toMatchObject({ completeness: "complete", revision });
    expect(page.collaboration.scope.kind).toBe("query");
    expect(page.collaboration.scope.key.startsWith("issues:")).toBe(true);
    expect(Number.isNaN(Date.parse(page.collaboration.asOf))).toBe(false);

    const issueId = page.items[0]?.id;
    if (issueId === undefined) throw new Error("the evidence fixture seeded no issue");
    const detail = await getIssue(context, issueId);
    expect(detail.collaboration).toMatchObject({
      completeness: "complete",
      revision,
      scope: { kind: "query", key: `issue:${issueId}` },
    });

    const catalogPage = await listCatalog(context, {});
    expect(catalogPage.collaboration).toMatchObject({ completeness: "complete", revision });
    expect(catalogPage.collaboration.scope.kind).toBe("query");
    expect(catalogPage.collaboration.scope.key.startsWith("catalog:")).toBe(true);

    const catalogDetail = await getCatalog(context, { kind: "project", id: "proj-a" });
    expect(catalogDetail.collaboration).toMatchObject({
      completeness: "complete",
      revision,
      scope: { kind: "query", key: "catalog:project:proj-a" },
    });
  });

  test("each source observation is stamped at its own snapshot, not at request time", async () => {
    const { context } = await workspace("as-of-");
    await seedIssue(context, "as-of row", "low");
    const realOpen = storeDb.openStore;
    const spy = spyOn(storeDb, "openStore").mockImplementation(async (ctx, mode) => {
      // invariant: The execution open is slow: the collaboration observation must NOT be
      // backdated to a shared pre-open instant.
      if (mode === "read") await new Promise((resolve) => setTimeout(resolve, 40));
      return realOpen(ctx, mode);
    });
    let envelope;
    const startedAt = Date.parse(new Date().toISOString());
    try {
      envelope = await readDashboardView({ context, view: "overview" });
    } finally {
      spy.mockRestore();
    }
    const collaborationAsOf = Date.parse(envelope.collaboration!.asOf!);
    const executionAsOf = Date.parse(envelope.execution!.asOf as string);
    // why: The shared pre-open instant the old read recorded would sit at request time;
    // each source's own in-transaction stamp lands after its own open, so the
    // collaboration observation carries the slow execution open's delay.
    expect(collaborationAsOf - startedAt).toBeGreaterThanOrEqual(30);
    expect(executionAsOf).toBeGreaterThanOrEqual(collaborationAsOf);
  });
});