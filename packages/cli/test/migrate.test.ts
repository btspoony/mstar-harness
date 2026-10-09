/**
 * CLI `mstar migrate [--dry-run] [--path <root>] [--json]` — thin wrapper
 * over the engine v1 -> v2 migration planner/executor (`migrateHarnessTree`
 * / `applyMigratePlan`).
 *
 * The v1 fixture is the ENGINE's committed snapshot fixture
 * (`packages/engine/test/fixtures/migrate-real/` — the repo's single v1
 * fixture; CLI tests must not fork a second one). Each case copies it into
 * a fresh temp dir and runs the real CLI entry as a subprocess.
 *
 * Exit-code contract:
 * - 0 = ok, or idempotent no-op (root already v2)
 * - 1 = plan-invalid (planner refused: no/unrecognized v1 status.json,
 *   unliftable or duplicate plans[] rows, unsafe ids)
 * - 2 = apply-failure (executor threw mid-apply; the root v2 replacement
 *   is the commit point, so the v1 root stays intact for a re-run)
 */
import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
/** Reuse the engine's committed v1 snapshot fixture (single v1 source). */
const V1_FIXTURE = join(CLI_ROOT, "..", "engine", "test", "fixtures", "migrate-real");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn env with ambient harness env vars pinned out: the CLI
 * resolves harness dirs from MSTAR_HARNESS_DIR / MSTAR_CONTROL_ROOT ahead
 * of probing — migrate uses --path/cwd only, but an ambient value must
 * never redirect a fixture.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test. */
function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Copy the engine's v1 fixture into a fresh temp harness root. */
function fixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), "migrate-cli-fixture-"));
  cpSync(V1_FIXTURE, root, { recursive: true });
  return root;
}

function readJsonFile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}
interface CliEnvelope {
  version: number;
  command: string;
  status: string;
  code: string;
  exitCode: number;
  message?: string;
  details?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function envelopeOf(result: RunResult, status?: string, code?: string): CliEnvelope {
  const envelope = JSON.parse(result.stdout) as CliEnvelope;
  expect(envelope.version).toBe(1);
  expect(envelope.command).toBe("migrate");
  expect(envelope.exitCode).toBe(result.exitCode);
  if (status !== undefined) expect(envelope.status).toBe(status);
  if (code !== undefined) expect(envelope.code).toBe(code);
  return envelope;
}

function migrationData(result: RunResult): Record<string, unknown> {
  return envelopeOf(result, "ok", "migrate.ok").data!;
}

/** Relative path list of every file under `root` (change detection). */
function treeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full.slice(root.length + 1));
    }
  };
  walk(root);
  return out.sort();
}

describe("mstar migrate — dry-run", () => {
  test("prints the step plan (archive first, root v2 replacement last) and writes nothing", () => {
    const root = fixtureTree();
    try {
      const before = treeFiles(root);
      const r = runCli(["migrate", "--dry-run", "--path", root]);
      expect(r.exitCode).toBe(0);
      const data = migrationData(r);
      expect(data.message).toContain("dry-run");
      const steps = data.steps as { kind: string; source: string; destination: string }[];
      expect(steps[0]).toMatchObject({ kind: "archive-status-v1", source: "status.json", destination: "archived/status.v1.json" });
      expect(steps.some((step) => step.kind === "write-snapshot")).toBe(true);
      expect(steps.at(-1)?.kind).toBe("replace-root-v2");
      // zero writes
      expect(treeFiles(root)).toEqual(before);
      expect(existsSync(join(root, "archived", "status.v1.json"))).toBe(false);
      expect(existsSync(join(root, "workflows"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults --path to the cwd", () => {
    const root = fixtureTree();
    try {
      const r = runCli(["migrate", "--dry-run"], { cwd: root });
      expect(r.exitCode).toBe(0);
      expect(migrationData(r).message).toContain("dry-run");
      expect(existsSync(join(root, "archived", "status.v1.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults --path to the resolved {HARNESS_DIR} when cwd is the repo root", () => {
    // Repo root with the v1 tree under `.mstar/` — every other command
    // auto-discovers the harness; migrate must too.
    const repoRoot = mkdtempSync(join(tmpdir(), "migrate-cli-discovery-"));
    try {
      const harness = join(repoRoot, ".mstar");
      mkdirSync(harness, { recursive: true });
      cpSync(V1_FIXTURE, harness, { recursive: true });
      const r = runCli(["migrate", "--dry-run", "--json"], { cwd: repoRoot });
      expect(r.exitCode).toBe(0);
      const data = migrationData(r);
      expect(data.dryRun).toBe(true);
      expect(data.root).toBe(realpathSync(harness));
      expect(existsSync(join(harness, "archived", "status.v1.json"))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("mstar migrate --dry-run — planned-document validation", () => {
  test("valid v1 tree → dry-run emits zero validation warnings", () => {
    const root = fixtureTree();
    try {
      const r = runCli(["migrate", "--dry-run", "--path", root]);
      expect(r.exitCode).toBe(0);
      const data = migrationData(r);
      expect(data.message).toContain("dry-run");
      expect(data.validationWarnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("poisoned v1 row (missing plan-row title) → dry-run warns with the apply-time validator code", () => {
    const root = fixtureTree();
    try {
      // The planner preserves rows verbatim; a row without `title` fails
      // validatePlanRow inside validateWorkflowSnapshot — the same check
      // writeWorkflowSnapshot applies fail-closed at apply time. Dry-run
      // must surface it as a warning instead of printing a clean plan.
      const statusPath = join(root, "status.json");
      const doc = readJsonFile(statusPath);
      const plans = doc.plans as Array<Record<string, unknown>>;
      delete plans[0]!.title;
      writeFileSync(statusPath, JSON.stringify(doc, null, 2));

      const r = runCli(["migrate", "--dry-run", "--path", root]);
      expect(r.exitCode).toBe(0);
      const data = migrationData(r);
      expect((data.validationWarnings as string[])[0]).toContain("status.plan-row.missing-title");
      // zero writes even when warnings are present
      expect(existsSync(join(root, "archived", "status.v1.json"))).toBe(false);

      const j = runCli(["migrate", "--dry-run", "--path", root, "--json"]);
      expect(j.exitCode).toBe(0);
      const validationWarnings = migrationData(j).validationWarnings as string[];
      expect(validationWarnings.length).toBeGreaterThan(0);
      expect(validationWarnings[0]).toContain("status.plan-row.missing-title");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar migrate — real run", () => {
  test("converts the v1 fixture to a v2 tree while keeping roadmap seeds transport-only", () => {
    const root = fixtureTree();
    try {
      const v1Before = readJsonFile(join(root, "status.json"));
      const r = runCli(["migrate", "--path", root]);
      expect(r.exitCode).toBe(0);
      const data = migrationData(r);
      expect(data.message).toContain("migrated");
      const roadmapCandidate = data.roadmapCandidate as { file: string; source: string; content: string };
      expect(roadmapCandidate).toMatchObject({ file: "projects/_default/roadmap.md", source: "status.json metadata.program_roadmap" });
      expect(roadmapCandidate.content).toContain("- pi/dsh adapters (host APIs unknown)");

      const rootDoc = readJsonFile(join(root, "status.json"));
      expect(rootDoc).toEqual({ version: 2, updated_at: "2026-08-19", workflows: [] });
      expect(readJsonFile(join(root, "archived", "status.v1.json"))).toEqual(v1Before);

      const workflows = readdirSync(join(root, "workflows"));
      expect(workflows).toHaveLength(29);
      // Deterministic set check: 19 iteration snapshots + 10 standalone
      // plan snapshots (ids sorted; readdirSync order is FS-dependent).
      expect([...workflows].sort()).toEqual([
        "00000717-kimi-host",
        "00000722-iter-wt-lease",
        "00000728-zero-residual",
        "00000807-agent-plugins-v1",
        "00000808-omp-inprocess-binding",
        "00000809-omp-engine-compat-hotfix",
        "00000811-code-reviewer-role",
        "00000811-gitignore-default-ignore",
        "00000816-mechanical-verification",
        "00000817-cli-bin-alias",
        "iter-0000-fixture-zero-plan",
        "iter-00000809-dsh-workflow-viz",
        "iter-00000809-harness-root-fix",
        "iter-00000809-mstar-panel-beautify",
        "iter-00000810-panel-fix-agentflow",
        "iter-00000810-panel-zones",
        "iter-00000811-panel-f4",
        "iter-00000811-panel-fixes",
        "iter-00000812-sync-v211-panel-f5",
        "iter-00000814-fallbacks-integration",
        "iter-00000815-dsh-skills-adoption",
        "iter-00000815-fallbacks-personas-workflow",
        "iter-00000816-audit-mechanical-alignment",
        "iter-00000816-dsh-inspect-adoption",
        "iter-00000816-dsh-seeds-bridges",
        "iter-00000817-dsh-cli-roles",
        "v2.0.0",
        "v2.1.0",
        "v3.0.0",
      ]);
      expect(existsSync(join(root, "workflows", "v3.0.0", "snapshot.json"))).toBe(true);

      expect(existsSync(join(root, "projects", "_default", "roadmap.md"))).toBe(false);
      // empty residual_findings -> no register file
      expect(existsSync(join(root, "projects", "_default", "residuals.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-run is an idempotent no-op and changes nothing", () => {
    const root = fixtureTree();
    try {
      expect(runCli(["migrate", "--path", root]).exitCode).toBe(0);
      const afterFirst = treeFiles(root);
      const second = runCli(["migrate", "--path", root]);
      expect(second.exitCode).toBe(0);
      const data = migrationData(second);
      expect(data.message).toContain("no-op");
      expect(data.alreadyMigrated).toBe(true);
      expect(treeFiles(root)).toEqual(afterFirst);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar migrate — exit codes", () => {
  test("missing v1 status.json is plan-invalid (exit 1)", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-cli-nov1-"));
    try {
      const r = runCli(["migrate", "--path", root]);
      expect(r.exitCode).toBe(1);
      const response = envelopeOf(r, "refused", "coordination.check-refused");
      expect(response.details).toMatchObject({ underlyingCode: "migrate.refused" });
      expect(response.message).toContain("no v1 status.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unrecognized schema version is plan-invalid (exit 1)", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-cli-badver-"));
    try {
      writeFileSync(join(root, "status.json"), JSON.stringify({ version: 99 }));
      const r = runCli(["migrate", "--path", root]);
      expect(r.exitCode).toBe(1);
      const response = envelopeOf(r, "refused", "coordination.check-refused");
      expect(response.details).toMatchObject({ underlyingCode: "migrate.refused" });
      expect(response.message).toContain("unrecognized schema version");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply failure exits 2 and leaves the v1 root intact (commit point)", () => {
    const root = fixtureTree();
    try {
      // Block the additive snapshot writes deterministically: `workflows`
      // as a FILE makes the recursive mkdir of workflows/<id> throw
      // mid-apply (ENOTDIR) — the root v2 replacement never runs.
      writeFileSync(join(root, "workflows"), "not a directory");
      const r = runCli(["migrate", "--path", root]);
      expect(r.exitCode).toBe(2);
      // rolled back: root status.json is still v1; the v1 archive landed
      expect(readJsonFile(join(root, "status.json")).version).toBe(1);
      expect(envelopeOf(r, "error", "migrate.apply-failure").code).toBe("migrate.apply-failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mid-snapshot apply failure then re-run converges", () => {
    const root = fixtureTree();
    try {
      // Fail AFTER ≥1 snapshot write: a FILE at a late-sorted workflow id
      // makes mkdir of that snapshot's dir throw (EEXIST), after the
      // earlier snapshots already landed — the existing test only covers
      // the pre-snapshot partial state (workflows as a file).
      const workflowsDir = join(root, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      const blocker = join(workflowsDir, "iter-00000817-dsh-cli-roles");
      writeFileSync(blocker, "not a directory");

      const r = runCli(["migrate", "--path", root]);
      expect(r.exitCode).toBe(2);
      // Partial state: v1 root intact + archive landed + the FIRST sorted
      // snapshot written; the blocked snapshot and later ones absent.
      expect(envelopeOf(r, "error", "migrate.apply-failure").code).toBe("migrate.apply-failure");
      expect(existsSync(join(root, "archived", "status.v1.json"))).toBe(true);
      expect(existsSync(join(workflowsDir, "00000717-kimi-host", "snapshot.json"))).toBe(true);
      expect(existsSync(join(workflowsDir, "iter-00000817-dsh-cli-roles", "snapshot.json"))).toBe(false);
      expect(existsSync(join(workflowsDir, "v3.0.0", "snapshot.json"))).toBe(false);

      // Remove the blocker and re-run: the deterministic plan converges by
      // overwrite (additive-first, same destinations).
      rmSync(blocker);
      const second = runCli(["migrate", "--path", root]);
      expect(second.exitCode).toBe(0);
      expect(readJsonFile(join(root, "status.json")).version).toBe(2);
      expect(readdirSync(workflowsDir)).toHaveLength(29);
      expect(existsSync(join(workflowsDir, "iter-00000817-dsh-cli-roles", "snapshot.json"))).toBe(true);
      expect(existsSync(join(workflowsDir, "v3.0.0", "snapshot.json"))).toBe(true);
      // Converged re-run is idempotent.
      const third = runCli(["migrate", "--path", root]);
      expect(third.exitCode).toBe(0);
      expect(migrationData(third).message).toContain("no-op");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar migrate --json — machine-readable output", () => {
  test("dry-run shape: ok/dryRun/steps/message, root v2 replacement last", () => {
    const root = fixtureTree();
    try {
      const r = runCli(["migrate", "--dry-run", "--path", root, "--json"]);
      expect(r.exitCode).toBe(0);
      const doc = migrationData(r);
      expect(doc.root).toBe(root);
      expect(doc.dryRun).toBe(true);
      expect(doc.alreadyMigrated).toBe(false);
      expect(doc.applied).toBe(false);
      expect(typeof doc.message).toBe("string");
      expect(Array.isArray(doc.steps)).toBe(true);
      const candidate = doc.roadmapCandidate as { file: string; source: string; content: string };
      expect(candidate.file).toBe("projects/_default/roadmap.md");
      expect(candidate.source).toBe("status.json metadata.program_roadmap");
      expect(candidate.content).toContain("- pi/dsh adapters (host APIs unknown)");
      const steps = doc.steps as { kind: string; source: string; destination: string }[];
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]!.kind).toBe("archive-status-v1");
      expect(steps[steps.length - 1]!.kind).toBe("replace-root-v2");
      for (const step of steps) {
        expect(typeof step.source).toBe("string");
        expect(typeof step.destination).toBe("string");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("real-run shape: applied true; re-run no-op shape: alreadyMigrated true, zero steps", () => {
    const root = fixtureTree();
    try {
      const first = migrationData(runCli(["migrate", "--path", root, "--json"]));
      expect(first.applied).toBe(true);
      expect(first.alreadyMigrated).toBe(false);
      const steps = first.steps as { kind: string; source: string; destination: string }[];
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]!.kind).toBe("archive-status-v1");
      expect(steps[steps.length - 1]!.kind).toBe("replace-root-v2");
      for (const step of steps) {
        expect(typeof step.source).toBe("string");
        expect(typeof step.destination).toBe("string");
      }

      const second = migrationData(runCli(["migrate", "--path", root, "--json"]));
      expect(second.applied).toBe(false);
      expect(second.alreadyMigrated).toBe(true);
      expect(second.steps).toEqual([]);
      expect(String(second.message)).toContain("no-op");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failure shape: ok false with phase + exitCode", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-cli-jsonfail-"));
    try {
      const r = runCli(["migrate", "--path", root, "--json"]);
      expect(r.exitCode).toBe(1);
      const response = envelopeOf(r, "refused", "coordination.check-refused");
      expect(response.details).toMatchObject({ underlyingCode: "migrate.refused" });
      expect(response.exitCode).toBe(1);
      expect(typeof response.message).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Delivery kind for ACTIVE standalone plan lifts (plan-workflow-lifecycle-
 * contract §1/§4a): a v1 `plans[]` row lifts into a live `type: plan`
 * lifecycle, so its kind is a caller-declared input — the lift refuses as
 * usage (exit 2) when it would create an active kind-less plan snapshot, and
 * the declared kind + anchors land on the lifted snapshot.
 */
describe("mstar migrate — delivery kind for ACTIVE standalone plan lifts", () => {
  const ACTIVE_ID = "00000819-fixture-standalone-active";
  const SECOND_ACTIVE_ID = "00000820-fixture-standalone-active-2";

  /** The v1 fixture plus one ACTIVE (InProgress -> running) standalone plan row. */
  function activeRowTree(): string {
    const root = fixtureTree();
    const statusPath = join(root, "status.json");
    const doc = readJsonFile(statusPath);
    const plans = (doc.plans as Array<Record<string, unknown>>).concat([
      {
        id: ACTIVE_ID,
        file: `.mstar/plans/${ACTIVE_ID}.md`,
        title: "Fixture standalone active row",
        status: "InProgress",
        created_at: "2026-08-19",
      },
    ]);
    doc.plans = plans;
    writeFileSync(statusPath, JSON.stringify(doc, null, 2), "utf8");
    return root;
  }

  /** The v1 fixture plus TWO ACTIVE standalone plan rows (distinct plans). */
  function twoActiveRowTree(): string {
    const root = activeRowTree();
    const statusPath = join(root, "status.json");
    const doc = readJsonFile(statusPath);
    doc.plans = (doc.plans as Array<Record<string, unknown>>).concat([
      {
        id: SECOND_ACTIVE_ID,
        file: `.mstar/plans/${SECOND_ACTIVE_ID}.md`,
        title: "Fixture standalone active row 2",
        status: "Todo",
        created_at: "2026-08-20",
      },
    ]);
    writeFileSync(statusPath, JSON.stringify(doc, null, 2), "utf8");
    return root;
  }

  test("without --delivery-kind the ACTIVE lift is refused as usage (exit 2, zero writes)", () => {
    const root = activeRowTree();
    try {
      const before = treeFiles(root);
      const refused = runCli(["migrate", "--path", root]);
      expect(refused.exitCode).toBe(2);
      const response = envelopeOf(refused, "usage", "command.invalid-input");
      expect(response.message).toContain("would be lifted without a declared delivery kind");
      expect(response.message).toContain(ACTIVE_ID);
      expect(treeFiles(root)).toEqual(before);

      const declared = runCli([
        "migrate", "--path", root,
        "--delivery-kind", "development", "--branch-source", "feature/standalone", "--branch-target", "main",
      ]);
      expect(declared.exitCode).toBe(0);
      const snapshot = readJsonFile(join(root, "workflows", ACTIVE_ID, "snapshot.json"));
      expect(snapshot.status).toBe("running");
      expect(snapshot.delivery_kind).toBe("development");
      expect(snapshot.branch).toEqual({ source: "feature/standalone", target: "main" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an incoherent declaration is plan-invalid (exit 1): development needs both anchors", () => {
    const root = activeRowTree();
    try {
      const r = runCli(["migrate", "--path", root, "--delivery-kind", "development", "--branch-source", "feature/a"]);
      expect(r.exitCode).toBe(1);
      const response = envelopeOf(r, "refused", "coordination.check-refused");
      expect(response.details).toMatchObject({ underlyingCode: "migrate.refused" });
      expect(response.message).toContain("delivery source and target branches");
      expect(existsSync(join(root, "workflows"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one declaration for 2+ ACTIVE standalone lifts is refused as usage (exit 2, ids listed, zero writes)", () => {
    const root = twoActiveRowTree();
    try {
      const before = treeFiles(root);
      const args = [
        "migrate", "--path", root,
        "--delivery-kind", "development", "--branch-source", "feature/standalone", "--branch-target", "main",
      ];
      const refused = runCli(args);
      expect(refused.exitCode).toBe(2);
      const response = envelopeOf(refused, "usage", "command.invalid-input");
      expect(response.message).toContain("a single delivery declaration cannot describe 2 active standalone plan lifts");
      expect(response.message).toContain(ACTIVE_ID);
      expect(response.message).toContain(SECOND_ACTIVE_ID);
      expect(response.message).toContain("batches of one declared plan");
      expect(treeFiles(root)).toEqual(before);

      // The JSON shape keeps the plan-phase contract for the refusal.
      const json = runCli([...args, "--json"]);
      expect(json.exitCode).toBe(2);
      const failure = envelopeOf(json, "usage", "command.invalid-input");
      expect(failure.message).toContain(SECOND_ACTIVE_ID);
      expect(treeFiles(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
