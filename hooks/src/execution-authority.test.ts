/**
 * execution-authority.test.ts — §4.3/§5 (plan S4) the ZCode PreToolUse
 * write gate's EXECUTION-authority boundary.
 *
 * The gate is the one host in this round with a refusal channel, so the
 * requirement is enforcement, not a warning: a write to a retired coordination
 * document (root `status.json`, `workflows/<id>/snapshot.json`) is refused with
 * exit 2 + the authority-invariant stderr dialect while the control harness's
 * execution authority is ACTIVE, refused fail-closed when that authority exists
 * and cannot be read, and refused on the path the write really LANDS on — a
 * symlink alias is the document itself. A harness with no store keeps the
 * unchanged document lint, and an unrelated target stays a silent pass.
 *
 * The SOURCE entry runs under the test runner: the committed bundle is a 2b
 * obligation (primary spec §9: "No generated bundle … in 2a"), so nothing here
 * bundles or launches an installed host. Stores are REAL (`initializeStore` /
 * `initializeExecutionAuthority` / `createExecutionWorkflow`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutionWorkflow,
  initializeExecutionAuthority,
  initializeStore,
  registerCatalogEntity,
} from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext } from "@mstar-harness/engine";

const HOOK_SRC = join(import.meta.dir, "mstar-write-gate.ts");

const SKILL_POINTER = "(skill: mstar-artifacts/references/status-and-residuals.md)";
const ENFORCEMENT_LINE =
  "Enforcement: hard \u2014 this repo opts in via .mstarc/compass; disable for this session with MSTAR_WRITE_GATE=off.";
const AUTHORITY_LINE =
  "Authority invariant (not the enforcement flag) \u2014 the issue/catalog authority is not hand-writable; disable for this session with MSTAR_WRITE_GATE=off.";

const VALID_STATUS = JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] });
const BAD_JSON = "{ not json";

const TS = "2026-09-21T00:00:00.000Z";
const WORKFLOW_ID = "wf-hook-execution";
const PLAN_ID = "20260000-hook-plan";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHarness(
  id: string,
  enforcement?: "hard" | "soft",
): { root: string; harness: string; statusPath: string; snapshotPath: string; storeDb: string } {
  const root = mkdtempSync(join(tmpdir(), `wgate-s4-${id}-`));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  const statusPath = join(harness, "status.json");
  writeFileSync(statusPath, VALID_STATUS);
  if (enforcement !== undefined) writeFileSync(join(root, ".mstarc"), `[config]\nenforcement=${enforcement}\n`);
  return {
    root,
    harness,
    statusPath,
    snapshotPath: join(harness, "workflows", WORKFLOW_ID, "snapshot.json"),
    storeDb: join(harness, "store.db"),
  };
}

/**
 * REAL ACTIVE EXECUTION authority (primary spec §3/§4.3): the create-only
 * empty-execution initializer, the catalog plan row and the workflow that
 * holds it, all through the engine's own producers. The retired `status.json`
 * is parked while the initializer runs — it refuses a harness that still
 * carries live execution sources — and restored afterwards, which is exactly
 * the state a real cutover leaves behind.
 */
async function seedActiveExecutionAuthority(harness: string, statusPath: string): Promise<void> {
  const parked = `${statusPath}.parked`;
  renameSync(statusPath, parked);
  try {
    const handle = await initializeStore({ harnessDir: harness });
    handle.close();
    const initialized = await initializeExecutionAuthority({ harnessDir: harness });
    await registerCatalogEntity(
      { harnessDir: harness },
      {
        kind: "plan",
        id: PLAN_ID,
        title: `${PLAN_ID} title`,
        rootKind: "plans",
        relativePath: `plans/${PLAN_ID}.md`,
      },
      { operationId: `register-${PLAN_ID}`, actor: "execution-authority.test" },
    );
    const context: ExecutionContext = {
      harnessDir: harness,
      caller: {
        sessionId: `host-${WORKFLOW_ID}`,
        role: "coordinator",
        workflowId: WORKFLOW_ID,
        planId: null,
      } satisfies ExecutionCaller,
    };
    await createExecutionWorkflow(context, {
      entry: { id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` },
      snapshot: {
        schema_version: 1,
        id: WORKFLOW_ID,
        type: "plan",
        status: "running",
        started_at: TS,
        updated_at: TS,
        plans: [{ id: PLAN_ID, title: `${PLAN_ID} title`, file: `plans/${PLAN_ID}.md`, status: "Todo" }],
        delivery_kind: "development",
        branch: { source: `feature/${WORKFLOW_ID}`, target: "main" },
      } as never,
      expected: initialized.token,
      operationId: `create-${WORKFLOW_ID}`,
    });
  } finally {
    renameSync(parked, statusPath);
  }
}

/** Unreadable authority through the REAL engine channel (`store.corrupt`). */
function corruptStore(harness: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(harness, `store.db${suffix}`), { force: true });
  mkdirSync(join(harness, "store.db"), { recursive: true });
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run the gate SOURCE under the test runner with a synthetic stdin envelope;
 * harness-affecting env vars are scrubbed. */
function runGate(payload: unknown, env: Record<string, string> = {}): RunResult {
  const merged = { ...process.env };
  delete merged.MSTAR_WRITE_GATE;
  delete merged.MSTAR_HARNESS_DIR;
  Object.assign(merged, env);
  const proc = spawnSync(process.execPath, [HOOK_SRC], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: merged,
    encoding: "utf8",
  });
  return { exitCode: proc.status ?? -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function writeEvent(filePath: string, content: string): unknown {
  return { tool_name: "Write", tool_input: { file_path: filePath, content } };
}

function lines(run: RunResult): string[] {
  return run.stderr.trimEnd().split("\n");
}

/** The three-line authority refusal + exit 2 + empty stdout. */
function expectAuthorityBlock(run: RunResult, code: string): void {
  expect(run.exitCode).toBe(2);
  expect(run.stdout).toBe("");
  const out = lines(run);
  expect(out).toHaveLength(3);
  expect(out[1]!.startsWith(`[high] ${code}: `)).toBe(true);
  expect(out[1]!.endsWith(SKILL_POINTER)).toBe(true);
  expect(out[2]).toBe(AUTHORITY_LINE);
}

describe("execution-hook-authority — the ZCode write gate refuses retired coordination documents (plan S4)", () => {
  test("the retired root register and workflow snapshots are refused in hard AND soft mode", async () => {
    for (const enforcement of ["hard", "soft"] as const) {
      const fixture = makeHarness(`execution-${enforcement}`, enforcement);
      await seedActiveExecutionAuthority(fixture.harness, fixture.statusPath);

      // Document-VALID bytes prove the refusal is the execution authority's
      // route, not a shape violation — and soft mode proves it is not the
      // compass-governed document axis.
      expectAuthorityBlock(runGate(writeEvent(fixture.statusPath, VALID_STATUS)), "execution.direct-write-refused");
      mkdirSync(join(fixture.snapshotPath, ".."), { recursive: true });
      expectAuthorityBlock(
        runGate(writeEvent(fixture.snapshotPath, JSON.stringify({ schema_version: 1 }))),
        "execution.direct-write-refused",
      );
    }
  });

  test("a symlink alias of a retired document is refused like the document itself", async () => {
    const fixture = makeHarness("execution-alias", "soft");
    await seedActiveExecutionAuthority(fixture.harness, fixture.statusPath);
    const aliasDir = mkdtempSync(join(tmpdir(), "wgate-s4-alias-"));
    roots.push(aliasDir);
    const alias = join(aliasDir, "carry-over-status.json");
    symlinkSync(fixture.statusPath, alias);

    expectAuthorityBlock(runGate(writeEvent(alias, VALID_STATUS)), "execution.direct-write-refused");
  });

  test("an unreadable execution authority refuses fail-closed, never a silent pass", async () => {
    const fixture = makeHarness("execution-corrupt", "soft");
    await seedActiveExecutionAuthority(fixture.harness, fixture.statusPath);
    corruptStore(fixture.harness);

    const run = runGate(writeEvent(fixture.statusPath, VALID_STATUS));
    expectAuthorityBlock(run, "store.authority-unavailable");
    expect(run.stderr).toContain("execution authority");
    expect(run.stderr).toContain("store.corrupt");
  });

  test("pre-activation keeps the document validator: no store at all", () => {
    const hard = makeHarness("execution-legacy-hard", "hard");
    // The compass-governed document lint still decides, and its refusal is the
    // document's own code — never the execution route's.
    const blocked = runGate(writeEvent(hard.statusPath, BAD_JSON));
    expect(blocked.exitCode).toBe(2);
    const out = lines(blocked);
    expect(out[1]!.startsWith("[high] status.invalid-json: ")).toBe(true);
    expect(out[2]).toBe(ENFORCEMENT_LINE);
    expect(runGate(writeEvent(hard.statusPath, VALID_STATUS)).exitCode).toBe(0);

    const soft = makeHarness("execution-legacy-soft", "soft");
    const silent = runGate(writeEvent(soft.statusPath, BAD_JSON));
    expect(silent.exitCode).toBe(0);
    expect(silent.stdout).toBe("");
    expect(silent.stderr).toBe("");
  });

  test("an unrelated target stays a silent pass (no authority route is entered)", () => {
    const fixture = makeHarness("execution-unrelated", "hard");
    writeFileSync(join(fixture.root, "notes.md"), "# notes\n");
    const run = runGate(writeEvent(join(fixture.root, "notes.md"), BAD_JSON));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});
