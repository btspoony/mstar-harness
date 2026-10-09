import { expect, test } from "bun:test";
import { collectActiveLifecycleBranches } from "../src/lifecycle-branches.js";

test("ownership includes retained tracks and excludes base/target anchors", () => {
  expect(collectActiveLifecycleBranches([
    {
      id: "wf-a",
      branch: { integration: "iteration/a", base: "main", target: "release" },
      plans: [{ id: "plan-a", metadata: { working_branch: "feature/retained", track_branches: ["feature/track", "feature/a", "", null] } }],
    },
  ])).toEqual([
    { branch: "iteration/a", workflowId: "wf-a", planId: null },
    { branch: "feature/track", workflowId: "wf-a", planId: "plan-a" },
    { branch: "feature/a", workflowId: "wf-a", planId: "plan-a" },
    { branch: "feature/retained", workflowId: "wf-a", planId: "plan-a" },
  ]);
});
