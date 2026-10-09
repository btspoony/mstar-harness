/**
 * CLI `mstar workflow register` — the generic standalone-plan registration
 * producer (mstar-artifacts/references/plan-workflow-lifecycle-contract.md seam S1; engine-backed).
 *
 * Thin wrapper over engine `registerPlanWorkflow` (create-only `type: plan`
 * snapshot + root `workflows[]` entry under one lock).
 * Contract pinned here:
 * - exit 0: a standalone development plan registers before execution — the
 *   root entry appears in `status.json`, the snapshot lands on disk with the
 *   recorded delivery kind / project / branches / single Todo plan row, and
 *   both documents pass `mstar status validate`.
 * - exit 1: a different registration for an existing workflow id refuses;
 *   development registration without branches and verification registration
 *   without a completion policy refuse before any write; a hostile workflow
 *   id is rejected by the shared guard.
 * - exit 2: usage — missing required flags, an unknown delivery kind.
 * - a verification/report-only workflow registers without branch fields,
 *   recording its completion policy instead.
 *
 * Every case runs the real CLI as a subprocess against an isolated temp
 * fixture harness — no live harness is ever touched.
 */
import { describe, expect, test } from "bun:test";
import { initializeStore, listPendingCatalogRegistrations, resolveCatalogRegistrationState, type StoreContext } from "@mstar-harness/engine";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

function commandOutput(result: RunResult): Record<string, unknown> {
  const value: unknown = JSON.parse(result.stdout);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected a command envelope on stdout, received ${JSON.stringify(result.stdout)}`);
  }
  return value as Record<string, unknown>;
}

function commandMessage(result: RunResult): string {
  const message = commandOutput(result).message;
  if (typeof message !== "string") throw new Error(`command envelope has no message: ${result.stdout}`);
  return message;
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
async function setupHarness(fn: (harness: string, paths: { root: string; snapshot: string }) => void | Promise<void>): Promise<void> {
  const harness = mkdtempSync(join(tmpdir(), "mstar-workflow-register-"));
  // The registration derives id/title from the SELECTED DOCUMENT (the plan
  // document is the registered title source), so the declared plan file must
  // exist and declare the registered title.
  mkdirSync(join(harness, "plans"), { recursive: true });
  writeFileSync(join(harness, "plans", "20260916-plan-cli-example.md"), "# CLI example plan\n\n**plan_id:** 20260916-plan-cli-example\n");
  writeFileSync(join(harness, "plans", "20260916-plan-verify.md"), "# Verification plan\n\n**plan_id:** 20260916-plan-verify\n");
  // These cases pin the pre-activation file transport contract. Store
  // initialization now activates execution authority, so explicitly restore
  // legacy state for this fixture instead of exercising the ACTIVE route.
  const store = await initializeStore({ harnessDir: harness });
  store.db.prepare("update execution_meta set authority_state = 'legacy' where id = 1").run();
  store.close();
  try {
    await fn(harness, {
      root: join(harness, "status.json"),
      snapshot: join(harness, "workflows", WORKFLOW_ID, "snapshot.json"),
    });
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
}

describe("mstar workflow register", () => {
  test("mismatched declared title returns the typed constraint refusal verbatim", async () => {
    await setupHarness((harness) => {
      const args = registerArgs(harness);
      args[args.indexOf("--plan-title") + 1] = "Contradictory title";
      const result = runCli([...args, "--json"]);
      expect(result.exitCode).toBe(1);
      const envelope = commandOutput(result);
      expect(envelope).toMatchObject({
        status: "refused",
        code: "workflow.register.title-constraint",
        exitCode: 1,
      });
      expect(String(envelope.message)).toContain(
        `derivePlanRegistration: plan "20260916-plan-cli-example" was declared with title "Contradictory title", but the selected document ${realpathSync(join(harness, "plans/20260916-plan-cli-example.md"))} states "CLI example plan" - the selected plan document is the registration authority (R1/section 4), so a supplied title is a constraint against it, never an override`,
      );
      expect(String(envelope.message)).toContain("the selected plan document is the registration authority");
      expect(String(envelope.message)).toContain("Help: mstar workflow register --help");
      expect(String(envelope.message)).toContain(
        "Recovery: Use the title in the selected plan document's H1, or correct that document before registering.",
      );
    });
  });
  test("registers a standalone development plan: root entry + snapshot on disk, both validate (exit 0)", async () => {
    await setupHarness((harness, { root, snapshot }) => {
      const result = runCli(registerArgs(harness));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const response = commandOutput(result);
      expect(response).toMatchObject({
        status: "ok",
        code: "workflow.register.ok",
        exitCode: 0,
      });
      expect(response.data).toMatchObject({ workflowId: WORKFLOW_ID });

      expect(existsSync(snapshot)).toBe(true);
      const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(doc).toMatchObject({
        schema_version: 1,
        id: WORKFLOW_ID,
        type: "plan",
        status: "running",
        delivery_kind: "development",
        project: "engine",
      });
      // `--branch-source` records the delivery branch on `branch.source`;
      // `branch.base` (protected base anchor: cleanup Rule 2 / L1 fallback)
      // stays unset.
      expect(doc.branch).toEqual({ source: "feature/20260916-plan-cli-example", target: "main" });
      expect(doc.plans).toEqual([
        { id: "20260916-plan-cli-example", title: "CLI example plan", file: realpathSync(join(harness, "plans/20260916-plan-cli-example.md")), status: "Todo" },
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

  test("success is advertised only after the committed catalog registration (contract §3)", async () => {
    await setupHarness(async (harness) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const context: StoreContext = { harnessDir: harness };
      const state = await resolveCatalogRegistrationState(context, WORKFLOW_ID);
      expect(state.pending).toBeNull();
      expect(state.binding).toMatchObject({ catalogKind: "plan", catalogId: "20260916-plan-cli-example" });
      expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    });
  });
  test("a distinct operation cannot register an already-registered workflow id", async () => {
    await setupHarness((harness, { root, snapshot }) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const beforeSnapshot = readFileSync(snapshot, "utf8");
      const beforeRoot = readFileSync(root, "utf8");

      const duplicate = runCli(registerArgs(harness));
      expect(duplicate.exitCode).toBe(1);
      expect(commandOutput(duplicate).status).toBe("refused");
      expect(commandMessage(duplicate)).toContain("[catalog.registration-conflict]");
      expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
      expect(readFileSync(root, "utf8")).toBe(beforeRoot);
    });
  });
  test("a distinct-operation retry after a lost root entry refuses without restoring bytes", async () => {
    await setupHarness((harness, { root, snapshot }) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const snapshotBytes = readFileSync(snapshot, "utf8");
      writeFileSync(root, JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [] }, null, 2));
      const lostRootBytes = readFileSync(root, "utf8");

      const retry = runCli(registerArgs(harness));
      expect(retry.exitCode).toBe(1);
      expect(commandOutput(retry).status).toBe("refused");
      expect(commandMessage(retry)).toContain("[catalog.registration-conflict]");
      expect(readFileSync(snapshot, "utf8")).toBe(snapshotBytes);
      expect(readFileSync(root, "utf8")).toBe(lostRootBytes);
    });
  });

  test("development registration without branches refuses before any write (exit 1)", async () => {
    await setupHarness((harness, { root, snapshot }) => {
      const args = registerArgs(harness);
      const noBranches: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--branch-source" || args[i] === "--branch-target") i++;
        else noBranches.push(args[i]!);
      }
      const result = runCli(noBranches);
      expect(result.exitCode).toBe(1);
      expect(commandOutput(result).status).toBe("refused");
      expect(commandMessage(result)).toContain("incomplete registration");
      // Refusal before any write — no partial activation.
      expect(existsSync(snapshot)).toBe(false);
      expect(existsSync(root)).toBe(false);
    });
  });

  test("verification/report-only registers without branches but requires the completion policy", async () => {
    await setupHarness((harness, { root, snapshot }) => {
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
      const response = commandOutput(withoutPolicy);
      expect(withoutPolicy.exitCode).not.toBe(0);
      expect(["usage", "refused"]).toContain(response.status);
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

  test("missing required flags are a usage error (exit 2)", async () => {
    await setupHarness((harness) => {
      const result = runCli(["workflow", "register", "--workflow", WORKFLOW_ID, "--harness", harness]);
      const response = commandOutput(result);
      expect(response.status).toBe("usage");
      expect(commandMessage(result)).toContain("planId");
    });
  });

  test("unknown delivery kind is a usage error (exit 2)", async () => {
    await setupHarness((harness) => {
      const result = runCli(registerArgs(harness, ["--delivery-kind", "stealth"]));
      expect(commandOutput(result).status).toBe("usage");
      expect(commandMessage(result)).toContain("--delivery-kind");
      expect(commandMessage(result)).toContain("development | verification/report-only");
      expect(commandMessage(result)).toContain("stealth");
    });
  });

  test("hostile workflow id is rejected by the shared id guard (exit 1)", async () => {
    await setupHarness((harness) => {
      const result = runCli(registerArgs(harness, ["--workflow", "../escape"]));
      expect(result.exitCode).toBe(1);
      expect(commandOutput(result).status).toBe("refused");
      expect(commandMessage(result)).toContain("single safe path component");
      expect(existsSync(join(harness, "escape"))).toBe(false);
    });
  });

});
