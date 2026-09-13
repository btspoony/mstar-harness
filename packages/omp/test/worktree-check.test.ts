import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import worktreeTool from "../src/tools/mstar_worktree_check/index.ts";

test("linked cwd uses main process snapshot despite feature-local harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-main-discovery-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "base");
    const feature = join(root, "feature");
    git("worktree", "add", "-qb", "feature/a", feature);
    const snapshotDir = join(root, ".mstar", "workflows", "wf-a");
    mkdirSync(snapshotDir, { recursive: true });
    mkdirSync(join(feature, ".mstar"), { recursive: true });
    writeFileSync(join(root, ".mstar", "status.json"), JSON.stringify({ version: 2, workflows: [] }));
    const snapshot = {
      schema_version: 1, id: "wf-a", type: "plan", status: "running", started_at: "2026-01-01", updated_at: "2026-01-01",
      branch: { base: "main" }, plans: [{ id: "plan-a", title: "Plan", file: "plans/plan-a.md", status: "InProgress", execution_lease: {
        holder: "dev", host: "codex", worktree_path: feature, working_branch: "feature/a", claimed_at: "2026-01-01", updated_at: "2026-01-01",
      }}],
    };
    writeFileSync(join(snapshotDir, "snapshot.json"), JSON.stringify(snapshot));
    // Only parameter schema construction is stubbed; execute uses real engine/Git/filesystem.
    const schema: any = { optional: () => schema, describe: () => schema };
    const zod: any = { object: () => schema, enum: () => schema, string: () => schema, array: () => schema };
    const tool = worktreeTool({ cwd: feature, zod } as any);
    const result = await tool.execute("test", { kind: "l1", workflowId: "wf-a" } as any, undefined as any, undefined as any, undefined as any);
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("l1 pre-dispatch check OK");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
