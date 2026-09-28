/**
 * Iteration Prepare recovery (R3 / I-000243 / #293) — engine-level targeted
 * tests for the ordinary-intent derivation contract:
 *
 * - the registration producer declares `phase-1-prepare` and stores a
 *   harness-relative `compass_ref` (normalizing an absolute-in-root spelling,
 *   refusing anything that escapes the root, including through a symlink);
 * - `show-prepare` derives the ABSENT phase and the canonical pointer from
 *   pristine Prepare facts and reports them without writing;
 * - the next ordinary `amend-prepare` adopts both in its own locked write
 *   together with the requested patch;
 * - a PRESENT non-Prepare phase is a lifecycle fact: refused, never rewritten;
 * - execution facts (a row off `Todo`) still refuse with `execution-started`.
 *
 * Fixtures are in-process: a temp Git root with the harness layout, the
 * workflow registered through the real producer, and a hand-recorded
 * coordinator binding exactly like the managed host bootstrap writes one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  amendPrepareWorkflow,
  createFsStore,
  registerIterationWorkflow,
  setArtifactStore,
  showPrepareWorkflow,
} from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  harnessDir: string;
  workflowId: string;
  planId: string;
  envelopePath: string;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

function makeFixture(workflowId: string): Fixture {
  const unpinned = mkdtempSync(path.join(os.tmpdir(), "prepare-recovery-"));
  roots.push(unpinned);
  const root = realpath(unpinned);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "fixture");
  writeFileSync(path.join(root, ".gitkeep"), "");
  git(root, "add", ".gitkeep");
  git(root, "commit", "-m", "fixture root");
  const harnessDir = path.join(root, ".mstar");
  const planId = "plan-a";
  mkdirSync(path.join(harnessDir, "plans"), { recursive: true });
  mkdirSync(path.join(harnessDir, "iterations", workflowId), { recursive: true });
  mkdirSync(path.join(harnessDir, "workflows", workflowId, "sessions"), { recursive: true });
  writeFileSync(
    path.join(harnessDir, "status.json"),
    `${JSON.stringify({ version: 2, updated_at: "2026-09-28", workflows: [] }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(harnessDir, "plans", `${planId}.md`),
    `# Fixture plan\n\n**plan_id:** ${planId}\n**Working branch:** feature/${planId}\n`,
  );
  writeFileSync(
    path.join(harnessDir, "iterations", workflowId, "delivery-compass.md"),
    `---\niteration_id: ${workflowId}\nstatus: active\nplans:\n  - ${planId}\nspec_integration_branch: iteration/${workflowId}\n---\n\n# compass\n`,
  );
  return { root, harnessDir, workflowId, planId, envelopePath: path.join(harnessDir, "workflows", workflowId, "sessions", "coordinator-fixture-coordinator.json") };
}

function realpath(target: string): string {
  // Canonical form of every fixture path: macOS /var is a symlink to
  // /private/var and the residency/containment checks compare canonical forms.
  return path.resolve(realpathSync(target));
}

function absoluteCompassRef(fixture: Fixture): string {
  return path.join(fixture.harnessDir, "iterations", fixture.workflowId, "delivery-compass.md");
}

async function register(
  fixture: Fixture,
  compassRef: string,
): Promise<void> {
  setArtifactStore(createFsStore(fixture.harnessDir));
  await registerIterationWorkflow(fixture.workflowId, {
    harnessDir: fixture.harnessDir,
    compassRef,
    branch: { base: "main", integration: `iteration/${fixture.workflowId}`, target: "main" },
    rows: [{ id: fixture.planId, title: "Fixture plan", file: path.join(fixture.harnessDir, "plans", `${fixture.planId}.md`) }],
  });
}

function snapshotPath(fixture: Fixture): string {
  return path.join(fixture.harnessDir, "workflows", fixture.workflowId, "snapshot.json");
}

function readSnapshot(fixture: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(snapshotPath(fixture), "utf8")) as Record<string, unknown>;
}

function writeSnapshot(fixture: Fixture, snapshot: Record<string, unknown>): void {
  writeFileSync(snapshotPath(fixture), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Hand-record the coordinator binding exactly like the managed host bootstrap. */
function bindCoordinator(fixture: Fixture): string {
  const envelope = {
    schema_version: 1,
    role: "coordinator",
    session_id: "fixture-coordinator",
    workflow_id: fixture.workflowId,
    // The canonical CONTROL harness root (the directory with status.json),
    // matching what the managed host bootstrap records for a .mstar layout.
    harness_root: fixture.harnessDir,
  };
  writeFileSync(fixture.envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);
  const snapshot = readSnapshot(fixture) as Record<string, any>;
  snapshot.coordination = {
    coordinator: {
      session_id: "fixture-coordinator",
      session_file: fixture.envelopePath,
      bound_at: new Date().toISOString(),
    },
  };
  writeSnapshot(fixture, snapshot);
  return fixture.envelopePath;
}

describe("iteration Prepare recovery \u2014 ordinary-intent derivation (R3 / I-000243)", () => {
  test("registration declares the Prepare phase and stores the harness-relative compass_ref from an absolute-in-root spelling", async () => {
    const fixture = makeFixture("iter-abs-compass");
    await register(fixture, absoluteCompassRef(fixture));
    const snapshot = readSnapshot(fixture);
    expect(snapshot.phase).toBe("phase-1-prepare");
    expect(snapshot.compass_ref).toBe(`iterations/${fixture.workflowId}/delivery-compass.md`);
    const rows = snapshot.plans as Array<Record<string, any>>;
    expect(rows[0]?.metadata?.iteration_refs).toEqual([`iterations/${fixture.workflowId}/delivery-compass.md`]);
  });

  test("registration keeps an already-relative compass_ref verbatim", async () => {
    const fixture = makeFixture("iter-rel-compass");
    await register(fixture, `iterations/${fixture.workflowId}/delivery-compass.md`);
    const snapshot = readSnapshot(fixture);
    expect(snapshot.compass_ref).toBe(`iterations/${fixture.workflowId}/delivery-compass.md`);
    expect(snapshot.phase).toBe("phase-1-prepare");
  });

  test("registration refuses a compass_ref that escapes the harness root", async () => {
    const fixture = makeFixture("iter-escape-compass");
    const outside = mkdtempSync(path.join(os.tmpdir(), "prepare-escape-"));
    roots.push(outside);
    writeFileSync(path.join(outside, "delivery-compass.md"), "# outside\n");
    await expect(register(fixture, path.join(outside, "delivery-compass.md"))).rejects.toThrow(/outside the harness root/);
  });

  test("an in-root symlink whose target lies outside the harness refuses registration", async () => {
    const fixture = makeFixture("iter-symlink-compass");
    const outside = mkdtempSync(path.join(os.tmpdir(), "prepare-symlink-"));
    roots.push(outside);
    writeFileSync(path.join(outside, "delivery-compass.md"), "# outside via symlink\n");
    const linkPath = path.join(fixture.harnessDir, "iterations", fixture.workflowId, "linked-compass.md");
    symlinkSync(path.join(outside, "delivery-compass.md"), linkPath);
    await expect(register(fixture, linkPath)).rejects.toThrow(/outside the harness root/);
  });

  test("show-prepare derives the absent phase and canonical pointer without writing", async () => {
    const fixture = makeFixture("iter-show-derive");
    await register(fixture, absoluteCompassRef(fixture));
    // Simulate the historical producer state this hotfix heals (I-000243 +
    // #293): the stored snapshot carries no phase and an ABSOLUTE compass_ref
    // (register's new normalization is deliberately bypassed here so the
    // legacy bytes are reproduced exactly).
    const snapshot = readSnapshot(fixture) as Record<string, any>;
    delete snapshot.phase;
    snapshot.compass_ref = absoluteCompassRef(fixture);
    writeSnapshot(fixture, snapshot);
    const envelopePath = bindCoordinator(fixture);
    setArtifactStore(createFsStore(fixture.harnessDir));
    const view = await showPrepareWorkflow({ sessionPath: envelopePath, cwd: fixture.root });
    expect(view.view.allowed).toBe(true);
    expect(view.view.blockers).toEqual([]);
    expect(view.view.derived).toEqual(["phase", "compass_ref"]);
    // The read never writes: the bytes still lack the phase and keep the
    // absolute pointer.
    const after = readSnapshot(fixture);
    expect(after.phase).toBeUndefined();
    expect(after.compass_ref).toBe(absoluteCompassRef(fixture));
  });

  test("the next ordinary amendment adopts the derived state together with the requested patch", async () => {
    const fixture = makeFixture("iter-amend-adopt");
    await register(fixture, absoluteCompassRef(fixture));
    // Legacy bytes again: no phase + absolute pointer (register normalizes
    // now, so the legacy state is reproduced explicitly).
    const snapshot = readSnapshot(fixture) as Record<string, any>;
    delete snapshot.phase;
    snapshot.compass_ref = absoluteCompassRef(fixture);
    writeSnapshot(fixture, snapshot);
    const envelopePath = bindCoordinator(fixture);
    setArtifactStore(createFsStore(fixture.harnessDir));
    const shown = await showPrepareWorkflow({ sessionPath: envelopePath, cwd: fixture.root });
    // The recorded integration checkout must be a REAL checkout of this
    // repository (the patch validator proves it) — mirror §2.3's step 3.
    const integrationPath = path.join(fixture.root, ".worktrees", "int");
    execFileSync("git", ["-C", fixture.root, "worktree", "add", "-b", `iteration/${fixture.workflowId}`, integrationPath, "main"], { stdio: "pipe" });
    setArtifactStore(createFsStore(fixture.harnessDir));
    const amended = await amendPrepareWorkflow({
      sessionPath: envelopePath,
      cwd: fixture.root,
      expectedSnapshotVersion: shown.view.snapshotVersion,
      expectedCompassVersion: shown.view.compassVersion,
      patch: { mainWorktreeBranch: "main", appendPlans: [], integrationWorktreePath: integrationPath, planParallelism: "serial" },
    });
    expect(amended.outcome).toBe("amended");
    expect(amended.view.derived).toEqual(["phase", "compass_ref"]);
    const after = readSnapshot(fixture);
    expect(after.phase).toBe("phase-1-prepare");
    expect(after.compass_ref).toBe(`iterations/${fixture.workflowId}/delivery-compass.md`);
    expect(after.integration_worktree_path).toBe(integrationPath);
    expect((after.execution_policy as Record<string, unknown>).plan_parallelism).toBe("serial");
    setArtifactStore(createFsStore(fixture.harnessDir));
    const shownAgain = await showPrepareWorkflow({ sessionPath: envelopePath, cwd: fixture.root });
    expect(shownAgain.view.allowed).toBe(true);
    expect(shownAgain.view.derived).toBeUndefined();
  });

  test("a present non-Prepare phase refuses and is never rewritten", async () => {
    const fixture = makeFixture("iter-present-phase");
    await register(fixture, absoluteCompassRef(fixture));
    const snapshot = readSnapshot(fixture) as Record<string, any>;
    snapshot.phase = "phase-2-execute";
    writeSnapshot(fixture, snapshot);
    const envelopePath = bindCoordinator(fixture);
    setArtifactStore(createFsStore(fixture.harnessDir));
    const shown = await showPrepareWorkflow({ sessionPath: envelopePath, cwd: fixture.root });
    expect(shown.view.allowed).toBe(false);
    expect(shown.view.blockers.join(" ")).toMatch(/not-prepare/);
    expect(shown.view.derived).toBeUndefined();
    await expect(
      amendPrepareWorkflow({
        sessionPath: envelopePath,
        cwd: fixture.root,
        expectedSnapshotVersion: shown.view.snapshotVersion,
        expectedCompassVersion: shown.view.compassVersion,
        patch: { mainWorktreeBranch: "main", appendPlans: [] },
      }),
    ).rejects.toThrow(/not phase-1-prepare/);
    expect((readSnapshot(fixture) as Record<string, unknown>).phase).toBe("phase-2-execute");
  });

  test("execution facts still refuse before any derivation", async () => {
    const fixture = makeFixture("iter-executing-row");
    await register(fixture, absoluteCompassRef(fixture));
    const snapshot = readSnapshot(fixture) as Record<string, any>;
    delete snapshot.phase;
    (snapshot.plans as Array<Record<string, unknown>>)[0]!.status = "InProgress";
    writeSnapshot(fixture, snapshot);
    const envelopePath = bindCoordinator(fixture);
    setArtifactStore(createFsStore(fixture.harnessDir));
    const shown = await showPrepareWorkflow({ sessionPath: envelopePath, cwd: fixture.root });
    expect(shown.view.allowed).toBe(false);
    expect(shown.view.blockers.join(" ")).toMatch(/execution-started/);
    expect(shown.view.derived).toBeUndefined();
  });
});
