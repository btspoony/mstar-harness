/**
 * execution-read.test.ts — §5 (plan S4) the OpenCode plugin's source
 * readiness for the EXECUTION authority.
 *
 * What this host can and cannot do is the point of the group:
 *
 * - an ACTIVE execution authority retires the root `status.json` and the
 *   workflow snapshots as persistence routes, so a write to either is refused
 *   `execution.direct-write-refused` — canonical path and symlink alias alike —
 *   and an authority that exists and cannot be read refuses fail-closed
 *   (`store.authority-unavailable`) instead of falling back to the retired
 *   file;
 * - `tool.execute.before` returns void on this host, so every one of those
 *   verdicts is a DECISION record plus an error log. The log says so plainly
 *   ("the write is NOT stopped"); nothing here claims installed enforcement;
 * - a harness with no store, and an engine without the route export, keep the
 *   unchanged document lint.
 *
 * Stores are REAL (`initializeStore` / `initializeExecutionAuthority` /
 * `createExecutionWorkflow`, real `node:sqlite` migrations); the refusals are
 * the plugin's own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutionWorkflow,
  initializeExecutionAuthority,
  initializeStore,
  registerCatalogEntity,
} from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext } from "@mstar-harness/engine";
import { storeApiLoader, validateStatusWrite, type StatusLogger } from "../src/mstar.js";

/** Ambient MSTAR_HARNESS_DIR would redirect every `.mstar` fixture — pinned out. */
const ENV_KEY = "MSTAR_HARNESS_DIR";
let previousEnv: string | undefined;
beforeEach(() => {
  previousEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
});

const realStoreApiLoad = storeApiLoader.load;
const projects: string[] = [];

afterEach(() => {
  storeApiLoader.load = realStoreApiLoad;
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

const TS = "2026-09-21T00:00:00.000Z";
const WORKFLOW_ID = "wf-opencode";
const PLAN_ID = "20260000-opencode-plan";

const validStatus = { version: 2, updated_at: "2026-09-08", workflows: [] };

/** Temp project rooted in a real git work tree (harness resolution boundary),
 * with the default `.mstar` layout and the root markers the document
 * classifier probes for. */
function makeHarnessProject(): {
  project: string;
  harness: string;
  statusPath: string;
  snapshotPath: string;
  storeDb: string;
} {
  const project = mkdtempSync(join(tmpdir(), "mstar-opencode-s4-"));
  projects.push(project);
  execFileSync("git", ["init", "-q", project], { stdio: "ignore" });
  const harness = join(project, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  return {
    project,
    harness,
    statusPath: join(harness, "status.json"),
    snapshotPath: join(harness, "workflows", WORKFLOW_ID, "snapshot.json"),
    storeDb: join(harness, "store.db"),
  };
}

/**
 * REAL ACTIVE EXECUTION authority plus the retired root register a real
 * cutover leaves behind: the create-only empty-execution initializer, the
 * catalog plan row, the workflow that holds it, and only THEN the retired
 * `status.json` (the initializer refuses a harness that still carries live
 * execution sources).
 */
async function seedActiveExecutionAuthority(harness: string, statusPath: string): Promise<void> {
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
    { operationId: `register-${PLAN_ID}`, actor: "execution-read.test" },
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
  // The retired register is restored afterwards — exactly the on-disk state a
  // real cutover leaves: an ACTIVE execution authority whose retired root
  // register still sits there.
  writeFileSync(statusPath, JSON.stringify(validStatus, null, 2));
}

/** Unreadable authority through the REAL engine channel (`store.corrupt`). */
function corruptStore(harness: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(harness, `store.db${suffix}`), { force: true });
  mkdirSync(join(harness, "store.db"), { recursive: true });
}

/** Capture `[mstar-harness]` log lines by level. */
function capture(): { entries: Array<[string, string]>; log: StatusLogger } {
  const entries: Array<[string, string]> = [];
  return { entries, log: (level, message) => entries.push([level, message]) };
}

describe("execution-opencode-read — the OpenCode plugin's execution-authority readiness (plan S4)", () => {
  test("an ACTIVE authority refuses a retired root register and snapshot write by decision (hard or soft)", async () => {
    const fixture = makeHarnessProject();
    await seedActiveExecutionAuthority(fixture.harness, fixture.statusPath);

    const { entries, log } = capture();
    const status = await validateStatusWrite(fixture.statusPath, { doc: validStatus, log });
    expect(status?.ok).toBe(false);
    expect(status?.violations.map((violation) => violation.code)).toEqual(["execution.direct-write-refused"]);
    // The authority invariant, not the compass axis: `hardBlocked` is set with
    // no enforcement flag involved so a refusal-capable caller must act.
    expect(status?.hardBlocked).toBe(true);

    const snapshot = await validateStatusWrite(fixture.snapshotPath, {
      doc: { schema_version: 1, id: WORKFLOW_ID },
      log,
    });
    expect(snapshot?.violations.map((violation) => violation.code)).toEqual(["execution.direct-write-refused"]);

    // …and the record is HONEST about this host's channel: the write was not
    // stopped, so nothing claims installed enforcement.
    const refusalLines = entries.filter(([, message]) => message.includes("execution.direct-write-refused"));
    expect(refusalLines).toHaveLength(2);
    for (const [level, message] of refusalLines) {
      expect(level).toBe("error");
      expect(message).toContain("NOT stopped");
      expect(message).toContain("warn-only");
    }
  });

  test("a symlink alias of a retired document is refused like the document itself", async () => {
    const fixture = makeHarnessProject();
    await seedActiveExecutionAuthority(fixture.harness, fixture.statusPath);
    const aliasDir = mkdtempSync(join(tmpdir(), "mstar-opencode-s4-alias-"));
    projects.push(aliasDir);
    const alias = join(aliasDir, "retired-status.json");
    symlinkSync(fixture.statusPath, alias);

    const { log } = capture();
    const result = await validateStatusWrite(alias, { doc: validStatus, log });
    expect(result?.violations.map((violation) => violation.code)).toEqual(["execution.direct-write-refused"]);
  });

  test("an unreadable execution authority refuses fail-closed instead of reading the retired file", async () => {
    const fixture = makeHarnessProject();
    await seedActiveExecutionAuthority(fixture.harness, fixture.statusPath);
    corruptStore(fixture.harness);

    const { log } = capture();
    const result = await validateStatusWrite(fixture.statusPath, { doc: validStatus, log });
    expect(result?.violations.map((violation) => violation.code)).toEqual(["store.authority-unavailable"]);
    expect(result?.violations[0]?.message).toContain("execution authority");
    expect(result?.violations[0]?.message).toContain("store.corrupt");
  });

  test("a PRE-ACTIVATION harness's document symlinked into another harness's ACTIVE authority is refused (both roots probed)", async () => {
    // Harness B: the ACTIVE execution authority the write really lands on.
    const authority = makeHarnessProject();
    await seedActiveExecutionAuthority(authority.harness, authority.statusPath);

    // Harness A: pre-activation (no store at all) whose OWN `status.json` is a
    // symlink into B's retired register. The textual classification resolves a
    // pre-activation harness, so a single-root probe would let the write
    // through although the bytes land on B's retired document.
    const source = makeHarnessProject();
    symlinkSync(authority.statusPath, source.statusPath);

    const { log } = capture();
    const refused = await validateStatusWrite(source.statusPath, { doc: validStatus, log });
    expect(refused?.violations.map((violation) => violation.code)).toEqual(["execution.direct-write-refused"]);

    // The same alias on an UNREADABLE authority fails closed on the landed
    // root — never a silent pass because the source harness has no store.
    corruptStore(authority.harness);
    const corruptSource = makeHarnessProject();
    symlinkSync(authority.statusPath, corruptSource.statusPath);
    const unreadable = await validateStatusWrite(corruptSource.statusPath, { doc: validStatus, log });
    expect(unreadable?.violations.map((violation) => violation.code)).toEqual(["store.authority-unavailable"]);
    expect(unreadable?.violations[0]?.message).toContain("store.corrupt");
  });

  test("pre-activation keeps the unchanged document lint: a harness with no store", async () => {
    const fixture = makeHarnessProject();
    writeFileSync(fixture.statusPath, JSON.stringify(validStatus, null, 2));

    const { log } = capture();
    // No store at all → absence is not an authority verdict (§2.1): the
    // document validator still decides and the execution refusal never fires.
    const valid = await validateStatusWrite(fixture.statusPath, { doc: validStatus, log });
    expect(valid?.ok).toBe(true);
    expect(valid?.hardBlocked).toBe(false);

    const invalid = await validateStatusWrite(fixture.statusPath, {
      doc: { version: 2, updated_at: "2026-09-08", workflows: [{ id: "wf-1", type: "sprint" }] },
      log,
    });
    expect(invalid?.violations[0]?.code).toBe("status.workflow.invalid-type");
    expect(invalid?.violations.some((violation) => violation.code === "execution.direct-write-refused")).toBe(false);
    expect(invalid?.hardBlocked).toBe(false);
  });

  test("an installed engine without the route export keeps the document lint (no invented authority)", async () => {
    const fixture = makeHarnessProject();
    await seedActiveExecutionAuthority(fixture.harness, fixture.statusPath);

    // A pre-execution engine: the route export is not there, so there is no
    // authority to classify and the retired document keeps its document lint
    // instead of a refusal class the engine cannot support.
    storeApiLoader.load = async () => null;
    const { log } = capture();
    const result = await validateStatusWrite(fixture.statusPath, { log });
    expect(result?.violations.some((violation) => violation.code === "execution.direct-write-refused")).toBe(false);
    expect(result?.hardBlocked).not.toBe(true);
  });
});
