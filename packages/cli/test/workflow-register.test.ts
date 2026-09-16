/**
 * CLI `mstar workflow register` — the generic standalone-plan registration
 * producer (plan-workflow-lifecycle-contract seam S1; engine-backed).
 *
 * Thin wrapper over engine `registerPlanWorkflow` (create-only `type: plan`
 * snapshot + root `workflows[]` entry under one lock, mirroring the
 * audit-promotion primitive sequence). Contract pinned here:
 * - exit 0: a standalone development plan registers before execution — the
 *   root entry appears in `status.json`, the snapshot lands on disk with the
 *   recorded delivery kind / project / branches / single Todo plan row, and
 *   both documents pass `mstar status validate`.
 * - exit 1: a duplicate registration refuses fail-loud with NO byte change
 *   (snapshot AND root); a development registration without branches and a
 *   verification registration without a completion policy refuse before any
 *   write; a hostile workflow id is rejected by the shared guard.
 * - exit 2: usage — missing required flags, an unknown delivery kind.
 * - a verification/report-only workflow registers without branch fields,
 *   recording its completion policy instead (contract §1 — no implicit
 *   escape hatch, an explicit recorded policy).
 *
 * Every case runs the real CLI as a subprocess against an isolated temp
 * fixture harness — no live harness is ever touched.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW_ID = "20260916-plan-register-cli";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn env with ambient harness env vars pinned out: the CLI
 * resolves harness dirs from MSTAR_HARNESS_DIR / MSTAR_CONTROL_ROOT ahead
 * of probing, and SDD_DIR redirects default outfile paths — ambient values
 * would redirect every fixture spuriously.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function registerArgs(harness: string, extra: string[] = []): string[] {
  return [
    "workflow",
    "register",
    "--workflow",
    WORKFLOW_ID,
    "--plan-id",
    "20260916-plan-cli-example",
    "--plan-title",
    "CLI example plan",
    "--plan-file",
    "plans/20260916-plan-cli-example.md",
    "--delivery-kind",
    "development",
    "--project",
    "engine",
    "--branch-source",
    "feature/20260916-plan-cli-example",
    "--branch-target",
    "main",
    "--started-at",
    "2026-09-16T00:00:00.000Z",
    "--harness",
    harness,
    ...extra,
  ];
}

/** Temp fixture harness; returns paths plus a byte-snapshot helper. */
function setupHarness(fn: (harness: string, paths: { root: string; snapshot: string }) => void): void {
  const harness = mkdtempSync(join(tmpdir(), "mstar-workflow-register-"));
  try {
    fn(harness, {
      root: join(harness, "status.json"),
      snapshot: join(harness, "workflows", WORKFLOW_ID, "snapshot.json"),
    });
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
}

describe("mstar workflow register", () => {
  test("registers a standalone development plan: root entry + snapshot on disk, both validate (exit 0)", () => {
    setupHarness((harness, { root, snapshot }) => {
      const result = runCli(registerArgs(harness));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`workflow register: OK \u2014 ${WORKFLOW_ID} registered`);
      expect(result.stdout).toContain(snapshot);

      expect(existsSync(snapshot)).toBe(true);
      const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(doc).toMatchObject({
        schema_version: 1,
        id: WORKFLOW_ID,
        type: "plan",
        status: "running",
        delivery_kind: "development",
        project: "engine",
        branch: { source: "feature/20260916-plan-cli-example", target: "main" },
      });
      expect(doc.plans).toEqual([
        { id: "20260916-plan-cli-example", title: "CLI example plan", file: "plans/20260916-plan-cli-example.md", status: "Todo" },
      ]);

      const rootDoc = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootDoc.workflows).toEqual([
        { id: WORKFLOW_ID, type: "plan", started_at: "2026-09-16T00:00:00.000Z", dir: `workflows/${WORKFLOW_ID}` },
      ]);

      // Product contract: both registered documents validate (exit 0).
      expect(runCli(["status", "validate", root]).exitCode).toBe(0);
      expect(runCli(["status", "validate", snapshot]).exitCode).toBe(0);
    });
  });

  test("duplicate registration refuses fail-loud without mutating bytes (exit 1)", () => {
    setupHarness((harness, { root, snapshot }) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const beforeSnapshot = readFileSync(snapshot, "utf8");
      const beforeRoot = readFileSync(root, "utf8");

      const duplicate = runCli(registerArgs(harness));
      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr).toContain("already registered");
      expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
      expect(readFileSync(root, "utf8")).toBe(beforeRoot);
    });
  });

  test("development registration without branches refuses before any write (exit 1)", () => {
    setupHarness((harness, { root, snapshot }) => {
      const args = registerArgs(harness);
      const noBranches: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--branch-source" || args[i] === "--branch-target") i++;
        else noBranches.push(args[i]!);
      }
      const result = runCli(noBranches);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("incomplete registration");
      // Refusal before any write — no partial activation.
      expect(existsSync(snapshot)).toBe(false);
      expect(existsSync(root)).toBe(false);
    });
  });

  test("verification/report-only registers without branches but requires the completion policy", () => {
    setupHarness((harness, { root, snapshot }) => {
      // Without the policy: refusal (exit 1), nothing written — the engine
      // refuses a verification/report-only registration whose policy is empty.
      const withoutPolicy = runCli([
        "workflow",
        "register",
        "--workflow",
        WORKFLOW_ID,
        "--plan-id",
        "20260916-plan-verify",
        "--plan-title",
        "Verification plan",
        "--plan-file",
        "plans/20260916-plan-verify.md",
        "--delivery-kind",
        "verification/report-only",
        "--completion-policy",
        "",
        "--harness",
        harness,
      ]);
      expect(withoutPolicy.exitCode).toBe(1);
      expect(withoutPolicy.stderr).toContain("--completion-policy");
      expect(existsSync(snapshot)).toBe(false);
      expect(existsSync(root)).toBe(false);

      // With the policy: registration succeeds without any branch fields.
      const result = runCli([
        "workflow",
        "register",
        "--workflow",
        WORKFLOW_ID,
        "--plan-id",
        "20260916-plan-verify",
        "--plan-title",
        "Verification plan",
        "--plan-file",
        "plans/20260916-plan-verify.md",
        "--delivery-kind",
        "verification/report-only",
        "--completion-policy",
        "acceptance report at plans/20260916-plan-verify/report.md",
        "--started-at",
        "2026-09-16T00:00:00.000Z",
        "--harness",
        harness,
      ]);
      expect(result.exitCode).toBe(0);
      const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(doc.delivery_kind).toBe("verification/report-only");
      expect(doc.completion_policy).toBe("acceptance report at plans/20260916-plan-verify/report.md");
      expect(doc.branch).toBeUndefined();
      expect((JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>).workflows).toHaveLength(1);
    });
  });

  test("missing required flags are a usage error (exit 2)", () => {
    setupHarness((harness) => {
      const result = runCli(["workflow", "register", "--workflow", WORKFLOW_ID, "--harness", harness]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("missing required option(s)");
      expect(result.stderr).toContain("--plan-id");
    });
  });

  test("unknown delivery kind is a usage error (exit 2)", () => {
    setupHarness((harness) => {
      const result = runCli(registerArgs(harness, ["--delivery-kind", "stealth"]));
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--delivery-kind must be one of");
    });
  });

  test("hostile workflow id is rejected by the shared id guard (exit 1)", () => {
    setupHarness((harness) => {
      const result = runCli(registerArgs(harness, ["--workflow", "../escape"]));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid workflow id");
      expect(existsSync(join(harness, "escape"))).toBe(false);
    });
  });

  test("crash recovery: an orphan snapshot from a lost root write is adopted without byte changes (exit 0)", () => {
    setupHarness((harness, { root, snapshot }) => {
      // Round 1: a successful registration whose root write is then lost
      // (simulating the crash between snapshot creation and registration).
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const orphanBytes = readFileSync(snapshot, "utf8");
      const orphan = JSON.parse(orphanBytes) as Record<string, unknown>;
      const { started_at: orphanStartedAt } = orphan;
      writeFileSync(root, JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [] }, null, 2));

      // Round 2: re-running the verb completes the registration and reports
      // the recovery; the snapshot bytes are preserved verbatim.
      const retry = runCli(registerArgs(harness));
      expect(retry.exitCode).toBe(0);
      expect(retry.stdout).toContain("recovered");
      expect(readFileSync(snapshot, "utf8")).toBe(orphanBytes);
      const rootDoc = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootDoc.workflows).toEqual([{ id: WORKFLOW_ID, type: "plan", started_at: orphanStartedAt, dir: `workflows/${WORKFLOW_ID}` }]);
    });
  });
});
