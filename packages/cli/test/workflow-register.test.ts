/**
 * CLI `mstar workflow register` — ACTIVE catalog-backed registration.
 *
 * Every case runs the real CLI as a subprocess against an isolated temporary
 * harness. Registration is asserted through the store, never file transports.
 */
import { initializeStore, readExecutionAuthority } from "@mstar-harness/engine";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = resolve(import.meta.dir, "../src/index.ts");
const WORKFLOW_ID = "20260916-plan-register-cli";
const SESSION_ID = "registration-cli-session";

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
  if (result.stdout.trim() === "") {
    throw new Error(`CLI emitted no JSON envelope (exit ${result.exitCode}); stderr: ${result.stderr}`);
  }
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
    "--session-id",
    SESSION_ID,
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
  const store = await initializeStore({ harnessDir: harness });
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

async function readWorkflows(harnessDir: string) {
  const authority = await readExecutionAuthority({ harnessDir });
  if (!("workflows" in authority.data)) throw new Error("ACTIVE workflow view is unavailable");
  return authority.data.workflows;
}

describe("mstar workflow register", () => {
  test("registers a standalone development plan through the ACTIVE shipped route without explicit CAS inputs", async () => {
    await setupHarness(async (harness, { root, snapshot }) => {
      const result = runCli(registerArgs(harness));
      expect(commandOutput(result)).toMatchObject({
        status: "ok",
        code: "workflow.register.ok",
        exitCode: 0,
        data: { workflowId: WORKFLOW_ID },
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(snapshot)).toBe(false);

      const workflows = await readWorkflows(harness);
      expect(workflows).toHaveLength(1);
      expect(workflows[0]?.plans.map((view) => view.plan.id)).toEqual(["20260916-plan-cli-example"]);
    });
  });

  test("an identical retry without an explicit operation replays the shipped registration", async () => {
    await setupHarness(async (harness) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const retry = runCli(registerArgs(harness));
      expect(retry.exitCode).toBe(0);
      expect(commandOutput(retry)).toMatchObject({ status: "ok", code: "workflow.register.ok" });
      expect(await readWorkflows(harness)).toHaveLength(1);
    });
  });

  test("an explicit operation and current root token constrain a new shipped registration", async () => {
    await setupHarness(async (harness) => {
      const authority = await readExecutionAuthority({ harnessDir: harness });
      const rootToken = authority.token;
      const result = runCli(registerArgs(harness, ["--expect", rootToken, "--operation", "cli-explicit-registration"]));
      expect(result.exitCode).toBe(0);
      expect(commandOutput(result)).toMatchObject({ status: "ok", code: "workflow.register.ok" });
      expect((await readWorkflows(harness))[0]?.plans.map((view) => view.plan.id))
        .toEqual(["20260916-plan-cli-example"]);
    });
  });

  test("records delivery evidence through the ACTIVE route under the bound session identity", async () => {
    await setupHarness(async (harness) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const read = await readExecutionAuthority({ harnessDir: harness }, { workflowId: WORKFLOW_ID });
      if (!("workflows" in read.data)) throw new Error("workflow registration did not produce an execution workflow view");
      const workflow = read.data.workflows.find((entry) => entry.state.id === WORKFLOW_ID);
      if (workflow === undefined) throw new Error("registered workflow was absent from the execution view");

      const bound = runCli([
        "plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator",
        "--expect", workflow.workflowToken, "--operation", "bind-registration-cli",
        "--harness", harness, "--session-id", SESSION_ID,
      ]);
      expect(bound.exitCode).toBe(0);

      const evidenceFile = join(harness, "delivery.json");
      writeFileSync(evidenceFile, JSON.stringify({ compound: { outcome: "updated" } }));
      const evidence = runCli([
        "workflow", "evidence", "--workflow", WORKFLOW_ID, "--file", evidenceFile,
        "--harness", harness, "--expect", workflow.workflowToken,
        "--operation", "evidence-registration-cli", "--session-id", SESSION_ID,
      ]);
      expect(evidence.exitCode).toBe(0);
      expect(commandOutput(evidence)).toMatchObject({ status: "ok", code: "workflow.evidence.ok" });

      const after = await readExecutionAuthority({ harnessDir: harness }, { workflowId: WORKFLOW_ID });
      if (!("workflows" in after.data)) throw new Error("workflow evidence read did not return a workflow view");
      expect(after.data.workflows.find((entry) => entry.state.id === WORKFLOW_ID)?.state.delivery)
        .toEqual({ compound: { outcome: "updated" } });
    });
  });

  test("mismatched declared title returns the typed constraint refusal verbatim", async () => {
    await setupHarness((harness) => {
      const args = registerArgs(harness);
      args[args.indexOf("--plan-title") + 1] = "Contradictory title";
      const result = runCli([...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(commandOutput(result)).toMatchObject({ status: "refused", code: "workflow.register.title-constraint", exitCode: 1 });
      expect(commandMessage(result)).toContain("the selected plan document is the registration authority");
    });
  });

  test("development registration without branches refuses before writing a catalog binding", async () => {
    await setupHarness(async (harness) => {
      const args = registerArgs(harness);
      const noBranches: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--branch-source" || args[i] === "--branch-target") i++;
        else noBranches.push(args[i]!);
      }
      const result = runCli(noBranches);
      expect(result.exitCode).toBe(1);
      expect(commandOutput(result).status).toBe("refused");
      expect((await readWorkflows(harness)).map((workflow) => workflow.state.id)).toEqual([]);
    });
  });

  test("verification/report-only registration requires completion policy and succeeds without branches", async () => {
    await setupHarness(async (harness) => {
      const withoutPolicy = runCli([
        "workflow", "register", "--workflow", WORKFLOW_ID, "--plan-id", "20260916-plan-verify",
        "--plan-title", "Verification plan", "--plan-file", "plans/20260916-plan-verify.md",
        "--delivery-kind", "verification/report-only", "--completion-policy", "", "--harness", harness,
      ]);
      expect(withoutPolicy.exitCode).not.toBe(0);
      expect(["usage", "refused"]).toContain(commandOutput(withoutPolicy).status);

      const result = runCli([
        "workflow", "register", "--workflow", WORKFLOW_ID, "--plan-id", "20260916-plan-verify",
        "--plan-title", "Verification plan", "--plan-file", "plans/20260916-plan-verify.md",
        "--delivery-kind", "verification/report-only", "--completion-policy",
        "acceptance report at plans/20260916-plan-verify/report.md", "--harness", harness,
      ]);
      expect(result.exitCode).toBe(0);
      expect(commandOutput(result)).toMatchObject({ status: "ok", code: "workflow.register.ok" });
      expect((await readWorkflows(harness))[0]?.plans.map((view) => view.plan.id))
        .toEqual(["20260916-plan-verify"]);
    });
  });

  test("missing required flags and unknown delivery kind are usage errors", async () => {
    await setupHarness((harness) => {
      const missing = runCli(["workflow", "register", "--workflow", WORKFLOW_ID, "--harness", harness]);
      expect(commandOutput(missing).status).toBe("usage");
      expect(commandMessage(missing)).toContain("planId");
      const unknown = runCli(registerArgs(harness, ["--delivery-kind", "stealth"]));
      expect(commandOutput(unknown).status).toBe("usage");
      expect(commandMessage(unknown)).toContain("development | verification/report-only");
    });
  });

  test("hostile workflow id is rejected by the shared id guard", async () => {
    await setupHarness((harness) => {
      const result = runCli(registerArgs(harness, ["--workflow", "../escape"]));
      expect(result.exitCode).toBe(1);
      expect(commandOutput(result).status).toBe("refused");
      expect(commandMessage(result)).toContain("single safe path component");
      expect(existsSync(join(harness, "escape"))).toBe(false);
    });
  });

  test("retired workflow verbs refuse with cause and supported replacement", () => {
    for (const [verb, replacement] of [
      ["show-prepare", "mstar plan prepare"],
      ["amend-prepare", "mstar plan prepare"],
      ["recover-coordinator", "mstar session recover"],
    ] as const) {
      const result = runCli(["workflow", verb, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(commandOutput(result)).toMatchObject({ status: "refused", code: "workflow.verb-retired" });
      expect(commandMessage(result).toLowerCase()).toContain("pre-activation");
      expect(commandMessage(result)).toContain(replacement);
    }
  });

  test("workflow evidence help no longer exposes pre-activation inputs", () => {
    const help = runCli(["workflow", "evidence", "--help"]);
    expect(help.exitCode).toBe(0);
    for (const retired of ["--declare-kind", "--session ", "--at "]) {
      expect(help.stdout).not.toContain(retired);
    }
    expect(help.stdout).toContain("--session-ref");
    expect(help.stdout).toContain("--expect");
    expect(help.stdout).toContain("--operation");
  });
});
