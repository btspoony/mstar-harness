/**
 * CLI store-read transport -- the dashboard API surface (P6).
 *
 * Every case runs the real adapter against the real engine read boundary and a
 * real temporary store (`node:sqlite`), asserting observable contracts: the
 * route table, the query-parameter refusals, and the envelopes each view
 * answers with. No mocked database exists anywhere in this proof.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { getIssue, initializeStore, listIssues, openStore, refreshProjections, registerCatalogEntity, replaceRoadmapAuthority, type IssueDetail, type IssueFlow, type IssuePage, type IterationListDTO, type RoadmapDTO, type StoreContext, type StoreDb, type WorkflowListDTO } from "@mstar-harness/engine";
import {
  DASHBOARD_API_VIEWS,
  dashboardFailure,
  dashboardFilters,
  readDashboardView,
  resolveDashboardRoute,
} from "../src/store-read";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-read-cli-"));
const RECORDED_AT = "2026-09-18T02:00:00.000Z";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

async function workspace(name: string): Promise<{ dir: string; harness: string; context: StoreContext }> {
  const dir = mkdtempSync(join(ROOT, name));
  const harness = join(dir, ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: dir };
  const handle = await initializeStore(context);
  handle.close();
  return { dir, harness, context };
}

async function withWrite(context: StoreContext, fn: (db: StoreDb) => void): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    fn(handle.db);
  } finally {
    handle.close();
  }
}

function seedIssue(db: StoreDb, id: string, title: string, severity: string, registeredAt: string | null, disposition = "open"): void {
  db.prepare(
    "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key) " +
      "values (?, 'proj-a', ?, 'bug', ?, ?, 'impact', 'acceptance', ?, ?, ?, 1, ?)",
  ).run(id, title, severity, disposition, registeredAt, RECORDED_AT, RECORDED_AT, `identity-${id}`);
}

describe("route table", () => {
  test("resolves exactly the fixed API routes", () => {
    expect(DASHBOARD_API_VIEWS).toEqual({
      "/api/issues": "issues",
      "/api/issue-flow": "issue-flow",
      "/api/workflows": "workflows",
      "/api/iterations": "iterations",
      "/api/roadmap": "roadmap",
    });
    expect(resolveDashboardRoute("/api/issues")).toEqual({ view: "issues" });
    expect(resolveDashboardRoute("/api/issue-flow")).toEqual({ view: "issue-flow" });
    expect(resolveDashboardRoute("/api/workflows")).toEqual({ view: "workflows" });
    expect(resolveDashboardRoute("/api/iterations")).toEqual({ view: "iterations" });
    expect(resolveDashboardRoute("/api/roadmap")).toEqual({ view: "roadmap" });
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
      "/api/projects",
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
    await withWrite(context, (db) => {
      seedIssue(db, "I-000001", "critical open", "critical", "2026-09-01");
      seedIssue(db, "I-000002", "medium open", "medium", "2026-09-02");
      seedIssue(db, "I-000003", "resolved", "high", "2026-09-03", "resolved");
    });

    const envelope = await readDashboardView({ context, view: "issues" });
    const page = envelope.data as IssuePage;
    expect(page).toEqual(await listIssues(context, {}));
    expect(page.items.map((item) => item.id)).toEqual(["I-000001", "I-000002"]);
    const reader = await openStore(context, "read");
    const storedRevision = (reader.db.prepare("select revision as n from store_meta where id = 1").get() as { n: number }).n;
    reader.close();
    expect(envelope.storeRevision).toBe(storedRevision);
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
    await withWrite(context, (db) => seedIssue(db, "I-000001", "detail row", "low", "2026-09-01"));

    const envelope = await readDashboardView({ context, view: "issue-detail", id: "I-000001" });
    expect(envelope.data as IssueDetail).toEqual(await getIssue(context, "I-000001"));

    const failure = await readDashboardView({ context, view: "issue-detail", id: "I-999999" }).catch((error: unknown) => error);
    expect(dashboardFailure(failure)).toMatchObject({ code: "issue.not-found" });
  });

  test("issue-flow returns the dated buckets, the unknown-date counts and the current open total", async () => {
    const { context } = await workspace("flow-");
    await withWrite(context, (db) => {
      seedIssue(db, "I-000001", "dated", "high", "2026-09-01");
      seedIssue(db, "I-000002", "undated", "high", null);
      seedIssue(db, "I-000003", "retired", "low", "2026-09-02", "waived");
    });
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare("update issues set closed_at = '2026-09-03' where id = 'I-000003'").run();
    } finally {
      handle.close();
    }

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
      origin: "store",
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
    const { context, harness } = await workspace("projection-");
    writeFileSync(join(harness, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-09-18", workflows: [] }));
    const report = await refreshProjections(context);
    expect(report.freshness).toBe("current");

    const workflows = await readDashboardView({ context, view: "workflows" });
    expect(workflows.projection.freshness).toBe("current");
    expect(workflows.projection.generation).toBe(report.generation);
    expect(workflows.data as WorkflowListDTO).toEqual({ items: [], total: 0 });

    const iterations = await readDashboardView({ context, view: "iterations" });
    expect(iterations.data as IterationListDTO).toEqual({ items: [], total: 0 });

    const roadmap = await readDashboardView({ context, view: "roadmap", params: { project: "proj-absent" } });
    expect(roadmap.data as RoadmapDTO | null).toBeNull();
    expect(roadmap.projection.freshness).toBe("current");
  });

  test("a missing or staged store fails with a structured code, never an empty page", async () => {
    const dir = mkdtempSync(join(ROOT, "no-store-"));
    mkdirSync(join(dir, ".mstar"), { recursive: true });
    const failure = await readDashboardView({ context: { harnessDir: dir }, view: "issues" }).catch((error: unknown) => error);
    expect(dashboardFailure(failure)).toMatchObject({ code: "store.not-initialized" });

    const { context } = await workspace("staged-");
    await withWrite(context, (db) => db.exec("update store_meta set authority_state = 'staged' where id = 1"));
    const staged = await readDashboardView({ context, view: "issue-flow" }).catch((error: unknown) => error);
    expect(dashboardFailure(staged)).toMatchObject({ code: "store.not-active" });
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
});
