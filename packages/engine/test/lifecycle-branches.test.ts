import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectActiveLifecycleBranches, scanActiveLifecycleBranches } from "../src/lifecycle-branches.js";

test("ownership includes retained tracks and excludes base/target anchors", () => {
  expect(collectActiveLifecycleBranches([
    { branch: { integration: "iteration/a", base: "main", target: "release" }, plans: [
      { execution_lease: { working_branch: "feature/a" }, metadata: { working_branch: "feature/retained", track_branches: ["feature/track", "feature/a", "", null] } },
    ] },
  ])).toEqual(["iteration/a", "feature/a", "feature/track", "feature/retained"]);
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
