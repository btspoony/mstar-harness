/**
 * Dashboard view layer — the generic request half of the dashboard read
 * transport (view → validated filters → one `withStoreRead` envelope).
 *
 * This suite pins the refusals the CLI transport asserted before the layer
 * moved here, so a second transport (the dsh panel) inherits exactly one
 * validation implementation. Every case runs the layer against the real store
 * boundary; nothing is mocked.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { MAX_DASHBOARD_SEARCH_LENGTH, dashboardFailure, dashboardFilters, readDashboardView } from "./dashboard-view.js";
import { captureIssue, getIssue } from "./issue.js";
import { initializeStore } from "./store-db.js";
import type { IssueDetail } from "./issue.js";
import type { StoreContext } from "./store-db.js";
import type { DashboardView, DashboardViewData, ReadEnvelope } from "./store-read.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-dashboard-view-"));
const RECORDED_AT = "2026-10-22T00:00:00.000Z";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

async function workspace(name: string): Promise<StoreContext> {
  const harness = join(mkdtempSync(join(ROOT, name)), ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: harness };
  const handle = await initializeStore(context);
  handle.close();
  return context;
}

describe("dashboardFilters refusals", () => {
  test("refuses an unknown view", () => {
    expect(() => dashboardFilters("not-a-view" as DashboardView)).toThrow(/unknown dashboard view "not-a-view"/);
  });

  test("refuses an unsupported query field per view", () => {
    expect(() => dashboardFilters("projects", { limit: "2" })).toThrow(/"limit" is not a supported projects query parameter/);
    expect(() => dashboardFilters("roadmap", { disposition: "open" })).toThrow(
      /"disposition" is not a supported roadmap query parameter/,
    );
  });

  test("refuses a limit outside 1-200 and a non-numeric limit", () => {
    expect(() => dashboardFilters("issues", { limit: "201" })).toThrow(/limit must be an integer between 1 and 200/);
    expect(() => dashboardFilters("issues", { limit: "0" })).toThrow(/limit must be an integer between 1 and 200/);
    expect(() => dashboardFilters("issues", { limit: "1.5" })).toThrow(/limit must be a nonnegative integer/);
    expect(() => dashboardFilters("issues", { offset: "-1" })).toThrow(/offset must be a nonnegative integer/);
  });

  test("accepts a search of exactly the maximum length and refuses one character more", () => {
    expect(MAX_DASHBOARD_SEARCH_LENGTH).toBe(200);
    expect(dashboardFilters("issues", { q: "x".repeat(MAX_DASHBOARD_SEARCH_LENGTH) })).toEqual({
      issue: { query: "x".repeat(MAX_DASHBOARD_SEARCH_LENGTH) },
    });
    expect(() => dashboardFilters("issues", { q: "x".repeat(MAX_DASHBOARD_SEARCH_LENGTH + 1) })).toThrow(
      /q must be at most 200 characters/,
    );
  });

  test("refuses an id that could not be a catalog id", () => {
    for (const unsafe of ["", ".", "..", "/", "\\", "a/b", "a\\b", "a\u0000b"]) {
      expect(() => dashboardFilters("issue-detail", {}, unsafe)).toThrow(/id must be a single safe id/);
    }
    // An empty query value is "not supplied" (queryValue), not an unsafe id.
    for (const unsafe of [".", "..", "/", "\\", "a/b", "a\\b", "a\u0000b"]) {
      expect(() => dashboardFilters("issues", { project: unsafe })).toThrow(/project must be a single safe id/);
    }
  });

  test("refuses the roadmap view without a project", () => {
    expect(() => dashboardFilters("roadmap")).toThrow(/the roadmap view requires a project query parameter/);
  });

  test("refuses a detail view without an id", () => {
    for (const view of ["issue-detail", "workflow-detail", "iteration-detail"] as const) {
      expect(() => dashboardFilters(view)).toThrow(new RegExp(`the ${view} route requires an id`));
    }
  });

  test("maps raw query parameters onto the engine's filter shape", () => {
    expect(dashboardFilters("issues")).toEqual({ issue: {} });
    expect(
      dashboardFilters("issues", { project: "proj-a", disposition: "open", kind: "bug", severity: "high", q: "race", limit: "10", offset: "5" }),
    ).toEqual({ issue: { projectId: "proj-a", disposition: "open", kind: "bug", severity: "high", query: "race", limit: 10, offset: 5 } });
    expect(dashboardFilters("roadmap", { project: "proj-a" })).toEqual({ projectId: "proj-a" });
    expect(dashboardFilters("iteration-detail", {}, "iter-read")).toEqual({ id: "iter-read" });
  });
});

describe("readDashboardView over a real store", () => {
  test("answers a detail view with the store read boundary's envelope", async () => {
    const context = await workspace("detail-");
    await captureIssue(
      context,
      {
        projectId: "proj-a",
        title: "detail row",
        severity: "low",
        kind: "bug",
        impact: "A second transport reads this row through the shared layer",
        acceptance: "The shared layer answers the detail envelope",
        sourceIdentity: "detail row",
        rootCauseKey: "detail row",
        acceptanceKey: "detail row",
        occurrenceKey: "detail row",
        sourceKind: "test",
        location: "dashboard-view.test.ts",
        observedBehavior: "detail row",
        evidence: ["isolated fixture"],
        discoveredAt: RECORDED_AT,
      },
      { actor: "project-manager", operationId: "capture-detail-row" },
    );

    // The declared contract: one envelope carrying the store's own DTO.
    const envelope: ReadEnvelope<DashboardViewData[DashboardView]> = await readDashboardView({
      context,
      view: "issue-detail",
      id: "I-000001",
    });
    const detail: IssueDetail = envelope.data as IssueDetail;
    expect(detail).toEqual(await getIssue(context, "I-000001"));
    expect(typeof envelope.storeRevision).toBe("number");
    expect(envelope.catalogRevision).toBe(0);
  });

  test("surfaces a store refusal through dashboardFailure", async () => {
    const harness = join(mkdtempSync(join(ROOT, "uninitialized-")), ".mstar");
    const failure = await readDashboardView({ context: { harnessDir: harness }, view: "issues" }).catch((error: unknown) => error);
    expect(dashboardFailure(failure)).toMatchObject({ code: "store.not-initialized" });
  });
});
