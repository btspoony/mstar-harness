/**
 * omp hook Gate 1 / Gate 2 smoke + regression. The standalone validator tools
 * moved to the CLI MCP server; their arms in this file were deleted together
 * with `packages/omp/src/tools/`. Covers the omp `hooks/pre/mstar-gates`
 * Gate 1 hard paths and the Gate 2 caller-scoped anti-recursion contract.
 * Fixture: a committed minimal v2 harness tree (`test/fixtures/tools-v2-smoke/`)
 * copied into temp git repos (default `plans/` root, `.mstar/` root,
 * double-harness, `.mstarc` custom layout), so the gate's harness-root
 * resolution runs against real layouts.
 *
 * Regression anchors bundled here (fix wave 1):
 * - W-REV-2: default `.mstar` root layout — the Gate-1 classifier must gate
 *   through the `.mstar` root, not the nested `plans/` rung.
 * - W-REV-3: a nested sparse harness under a full-marker outer root stays gated.
 * - Phase-5 F1: `.mstarc` custom `workflow_dir` / `project_dir` layouts stay gated.
 * - S-d: omp hook 2MB size guard extended to the on-disk edit path.
 * - Gate 2 (#156): caller-scoped anti-recursion on task dispatches.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mstarGates from "../../omp/src/hooks/pre/mstar-gates";

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
  // The dedicated integration checkout (worktree-write model): an
  // iteration snapshot's full L1 input requires a real integration worktree
  // on branch.integration, distinct from the main worktree.
  const integration = join(root, "integration");
  const mainBranch = git(["branch", "--show-current"], root);
  const integrationBranch = "iteration/wf-smoke";
  git(["worktree", "add", "-q", integration, "-b", integrationBranch], root);

  // Patch the committed snapshot's placeholder paths with real ones (the
  // canonical `integration_worktree_path` + branch anchors; the v1
  // `control_worktree_path` key is gone — writers emit only the canonical
  // shape and the strict writer rejects the legacy key).
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
  snapshotDoc.integration_worktree_path = integration;
  snapshotDoc.branch = { base: mainBranch, integration: integrationBranch };
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
        integration_worktree_path: "__INTEGRATION_WORKTREE__",
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
  // Dedicated integration checkout (worktree-write model): the full L1
  // input for an iteration snapshot requires the integration worktree on
  // branch.integration, distinct from the main worktree.
  const integration = join(root, "integration");
  const mainBranch = git(["branch", "--show-current"], root);
  const integrationBranch = "iteration/wf-custom";
  git(["worktree", "add", "-q", integration, "-b", integrationBranch], root);
  // Patch the committed snapshot's placeholder paths with real ones (the
  // canonical `integration_worktree_path` + branch anchors — the v1
  // `control_worktree_path` key is gone, the strict writer rejects it).
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
  snapshotDoc.integration_worktree_path = integration;
  snapshotDoc.branch = { base: mainBranch, integration: integrationBranch };
  writeFileSync(snapshotPath, JSON.stringify(snapshotDoc, null, 2));
  return { root, linked, harness, snapshotPath: "", mstar: harness };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readFile(file: string): string {
  return readFileSync(file, "utf8");
}

let repo: SmokeRepo | undefined;

beforeAll(() => {
  repo = setupRepo();
});

afterAll(() => {
  if (repo) rmSync(repo.root, { recursive: true, force: true });
});

describe("omp hook Gate 2 — task dispatch (issue #156: caller-scoped anti-recursion)", () => {
  const ENV_KEY = "MSTAR_HARNESS_DIR";

  /** Register the hook's tool_call handler with a warnings collector. */
  const registerHandler = (warnings: string[]): ((event: unknown) => Promise<unknown>) => {
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: (m: string) => warnings.push(m), error: () => undefined },
    } as never);
    if (handler === undefined) throw new Error("mstarGates did not register a tool_call handler");
    return handler;
  };

  /** Pin the repo-hard resolution (session-cwd probe) for one call. */
  const withHarnessDir = async <T>(dir: string, run: () => Promise<T>): Promise<T> => {
    const previous = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    }
  };

  /** The issue #156 repro: minimal valid Phase-1 Review-&-Edit Assignment. */
  const VALID_HARD_ASSIGNMENT = [
    "## Assignment",
    "",
    "**Enforcement**: hard",
    "**Execute as**: product-manager",
    "**Delegation**: forbidden",
    "**Task category**: docs",
    "**Task budget (implement / ops rounds)**: S — one focused implementer round",
    "**Branch policy**: direct on main — docs-only plan review",
    "",
    "# Task",
    "",
    "Review and edit the plan document.",
    "",
  ].join("\n");

  const MISSING_DELEGATION_HARD = VALID_HARD_ASSIGNMENT.replace("**Delegation**: forbidden\n", "");
  const MISSING_DELEGATION_SOFT = MISSING_DELEGATION_HARD.replace("**Enforcement**: hard\n", "");
  const VALID_SOFT_ASSIGNMENT = VALID_HARD_ASSIGNMENT.replace("**Enforcement**: hard\n", "");

  test("C5-compliant dispatch (entry agent == Execute as) under header hard → NOT blocked, no warnings", async () => {
    const warnings: string[] = [];
    const handler = registerHandler(warnings);
    const res = await handler({
      toolName: "task",
      input: { tasks: [{ name: "ReviewEdit", agent: "product-manager", task: VALID_HARD_ASSIGNMENT }] },
    });
    expect(res).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("omitted agent under header hard → NOT blocked (no empty-binding pincer)", async () => {
    const warnings: string[] = [];
    const handler = registerHandler(warnings);
    const res = await handler({
      toolName: "task",
      input: { tasks: [{ name: "ReviewEdit", task: VALID_HARD_ASSIGNMENT }] },
    });
    expect(res).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("a REAL violation (missing Delegation) under header hard → blocked with the field code", async () => {
    const warnings: string[] = [];
    const handler = registerHandler(warnings);
    const res = await handler({
      toolName: "task",
      input: { tasks: [{ name: "Bad", agent: "product-manager", task: MISSING_DELEGATION_HARD }] },
    });
    const blocked = res as { block: boolean; reason: string } | undefined;
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("assignment.field.missing-delegation");
  });

  test("soft mode + violations → warn-logged, never blocked (the pre-#156 silent drop, closed)", async () => {
    const warnings: string[] = [];
    const handler = registerHandler(warnings);
    const emptyHarness = mkdtempSync(join(tmpdir(), "tools-smoke-soft-"));
    const res = await withHarnessDir(emptyHarness, () =>
      handler({
        toolName: "task",
        input: { tasks: [{ name: "Soft", agent: "product-manager", task: MISSING_DELEGATION_SOFT }] },
      }),
    );
    expect(res).toBeUndefined();
    expect(warnings.some((w) => w.includes("assignment.field.missing-delegation"))).toBe(true);
  });

  test("repo-level hard compass hardens a flag-less dispatch (Gate 1 / dsh resolveDispatchHard parity)", async () => {
    const warnings: string[] = [];
    const handler = registerHandler(warnings);
    const res = await withHarnessDir(repo!.harness, () =>
      handler({
        toolName: "task",
        input: { tasks: [{ name: "RepoHard", agent: "product-manager", task: MISSING_DELEGATION_SOFT }] },
      }),
    );
    const blocked = res as { block: boolean; reason: string } | undefined;
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("assignment.field.missing-delegation");
  });

  test("repo-level hard compass + compliant flag-less dispatch → NOT blocked", async () => {
    const warnings: string[] = [];
    const handler = registerHandler(warnings);
    const res = await withHarnessDir(repo!.harness, () =>
      handler({
        toolName: "task",
        input: { tasks: [{ name: "RepoHardOk", agent: "product-manager", task: VALID_SOFT_ASSIGNMENT }] },
      }),
    );
    expect(res).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("omp hook Gate 1 (S-d)", () => {
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

  beforeAll(() => {
    customRepo = setupCustomLayoutRepo();
  });

  afterAll(() => {
    if (customRepo) rmSync(customRepo.root, { recursive: true, force: true });
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
});
