/**
 * Committed tools v2 smoke + hook Gate 1 regression (QC fix-wave 1 S-g).
 *
 * Covers the five rewired `tools/mstar_*` (module load + one execution per
 * tool against the rebuilt engine dist) AND the omp `hooks/pre/mstar-gates`
 * Gate 1 degrade/hard paths — replacing the one-time smoke script that only
 * existed in task-2-report.md (qc3 S-4). Fixture: a committed minimal v2
 * harness tree (`test/fixtures/tools-v2-smoke/`) copied into a temp git
 * repo with a real linked worktree, so `l1PreDispatchCheck`'s existence +
 * branch probes pass.
 *
 * Regression anchors bundled here (fix wave 1):
 * - W-A: `mstar_worktree_check` workflowId traversal guard parity.
 * - W-B: hooks/tools lazy-load the P1-only engine exports — a stale engine
 *   (missing `validateWorkflowSnapshot` / `validateProjectRegister` /
 *   `WORKFLOW_SNAPSHOT_FILE` / `resolveWorkflowDir` / `resolveProjectDir`)
 *   degrades to a one-time warning + skip, never a module-link crash.
 * - W-C: `mstar_status_validate` classifies by harness-relative layout
 *   (Gate 1 parity), rejecting non-canonical snapshot paths.
 * - S-b: `mstar_iteration_gate` takes `workflowId` (CLI parity).
 * - S-d: omp hook 2MB size guard extended to the on-disk edit path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import mstarDispatchValidate from "../../../tools/mstar_dispatch_validate/index";
import mstarIterationGate, {
  workflowDirResolverLoader as iterationGateDirResolverLoader,
} from "../../../tools/mstar_iteration_gate/index";
import mstarLeaseVerify, {
  workflowDirResolverLoader as leaseVerifyDirResolverLoader,
} from "../../../tools/mstar_lease_verify/index";
import mstarPathResolve from "../../../tools/mstar_path_resolve/index";
import mstarStatusValidate from "../../../tools/mstar_status_validate/index";
import mstarWorktreeCheck, {
  workflowDirResolverLoader as worktreeCheckDirResolverLoader,
} from "../../../tools/mstar_worktree_check/index";
import mstarGates, { dirResolversLoader, loadNewValidators, newValidatorsLoader } from "../../../hooks/pre/mstar-gates";

const FIXTURE = join(import.meta.dir, "fixtures", "tools-v2-smoke", "repo");
const SNAPSHOT_REL = join("plans", "workflows", "wf-smoke", "snapshot.json");
// Default-layout fixture is committed under a non-ignored name
// (`.mstar/` is gitignored at the harness repo root) and renamed to
// `.mstar` inside the temp repo (W-REV-2).
const MSTAR_FIXTURE_DIR = ".mstar-dot";
const MSTAR_REL = ".mstar";

interface SmokeRepo {
  root: string;
  linked: string;
  harness: string;
  snapshotPath: string;
  mstar: string;
}

/** A worktree with the fixture copied in; patched lease paths. */
function setupRepo(): SmokeRepo {
  const root = mkdtempSync(join(tmpdir(), "tools-smoke-"));
  cpSync(FIXTURE, root, { recursive: true });
  // Real git repo + linked worktree so l1PreDispatchCheck probes pass.
  git(["init", "-q"], root);
  git(["config", "user.email", "tools-smoke@example.com"], root);
  git(["config", "user.name", "Tools Smoke"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);
  const linked = join(root, "linked");
  git(["worktree", "add", "-q", linked, "-b", "feature/plan-a"], root);

  // Patch the committed snapshot's placeholder lease paths with real ones.
  const snapshotPath = join(root, SNAPSHOT_REL);
  const snapshotDoc = JSON.parse(readFile(snapshotPath)) as Record<string, unknown>;
  const plans = snapshotDoc.plans;
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error("fixture snapshot must have exactly one plan row");
  }
  const row = plans[0] as Record<string, unknown>;
  row.execution_lease = {
    holder: "omp-pm-smoke",
    claimed_at: "2026-08-19",
    worktree_path: linked,
    working_branch: "feature/plan-a",
  };
  snapshotDoc.control_worktree_path = root;
  writeFileSync(snapshotPath, JSON.stringify(snapshotDoc, null, 2));

  return { root, linked, harness: join(root, "plans"), snapshotPath, mstar: "" };
}

/**
 * A SEPARATE temp repo holding only the default `.mstar` layout (W-REV-2):
 * the fixture is committed under the non-ignored alias `.mstar-dot` —
 * `.mstar/` is gitignored at the harness repo root — and renamed here.
 * Isolation from the plans-rooted repo matters: `resolveHarnessDir`'s rung
 * order (`.mstar` first) would otherwise redirect the plans-rooted smoke
 * targets to the `.mstar` root once both layouts exist in one repo.
 */
function setupMstarRepo(): SmokeRepo {
  const root = mkdtempSync(join(tmpdir(), "tools-smoke-mstar-"));
  cpSync(FIXTURE, root, { recursive: true });
  renameSync(join(root, MSTAR_FIXTURE_DIR), join(root, MSTAR_REL));
  git(["init", "-q"], root);
  git(["config", "user.email", "tools-smoke@example.com"], root);
  git(["config", "user.name", "Tools Smoke"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);
  return { root, linked: "", harness: join(root, MSTAR_REL), snapshotPath: "", mstar: join(root, MSTAR_REL) };
}

/**
 * Pathological double-harness repo (W-REV-3): an outer FULL-marker root
 * (`status.json` + `workflows/` + `projects/` at the repo root) with a
 * nested SPARSE harness (`inner/.mstar/` — `workflows/` + `projects/` but
 * NO `status.json` and NO `plans/`, so the marker probe skips it while the
 * name probe still finds it). Coordination docs live only in the inner
 * harness; the outer root carries the markers that make the probe return
 * the WRONG root.
 */
function setupDoubleHarnessRepo(): SmokeRepo {
  const root = mkdtempSync(join(tmpdir(), "tools-smoke-double-"));
  // Outer full-marker root.
  writeFileSync(
    join(root, "status.json"),
    JSON.stringify({ version: 2, updated_at: "2026-08-19", workflows: [] }, null, 2),
  );
  mkdirSync(join(root, "workflows"));
  mkdirSync(join(root, "projects"));
  // Inner sparse harness (hard compass so the hook gate can block).
  const inner = join(root, "inner", ".mstar");
  mkdirSync(join(inner, "workflows", "wf-inner"), { recursive: true });
  mkdirSync(join(inner, "projects", "_inner"), { recursive: true });
  mkdirSync(join(inner, "iterations", "iter-inner"), { recursive: true });
  writeFileSync(
    join(inner, "iterations", "iter-inner", "delivery-compass.md"),
    [
      "---",
      "iteration_id: iter-inner",
      "start_date: 2026-08-01",
      "status: active",
      "enforcement: hard",
      "iteration_base_branch: main",
      "target_branch: main",
      "plans:",
      "  - plan-a",
      "---",
      "",
      "# iter-inner Delivery Compass",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(inner, "workflows", "wf-inner", "snapshot.json"),
    JSON.stringify(
      {
        schema_version: 1,
        id: "wf-inner",
        type: "plan",
        status: "running",
        started_at: "2026-08-01",
        updated_at: "2026-08-19",
        plans: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(inner, "projects", "_inner", "residuals.json"), JSON.stringify({ entries: {} }, null, 2));
  git(["init", "-q"], root);
  git(["config", "user.email", "tools-smoke@example.com"], root);
  git(["config", "user.name", "Tools Smoke"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);
  return { root, linked: "", harness: join(root, "inner", ".mstar"), snapshotPath: "", mstar: "" };
}

/**
 * Custom `.mstarc` layout repo (Phase-5 F1): a default `.mstar/` harness
 * root whose `.mstarc` declares `workflow_dir` / `project_dir` — the
 * coordination docs live under the DECLARED names, never `workflows/` /
 * `projects/`. Hard iteration compass so the hook gate can block. The
 * snapshot carries a plan row + integration lease (placeholder paths,
 * patched after the linked worktree exists) so the snapshot-consuming
 * tools (lease verify / iteration gate / worktree check) can assert the
 * DECLARED location is read.
 */
function setupCustomLayoutRepo(): SmokeRepo {
  const root = mkdtempSync(join(tmpdir(), "tools-smoke-custom-"));
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "cw-wf", "wf-custom"), { recursive: true });
  mkdirSync(join(harness, "cw-pj", "_custom"), { recursive: true });
  mkdirSync(join(harness, "iterations", "iter-custom"), { recursive: true });
  writeFileSync(
    join(harness, "status.json"),
    JSON.stringify({ version: 2, updated_at: "2026-08-19", workflows: [] }, null, 2),
  );
  writeFileSync(join(harness, ".mstarc"), "[config]\nworkflow_dir=cw-wf\nproject_dir=cw-pj\n", "utf8");
  writeFileSync(
    join(harness, "iterations", "iter-custom", "delivery-compass.md"),
    [
      "---",
      "iteration_id: iter-custom",
      "start_date: 2026-08-01",
      "status: active",
      "enforcement: hard",
      "iteration_base_branch: main",
      "target_branch: main",
      "plans:",
      "  - plan-a",
      "---",
      "",
      "# iter-custom Delivery Compass",
      "",
    ].join("\n"),
  );
  const snapshotPath = join(harness, "cw-wf", "wf-custom", "snapshot.json");
  writeFileSync(
    snapshotPath,
    JSON.stringify(
      {
        schema_version: 1,
        id: "wf-custom",
        type: "iteration",
        status: "running",
        started_at: "2026-08-01",
        updated_at: "2026-08-19",
        plans: [
          {
            id: "plan-a",
            title: "Plan A",
            file: "plans/plan-a.md",
            status: "InProgress",
            execution_lease: {
              holder: "omp-pm-custom",
              claimed_at: "2026-08-19",
              worktree_path: "__LEASE_WORKTREE__",
              working_branch: "feature/plan-a",
            },
          },
        ],
        control_worktree_path: "__CONTROL_WORKTREE__",
        integration_merge_lease: {
          holder: "omp-pm-custom",
          claimed_at: "2026-08-19",
          plan_id: "plan-a",
          source_branch: "feature/plan-a",
          target_branch: "main",
        },
        compass_ref: "iterations/iter-custom/delivery-compass.md",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(harness, "cw-pj", "_custom", "residuals.json"), JSON.stringify({ entries: {} }, null, 2));
  git(["init", "-q"], root);
  git(["config", "user.email", "tools-smoke@example.com"], root);
  git(["config", "user.name", "Tools Smoke"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);
  // Real linked worktree so the L1 lease probes pass (mirrors setupRepo).
  const linked = join(root, "linked");
  git(["worktree", "add", "-q", linked, "-b", "feature/plan-a"], root);
  // Patch the committed snapshot's placeholder lease paths with real ones.
  const snapshotDoc = JSON.parse(readFile(snapshotPath)) as Record<string, unknown>;
  const plans = snapshotDoc.plans;
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error("custom fixture snapshot must have exactly one plan row");
  }
  const row = plans[0] as Record<string, unknown>;
  row.execution_lease = {
    holder: "omp-pm-custom",
    claimed_at: "2026-08-19",
    worktree_path: linked,
    working_branch: "feature/plan-a",
  };
  snapshotDoc.control_worktree_path = root;
  writeFileSync(snapshotPath, JSON.stringify(snapshotDoc, null, 2));
  return { root, linked, harness, snapshotPath: "", mstar: harness };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readFile(file: string): string {
  return readFileSync(file, "utf8");
}

/** Minimal mock of the omp CustomToolAPI (tools only touch cwd + zod). */
function mockPi(cwd: string): CustomToolAPI {
  return {
    cwd,
    zod,
    exec: async () => {
      throw new Error("exec is not used by the smoke");
    },
    ui: {} as CustomToolAPI["ui"],
    hasUI: false,
    logger: {
      warn: () => undefined,
      error: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as CustomToolAPI["logger"],
    typebox: {} as CustomToolAPI["typebox"],
    arktype: {} as CustomToolAPI["arktype"],
    pi: {} as CustomToolAPI["pi"],
    pushPendingAction: () => undefined,
  };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function runTool(
  factory: (pi: CustomToolAPI) => CustomTool,
  cwd: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = factory(mockPi(cwd));
  const result = await tool.execute("call-1", params, undefined, undefined as never, undefined);
  return result as ToolResult;
}

let repo: SmokeRepo | undefined;

beforeAll(() => {
  repo = setupRepo();
});

afterAll(() => {
  if (repo) rmSync(repo.root, { recursive: true, force: true });
});

describe("tools v2 smoke (S-g)", () => {
  test("mstar_status_validate: v2 root + workflow snapshot valid, non-canonical layout rejected (W-C)", async () => {
    const root = repo!.root;
    const harness = repo!.harness;
    // Root (default path discovery) — v2 root validates.
    const rootRes = await runTool(mstarStatusValidate, root, {});
    expect(rootRes.isError).not.toBe(true);
    expect(rootRes.content[0]!.text).toContain("status.json valid");

    // Canonical snapshot path — snapshot validator.
    const snapRes = await runTool(mstarStatusValidate, root, { path: join("plans", "workflows", "wf-smoke", "snapshot.json") });
    expect(snapRes.isError).not.toBe(true);
    expect(snapRes.content[0]!.text).toContain("snapshot valid");
    expect(snapRes.content[0]!.text).toContain("1 plans");

    // Canonical register path — register validator (Gate 1 kind parity).
    const regRes = await runTool(mstarStatusValidate, root, { path: join("plans", "projects", "_default", "residuals.json") });
    expect(regRes.isError).not.toBe(true);
    expect(regRes.content[0]!.text).toContain("register valid");

    // Non-canonical snapshot layout (basename matches but not under
    // {HARNESS_DIR}/workflows/<id>/) — explicit error, never validated.
    const evil = join(root, "tmp-outside", "snapshot.json");
    mkdirSync(join(root, "tmp-outside"), { recursive: true });
    writeFileSync(evil, JSON.stringify({ schema_version: 1 }));
    const evilRes = await runTool(mstarStatusValidate, root, { path: evil });
    expect(evilRes.isError).toBe(true);
    expect(evilRes.content[0]!.text).toContain("not a canonical");
    // Same for a snapshot.json outside the harness entirely.
    const strayRoot = mkdtempSync(join(tmpdir(), "tools-smoke-stray-"));
    const stray = join(strayRoot, "snapshot.json");
    writeFileSync(stray, "{}");
    const strayRes = await runTool(mstarStatusValidate, root, { path: stray });
    expect(strayRes.isError).toBe(true);
    expect(strayRes.content[0]!.text).toContain("not a canonical");
    rmSync(strayRoot, { recursive: true, force: true });

    expect(existsSync(join(harness, "workflows", "wf-smoke", "snapshot.json"))).toBe(true);
  });

  test("mstar_lease_verify: execution + integration on the snapshot; traversal guard parity", async () => {
    const root = repo!.root;
    const execRes = await runTool(mstarLeaseVerify, root, { workflowId: "wf-smoke", kind: "execution", planId: "plan-a" });
    expect(execRes.isError).not.toBe(true);
    expect(execRes.content[0]!.text).toContain("execution lease OK");

    const intRes = await runTool(mstarLeaseVerify, root, { workflowId: "wf-smoke", kind: "integration" });
    expect(intRes.isError).not.toBe(true);
    expect(intRes.content[0]!.text).toContain("integration merge lease OK");

    const evil = await runTool(mstarLeaseVerify, root, { workflowId: "../evil", kind: "execution", planId: "plan-a" });
    expect(evil.isError).toBe(true);
    expect(evil.content[0]!.text).toContain("invalid workflowId");
  });

  test("mstar_worktree_check: L1 passes on snapshot inputs; workflowId traversal guard parity (W-A)", async () => {
    const root = repo!.root;
    const l1 = await runTool(mstarWorktreeCheck, root, { kind: "l1", workflowId: "wf-smoke", planId: "plan-a" });
    expect(l1.isError).not.toBe(true);
    expect(l1.content[0]!.text).toContain("l1 pre-dispatch check OK");

    for (const bad of ["../evil", ".", "..", "a/b"]) {
      const res = await runTool(mstarWorktreeCheck, root, { kind: "l1", workflowId: bad });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("invalid workflowId");
    }
    // Empty string is a missing-required error, not a traversal case.
    const empty = await runTool(mstarWorktreeCheck, root, { kind: "l1", workflowId: "" });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]!.text).toContain("requires workflowId");
  });

  test("mstar_iteration_gate: workflowId param resolves the snapshot (S-b)", async () => {
    const root = repo!.root;
    const res = await runTool(mstarIterationGate, root, {
      phase: "phase-2-execute",
      workflowId: "wf-smoke",
      compassPath: join("plans", "iterations", "iter-smoke", "delivery-compass.md"),
    });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]!.text).toContain("gate ok");
    expect(res.content[0]!.text).toContain("phase-2-execute");

    const evil = await runTool(mstarIterationGate, root, {
      phase: "phase-2-execute",
      workflowId: "../evil",
      compassPath: join("plans", "iterations", "iter-smoke", "delivery-compass.md"),
    });
    expect(evil.isError).toBe(true);
    expect(evil.content[0]!.text).toContain("invalid workflowId");
  });

  test("mstar_path_resolve: eight symbols resolved", async () => {
    const root = repo!.root;
    const res = await runTool(mstarPathResolve, root, { planId: "plan-a" });
    expect(res.isError).not.toBe(true);
    const text = res.content[0]!.text;
    expect(text).toContain("harness:");
    expect(text).toContain("workflow:");
    expect(text).toContain("project:");
    expect(text).toContain("sdd:");
    expect(text.split("\n")).toHaveLength(8);
  });

  test("mstar_dispatch_validate: assignment gate executes (no status reads)", async () => {
    const root = repo!.root;
    const assignment = [
      "**Execute as**: scout",
      "**Delegation**: forbidden",
      "**Task category**: quick",
      "",
      "# Task",
      "",
      "Read-only survey of the repo.",
      "",
    ].join("\n");
    const res = await runTool(mstarDispatchValidate, root, { assignmentText: assignment, agent: "general" });
    expect(res.isError).not.toBe(true);
  });
});

describe("omp hook Gate 1 (W-B / S-d)", () => {
  test("stale engine (missing P1 validators) → silent pass + one-time warning, no crash", async () => {
    const root = repo!.root;
    const warnings: string[] = [];
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    const pi = {
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: (m: string) => warnings.push(m) },
    };
    mstarGates(pi as never);
    expect(handler).toBeDefined();

    const originalLoad = newValidatorsLoader.load;
    try {
      newValidatorsLoader.load = async () => ({ status: "missing" });
      const res = await handler!({
        toolName: "write",
        input: { path: repo!.snapshotPath, content: "{ not json" },
      });
      // Degrade: skip snapshot/register validation entirely (silent pass).
      expect(res).toBeUndefined();
      expect(warnings.some((w) => w.includes("lacks") && w.includes("snapshot/register"))).toBe(true);
    } finally {
      newValidatorsLoader.load = originalLoad;
    }
  });

  test("hard enforcement: invalid snapshot write blocked, valid write passes", async () => {
    const root = repo!.root;
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: () => undefined, error: () => undefined },
    } as never);
    expect(handler).toBeDefined();

    const snapshotPath = repo!.snapshotPath;
    const validDoc = JSON.parse(readFile(snapshotPath)) as Record<string, unknown>;

    const blocked = await handler!({
      toolName: "write",
      input: { path: snapshotPath, content: JSON.stringify({ schema_version: 99 }) },
    });
    // The handler returns `{ block: true, reason }` or undefined — narrow
    // the unknown result once into a named const.
    const blockedResult = blocked as { block: boolean; reason: string } | undefined;
    expect(blockedResult?.block).toBe(true);
    expect(blockedResult?.reason).toContain("workflow.snapshot");

    const passed = await handler!({
      toolName: "write",
      input: { path: snapshotPath, content: JSON.stringify(validDoc) },
    });
    expect(passed).toBeUndefined();

    // Root status.json kind still validated with the static validator.
    const rootPath = join(root, "plans", "status.json");
    const rootBlocked = await handler!({
      toolName: "write",
      input: { path: rootPath, content: JSON.stringify({ version: 1, plans: [] }) },
    });
    const rootBlockedResult = rootBlocked as { reason: string } | undefined;
    expect(rootBlockedResult?.reason).toContain("status.migration-required");
  });

  test("2MB size guard applies to the on-disk edit path (S-d)", async () => {
    const root = repo!.root;
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: () => undefined, error: () => undefined },
    } as never);
    expect(handler).toBeDefined();

    const rootPath = join(root, "plans", "status.json");
    const original = readFile(rootPath);
    try {
      // Oversized invalid file: without the guard the edit path would read +
      // parse it and block (hard compass); with the guard it passes silently.
      writeFileSync(rootPath, "x".repeat(2 * 1024 * 1024 + 1));
      const res = await handler!({ toolName: "edit", input: { path: rootPath } });
      expect(res).toBeUndefined();
    } finally {
      writeFileSync(rootPath, original);
    }
  });
});

describe("default .mstar root layout (W-REV-2)", () => {
  // Regression: `harnessDocKindOfTarget` resolved the harness root via
  // `resolveHarnessDir`'s rung-3 `plans/` probe — inside a default `.mstar`
  // root the probe matched the NESTED `.mstar/plans` subdir and returned it
  // as the root, so `status.json`, `workflows/<id>/snapshot.json` and
  // `projects/<id>/residuals.json` all fell outside the canonical rel and
  // were NOT gated (fail-open). The fixture `.mstar/` mirrors the default
  // layout: `plans/` lives INSIDE the root.
  let mstarRepo: SmokeRepo | undefined;

  beforeAll(() => {
    mstarRepo = setupMstarRepo();
  });

  afterAll(() => {
    if (mstarRepo) rmSync(mstarRepo.root, { recursive: true, force: true });
  });

  test("mstar_status_validate: all three coordination docs gated on the .mstar root", async () => {
    const root = mstarRepo!.root;
    // Explicit-path form for each canonical kind.
    const statusRes = await runTool(mstarStatusValidate, root, { path: join(".mstar", "status.json") });
    expect(statusRes.isError).not.toBe(true);
    expect(statusRes.content[0]!.text).toContain("status.json valid");

    const snapRes = await runTool(mstarStatusValidate, root, {
      path: join(".mstar", "workflows", "wf-default", "snapshot.json"),
    });
    expect(snapRes.isError).not.toBe(true);
    expect(snapRes.content[0]!.text).toContain("snapshot valid");

    const regRes = await runTool(mstarStatusValidate, root, {
      path: join(".mstar", "projects", "_default", "residuals.json"),
    });
    expect(regRes.isError).not.toBe(true);
    expect(regRes.content[0]!.text).toContain("register valid");

    // Default (cwd discovery) lands on the .mstar root — never the nested
    // plans/ rung.
    const rootRes = await runTool(mstarStatusValidate, root, {});
    expect(rootRes.isError).not.toBe(true);
    expect(rootRes.content[0]!.text).toContain("status.json valid");

    expect(existsSync(join(mstarRepo!.mstar, "plans", "plan-a.md"))).toBe(true);
  });

  test("omp hook Gate 1: invalid .mstar workflow snapshot hard-rejected, valid passes", async () => {
    const root = mstarRepo!.root;
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: () => undefined, error: () => undefined },
    } as never);
    expect(handler).toBeDefined();

    const snapshotPath = join(root, ".mstar", "workflows", "wf-default", "snapshot.json");
    const validDoc = JSON.parse(readFile(snapshotPath)) as Record<string, unknown>;

    // The .mstar iteration compass hardens the repo — an invalid snapshot
    // write must be blocked (the classification must reach the gate).
    const blocked = await handler!({
      toolName: "write",
      input: { path: snapshotPath, content: JSON.stringify({ schema_version: 99 }) },
    });
    const blockedResult = blocked as { block: boolean; reason: string } | undefined;
    expect(blockedResult?.block).toBe(true);
    expect(blockedResult?.reason).toContain("workflow.snapshot");

    const passed = await handler!({
      toolName: "write",
      input: { path: snapshotPath, content: JSON.stringify(validDoc) },
    });
    expect(passed).toBeUndefined();

    // Root status.json kind still gated through the .mstar root.
    const rootPath = join(root, ".mstar", "status.json");
    const rootBlocked = await handler!({
      toolName: "write",
      input: { path: rootPath, content: JSON.stringify({ version: 1, plans: [] }) },
    });
    const rootBlockedResult = rootBlocked as { reason: string } | undefined;
    expect(rootBlockedResult?.reason).toContain("status.migration-required");

    // Non-canonical snapshot layout stays ungated (silent pass) even on the
    // .mstar root — the fix must not over-gate.
    const stray = join(root, ".mstar", "workflows", "snapshot.json");
    writeFileSync(stray, JSON.stringify({ schema_version: 99 }));
    const strayRes = await handler!({ toolName: "write", input: { path: stray, content: "{}" } });
    expect(strayRes).toBeUndefined();
  });
});

describe("pathological double harness (W-REV-3)", () => {
  // Regression: `harnessDocKindOfTarget` resolves the root by marker probe
  // (`resolveHarnessRootOf`) FIRST — when a nested SPARSE harness (a
  // `.mstar/` root missing one of the three full markers) sits below an
  // outer FULL-marker root, the probe returns the OUTER root, the inner
  // doc's rel falls outside the canonical set, and the doc is silently
  // UNGATED. The fix retries `resolveHarnessDir` (name probe) when the
  // probe root hit but rel is non-canonical, so inner docs stay gated.
  let doubleRepo: SmokeRepo | undefined;

  beforeAll(() => {
    doubleRepo = setupDoubleHarnessRepo();
  });

  afterAll(() => {
    if (doubleRepo) rmSync(doubleRepo.root, { recursive: true, force: true });
  });

  test("mstar_status_validate: inner sparse-harness docs gated under an outer full-marker root", async () => {
    const root = doubleRepo!.root;
    const snapRes = await runTool(mstarStatusValidate, root, {
      path: join("inner", ".mstar", "workflows", "wf-inner", "snapshot.json"),
    });
    expect(snapRes.isError).not.toBe(true);
    expect(snapRes.content[0]!.text).toContain("snapshot valid");

    const regRes = await runTool(mstarStatusValidate, root, {
      path: join("inner", ".mstar", "projects", "_inner", "residuals.json"),
    });
    expect(regRes.isError).not.toBe(true);
    expect(regRes.content[0]!.text).toContain("register valid");

    // The outer full-marker root still gates its own docs.
    const outerRes = await runTool(mstarStatusValidate, root, { path: "status.json" });
    expect(outerRes.isError).not.toBe(true);
    expect(outerRes.content[0]!.text).toContain("status.json valid");

    // Non-canonical layout inside the inner harness stays rejected — the
    // fix must not over-gate.
    const stray = join(root, "inner", ".mstar", "workflows", "snapshot.json");
    writeFileSync(stray, "{}");
    const strayRes = await runTool(mstarStatusValidate, root, { path: stray });
    expect(strayRes.isError).toBe(true);
    expect(strayRes.content[0]!.text).toContain("not a canonical");
  });

  test("omp hook Gate 1: inner sparse-harness docs hard-blocked under an outer full-marker root", async () => {
    const root = doubleRepo!.root;
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: () => undefined, error: () => undefined },
    } as never);
    expect(handler).toBeDefined();

    const snapshotPath = join(root, "inner", ".mstar", "workflows", "wf-inner", "snapshot.json");
    const validSnapshot = JSON.parse(readFile(snapshotPath)) as Record<string, unknown>;

    // The inner harness compass hardens the repo — an invalid snapshot
    // write must be blocked (the classification must reach the gate).
    const blocked = await handler!({
      toolName: "write",
      input: { path: snapshotPath, content: JSON.stringify({ schema_version: 99 }) },
    });
    const blockedResult = blocked as { block: boolean; reason: string } | undefined;
    expect(blockedResult?.block).toBe(true);
    expect(blockedResult?.reason).toContain("workflow.snapshot");

    const passed = await handler!({
      toolName: "write",
      input: { path: snapshotPath, content: JSON.stringify(validSnapshot) },
    });
    expect(passed).toBeUndefined();

    // Root status.json kind still gated through the inner sparse root
    // (file absent at classification time — the write-gate scenario).
    const rootPath = join(root, "inner", ".mstar", "status.json");
    const rootBlocked = await handler!({
      toolName: "write",
      input: { path: rootPath, content: JSON.stringify({ version: 1, plans: [] }) },
    });
    const rootBlockedResult = rootBlocked as { reason: string } | undefined;
    expect(rootBlockedResult?.reason).toContain("status.migration-required");

    // Non-canonical snapshot layout stays ungated (silent pass) — the fix
    // must not over-gate.
    const stray = join(root, "inner", ".mstar", "workflows", "snapshot.json");
    writeFileSync(stray, JSON.stringify({ schema_version: 99 }));
    const strayRes = await handler!({ toolName: "write", input: { path: stray, content: "{}" } });
    expect(strayRes).toBeUndefined();
  });
});

describe("custom workflow_dir/project_dir layout (Phase-5 F1)", () => {
  // Regression: `harnessDocKindOfTarget` classified snapshot/register by
  // the hardcoded `workflows/` / `projects/` rel prefixes and the marker
  // probe checked the default names only — under a `.mstarc` custom layout
  // every coordination doc fell outside the canonical set and was silently
  // UNGATED (and the CLI/tools read/wrote different locations). The fix
  // resolves `{WORKFLOW_DIR}` / `{PROJECT_DIR}` through the engine
  // resolvers in BOTH the probe and the classify.
  let customRepo: SmokeRepo | undefined;

  beforeAll(async () => {
    customRepo = setupCustomLayoutRepo();
    // Deterministic classification: the hook's async gate awaits the
    // loader itself, but pinning it here makes the sync-slot state
    // explicit for the degrade test below.
    await dirResolversLoader.load();
  });

  afterAll(() => {
    if (customRepo) rmSync(customRepo.root, { recursive: true, force: true });
  });

  test("mstar_status_validate: snapshot + register at the DECLARED custom locations validate", async () => {
    const root = customRepo!.root;
    const snapRes = await runTool(mstarStatusValidate, root, {
      path: join(".mstar", "cw-wf", "wf-custom", "snapshot.json"),
    });
    expect(snapRes.isError).not.toBe(true);
    expect(snapRes.content[0]!.text).toContain("snapshot valid");

    const regRes = await runTool(mstarStatusValidate, root, {
      path: join(".mstar", "cw-pj", "_custom", "residuals.json"),
    });
    expect(regRes.isError).not.toBe(true);
    expect(regRes.content[0]!.text).toContain("register valid");

    // The default-named locations are NOT canonical under the custom
    // layout (the fix must not over-gate either).
    const wrong = join(".mstar", "workflows", "wf-custom", "snapshot.json");
    expect(existsSync(join(root, wrong))).toBe(false);
  });

  test("mstar_lease_verify: snapshot resolved at the DECLARED custom workflow_dir", async () => {
    const root = customRepo!.root;
    const execRes = await runTool(mstarLeaseVerify, root, { workflowId: "wf-custom", kind: "execution", planId: "plan-a" });
    expect(execRes.isError).not.toBe(true);
    expect(execRes.content[0]!.text).toContain("execution lease OK");

    const intRes = await runTool(mstarLeaseVerify, root, { workflowId: "wf-custom", kind: "integration" });
    expect(intRes.isError).not.toBe(true);
    expect(intRes.content[0]!.text).toContain("integration merge lease OK");

    // The hardcoded default-layout dir is NEVER consulted.
    expect(existsSync(join(root, ".mstar", "workflows"))).toBe(false);
  });

  test("mstar_iteration_gate: snapshot + compass resolved at the DECLARED custom locations", async () => {
    const root = customRepo!.root;
    const res = await runTool(mstarIterationGate, root, {
      phase: "phase-2-execute",
      workflowId: "wf-custom",
      compassPath: join(".mstar", "iterations", "iter-custom", "delivery-compass.md"),
    });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]!.text).toContain("gate ok");
    expect(res.content[0]!.text).toContain("phase-2-execute");
    expect(existsSync(join(root, ".mstar", "workflows"))).toBe(false);
  });

  test("mstar_worktree_check: L1 snapshot inputs resolved at the DECLARED custom workflow_dir", async () => {
    const root = customRepo!.root;
    const l1 = await runTool(mstarWorktreeCheck, root, { kind: "l1", workflowId: "wf-custom", planId: "plan-a" });
    expect(l1.isError).not.toBe(true);
    expect(l1.content[0]!.text).toContain("l1 pre-dispatch check OK");
    expect(existsSync(join(root, ".mstar", "workflows"))).toBe(false);
  });

  test("stale engine (no P1 dir resolver) degrades to the default workflows name in the tools", async () => {
    const root = customRepo!.root;
    const seams = [
      { loader: leaseVerifyDirResolverLoader, tool: mstarLeaseVerify, params: { workflowId: "wf-custom", kind: "execution", planId: "plan-a" } },
      {
        loader: iterationGateDirResolverLoader,
        tool: mstarIterationGate,
        params: { phase: "phase-2-execute", workflowId: "wf-custom", compassPath: join(".mstar", "iterations", "iter-custom", "delivery-compass.md") },
      },
      { loader: worktreeCheckDirResolverLoader, tool: mstarWorktreeCheck, params: { kind: "l1", workflowId: "wf-custom", planId: "plan-a" } },
    ];
    const originals = seams.map((s) => s.loader.load);
    try {
      for (const s of seams) s.loader.load = async () => null;
      for (const s of seams) {
        const res = await runTool(s.tool, root, s.params);
        expect(res.isError).toBe(true);
        expect(res.content[0]!.text).toContain("workflow snapshot not found");
        expect(res.content[0]!.text).toContain(join(".mstar", "workflows", "wf-custom"));
      }
    } finally {
      seams.forEach((s, i) => {
        s.loader.load = originals[i]!;
      });
    }
  });

  test("omp hook Gate 1: invalid custom-layout snapshot hard-blocked, valid passes", async () => {
    const root = customRepo!.root;
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: () => undefined, error: () => undefined },
    } as never);
    expect(handler).toBeDefined();

    const snapshotPath = join(root, ".mstar", "cw-wf", "wf-custom", "snapshot.json");
    const validSnapshot = JSON.parse(readFile(snapshotPath)) as Record<string, unknown>;

    // The custom-layout snapshot IS a gated coordination doc — an invalid
    // write must be blocked (the classification must reach the gate).
    const blocked = await handler!({
      toolName: "write",
      input: { path: snapshotPath, content: JSON.stringify({ schema_version: 99 }) },
    });
    const blockedResult = blocked as { block: boolean; reason: string } | undefined;
    expect(blockedResult?.block).toBe(true);
    expect(blockedResult?.reason).toContain("workflow.snapshot");

    const passed = await handler!({
      toolName: "write",
      input: { path: snapshotPath, content: JSON.stringify(validSnapshot) },
    });
    expect(passed).toBeUndefined();

    // Non-canonical custom-layout path (no <id> component) stays ungated —
    // the fix must not over-gate.
    const stray = join(root, ".mstar", "cw-wf", "snapshot.json");
    writeFileSync(stray, JSON.stringify({ schema_version: 99 }));
    const strayRes = await handler!({ toolName: "write", input: { path: stray, content: "{}" } });
    expect(strayRes).toBeUndefined();
  });

  test("stale engine (no P1 dir resolvers) degrades to default-layout classification: custom docs pass silently", async () => {
    const root = customRepo!.root;
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: () => undefined, error: () => undefined },
    } as never);
    expect(handler).toBeDefined();

    const snapshotPath = join(root, ".mstar", "cw-wf", "wf-custom", "snapshot.json");
    const originalLoad = dirResolversLoader.load;
    try {
      dirResolversLoader.load = async () => null;
      // Without the resolvers the custom layout is unclassifiable — the
      // write passes silently (the pre-F1 behavior), never a crash.
      const res = await handler!({
        toolName: "write",
        input: { path: snapshotPath, content: JSON.stringify({ schema_version: 99 }) },
      });
      expect(res).toBeUndefined();
    } finally {
      dirResolversLoader.load = originalLoad;
    }
  });
});
