import { expect, test } from "bun:test";
import { collectActiveLifecycleBranches } from "./lifecycle-branches.js";

test("ownership returns branch provenance, excludes anchors, and keeps anchor-less main-valued rows factual", () => {
  expect(collectActiveLifecycleBranches([
    {
      id: "wf-integration",
      branch: { base: "main", integration: "iteration/integration", target: "release" },
      plans: [{ id: "plan-feature", metadata: { working_branch: "feature/plan", track_branches: ["feature/track"] } }],
    },
    {
      id: "wf-anchorless",
      branch: {},
      plans: [{ id: "plan-main", metadata: { working_branch: "main" } }],
    },
  ])).toEqual([
    { branch: "iteration/integration", workflowId: "wf-integration", planId: null },
    { branch: "feature/track", workflowId: "wf-integration", planId: "plan-feature" },
    { branch: "feature/plan", workflowId: "wf-integration", planId: "plan-feature" },
    { branch: "main", workflowId: "wf-anchorless", planId: "plan-main" },
  ]);
});

test("missing workflow ids remain absent instead of fabricating owner provenance", () => {
  expect(collectActiveLifecycleBranches([{ plans: [{ plan_id: "legacy-plan", metadata: { working_branch: "feature/legacy" } }] }])).toEqual([
    { branch: "feature/legacy", workflowId: null, planId: "legacy-plan" },
  ]);
});
