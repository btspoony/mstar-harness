/**
 * The host's envelope handling for the Overview page — the three outcomes, and
 * the two facts this page must not render even though the envelope carries them.
 *
 * The screen itself is the shared layer's and was reviewed there; what is asserted
 * here is what the *host* owes: a degraded member is not "nothing here", a failed
 * read does not mount a page of lies, the trend the envelope carries reaches the
 * page, and no version identity comes back through the host's mapping.
 *
 * "Nothing here" claims are scoped to the page OUTSIDE the trend card. That card owns
 * an `empty` arm of its own — a store with fewer than two dated buckets answers "no
 * series to draw", which is a member's absence, not the page's — so an unscoped
 * `not.toContain('data-ms-absence="empty"')` would forbid the member its designed arm.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IterationDTO, OverviewDTO, ReadEnvelope, WorkflowListDTO } from "@mstar-harness/engine";
import { Overview, copyFor } from "@mstar-harness/ui";

import { asEnvelope, refusalMessage } from "./read-envelope";
import {
  overviewCopy,
  overviewFromEnvelope,
  overviewOutcome,
  readOverview,
} from "./overview-data";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

const workflow = {
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
};

const iteration = {
  iterationId: "iter-1",
  catalog: null,
  compass: null,
  workflow: null,
  plans: [],
  documents: [],
  badges: [],
  gateStep: null,
} as unknown as IterationDTO;

/** A complete, healthy aggregated read. */
const healthy = (over: Partial<OverviewDTO> = {}): OverviewDTO => ({
  workflows: { state: "read", data: { items: [workflow], total: 1 } as WorkflowListDTO },
  residuals: { state: "read", data: { open: 26, bySeverity: { critical: 2, high: 5, medium: 9, low: 7, nit: 3 } } },
  milestones: {
    state: "read",
    data: {
      projectId: "engine",
      milestones: [
        {
          milestoneId: "m-1",
          projectId: "engine",
          name: "Release the shared layer",
          target: "2026-11-07",
          status: "active",
          ordinal: 0,
          revision: 1,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-02T00:00:00.000Z",
          totalIssues: 10,
          openIssues: 4,
          resolvedIssues: 6,
          otherRetiredIssues: 0,
        },
      ],
      issues: [],
      unassignedIssues: 0,
    },
  },
  latestIteration: { state: "read", data: iteration },
  // §8.1 removed the trend from the UI. The member is still on the DTO, and the
  // fixture carries a distinguishable payload so the negative assertion has teeth.
  issueFlow: {
    state: "read",
    data: {
      buckets: [{ date: "2026-10-20", captured: 3, retired: 1 }],
      unknownCaptureDates: 1,
      unknownClosureDates: 0,
      incompleteHistory: false,
      currentOpen: 26,
    },
  },
  ...over,
});

const envelope = (data: OverviewDTO = healthy(), projectionBlock = projection): ReadEnvelope<OverviewDTO> => ({
  data,
  storeRevision: 1224,
  catalogRevision: 9,
  projection: projectionBlock,
});

/**
 * The rendered page with the trend card cut out, leaving every other member.
 *
 * Panels are the page's own units and each opens with `data-ms-panel`, so splitting on
 * that attribute and dropping the chunk that names the trend needs no HTML parser and
 * no assumption about nesting depth inside the card.
 */
const pageOutsideTrend = (html: string): string =>
  html
    .split(/(?=<section[^>]*data-ms-panel)/)
    .filter((chunk) => !chunk.includes("ms-overview-trend"))
    .join("");

/** How many members answered "nothing to show" — counted, so a scoped claim can say why. */
const emptyArms = (html: string): number => (html.match(/data-ms-absence="empty"/g) ?? []).length;

// `createElement`, not JSX: this suite keeps the `.ts` name the plan gives it.
const render = (model: ReturnType<typeof overviewFromEnvelope>): string =>
  renderToStaticMarkup(createElement(Overview, { model, copy: overviewCopy(copyFor("en")) }));

describe("outcome 1 — a healthy read renders the page", () => {
  const outcome = overviewOutcome({ status: "ready", envelope: envelope() });

  test("it is ready, and the shared model carries the five members' values", () => {
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.workflows.kind).toBe("populated");
    expect(outcome.model.residuals.kind).toBe("populated");
    expect(outcome.model.milestones.kind).toBe("populated");
    expect(outcome.model.latestIteration.kind).toBe("populated");
  });

  test("the rendered page carries the facts, not the envelope's counters", () => {
    const html = render(overviewFromEnvelope(envelope()));
    expect(html).toContain("issue-project-move");
    expect(html).toContain('data-ms-severity="critical"');
    expect(html).toContain('data-ms-projection="current"');
    // The envelope's revisions are diagnostics, not development facts (D30).
    expect(html).not.toContain("1224");
    expect(html).not.toContain("storeRevision");
    expect(html).not.toContain("catalogRevision");
  });

  test("the residual total reconciles with its five rows, from one read", () => {
    const html = render(overviewFromEnvelope(envelope()));
    const model = overviewFromEnvelope(envelope());
    if (model.residuals.kind !== "populated") throw new Error("expected the residual panel");
    const sum = model.residuals.value.rows.reduce((total, row) => total + row.count, 0);
    // The page states a total and five rows; a page whose total disagreed with its
    // own rows would be reporting two answers from one read.
    expect(model.residuals.value.total).toBe(sum);
    expect(html).toContain("26 open");
  });
});

describe("outcome 2 — one degraded member still renders the page", () => {
  const degraded = overviewOutcome({
    status: "ready",
    envelope: envelope(
      healthy({ residuals: { state: "unavailable", reason: "no such table: issue_residuals" } }),
    ),
  });

  test("it is ready, not failed: one member's failure is not the page's", () => {
    expect(degraded.kind).toBe("ready");
    if (degraded.kind !== "ready") return;
    expect(degraded.model.residuals).toEqual({ kind: "unavailable", reason: "no such table: issue_residuals" });
    expect(degraded.model.workflows.kind).toBe("populated");
  });

  test("the page renders the degraded member's own arm with the store's reason", () => {
    const html = render(
      overviewFromEnvelope(
        envelope(healthy({ residuals: { state: "unavailable", reason: "no such table: issue_residuals" } })),
      ),
    );
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).toContain("no such table: issue_residuals");
  });

  test("it is NOT rendered as 'nothing here' — that is a different fact", () => {
    const html = render(
      overviewFromEnvelope(
        envelope(healthy({ residuals: { state: "unavailable", reason: "no such table: issue_residuals" } })),
      ),
    );
    // The `empty` arm's label word and body would claim the read succeeded. The trend
    // card's own arm is the only one allowed, and it is not a page-level claim: outside
    // that card, no member says "nothing here".
    expect(pageOutsideTrend(html)).not.toContain('data-ms-absence="empty"');
    expect(emptyArms(html)).toBe(1);
    // The `empty` arm's body sentence is the claim being refused here, and the trend
    // card's own arm states it truthfully (its read succeeded; it has no dated buckets),
    // so the sentence is checked where a page-level claim would be made: outside the card.
    expect(pageOutsideTrend(html)).not.toContain("there is nothing to show");
    // And the neighbours are untouched by it.
    expect(html).toContain("issue-project-move");
  });
});

describe("outcome 3 — a whole-read failure mounts no page", () => {
  test("the outcome is failed and carries the message", () => {
    const outcome = overviewOutcome({ status: "error", message: "the store is not active" });
    expect(outcome).toEqual({ kind: "failed", message: "the store is not active" });
  });

  test("a transport failure is reported, not rendered as an empty page", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await readOverview(failing);
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("could not reach its local server");
  });

  test("a refused read carries the server's own message", async () => {
    const refused = (async () =>
      new Response(JSON.stringify({ error: { code: "store.not-active", message: "the store is staged" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readOverview(refused);
    expect(result).toEqual({ status: "error", message: "the store is staged" });
  });

  test("a body that is not an envelope is a failure, not an empty read", async () => {
    const nonsense = (async () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readOverview(nonsense);
    expect(result.status).toBe("error");
    expect(asEnvelope({ hello: "world" })).toBeNull();
  });

  test("the three outcomes are three distinct presentations", () => {
    const ok = overviewOutcome({ status: "ready", envelope: envelope() });
    const partial = overviewOutcome({
      status: "ready",
      envelope: envelope(healthy({ workflows: { state: "read", data: { items: [], total: 0 } as WorkflowListDTO } })),
    });
    const failed = overviewOutcome({ status: "error", message: "refused" });
    expect([ok.kind, partial.kind, failed.kind]).toEqual(["ready", "ready", "failed"]);
    // ...and the two `ready` ones render differently: a member's arm, not a page error.
    const okHtml = render(overviewFromEnvelope(envelope()));
    const partialHtml = render(
      overviewFromEnvelope(envelope(healthy({ workflows: { state: "read", data: { items: [], total: 0 } as WorkflowListDTO } }))),
    );
    // Scoped: a healthy page shows no member's "nothing here" outside the trend card,
    // and the partial one does — the empty workflow list, which is the difference being
    // asserted. Counting is what keeps the trend's own arm from blurring the two.
    expect(pageOutsideTrend(okHtml)).not.toContain('data-ms-absence="empty"');
    expect(pageOutsideTrend(partialHtml)).toContain('data-ms-absence="empty"');
    expect(emptyArms(partialHtml)).toBe(emptyArms(okHtml) + 1);
    expect(failed.kind).not.toBe(ok.kind);
  });
});

describe("the trend the envelope carries is rendered, not remapped", () => {
  /** Two dated buckets: the minimum a line needs, and the host's payload verbatim. */
  const dated: OverviewDTO["issueFlow"] = {
    state: "read",
    data: {
      buckets: [
        { date: "2026-10-20", capturedCumulative: 812, retiredCumulative: 305, openDifference: 507, origin: "store" },
        { date: "2026-10-25", capturedCumulative: 838, retiredCumulative: 312, openDifference: 526, origin: "store" },
      ],
      unknownCaptureDates: 1,
      unknownClosureDates: 0,
      currentOpen: 526,
      incompleteHistory: false,
    },
  };

  test("the envelope's buckets reach the page's own chart", () => {
    const html = render(overviewFromEnvelope(envelope(healthy({ issueFlow: dated }))));
    // The host maps the member through; it neither recomputes nor drops the series.
    expect(html).toContain('data-ms-flow=""');
    expect(html).toContain("2026-10-20");
    expect(html).toContain("2026-10-25");
    expect(html).toMatch(/<svg[^>]*role="img"/);
    // One step path per series, and the counts as text beside the figure.
    expect((html.match(/<path[^>]*d="M[^"]*"/g) ?? []).length).toBe(2);
    expect(html).toContain("526 dated open · 526 recorded open");
  });

  test("a fixture with one bucket is the card's empty arm, not a one-point line", () => {
    // The healthy fixture carries a single bucket, which is what the screen's rule calls
    // empty; no line may be drawn from it.
    const html = render(overviewFromEnvelope(envelope()));
    expect(html).toContain('data-ms-flow=""');
    expect(emptyArms(html)).toBe(1);
    expect(html).not.toMatch(/<svg/i);
  });
});

describe("what the host must not reintroduce", () => {

  test("the identity line is projection state only — no version, no harness path", () => {
    const html = render(overviewFromEnvelope(envelope()));
    expect(html).not.toContain("4.0.9");
    expect(html).not.toContain("{HARNESS_DIR}");
    expect(html).not.toContain(".mstar");
    expect(html).toContain('data-ms-projection="current"');
  });

  test("a stale projection says so with the sources' reasons", () => {
    const html = render(
      overviewFromEnvelope(
        envelope(healthy(), {
          ...projection,
          freshness: "stale",
          diagnostics: [{ sourceKey: "compass", reason: "unreadable", message: "compass could not be parsed" }],
        }),
      ),
    );
    expect(html).toContain('data-ms-projection="stale"');
    expect(html).toContain("compass: compass could not be parsed");
  });
});

describe("the read itself", () => {
  test("a healthy response becomes an envelope", async () => {
    const ok = (async () =>
      new Response(JSON.stringify(envelope()), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readOverview(ok);
    expect(result.status).toBe("ready");
  });

  test("a refusal without a message still names what failed", () => {
    expect(refusalMessage(null, 500)).toContain("HTTP 500");
  });
});
