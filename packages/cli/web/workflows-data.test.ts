/**
 * The host's envelope handling for the Workflows pair.
 *
 * The distinction this suite exists to protect: a workflow whose execution
 * projection is unreadable arrives as `200` with a `null` payload — an
 * `unavailable`, not a missing record — while a `404` is a genuinely absent
 * workflow. Collapsing them turns a degradation into a "not found".
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReadEnvelope, WorkflowDTO, WorkflowListDTO } from "@mstar-harness/engine";
import { WorkflowDetail, Workflows, copyFor, workflowDetailModel } from "@mstar-harness/ui";

import { ABSENT_PROJECTION } from "./absent-projection";
import {
  WORKFLOWS_PATH,
  readWorkflowDetail,
  readWorkflows,
  workflowDetailCopy,
  workflowDetailOutcome,
  workflowDetailPath,
  workflowsCopy,
  workflowsOutcome,
} from "./workflows-data";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

const row = (over: Partial<WorkflowDTO> = {}): WorkflowDTO =>
  ({
    id: "issue-project-move",
    type: "plan",
    status: "running",
    phase: "phase-2-execute",
    startedAt: "2026-10-25T01:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-25T05:00:00.000Z",
    branch: { base: "main", source: "w", integration: "w", target: "main" },
    activeRegistration: true,
    catalog: null,
    plans: [],
    badges: [],
    ...over,
  }) as unknown as WorkflowDTO;

const listEnvelope = (items: WorkflowDTO[], total: number, generation: number | null = 7): ReadEnvelope<WorkflowListDTO> => ({
  data: { items, total } as WorkflowListDTO,
  storeRevision: 1224,
  catalogRevision: 9,
  projection: { ...projection, generation },
});

const renderList = (items: WorkflowDTO[], total: number, generation: number | null = 7): string => {
  const outcome = workflowsOutcome({ status: "ready", envelope: listEnvelope(items, total, generation) });
  if (outcome.kind !== "ready") throw new Error("expected a ready list");
  return renderToStaticMarkup(
    createElement(Workflows, { model: outcome.model, copy: workflowsCopy(copyFor("en")) }),
  );
};

describe("the list read", () => {
  test("the path is the fixed route", () => {
    expect(WORKFLOWS_PATH).toBe("/api/workflows");
    expect(workflowDetailPath("a/b")).toBe("/api/workflows/a%2Fb");
  });

  test("outcome 1 — a healthy read lists the rows", () => {
    const outcome = workflowsOutcome({ status: "ready", envelope: listEnvelope([row()], 3) });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.rows.kind).toBe("populated");
    expect(outcome.model.total).toBe(3);
    expect(outcome.model.shown).toBe(1);
  });

  test("outcome 2 — no projection generation is unavailable, never 'nothing here'", () => {
    const html = renderList([], 0, null);
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).not.toContain('data-ms-absence="empty"');
  });

  test("truncation is disclosed from the store's total, not the item count", () => {
    const html = renderList([row()], 120);
    expect(html).toContain("Showing 1 of 120");
    // A page whose total matched its rows would disclose nothing.
    const complete = renderList([row()], 1);
    expect(complete).not.toContain("Showing 1 of 1");
  });

  test("outcome 3 — a whole-read failure mounts no list", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await readWorkflows(failing);
    expect(result.status).toBe("error");
    expect(workflowsOutcome(result).kind).toBe("failed");
  });

  test("the list carries no lease or adoption audit; the pin column is the prototype's", () => {
    // §8.1 removed leases, adoption audits and pin badges from the list. The prototype keeps
    // a `Pin` column on the workflow detail's plan table (`design-v1.html`), not here — so on
    // THIS screen the only surviving exclusion is the lease and the audit, and the pin column
    // must still be absent because the list has no such column.
    const html = renderList([row()], 1);
    for (const removed of ["lease", "adoption", "pin badge"]) {
      expect(html.toLowerCase()).not.toContain(removed);
    }
  });
});

describe("the detail read", () => {
  test("outcome 1 — a readable workflow renders its execution facts", () => {
    const outcome = workflowDetailOutcome({
      status: "ready",
      envelope: { data: row(), storeRevision: 1, catalogRevision: 1, projection },
    });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.kind).toBe("populated");
    const html = renderToStaticMarkup(
      createElement(WorkflowDetail, { model: outcome.model, copy: workflowDetailCopy(copyFor("en")) }),
    );
    expect(html).toContain("issue-project-move");
    expect(html).toContain("phase-2-execute");
    // The detail HAS a Leases panel — the prototype's own (`design-v1.html`), which §8.1
    // had excluded and the acceptance bar puts back. What stays out is an adoption audit.
    expect(html).toContain("ms-workflow-leases");
    expect(html.toLowerCase()).not.toContain("adoption");
  });

  test("a null payload WITH no generation is unavailable — not a 404", () => {
    const outcome = workflowDetailOutcome({
      status: "ready",
      envelope: { data: null, storeRevision: 1, catalogRevision: 1, projection: { ...projection, generation: null } },
    });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.kind).toBe("unavailable");
  });

  test("a null payload WITH a published generation is absent", () => {
    const outcome = workflowDetailOutcome({
      status: "ready",
      envelope: { data: null, storeRevision: 1, catalogRevision: 1, projection },
    });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.kind).toBe("absent");
  });

  test("a 404 is absent, and it reuses the shared constant", async () => {
    const notFound = (async () =>
      new Response(JSON.stringify({ error: { code: "not-found", message: "no such record" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readWorkflowDetail(notFound, "gone");
    expect(result.status).toBe("absent");
    const outcome = workflowDetailOutcome(result);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.kind).toBe("absent");
    // The one shape every detail pair uses for "there is no record here".
    expect(workflowDetailModel({ data: null, projection: ABSENT_PROJECTION }).kind).toBe("absent");
  });

  test("every other refusal is a failure, not an absence", async () => {
    const refused = (async () =>
      new Response(JSON.stringify({ error: { code: "store.not-active", message: "the store is staged" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readWorkflowDetail(refused, "w");
    expect(result).toEqual({ status: "error", message: "the store is staged" });
  });

  test("a body that is not an envelope is a failure", async () => {
    const nonsense = (async () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect((await readWorkflowDetail(nonsense, "w")).status).toBe("error");
  });

  test("the three outcomes are distinct presentations", () => {
    const ok = workflowDetailOutcome({
      status: "ready",
      envelope: { data: row(), storeRevision: 1, catalogRevision: 1, projection },
    });
    const absent = workflowDetailOutcome({ status: "absent" });
    const failed = workflowDetailOutcome({ status: "error", message: "refused" });
    expect([ok.kind, absent.kind, failed.kind]).toEqual(["ready", "ready", "failed"]);
    // Both `ready`s are ready, but only one carries a record.
    if (ok.kind !== "ready" || absent.kind !== "ready") return;
    expect(ok.model.kind).toBe("populated");
    expect(absent.model.kind).toBe("absent");
  });
});
