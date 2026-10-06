import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectActiveLifecycleBranches, scanActiveLifecycleBranches } from "../src/lifecycle-branches.js";

test("ownership includes retained tracks and excludes base/target anchors", () => {
  expect(collectActiveLifecycleBranches([
    { branch: { integration: "iteration/a", base: "main", target: "release" }, plans: [
      { metadata: { working_branch: "feature/retained", track_branches: ["feature/track", "feature/a", "", null] } },
    ] },
  ])).toEqual(["iteration/a", "feature/track", "feature/a", "feature/retained"]);
});

test("unreadable active register shapes fail closed, including null", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-register-"));
  try {
    for (const value of [null, [], { version: 2, workflows: [null] }, { version: 2, workflows: [{ id: "../escape" }] }]) {
      writeFileSync(join(root, "status.json"), JSON.stringify(value));
      expect(scanActiveLifecycleBranches(root, "wf-a")).toMatchObject({ kind: "refusal", code: "worktree.l1.lifecycle-register-unreadable" });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a running sibling row's branch intent is reported by the scan", () => {
  // E07 admits Prepare amendment while a SIBLING row runs: that row's active
  // branch intent is recorded in its own metadata. The lifecycle scan feeds
  // the L1 worktree gate from that row scope, without rewriting observations.
  const root = mkdtempSync(join(tmpdir(), "lifecycle-ownership-"));
  try {
    const harness = join(root, ".mstar");
    const workflowDir = join(harness, "workflows", "wf-running");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(harness, "status.json"),
      JSON.stringify({
        version: 2,
        updated_at: "2026-09-16",
        workflows: [{ id: "wf-running", status: "running", type: "iteration", started_at: "2026-09-16", dir: "workflows/wf-running" }],
      }),
    );
    const snapshotPath = join(workflowDir, "snapshot.json");
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          id: "wf-running",
          type: "iteration",
          status: "running",
          started_at: "2026-09-16",
          updated_at: "2026-09-16",
          branch: { base: "main", integration: "iteration/wf-running", target: "main" },
          plans: [
            {
              id: "plan-running",
              title: "Plan plan-running",
              file: join(harness, "plans", "plan-running.md"),
              status: "InProgress",
              progress: 40,
              metadata: { worktree_path: join(root, "wt-running"), working_branch: "feature/plan-running" },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const scan = scanActiveLifecycleBranches(harness, "wf-governing");
    expect(scan.kind).toBe("ok");
    if (scan.kind !== "ok") throw new Error("the active register must be readable");
    expect([...scan.branches].sort()).toEqual(["feature/plan-running", "iteration/wf-running"]);

  } finally { rmSync(root, { recursive: true, force: true }); }
});
