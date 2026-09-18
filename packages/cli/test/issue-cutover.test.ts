/**
 * CLI issue cutover: the retired register verbs and the store-backed findings
 * authority.
 *
 * The scoped findings operations moved to `mstar plan issue-add|issue-close`
 * over the core issue domain, and the legacy register commands are gone. Every
 * case runs the real CLI entry as a subprocess and asserts the observable
 * contract:
 *
 *  - command results come from `store.db` (read back through the CLI's own
 *    `mstar issue list`, never from the CLI's claim);
 *  - the retired verbs (`plan residual-add|residual-close`,
 *    `status backlog-register|backlog-close`, `status archive-residuals`,
 *    `persist residuals`) refuse with the migration path and write nothing —
 *    there is no write-through compatibility alias;
 *  - a missing, corrupt or staged store never yields an empty rollup or a
 *    passing findings gate;
 *  - no project register is written, including through a `persist json` alias.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
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
import { dirname, join, resolve } from "node:path";
import { initializeStore, openStore } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

const WORKFLOW_ID = "wf-issues";
const PLAN_ID = "plan-issues";
const PROJECT_ID = "proj-issues";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Spawn env with ambient harness env vars pinned out (fixtures must not leak). */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd,
    env: { ...cliEnv(), ...env },
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

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A plan row in the `validatePlanRow` shape, carrying its project id. */
function planRow(): Record<string, unknown> {
  return {
    id: PLAN_ID,
    plan_id: PLAN_ID,
    title: `Plan ${PLAN_ID}`,
    file: `.mstar/plans/${PLAN_ID}.md`,
    status: "Todo",
    metadata: { project_id: PROJECT_ID },
  };
}

function assignmentText(input: { harness: string; planPath: string; worktreePath: string; sddDir: string }): string {
  return [
    `# Assignment — ${PLAN_ID}`,
    "",
    `**Control harness root**: ${input.harness}`,
    `**Workflow id**: ${WORKFLOW_ID}`,
    `**Plan id**: ${PLAN_ID}`,
    `**Plan Path**: ${input.planPath}`,
    `**Worktree Path**: ${input.worktreePath}`,
    `**Working branch**: feature/plan-issues`,
    `**SDD dir**: ${input.sddDir}`,
    "**Execute as**: project-manager",
    "**Execution scope**: plan",
    "**Delegation**: allowed (plan-local subagents only)",
    "**Prepare gate**: go",
    "**QA gate**: mandatory",
    "**Findings cleanup**: zero-residual",
    "",
    "Body.",
    "",
  ].join("\n");
}

interface Fixture {
  root: string;
  harness: string;
  registerPath: string;
  snapshotPath: string;
  planSession: string;
}

/** A real Git root + an ACTIVE store + one prepared, bound plan session. */
function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-cutover-")));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: root,
  });

  const harness = join(root, ".mstar");
  const snapshotPath = join(harness, "workflows", WORKFLOW_ID, "snapshot.json");
  const registerPath = join(harness, "projects", PROJECT_ID, "residuals.json");
  const planPath = join(harness, "plans", `${PLAN_ID}.md`);
  const sddDir = join(harness, "sdd", PLAN_ID);
  const worktreePath = join(root, "wt-issues");
  writeText(planPath, "# plan issues\n");
  writeText(join(sddDir, "evidence.md"), "# evidence\n");
  mkdirSync(worktreePath, { recursive: true });

  // The active store comes first: `store init` is create-only for a genuinely
  // empty workspace, so it must precede status.json's workflow registration.
  const init = runCli(["store", "init", "--harness", harness, "--json"], root);
  expect(init.exitCode).toBe(0);

  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-18T00:00:00Z",
    workflows: [
      {
        id: WORKFLOW_ID,
        status: "running",
        type: "iteration",
        started_at: "2026-09-18T00:00:00Z",
        dir: `workflows/${WORKFLOW_ID}`,
      },
    ],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "iteration",
    status: "running",
    started_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
    branch: { base: "main" },
    plans: [planRow()],
  });
  writeText(join(sddDir, "assignment.md"), assignmentText({ harness, planPath, worktreePath, sddDir }));

  const bound = runCli(["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--json"], root);
  expect(bound.exitCode).toBe(0);
  const coordinator = String(jsonOf(bound).session_file);
  const view = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID, "--json"], root);
  expect(view.exitCode).toBe(0);
  const prepared = runCli(
    [
      "plan",
      "prepare",
      "--session",
      coordinator,
      "--plan",
      PLAN_ID,
      "--assignment",
      join(sddDir, "assignment.md"),
      "--expect",
      String(jsonOf(view).revision),
      "--json",
    ],
    root,
  );
  expect(prepared.exitCode).toBe(0);
  expect(jsonOf(prepared).outcome).toBe("prepared");

  const planBound = runCli(["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], root);
  expect(planBound.exitCode).toBe(0);
  return { root, harness, registerPath, snapshotPath, planSession: String(jsonOf(planBound).session_file) };
}

/** One capture entry as `plan issue-add` takes it (the core input minus projectId). */
function issueEntryOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Stale rollup after the cutover",
    kind: "bug",
    severity: "high",
    impact: "an acceptance is not met",
    acceptance: "the finding is fixed and verified",
    sourceIdentity: "issue-cutover/stale-rollup",
    rootCauseKey: "cutover-root-cause",
    acceptanceKey: "cutover-acceptance",
    occurrenceKey: "cutover-occ-1",
    sourceKind: "qc",
    location: "packages/cli/src/index.ts",
    observedBehavior: "observed by the cutover fixture",
    evidence: ["fixture evidence"],
    discoveredAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

/** The row `coordination.revision` from `plan show`. */
function rowRevision(fixture: Fixture, session: string): number {
  const show = runCli(["plan", "show", "--session", session, "--json"], fixture.root);
  expect(show.exitCode).toBe(0);
  return Number(jsonOf(show).revision);
}

/** The issues the CLI's own `mstar issue list` reports (the DB truth). */
function listedIssues(fixture: Fixture, extraArgs: string[] = []): Array<Record<string, unknown>> {
  const result = runCli(["issue", "list", "--harness", fixture.harness, "--json", ...extraArgs], fixture.root);
  expect(result.exitCode).toBe(0);
  const envelope = jsonOf(result);
  const data = envelope.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`issue list returned no data: ${result.stdout}`);
  }
  const items: unknown = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) throw new Error(`issue list returned no items: ${result.stdout}`);
  return items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
}

/** Assert the harness carries no project register anywhere (the retired artifact). */
function expectNoRegister(fixture: Fixture): void {
  expect(existsSync(fixture.registerPath)).toBe(false);
  expect(existsSync(join(fixture.harness, "projects"))).toBe(false);
}

describe("mstar plan issue-add|issue-close — DB-only scoped findings (G2b)", () => {
  test("captures and closes issues in store.db; no register file is ever written", () => {
    const fixture = makeFixture();
    const before = readFileSync(fixture.snapshotPath, "utf8");

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf()]);
    const added = runCli(
      [
        "plan",
        "issue-add",
        "--session",
        fixture.planSession,
        "--file",
        entriesPath,
        "--expect",
        String(rowRevision(fixture, fixture.planSession)),
        "--json",
      ],
      fixture.root,
    );
    expect(added.exitCode).toBe(0);
    const addedPayload = jsonOf(added);
    expect(addedPayload.outcome).toBe("issue-added");
    const receipts = addedPayload.issues;
    if (!Array.isArray(receipts) || receipts.length !== 1) throw new Error(`no issue receipt: ${added.stdout}`);
    const receipt = receipts[0] as Record<string, unknown>;
    const issueId = String(receipt.issue_id);
    expect(issueId.startsWith("I-")).toBe(true);

    // The DB is the only target, and the CLI reads it back through its own
    // issue surface — the register path stays absent.
    const open = listedIssues(fixture);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(issueId);
    expect(open[0]!.title).toBe("Stale rollup after the cutover");
    expectNoRegister(fixture);

    // The authoritative rollup and the closure gate both read that same row.
    const openRollup = runCli(["status", "tech-debt", "--harness", fixture.harness], fixture.root);
    expect(openRollup.exitCode).toBe(0);
    expect(openRollup.stdout).toContain("total_open: 1");
    expect(openRollup.stdout).toContain(`by_project: {"${PROJECT_ID}":1}`);
    const blocked = runCli(
      ["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"],
      fixture.root,
    );
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain(issueId);

    const evidencePath = join(fixture.root, "evidence.json");
    writeJson(evidencePath, {
      reason: "fixed in the cutover",
      references: ["packages/cli/src/index.ts"],
      alignmentRef: "QA gate acceptance 2026-09-19",
    });
    const closed = runCli(
      [
        "plan",
        "issue-close",
        "--session",
        fixture.planSession,
        "--issue",
        issueId,
        "--disposition",
        "resolved",
        "--file",
        evidencePath,
        "--expect-issue",
        String(receipt.revision),
        "--expect",
        String(rowRevision(fixture, fixture.planSession)),
        "--json",
      ],
      fixture.root,
    );
    expect(closed.exitCode).toBe(0);
    expect(jsonOf(closed).outcome).toBe("issue-closed");

    expect(listedIssues(fixture)).toHaveLength(0);
    expect(listedIssues(fixture, ["--disposition", "resolved"])).toHaveLength(1);
    const emptyRollup = runCli(["status", "tech-debt", "--harness", fixture.harness], fixture.root);
    expect(emptyRollup.stdout).toContain("total_open: 0");
    const released = runCli(
      ["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"],
      fixture.root,
    );
    expect(released.exitCode).toBe(0);
    expect(released.stdout).toContain(`findings-cleanup ${PLAN_ID}: OK`);
    expectNoRegister(fixture);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
  });

  test("the view advertises the CLI's own issue verbs and no register version", () => {
    const fixture = makeFixture();
    const show = runCli(["plan", "show", "--session", fixture.planSession, "--json"], fixture.root);
    expect(show.exitCode).toBe(0);
    const payload = jsonOf(show);
    expect(payload.register_version).toBeUndefined();
    expect(payload.allowed_operations).toEqual(["progress", "issue-add", "issue-close", "handoff"]);
  });
});

describe("mstar issue — the retired commands refuse with the migration path (G2b)", () => {
  test("plan residual-add|residual-close: retired, write nothing", () => {
    const fixture = makeFixture();
    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf()]);

    for (const [verb, replacement] of [
      ["residual-add", "issue-add"],
      ["residual-close", "issue-close"],
    ] as const) {
      const refused = runCli(
        ["plan", verb, "--session", fixture.planSession, "--file", entriesPath, "--expect", "0", "--json"],
        fixture.root,
      );
      expect(`${verb} -> ${refused.exitCode}`).toBe(`${verb} -> 1`);
      const payload = jsonOf(refused);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe("plan.verb-retired");
      expect(String(payload.message)).toContain(`\`mstar plan ${replacement}\``);
    }
    expect(listedIssues(fixture)).toHaveLength(0);
    expectNoRegister(fixture);
  });

  test("status backlog-register|backlog-close and archive-residuals: removed, name the replacement", () => {
    const fixture = makeFixture();
    for (const [verb, replacement] of [
      ["backlog-register", "plan issue-add"],
      ["backlog-close", "plan issue-close"],
    ] as const) {
      const refused = runCli(
        ["status", verb, "--harness", fixture.harness, "--key", "k1", "--entry", "{}", "--id", "x"],
        fixture.root,
      );
      expect(`${verb} -> ${refused.exitCode}`).toBe(`${verb} -> 1`);
      expect(refused.stderr).toContain(`status ${verb}: removed`);
      expect(refused.stderr).toContain(`mstar ${replacement}`);
    }

    const archived = runCli(["status", "archive-residuals"], fixture.root);
    expect(archived.exitCode).toBe(1);
    expect(archived.stderr).toContain("status archive-residuals: removed");
    expect(archived.stderr).toContain("mstar plan issue-close");
    expectNoRegister(fixture);
  });

  test("persist residuals and a json alias to a project register: refused, no file written", () => {
    const fixture = makeFixture();
    const payloadPath = join(fixture.root, "register.json");
    writeJson(payloadPath, { entries: {} });

    const retiredKind = runCli(
      ["persist", "residuals", "--key", PROJECT_ID, "--file", payloadPath],
      fixture.root,
      { MSTAR_HARNESS_DIR: fixture.harness },
    );
    expect(retiredKind.exitCode).toBe(1);
    expect(retiredKind.stderr).toContain("`persist residuals` is retired");

    const alias = runCli(
      ["persist", "json", "--key", fixture.registerPath, "--file", payloadPath],
      fixture.root,
      { MSTAR_HARNESS_DIR: fixture.harness },
    );
    expect(alias.exitCode).toBe(1);
    expect(alias.stderr).toContain("project registers are retired migration history");
    expectNoRegister(fixture);
  });
});

describe("mstar status — the issue authority is never read as an empty rollup (G2b)", () => {
  test("a missing store refuses the rollup and the findings gate", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-nostore-")));
    roots.push(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });

    const rollup = runCli(["status", "tech-debt", "--harness", harness], root);
    expect(rollup.exitCode).toBe(1);
    expect(rollup.stderr).toContain("store.not-initialized");
    expect(rollup.stdout).not.toContain("total_open");

    const gate = runCli(["status", "findings-cleanup", PLAN_ID, "--harness", harness], root);
    expect(gate.exitCode).toBe(1);
    expect(gate.stderr).toContain("store.not-initialized");
    expect(gate.stdout).not.toContain("findings-cleanup");
  });

  test("a corrupt store refuses the rollup instead of reporting no findings", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-corrupt-")));
    roots.push(root);
    const harness = join(root, ".mstar");
    writeText(join(harness, "store.db"), "this is not a SQLite database");
    // An empty WAL beside a hand-written file is what a torn copy looks like.
    const rollup = runCli(["status", "tech-debt", "--harness", harness], root);
    expect(rollup.exitCode).toBe(1);
    expect(rollup.stderr).toContain("store.corrupt");
    expect(rollup.stdout).not.toContain("total_open");
  });

  test("a staged store is not the authority: the rollup and the gate both refuse", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-staged-")));
    roots.push(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });

    const handle = await initializeStore({ harnessDir: harness });
    handle.close();
    const write = await openStore({ harnessDir: harness }, "write");
    write.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    write.close();
    // A read in THIS process first: a child's first read of a store the runner
    // just wrote intermittently fails to open (task-3 report §observations).
    const seal = await openStore({ harnessDir: harness }, "read");
    seal.close();

    const rollup = runCli(["status", "tech-debt", "--harness", harness], root);
    expect(rollup.exitCode).toBe(1);
    expect(rollup.stderr).toContain("store.not-active");
    expect(rollup.stdout).not.toContain("total_open");

    const gate = runCli(["status", "findings-cleanup", PLAN_ID, "--harness", harness], root);
    expect(gate.exitCode).toBe(1);
    expect(gate.stderr).toContain("store.not-active");
  });

  test("no command in the cutover family leaves a residual register behind", () => {
    const fixture = makeFixture();
    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf()]);
    runCli(
      [
        "plan",
        "issue-add",
        "--session",
        fixture.planSession,
        "--file",
        entriesPath,
        "--expect",
        String(rowRevision(fixture, fixture.planSession)),
        "--json",
      ],
      fixture.root,
    );
    runCli(["status", "tech-debt", "--harness", fixture.harness], fixture.root);

    // Not just the canonical path: no file named residuals.json anywhere under
    // the harness, whatever directory a retired command might have chosen.
    const found = readdirSync(fixture.harness, { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith("residuals.json"));
    expect(found).toEqual([]);
  });
});
