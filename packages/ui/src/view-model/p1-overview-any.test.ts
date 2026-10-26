import { describe, expect, test } from "bun:test";

import { issueQuery, parseIssueQuery } from "./issues";
import { overviewModel } from "./overview";
import type { OverviewDTO } from "@mstar-harness/engine";

const projection = { generation: 3, freshness: "current" as const, builtAt: null, checkedAt: "", diagnostics: [] };

describe("P1: choosing Any clears the filter instead of meaning open", () => {
  test('an empty disposition round-trips as ""', () => {
    // The new "Any" option writes `disposition=`; the parser only accepted known
    // literals and both rewrote it to `open`, so Any filtered to open issues.
    expect(parseIssueQuery("disposition=").filters.disposition).toBe("");
    expect(parseIssueQuery("disposition=&severity=high").filters.disposition).toBe("");
    expect(parseIssueQuery("disposition=&severity=high").filters.severity).toBe("high");
  });

  test("any round-trips back out", () => {
    const query = { filters: { project: "", disposition: "", kind: "", severity: "", q: "" }, offset: 0 };
    expect(parseIssueQuery(issueQuery(query)).filters.disposition).toBe("");
  });

  test("an unknown literal still falls back to the default", () => {
    expect(parseIssueQuery("disposition=Purple").filters.disposition).toBe("open");
  });
});

describe("P1: a capped overview member discloses its truncation", () => {
  test("the workflows member carries the store's total, not just the page", () => {
    // The engine caps this member at 50; mapping to rows dropped `total`, so a
    // truncated list looked complete.
    const data = {
      workflows: {
        state: "read",
        data: {
          items: [{ id: "wf-1", type: "plan", status: "running", phase: null, startedAt: null, endedAt: null, updatedAt: null, branch: { base: "main", source: "w", integration: "w", target: "main" }, catalog: null, plans: [], badges: [] }],
          total: 120,
        },
      },
      residuals: { state: "read", data: { open: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 } } },
      milestones: { state: "read", data: { projectId: "p", milestones: [], issues: [], unassignedIssues: 0 } },
      latestIteration: { state: "read", data: null },
      issueFlow: { state: "read", data: { buckets: [], unknownCaptureDates: 0, unknownClosureDates: 0, currentOpen: 0, incompleteHistory: false } },
    } as unknown as OverviewDTO;
    const model = overviewModel(data, { projection });
    if (model.workflows.kind !== "populated") throw new Error("expected populated, got " + JSON.stringify(model.workflows).slice(0, 200));
    expect(model.workflows.total).toBe(120);
    expect(model.workflows.shown).toBe(1);
    expect(model.workflows.truncated).toBe(true);
  });
});
