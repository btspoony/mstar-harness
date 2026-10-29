/**
 * The host's envelope handling for the Iterations pair.
 *
 * What is asserted here is the host's half: the three outcomes stay distinct, the
 * `attribution` arm decides which absence a zero-row read lands in (and the two are
 * different pages), a `null` payload with a generation is `absent` while one
 * without is `unavailable`, and the gate is a position rather than a count.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IterationDTO, IterationListDTO, ReadEnvelope } from "@mstar-harness/engine";
import { IterationDetail, Iterations, copyFor, iterationDetailModel, iterationListModel } from "@mstar-harness/ui";

import { ABSENT_PROJECTION } from "./absent-projection";
import {
  iterationDetailCopy,
  iterationDetailOutcome,
  iterationDetailPath,
  iterationsCopy,
  iterationsOutcome,
  iterationsPath,
  readIterationDetail,
  readIterations,
} from "./iterations-data";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

/**
 * A compass at the fourth reachable step; the fifth never is.
 *
 * `IterationGateStep` is an integer `1 | 2 | 3 | 4`, not a step list — the store's member,
 * read by plain property access. The old fixture passed a `{ step, steps }` object and cast
 * it with `as unknown as`, which is why nothing caught that `gateStepPosition` resolved
 * `null` for it: the cast silenced the shape and the assertion above it was skipped instead
 * of fixed.
 */
const gate = 4 as IterationDTO["gateStep"];

const iteration = (over: Partial<IterationDTO> = {}): IterationDTO =>
  ({
    iterationId: "iter-1",
    catalog: null,
    compass: null,
    workflow: null,
    // The engine DTO's own members (dashboard plan): the execution lifecycle and
    // the catalog projects the iteration belongs to.
    executionLifecycle: "active",
    projects: ["engine"],
    plans: [],
    documents: [],
    badges: [],
    gateStep: gate,
    ...over,
  }) as unknown as IterationDTO;

const listEnvelope = (
  items: IterationDTO[],
  total: number,
  attribution: IterationListDTO["attribution"] = "present",
  generation: number | null = 7,
): ReadEnvelope<IterationListDTO> => ({
  data: { items, total, attribution } as IterationListDTO,
  storeRevision: 1224,
  catalogRevision: 9,
  projection: { ...projection, generation },
});

const renderList = (
  items: IterationDTO[],
  total: number,
  attribution: IterationListDTO["attribution"] = "present",
  generation: number | null = 7,
): string => {
  const outcome = iterationsOutcome({ status: "ready", envelope: listEnvelope(items, total, attribution, generation) });
  if (outcome.kind !== "ready") throw new Error("expected a ready list");
  return renderToStaticMarkup(
    createElement(Iterations, { model: outcome.model, copy: iterationsCopy(copyFor("en")) }),
  );
};

describe("the list read", () => {
  test("the path scopes by project and pages, so the list's filters see every row", () => {
    expect(iterationsPath(null)).toBe("/api/iterations?limit=200&offset=0");
    expect(iterationsPath("engine")).toBe("/api/iterations?limit=200&offset=0&project=engine");
    expect(iterationsPath("engine", 200)).toBe("/api/iterations?limit=200&offset=200&project=engine");
    expect(iterationDetailPath("iter/1")).toBe("/api/iterations/iter%2F1");
  });

  test("outcome 1 — a healthy read lists the iterations", () => {
    const outcome = iterationsOutcome({ status: "ready", envelope: listEnvelope([iteration()], 1) });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.rows.kind).toBe("populated");
    expect(outcome.model.total).toBe(1);
  });

  test("outcome 2 — no generation is unavailable, never 'nothing here'", () => {
    const html = renderList([], 0, "present", null);
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).not.toContain('data-ms-absence="empty"');
    expect(html).not.toContain('data-ms-absence="absent"');
  });

  test("the two attribution empties are two different pages", () => {
    // `present` with no rows: this project has none.
    const none = renderList([], 0, "present");
    // `absent` with no rows: the store attributes no iteration to any project.
    const notAttributed = renderList([], 0, "absent");
    expect(none).toContain('data-ms-absence="empty"');
    expect(none).not.toContain('data-ms-absence="absent"');
    expect(notAttributed).toContain('data-ms-absence="absent"');
    expect(notAttributed).not.toContain('data-ms-absence="empty"');
    expect(none).not.toBe(notAttributed);
  });

  test("the read's scope statement travels with the rows", () => {
    expect(renderList([iteration()], 1, "present")).toContain("Iterations are attributed to projects.");
    expect(renderList([iteration()], 1, "absent")).toContain("No iteration is attributed to any project.");
  });

  test("outcome 3 — a whole-read failure mounts no list", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await readIterations(failing, null);
    expect(result.status).toBe("error");
    expect(iterationsOutcome(result).kind).toBe("failed");
  });

  test("the list carries no document inventory; the detail has one", () => {
    // The prototype's iteration detail has a Documents panel (`design-v1.html`) and its
    // plan table a `Documents` column on the list — but the list row carries the *count*,
    // not an inventory, and the ids and revision counters stay off it.
    const html = renderList([iteration()], 1);
    for (const removed of ["milestone id", "revision counter", "dossier"]) {
      expect(html.toLowerCase()).not.toContain(removed);
    }
  });

  test("a row without a compass says so instead of inventing a step", () => {
    const html = renderList([iteration({ gateStep: null })], 1);
    expect(html).toContain("No compass");
  });
});

describe("the detail read", () => {
  test("outcome 1 — a readable iteration renders its gate position", () => {
    const outcome = iterationDetailOutcome({
      status: "ready",
      envelope: { data: iteration(), storeRevision: 1, catalogRevision: 1, projection },
    });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.kind).toBe("populated");
    const html = renderToStaticMarkup(
      createElement(IterationDetail, { model: outcome.model, copy: iterationDetailCopy(copyFor("en")) }),
    );
    expect(html).toContain("iter-1");
    // This fixture's gate has three reached steps; the panel names the track it was given
    // rather than the prototype's five, which is what the `gateSteps` helper is for. A
    // fifth step must not appear when the record never recorded one.
    // The detail states its position as the prototype's chip (`step 4 of 5`); the five-step
    // *track* is the overview's, not this screen's.
    expect(html).toContain("step 4 of 5");
    expect(html).not.toContain("step 5 of 5");
  });

  test("a null payload WITH no generation is unavailable — not a 404", () => {
    const outcome = iterationDetailOutcome({
      status: "ready",
      envelope: { data: null, storeRevision: 1, catalogRevision: 1, projection: { ...projection, generation: null } },
    });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.kind).toBe("unavailable");
  });

  test("a null payload WITH a published generation is absent", () => {
    const outcome = iterationDetailOutcome({
      status: "ready",
      envelope: { data: null, storeRevision: 1, catalogRevision: 1, projection },
    });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.kind).toBe("absent");
  });

  test("a 404 is absent, expressed through the shared constant", async () => {
    const notFound = (async () =>
      new Response(JSON.stringify({ error: { code: "not-found", message: "no such record" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readIterationDetail(notFound, "gone");
    expect(result.status).toBe("absent");
    const outcome = iterationDetailOutcome(result);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.kind).toBe("absent");
    expect(iterationDetailModel({ data: null, projection: ABSENT_PROJECTION }).kind).toBe("absent");
  });

  test("every other refusal is a failure, not an absence", async () => {
    const refused = (async () =>
      new Response(JSON.stringify({ error: { code: "store.not-active", message: "the store is staged" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readIterationDetail(refused, "iter-1");
    expect(result).toEqual({ status: "error", message: "the store is staged" });
  });

  test("a body that is not an envelope is a failure", async () => {
    const nonsense = (async () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect((await readIterationDetail(nonsense, "iter-1")).status).toBe("error");
  });

  test("the three outcomes are distinct presentations", () => {
    const ok = iterationDetailOutcome({
      status: "ready",
      envelope: { data: iteration(), storeRevision: 1, catalogRevision: 1, projection },
    });
    const absent = iterationDetailOutcome({ status: "absent" });
    const failed = iterationDetailOutcome({ status: "error", message: "refused" });
    expect([ok.kind, absent.kind, failed.kind]).toEqual(["ready", "ready", "failed"]);
    if (ok.kind !== "ready" || absent.kind !== "ready") return;
    expect(ok.model.kind).toBe("populated");
    expect(absent.model.kind).toBe("absent");
  });
});
