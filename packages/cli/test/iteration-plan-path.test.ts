/**
 * CLI `mstar iteration register` — active registration input contract plus the
 * registered-plan path resolver contract.
 *
 * The CLI test uses a real active harness and a valid row registration payload;
 * the resolver cases call the engine's shared resolver directly, which is the
 * contract that canonicalizes absolute and harness-relative plan pointers.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  initializeExecutionAuthority,
  initializeStore,
  readExecutionAuthority,
  resolveRegisteredPlanFile,
  serializeExecutionValue,
  type ExecutionIdentity,
  type StoreContext,
} from "@mstar-harness/engine";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const PLAN_ID = "20260918-plan-alpha";
const COMPASS_REF = "iterations/20260918-iteration-plan-path/delivery-compass.md";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn env with ambient harness env vars pinned out (see iteration-register). */
function cliEnv(harness: string, identity: ExecutionIdentity): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (key === "MSTAR_EXECUTION_IDENTITY") continue;
    if (value !== undefined) env[key] = value;
  }
  env.MSTAR_HARNESS_DIR = harness;
  env.MSTAR_EXECUTION_IDENTITY = serializeExecutionValue(identity);
  return env;
}

function runCli(args: string[], harness: string, identity: ExecutionIdentity): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: harness,
    env: cliEnv(harness, identity),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function identityFor(workflowId: string): ExecutionIdentity {
  return { source: "local", sessionId: `coord-${workflowId}`, workflowId, role: "coordinator", planId: null };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}


async function rootToken(harness: string): Promise<string> {
  return (await readExecutionAuthority({ harnessDir: harness })).token;
}

function registerArgs(harness: string, workflowId: string, file: string, token: string): string[] {
  return [
    "iteration",
    "register",
    "--workflow",
    workflowId,
    "--compass-ref",
    COMPASS_REF,
    "--branch-base",
    "main",
    "--branch-integration",
    "feature/20260918-iteration-plan-path",
    "--branch-target-iteration",
    "main",
    "--row",
    JSON.stringify({ id: PLAN_ID, title: "Plan alpha", file }),
    "--started-at",
    "2026-09-18T00:00:00.000Z",
    "--expect",
    token,
    "--operation",
    `register-${workflowId}`,
    "--harness",
    harness,
    "--session-id",
    `coord-${workflowId}`,
  ];
}


/**
 * Temp git-backed harness with a plan file under its configured plan root and
 * an initialized active store. Returns the harness plus the canonical path.
 */
function setupHarness(options: { mstarc?: string; planSubdir?: string } = {}): {
  harness: string;
  planPath: string;
  context: StoreContext;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "mstar-iteration-plan-path-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: root,
  });
  const harness = join(root, ".mstar");
  const planDir = join(harness, options.planSubdir ?? "plans");
  mkdirSync(planDir, { recursive: true });
  const planFile = join(planDir, `${PLAN_ID}.md`);
  writeFileSync(planFile, `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
  if (options.mstarc !== undefined) writeFileSync(join(harness, ".mstarc"), options.mstarc);
  return {
    harness,
    planPath: realpathSync(planFile),
    context: { harnessDir: harness },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
async function initStore(harness: string): Promise<void> {
  await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
  await initializeExecutionAuthority({ harnessDir: harness });
}


function expectInvalidRegisteredPath(harnessRoot: string, file: string): void {
  let error: unknown;
  try {
    resolveRegisteredPlanFile({ harnessRoot, planId: PLAN_ID, file });
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "plan-path.invalid-pointer" });
}

describe("iteration registration inputs and registered plan paths", () => {
  test("registers a valid active iteration input with a normalized harness-relative plan path", async () => {
    const fixture = setupHarness();
    await initStore(fixture.harness);
    try {
      const workflowId = "20260918-path-default";
      const result = runCli(
        registerArgs(fixture.harness, workflowId, `plans/${PLAN_ID}.md`, await rootToken(fixture.harness)),
        fixture.harness,
        identityFor(workflowId),
      );
      expect(result.exitCode).toBe(0);
      expect(jsonOf(result)).toMatchObject({
        command: "iteration.register",
        status: "ok",
        code: "iteration.register.ok",
        exitCode: 0,
      });

      const registration = await readExecutionAuthority(fixture.context, { workflowId });
      if (!("workflows" in registration.data)) throw new Error("registration read returned no workflow authority");
      const registered = registration.data.workflows.find((entry) => entry.state.id === workflowId);
      expect(registered?.plans[0]?.plan).toMatchObject({
        id: PLAN_ID,
        title: "Plan alpha",
        file: `plans/${PLAN_ID}.md`,
        status: "Todo",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("the path resolver accepts a normalized harness-relative pointer and rejects repository-relative .mstar spelling", () => {
    const fixture = setupHarness();
    try {
      expect(resolveRegisteredPlanFile({
        harnessRoot: fixture.harness,
        planId: PLAN_ID,
        file: `plans/${PLAN_ID}.md`,
      }).planPath).toBe(fixture.planPath);
      expectInvalidRegisteredPath(fixture.harness, `.mstar/plans/${PLAN_ID}.md`);
    } finally {
      fixture.cleanup();
    }
  });

  test("the path resolver honors a .mstarc-declared plan root", () => {
    const fixture = setupHarness({ mstarc: "[config]\nplan_dir=planning\n", planSubdir: "planning" });
    try {
      expect(resolveRegisteredPlanFile({
        harnessRoot: fixture.harness,
        planId: PLAN_ID,
        file: `planning/${PLAN_ID}.md`,
      }).planPath).toBe(fixture.planPath);
      expectInvalidRegisteredPath(fixture.harness, `plans/${PLAN_ID}.md`);
    } finally {
      fixture.cleanup();
    }
  });

  test("an external plan root requires an absolute pointer", () => {
    const external = mkdtempSync(join(tmpdir(), "mstar-iteration-plan-path-external-"));
    const externalPlan = join(external, `${PLAN_ID}.md`);
    writeFileSync(externalPlan, `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
    const fixture = setupHarness({ mstarc: `[config]\nplan_dir=${external}\n` });
    try {
      expectInvalidRegisteredPath(fixture.harness, `${PLAN_ID}.md`);
      expect(resolveRegisteredPlanFile({
        harnessRoot: fixture.harness,
        planId: PLAN_ID,
        file: realpathSync(externalPlan),
      }).planPath).toBe(realpathSync(externalPlan));
    } finally {
      fixture.cleanup();
      rmSync(external, { recursive: true, force: true });
    }
  });
});
