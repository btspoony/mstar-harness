/**
 * CLI `mstar iteration register` — the registered-plan path contract
 * (prerequisite contract §4) on the real registration path.
 *
 * The suite spawns the real CLI as a subprocess against isolated temp fixture
 * harnesses (no live harness, no helper called directly). Contract pinned here:
 * - a canonical absolute or a normalized harness-relative pointer to the
 *   configured `{PLAN_DIR}/<id>.md` registers, and the SNAPSHOT persists the
 *   canonical absolute path, never the caller's spelling;
 * - the old repository-relative `.mstar/plans/<id>.md` spelling is refused with
 *   the actionable diagnostic (received form, base, expected canonical target,
 *   permitted forms) and writes NOTHING — no status.json, no snapshot, no
 *   journal row;
 * - a `.mstarc`-declared plan root resolves from its own base, and an external
 *   plan root is admitted only as an absolute pointer.
 */
import { describe, expect, test } from "bun:test";
import {
  initializeStore,
  listPendingCatalogRegistrations,
  type StoreContext,
} from "@mstar-harness/engine";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function registerArgs(harness: string, workflowId: string, file: string): string[] {
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
    "--branch-target",
    "main",
    "--row",
    JSON.stringify({ id: PLAN_ID, title: "Plan alpha", file }),
    "--started-at",
    "2026-09-18T00:00:00.000Z",
    "--harness",
    harness,
  ];
}

/**
 * Temp fixture harness with a plan file under `planSubdir` (default `plans/`)
 * and an initialized active store. Returns the harness plus the canonical
 * absolute plan path.
 */
function setupHarness(options: { mstarc?: string; planSubdir?: string } = {}): {
  harness: string;
  planPath: string;
  context: StoreContext;
  cleanup: () => void;
} {
  const harness = mkdtempSync(join(tmpdir(), "mstar-iteration-plan-path-"));
  const planDir = join(harness, options.planSubdir ?? "plans");
  mkdirSync(planDir, { recursive: true });
  const planFile = join(planDir, `${PLAN_ID}.md`);
  writeFileSync(planFile, `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
  if (options.mstarc !== undefined) writeFileSync(join(harness, ".mstarc"), options.mstarc);
  return {
    harness,
    planPath: realpathSync(planFile),
    context: { harnessDir: harness },
    cleanup: () => rmSync(harness, { recursive: true, force: true }),
  };
}

async function initStore(harness: string): Promise<void> {
  await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
}

describe("mstar iteration register — registered plan path (§4)", () => {
  test("prerequisite path: a harness-relative pointer registers the canonical absolute plan file", async () => {
    const fixture = setupHarness();
    await initStore(fixture.harness);
    try {
      const result = runCli(registerArgs(fixture.harness, "20260918-path-default", `plans/${PLAN_ID}.md`));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("iteration register: OK");

      const snapshot = JSON.parse(
        readFileSync(join(fixture.harness, "workflows", "20260918-path-default", "snapshot.json"), "utf8"),
      ) as { plans: Array<{ id: string; file: string }> };
      expect(snapshot.plans).toEqual([expect.objectContaining({ id: PLAN_ID, file: fixture.planPath })]);
      expect(snapshot.plans[0]!.file.startsWith(realpathSync(fixture.harness))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("prerequisite path: the repository-relative .mstar/plans spelling refuses with nothing written", async () => {
    const fixture = setupHarness();
    await initStore(fixture.harness);
    try {
      const result = runCli(registerArgs(fixture.harness, "20260918-path-relative", `.mstar/plans/${PLAN_ID}.md`));
      expect(result.exitCode).toBe(1);
      // The actionable diagnostic: received form, base, expected target, forms.
      expect(result.stderr).toContain("plan pointer refused");
      expect(result.stderr).toContain("plan-path.invalid-pointer");
      expect(result.stderr).toContain(`.mstar/plans/${PLAN_ID}.md`);
      expect(result.stderr).toContain("permitted forms");

      // No execution bytes and no journal row: the refusal precedes every write.
      expect(existsSync(join(fixture.harness, "status.json"))).toBe(false);
      expect(existsSync(join(fixture.harness, "workflows"))).toBe(false);
      expect(await listPendingCatalogRegistrations(fixture.context)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("prerequisite path: a .mstarc-declared plan root resolves from its own base", async () => {
    const fixture = setupHarness({ mstarc: "[config]\nplan_dir=planning\n", planSubdir: "planning" });
    const custom = setupHarness({ mstarc: "[config]\nplan_dir=planning\n" });
    await initStore(fixture.harness);
    await initStore(custom.harness);
    try {
      const accepted = runCli(registerArgs(fixture.harness, "20260918-path-mstarc", `planning/${PLAN_ID}.md`));
      expect(accepted.exitCode).toBe(0);
      const snapshot = JSON.parse(
        readFileSync(join(fixture.harness, "workflows", "20260918-path-mstarc", "snapshot.json"), "utf8"),
      ) as { plans: Array<{ file: string }> };
      expect(snapshot.plans[0]!.file).toBe(fixture.planPath);

      // The default-root spelling is not the configured root: it refuses.
      const refused = runCli(registerArgs(custom.harness, "20260918-path-mstarc-default", `plans/${PLAN_ID}.md`));
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("plan pointer refused");
      expect(existsSync(join(custom.harness, "workflows"))).toBe(false);
    } finally {
      fixture.cleanup();
      custom.cleanup();
    }
  });

  test("prerequisite path: an external plan root is admitted only as an absolute pointer", async () => {
    const external = mkdtempSync(join(tmpdir(), "mstar-iteration-plan-path-external-"));
    const externalPlan = join(external, `${PLAN_ID}.md`);
    writeFileSync(externalPlan, `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
    const fixture = setupHarness({ mstarc: `[config]\nplan_dir=${external}\n` });
    await initStore(fixture.harness);
    try {
      const refused = runCli(registerArgs(fixture.harness, "20260918-path-external-rel", `${PLAN_ID}.md`));
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("plan pointer refused");
      expect(existsSync(join(fixture.harness, "workflows"))).toBe(false);

      const accepted = runCli(registerArgs(fixture.harness, "20260918-path-external-abs", realpathSync(externalPlan)));
      expect(accepted.exitCode).toBe(0);
      const snapshot = JSON.parse(
        readFileSync(join(fixture.harness, "workflows", "20260918-path-external-abs", "snapshot.json"), "utf8"),
      ) as { plans: Array<{ file: string }> };
      expect(snapshot.plans[0]!.file).toBe(realpathSync(externalPlan));
    } finally {
      fixture.cleanup();
      rmSync(external, { recursive: true, force: true });
    }
  });
});
