/**
 * CLI `mstar plan show` / `status` / `lease` / `iteration gate` reads — the
 * execution-authority read route (primary spec §5, plan task S2).
 *
 * Run with
 * `bun test packages/cli/test/execution-read.test.ts --test-name-pattern 'execution-cli-read'`
 * (after `bun run --cwd packages/engine build`, the same engine build the
 * package's own `test` script performs).
 *
 * Every case runs the real CLI entry as a subprocess against a temporary Git
 * workspace whose `.mstar` holds a REAL `node:sqlite` store built by the
 * engine's own producers (`initializeExecutionAuthority` /
 * `registerCatalogEntity` / `createExecutionWorkflow`) — no hand-written DB
 * rows. The leftovers the retired file route would have served (`status.json`,
 * `workflows/<id>/snapshot.json`) are planted AFTER that commit, so every
 * assertion distinguishes authority from file bytes.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `-show-answers-with-the-authority-*`: an explicit `--workflow/--plan`
 *   address is served by the DB adapter, with the plan token and without any
 *   `session_file`/`snapshot_version` — the leftovers on disk are not consulted.
 * - `-show-refuses-a-legacy-session-envelope-*`: a read that would need the
 *   retired file credential reports `execution.consumer-not-ready` (exit 1),
 *   and the DB form never becomes a silent file fallback (exit 2 usage on a
 *   legacy harness, exit 2 for a mixed flag shape).
 * - `-gates-read-their-input-*`: the lease gates take their row/lease from the
 *   authority (the leftover snapshot's claims are NOT the verdict), and the
 *   phase gate — whose input is a whole snapshot document — fails closed with
 *   `execution.consumer-not-ready` instead of reading retired JSON. The gate's
 *   OWN usage shape is decided ahead of that refusal, so a malformed phase-gate
 *   invocation is exit 2 (usage) even on an active authority.
 * - `-status-validates-*`: the root register is validated FROM the authority (a
 *   status.json the file route would reject), while an explicitly named
 *   `status.json` is refused; a legacy harness still validates its own file.
 * - `-refuses-an-unusable-store-*`: a corrupt store is the store's refusal with
 *   its own code and exit 1, and a harness with no store keeps the file route
 *   (exit 2 for the DB form) — never an empty success.
 * - `-dashboard-views-refuse-*`: the CLI store-read transport refuses the
 *   projection-derived views while the authority is active and keeps serving
 *   the issue views.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createExecutionWorkflow,
  initializeExecutionAuthority,
  initializeStore,
  openStore,
  registerCatalogEntity,
  type StoreContext,
  type WorkflowSnapshot,
} from "@mstar-harness/engine";
import { readDashboardView } from "../src/store-read";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

const WORKFLOW_ID = "wf-execution-read";
const PLAN_ID = "20260920-execution-read-plan";
const TS = "2026-09-21T00:00:00.000Z";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  harnessDir: string;
  context: StoreContext;
}

/** A temp workspace shaped like a real one: a Git main worktree with `.mstar`. */
function workspace(label: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { root, harnessDir, context: { harnessDir } };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Spawn env with ambient harness env vars pinned out, then the fixture's own. */
function cliEnv(fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (key === "MSTAR_HOST_SESSION_ID") continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, MSTAR_HARNESS_DIR: fixture.harnessDir, ...extra };
}

function runCli(args: string[], fixture: Fixture, extraEnv: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: fixture.root,
    env: cliEnv(fixture, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

/** An ACTIVE execution authority holding one workflow with one plan. */
async function activeFixture(label: string): Promise<Fixture> {
  const fixture = workspace(label);
  const handle = await initializeStore(fixture.context);
  handle.close();
  const initialized = await initializeExecutionAuthority(fixture.context);
  await registerCatalogEntity(
    fixture.context,
    { kind: "plan", id: PLAN_ID, title: "Execution read plan", rootKind: "plans", relativePath: `plans/${PLAN_ID}.md` },
    { operationId: `register-${PLAN_ID}`, actor: "cli-execution-read.test" },
  );
  await createExecutionWorkflow(
    {
      harnessDir: fixture.harnessDir,
      caller: { sessionId: `host-${WORKFLOW_ID}`, role: "coordinator", workflowId: WORKFLOW_ID, planId: null },
    },
    {
      entry: { id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` },
      snapshot: {
        schema_version: 1,
        id: WORKFLOW_ID,
        type: "plan",
        status: "running",
        started_at: TS,
        updated_at: TS,
        plans: [{ id: PLAN_ID, title: "Execution read plan", file: `plans/${PLAN_ID}.md`, status: "Todo" }],
        delivery_kind: "development",
        branch: { source: `feature/${WORKFLOW_ID}`, target: "main" },
      } as unknown as WorkflowSnapshot,
      expected: initialized.token,
      operationId: `create-${WORKFLOW_ID}`,
    },
  );
  return fixture;
}

/** A workspace whose store has the execution schema recorded `legacy` (§2.1). */
async function legacyFixture(label: string): Promise<Fixture> {
  const fixture = workspace(label);
  const handle = await initializeStore(fixture.context);
  handle.close();
  return fixture;
}

/**
 * The retired file route's bytes: a root register that registers nothing and a
 * snapshot that claims a Done, leased plan the DB has never heard of.
 */
function plantLeftoverSnapshot(fixture: Fixture): string {
  const snapshotPath = join(fixture.harnessDir, "workflows", WORKFLOW_ID, "snapshot.json");
  writeJson(join(fixture.harnessDir, "status.json"), { version: 2, updated_at: "2000-01-01", workflows: [] });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "completed",
    started_at: TS,
    updated_at: TS,
    plans: [
      {
        id: "plan-from-the-file",
        title: "file",
        file: "plans/file.md",
        status: "Done",
        execution_lease: { lease_id: "lease-from-the-file", holder: "holder-from-the-file", plan_id: "plan-from-the-file" },
      },
    ],
    integration_merge_lease: { lease_id: "merge-from-the-file", holder: "holder-from-the-file", status: "held" },
  });
  return snapshotPath;
}

function plantLeftoverSession(fixture: Fixture): string {
  const sessionPath = join(fixture.harnessDir, "workflows", WORKFLOW_ID, "sessions", "coordinator-leftover.json");
  writeJson(sessionPath, {
    schema_version: 1,
    role: "coordinator",
    session_id: "leftover-session",
    workflow_id: WORKFLOW_ID,
    harness_root: fixture.harnessDir,
  });
  return sessionPath;
}

function corruptStore(fixture: Fixture): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(fixture.harnessDir, `store.db${suffix}`), { force: true });
  writeFileSync(join(fixture.harnessDir, "store.db"), "this is not a sqlite database\n");
}

/**
 * A well-formed Phase-2 delivery compass. It exists so the transition form's
 * active-route arm fails for the ONE reason under test (the authority refusal),
 * never because the compass file was missing.
 */
function writeCompass(fixture: Fixture): string {
  const compassPath = join(fixture.harnessDir, "delivery-compass.md");
  writeFileSync(
    compassPath,
    `---
iteration_id: v9.9.9
start_date: 2026-09-01
status: active
iteration_base_branch: main
target_branch: main
plans:
  - ${PLAN_ID}
---

# v9.9.9 Delivery Compass
`,
  );
  return compassPath;
}

/* ------------------------------------------------------------------------ *
 * execution-cli-read — the CLI read route (primary spec §5)
 * ------------------------------------------------------------------------ */

describe("execution-cli-read — the CLI answers execution-source reads by route", () => {
  test("show answers with the authority, never the leftover snapshot or its session file", async () => {
    const fixture = await activeFixture("cli-read-show");
    const snapshotPath = plantLeftoverSnapshot(fixture);

    const result = runCli(["plan", "show", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], fixture);

    expect(result.exitCode).toBe(0);
    const payload = jsonOf(result);
    expect(payload.route).toBe("execution");
    expect(payload.operation).toBe("show");
    expect(payload.workflow_id).toBe(WORKFLOW_ID);
    expect(payload.plan_id).toBe(PLAN_ID);
    expect((payload.plan as Record<string, unknown>).id).toBe(PLAN_ID);
    expect((payload.plan as Record<string, unknown>).status).toBe("Todo");
    expect(String(payload.token).startsWith("exec-v1:plan:")).toBe(true);
    // The DB route carries the plan's OWN state — not the file's lease, and no
    // invented file envelope (§5: no `session_file`, no fake snapshot).
    expect(payload.execution_lease).toBeNull();
    expect(payload.session_file).toBeUndefined();
    expect(payload.snapshot_version).toBeUndefined();
    expect(payload.allowed_operations).toBeUndefined();
    expect(result.stdout).not.toContain("plan-from-the-file");
    expect(result.stdout).not.toContain("holder-from-the-file");

    // The file the CLI was reading before this route landed is untouched.
    expect(readFileSync(snapshotPath, "utf8")).toContain("plan-from-the-file");
  });

  test("show refuses a leftover session envelope as authority and never silently falls back to files", async () => {
    const fixture = await activeFixture("cli-read-session");
    const sessionPath = plantLeftoverSession(fixture);
    plantLeftoverSnapshot(fixture);

    // The file route would need the retired session credential: not-ready.
    const legacyRead = runCli(["plan", "show", "--session", sessionPath, "--json"], fixture);
    expect(legacyRead.exitCode).toBe(1);
    expect(jsonOf(legacyRead).code).toBe("execution.consumer-not-ready");

    // The DB form and the file form are alternatives, never combined.
    const mixed = runCli(
      ["plan", "show", "--session", sessionPath, "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"],
      fixture,
    );
    expect(mixed.exitCode).toBe(2);
    expect(jsonOf(mixed).code).toBe("usage");

    // On a harness whose execution authority is not active, this address form
    // has no DB row to serve — a usage refusal that names the file form, not an
    // empty view and not a silent file read.
    const legacy = await legacyFixture("cli-read-session-legacy");
    const noAuthority = runCli(
      ["plan", "show", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"],
      legacy,
    );
    expect(noAuthority.exitCode).toBe(2);
    const refusal = jsonOf(noAuthority);
    expect(refusal.code).toBe("usage");
    expect(String(refusal.message)).toContain("--session");

    // A usage shape with neither address is refused before any store access.
    const bare = runCli(["plan", "show", "--json"], fixture);
    expect(bare.exitCode).toBe(2);
    expect(jsonOf(bare).code).toBe("usage");
  });

  test("gates read their input from the authority, and the snapshot-document gate fails closed", async () => {
    const fixture = await activeFixture("cli-read-gates");
    // A snapshot claiming a held lease for the plan and a held merge lease.
    plantLeftoverSnapshot(fixture);

    // The plan's row + lease come from the DB (no lease there → missing), so the
    // file's holder never becomes the verdict.
    const lease = runCli(["lease", "verify", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID], fixture);
    expect(lease.exitCode).toBe(1);
    expect(lease.stderr).toContain("lease.verify.missing");
    expect(lease.stderr).toContain("execution authority (store");
    expect(lease.stderr).not.toContain("holder-from-the-file");

    // The workflow-wide merge lease is unclaimed in the DB although the file
    // claims one.
    const merge = runCli(["lease", "verify-integration", "--workflow", WORKFLOW_ID], fixture);
    expect(merge.exitCode).toBe(0);
    expect(merge.stdout).toContain("no integration_merge_lease (unclaimed)");
    expect(merge.stdout).toContain("execution authority (store");
    expect(merge.stdout).not.toContain("merge-from-the-file");

    // The phase gate's input is a whole snapshot document (whose plan rows carry
    // their session binding): it reports not-ready instead of inventing one.
    const gate = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--phase", "6"], fixture);
    expect(gate.exitCode).toBe(1);
    expect(gate.stderr).toContain("execution.consumer-not-ready");
    expect(gate.stdout).not.toContain("phase 6");

    // The CLI's OWN usage shape is decided before that refusal, so on the same
    // active authority a malformed invocation stays a usage error (exit 2):
    // reporting the route refusal (exit 1) here would tell a caller the gate
    // refused and send it after a token instead of fixing its command.
    const badPhase = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--phase", "7"], fixture);
    expect(badPhase.exitCode).toBe(2);
    expect(badPhase.stderr).toContain("usage: iteration gate --phase only supports 6");
    expect(badPhase.stderr).not.toContain("execution.consumer-not-ready");

    const noCompass = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID], fixture);
    expect(noCompass.exitCode).toBe(2);
    expect(noCompass.stderr).toContain("usage: iteration gate requires --compass");
    expect(noCompass.stderr).not.toContain("execution.consumer-not-ready");

    // The transition form is WELL FORMED here (a real compass): it is still the
    // authority that refuses it (exit 1), so the ordering fix narrowed nothing.
    const transition = runCli(
      ["iteration", "gate", "--workflow", WORKFLOW_ID, "--compass", writeCompass(fixture)],
      fixture,
    );
    expect(transition.exitCode).toBe(1);
    expect(transition.stderr).toContain("execution.consumer-not-ready");

    // The usage verdict does not depend on the route: a harness whose authority
    // is not active answers the same malformed shape the same way.
    const legacyHarness = await legacyFixture("cli-read-gate-legacy");
    const legacyBadPhase = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--phase", "7"], legacyHarness);
    expect(legacyBadPhase.exitCode).toBe(2);
    expect(legacyBadPhase.stderr).toContain("usage: iteration gate --phase only supports 6");
    expect(legacyBadPhase.stderr).not.toContain("execution.consumer-not-ready");
  });

  test("status validates the authority register, and refuses the retired file", async () => {
    const fixture = await activeFixture("cli-read-status");
    const snapshotPath = plantLeftoverSnapshot(fixture);
    // The file route would FAIL this document (v1 shape); the authority's own
    // register is what the command must answer with.
    writeJson(join(fixture.harnessDir, "status.json"), { version: 1, updated_at: "2000-01-01", plans: [] });

    const viaAuthority = runCli(["status", "validate"], fixture);
    expect(viaAuthority.exitCode).toBe(0);
    expect(viaAuthority.stdout).toContain("OK");
    expect(viaAuthority.stdout).toContain("execution authority (store");

    // The authority's own validation is real: a register row that disagrees with
    // its key is refused instead of reported OK.
    const handle = await openStore(fixture.context, "write");
    try {
      handle.db
        .prepare("update execution_registry set entry_json = ? where workflow_id = ?")
        .run(`${JSON.stringify({ id: "wf-somewhere-else", type: "plan", started_at: TS, dir: "workflows/other" })}\n`, WORKFLOW_ID);
    } finally {
      handle.close();
    }
    const inconsistent = runCli(["status", "validate"], fixture);
    expect(inconsistent.exitCode).toBe(1);
    expect(inconsistent.stderr).toContain("store.corrupt");
    expect(inconsistent.stdout).not.toContain("OK");

    const retiredFile = runCli(["status", "validate", join(fixture.harnessDir, "status.json")], fixture);
    expect(retiredFile.exitCode).toBe(1);
    expect(retiredFile.stderr).toContain("execution.consumer-not-ready");

    // A snapshot path already goes through the guarded engine reader: refused,
    // not validated.
    const retiredSnapshot = runCli(["status", "validate", snapshotPath], fixture);
    expect(retiredSnapshot.exitCode).toBe(1);
    expect(retiredSnapshot.stderr).toContain("execution.consumer-not-ready");

    // …while a legacy harness keeps validating its own file route unchanged.
    const legacy = await legacyFixture("cli-read-status-legacy");
    writeJson(join(legacy.harnessDir, "status.json"), { version: 2, updated_at: "2026-09-21", workflows: [] });
    const legacyOk = runCli(["status", "validate"], legacy);
    expect(legacyOk.exitCode).toBe(0);
    expect(legacyOk.stdout).toContain("OK");
  });

  test("refuses an unusable store instead of an empty view", async () => {
    const corrupt = await activeFixture("cli-read-corrupt");
    corruptStore(corrupt);

    const show = runCli(["plan", "show", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], corrupt);
    expect(show.exitCode).toBe(1);
    expect(jsonOf(show).code).toBe("store.corrupt");

    const lease = runCli(["lease", "verify", "--workflow", WORKFLOW_ID], corrupt);
    expect(lease.exitCode).toBe(1);
    expect(lease.stderr).toContain("store.corrupt");

    const status = runCli(["status", "validate"], corrupt);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain("store.corrupt");
    expect(status.stdout).not.toContain("OK");

    // No store at all: the file route stays in force, so the DB address form has
    // nothing to serve and says so (exit 2) rather than reporting an empty row.
    const absent = workspace("cli-read-absent");
    const noStore = runCli(["plan", "show", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], absent);
    expect(noStore.exitCode).toBe(2);
    expect(jsonOf(noStore).code).toBe("usage");
    const noStoreStatus = runCli(["status", "validate"], absent);
    expect(noStoreStatus.exitCode).toBe(1);
    expect(noStoreStatus.stdout).not.toContain("OK");
  });

  test("dashboard views refuse the projection route while the authority is active", async () => {
    const fixture = await activeFixture("cli-read-dashboard");
    plantLeftoverSnapshot(fixture);

    // A projection-derived view would present the retired root/snapshot bytes as
    // current execution state: not-ready instead.
    const projected = await readDashboardView({ context: fixture.context, view: "workflows" }).catch(
      (error: unknown) => error,
    );
    expect((projected as { code?: string }).code).toBe("execution.consumer-not-ready");

    // The issue authority is untouched by execution activation, so that view
    // still answers (and it is the proof the store itself is readable).
    const issues = await readDashboardView({ context: fixture.context, view: "issues" });
    expect(Array.isArray((issues.data as { items: unknown[] }).items)).toBe(true);
    expect(issues.storeRevision).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Cross-domain closure (S6): an unavailable authority refuses every read
 * ------------------------------------------------------------------------ */

describe("execution-cross-domain", () => {
  test("execution-cross-domain-cli-reads-refuse-an-unavailable-authority", async () => {
    const fixture = await activeFixture("cross-domain-cli");
    plantLeftoverSnapshot(fixture);
    const sessionPath = plantLeftoverSession(fixture);

    // The accepted authority answers while it is readable: the DB row, not the
    // file's Done plan and not its lease.
    const baseline = runCli(["plan", "show", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], fixture);
    expect(baseline.exitCode).toBe(0);
    expect((jsonOf(baseline).plan as Record<string, unknown>).status).toBe("Todo");

    // The active DB becomes unavailable. Every consumer of the authority now
    // refuses: none of them may fall back to the leftover root/snapshot/session
    // bytes, and none may serve a projection derived from them.
    corruptStore(fixture);

    const show = runCli(["plan", "show", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], fixture);
    expect(show.exitCode).toBe(1);
    expect(jsonOf(show).code).toBe("store.corrupt");
    expect(show.stdout).not.toContain("plan-from-the-file");

    // The retired file form is refused on the same unreadable store too: the
    // leftover session file is never promoted to an authority answer.
    const fileForm = runCli(["plan", "show", "--session", sessionPath, "--json"], fixture);
    expect(fileForm.exitCode).toBe(1);
    expect(jsonOf(fileForm).code).toBe("store.corrupt");

    const status = runCli(["status", "validate"], fixture);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain("store.corrupt");
    expect(status.stdout).not.toContain("OK");

    const lease = runCli(["lease", "verify", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID], fixture);
    expect(lease.exitCode).toBe(1);
    expect(lease.stderr).toContain("store.corrupt");

    const merge = runCli(["lease", "verify-integration", "--workflow", WORKFLOW_ID], fixture);
    expect(merge.exitCode).toBe(1);
    expect(merge.stderr).toContain("store.corrupt");

    const gate = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--compass", writeCompass(fixture)], fixture);
    expect(gate.exitCode).toBe(1);
    expect(gate.stderr).toContain("store.corrupt");

    // The dashboard's projection boundary is not an authority on an unreadable
    // store either -- for the execution view or any other.
    const projected = await readDashboardView({ context: fixture.context, view: "workflows" }).catch((error: unknown) => error);
    expect(
      projected !== null && typeof projected === "object" && "code" in projected ? projected.code : undefined,
    ).toBe("store.corrupt");
    const issues = await readDashboardView({ context: fixture.context, view: "issues" }).catch((error: unknown) => error);
    expect(issues !== null && typeof issues === "object" && "code" in issues ? issues.code : undefined).toBe(
      "store.corrupt",
    );

    // The retired bytes are untouched: never promoted, never rewritten.
    expect(readFileSync(sessionPath, "utf8")).toContain("leftover-session");
  });
});
