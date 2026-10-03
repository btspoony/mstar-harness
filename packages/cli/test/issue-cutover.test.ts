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
import { encodeExecutionSessionRef, initializeExecutionAuthority, initializeStore, openStore, readExecutionAuthority, type ExecutionSessionRef } from "@mstar-harness/engine";

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
  const currentArgs = args.filter((arg) => arg !== "--json");
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...currentArgs], {
    cwd,
    env: { ...cliEnv(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  const output = { ...envelope, ok: envelope.status === "ok" };
  let data = envelope.data;
  while (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    Object.assign(output, record);
    for (const key of ["session", "details", "view"] as const) {
      const nested = record[key];
      if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) Object.assign(output, nested);
    }
    data = record.data;
  }
  if (envelope.details !== null && typeof envelope.details === "object" && !Array.isArray(envelope.details)) {
    Object.assign(output, envelope.details);
  }
  return output;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** An iteration row in the registration API shape, retaining project scope. */
function planRow(): Record<string, unknown> {
  return {
    id: PLAN_ID,
    title: `Plan ${PLAN_ID}`,
    file: `plans/${PLAN_ID}.md`,
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
  planSessionId: string;
}
function initializeFixtureStore(harness: string, cwd: string): void {
  const engineEntry = join(CLI_ROOT, "../engine/src/index.ts");
  const script = `import { createExecutionWorkflow, initializeExecutionAuthority, initializeStore, registerCatalogEntity } from ${JSON.stringify(engineEntry)};
const context = { harnessDir: ${JSON.stringify(harness)} };
const store = await initializeStore(context); store.close();
const initialized = await initializeExecutionAuthority(context);
await registerCatalogEntity(context, { kind: "plan", id: ${JSON.stringify(PLAN_ID)}, title: ${JSON.stringify(`Plan ${PLAN_ID}`)}, rootKind: "plans", relativePath: ${JSON.stringify(`plans/${PLAN_ID}.md`)} }, { operationId: "register-plan", actor: "issue-cutover.test" });
const caller = { sessionId: "fixture-coordinator", role: "coordinator", workflowId: ${JSON.stringify(WORKFLOW_ID)}, planId: null };
await createExecutionWorkflow({ harnessDir: ${JSON.stringify(harness)}, caller }, {
  entry: { id: ${JSON.stringify(WORKFLOW_ID)}, type: "plan", started_at: "2026-09-18T00:00:00Z", dir: ${JSON.stringify(`workflows/${WORKFLOW_ID}`)} },
  snapshot: {
    schema_version: 1, id: ${JSON.stringify(WORKFLOW_ID)}, type: "plan", status: "running",
    started_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-18T00:00:00Z",
    plans: [${JSON.stringify(planRow())}], delivery_kind: "development",
    branch: { source: "feature/plan-issues", target: "main" },
  },
  expected: initialized.token, operationId: "create-issues-workflow",
});`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`fixture store initialization failed: ${result.stdout.toString()}${result.stderr.toString()}`);
  }
}


/** A real Git root + an ACTIVE store + one prepared, bound plan session. */
async function makeFixture(): Promise<Fixture> {
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

  // Initialize the active DB directly; the CLI store-init command is not an
  // input surface for test setup.
  initializeFixtureStore(harness, root);
  writeJson(snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "running",
    started_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
    plans: [planRow()],
    delivery_kind: "development",
    branch: { source: "feature/plan-issues", target: "main" },
  });

  writeText(join(sddDir, "assignment.md"), assignmentText({ harness, planPath, worktreePath, sddDir }));

  const planSessionId = "fixture-plan-pm";
  const coordinatorSessionId = "fixture-coordinator";
  const coordinatorWorkflowToken = (await readExecutionAuthority({ harnessDir: harness }, { workflowId: WORKFLOW_ID })).token;
  const coordinatorBound = runCli(
    [
      "plan",
      "bind",
      "--execution",
      "--coordinator",
      "--workflow",
      WORKFLOW_ID,
      "--expect",
      coordinatorWorkflowToken,
      "--operation",
      "bind-coordinator",
      "--session-id",
      coordinatorSessionId,
      "--harness",
      harness,
    ],
    root,
  );
  expect(coordinatorBound).toMatchObject({ exitCode: 0 });
  const coordinatorRef = encodeExecutionSessionRef(jsonOf(coordinatorBound).data as ExecutionSessionRef);
  const assignmentPath = join(sddDir, "assignment.md");
  const prepareToken = (await readExecutionAuthority({ harnessDir: harness }, { workflowId: WORKFLOW_ID, planId: PLAN_ID })).token;
  const prepared = runCli(
    [
      "plan",
      "prepare",
      "--session-ref",
      coordinatorRef,
      "--plan",
      PLAN_ID,
      "--assignment",
      assignmentPath,
      "--expect",
      prepareToken,
      "--operation",
      "prepare-issues",
      "--session-id",
      coordinatorSessionId,
      "--harness",
      harness,
    ],
    root,
  );
  if (prepared.exitCode !== 0) throw new Error(`active prepare failed: ${prepared.stdout}${prepared.stderr}`);

  const planToken = (await readExecutionAuthority({ harnessDir: harness }, { workflowId: WORKFLOW_ID, planId: PLAN_ID })).token;
  const planBound = runCli(
    [
      "plan",
      "bind",
      "--execution",
      "--workflow",
      WORKFLOW_ID,
      "--plan",
      PLAN_ID,
      "--expect",
      planToken,
      "--operation",
      "bind-plan-pm",
      "--session-id",
      planSessionId,
      "--harness",
      harness,
    ],
    root,
  );
  expect(planBound.exitCode).toBe(0);
  const planSession = encodeExecutionSessionRef(jsonOf(planBound).data as ExecutionSessionRef);
  return { root, harness, registerPath, snapshotPath, planSession, planSessionId };
}

/** One captured issue entry with its owning project. */
function issueEntryOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
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

/** The active plan CAS token reported by the session-bound plan view. */
function planToken(fixture: Fixture): string {
  const show = runCli(
    ["plan", "show", "--session-ref", fixture.planSession, "--plan", PLAN_ID, "--session-id", fixture.planSessionId, "--harness", fixture.harness],
    fixture.root,
  );
  expect(show.exitCode).toBe(0);
  return String(jsonOf(show).token);
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
  test("captures and closes issues in store.db; no register file is ever written", async () => {
    const fixture = await makeFixture();
    const before = readFileSync(fixture.snapshotPath, "utf8");

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf()]);
    const added = runCli(
      [
        "plan",
        "issue-add",
        "--session-ref",
        fixture.planSession,
        "--file",
        entriesPath,
        "--expect",
        planToken(fixture),
        "--operation",
        "issue-add-1",
        "--session-id",
        fixture.planSessionId,
        "--harness",
        fixture.harness,
      ],
      fixture.root,
    );
    expect(added.exitCode).toBe(0);
    const addedPayload = jsonOf(added);
    expect((addedPayload.plan as Record<string, unknown>).id).toBe(PLAN_ID);
    expect((addedPayload.coordination as Record<string, unknown>).revision).toBeGreaterThan(0);

    // The DB is the only target, and the CLI reads it back through its own
    // issue surface — the register path stays absent.
    const open = listedIssues(fixture);
    expect(open).toHaveLength(1);
    const issueId = String(open[0]!.id);
    expect(issueId.startsWith("I-")).toBe(true);
    expect(open[0]!.title).toBe("Stale rollup after the cutover");
    expectNoRegister(fixture);

    // The authoritative rollup and the closure gate both read that same row.
    const openRollup = runCli(["status", "tech-debt", "--harness", fixture.harness], fixture.root);
    expect(openRollup.exitCode).toBe(0);
    expect(jsonOf(openRollup).total_open).toBe(1);
    expect(jsonOf(openRollup).by_project).toEqual({ [PROJECT_ID]: 1 });
    const blocked = runCli(
      ["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"],
      fixture.root,
    );
    expect(blocked.exitCode).toBe(1);
    expect(JSON.stringify(jsonOf(blocked).details)).toContain(issueId);

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
        "--session-ref",
        fixture.planSession,
        "--issue",
        issueId,
        "--disposition",
        "resolved",
        "--file",
        evidencePath,
        "--expect-issue",
        String(open[0]!.revision),
        "--expect",
        planToken(fixture),
        "--operation",
        "issue-close-1",
        "--session-id",
        fixture.planSessionId,
        "--harness",
        fixture.harness,
      ],
      fixture.root,
    );
    expect(closed.exitCode).toBe(0);
    expect(jsonOf(closed).status).toBe("ok");

    expect(listedIssues(fixture)).toHaveLength(0);
    expect(listedIssues(fixture, ["--disposition", "resolved"])).toHaveLength(1);
    const emptyRollup = runCli(["status", "tech-debt", "--harness", fixture.harness], fixture.root);
    expect(jsonOf(emptyRollup).total_open).toBe(0);
    const released = runCli(
      ["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"],
      fixture.root,
    );
    expect(released.exitCode).toBe(0);
    expect(jsonOf(released).data).toMatchObject({ planId: PLAN_ID, violations: [] });
    expectNoRegister(fixture);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
  }, 30000);

  test("the view advertises the CLI's own issue verbs and no register version", async () => {
    const fixture = await makeFixture();
    const show = runCli(["plan", "show", "--session-ref", fixture.planSession, "--plan", PLAN_ID, "--session-id", fixture.planSessionId, "--harness", fixture.harness], fixture.root);
    expect(show.exitCode).toBe(0);
    const payload = jsonOf(show);
    expect(payload.register_version).toBeUndefined();
    expect(payload.plan).toMatchObject({ id: PLAN_ID, status: "InProgress" });
    expect(payload.session).toMatchObject({ role: "plan-pm", planId: PLAN_ID });
  });
});

describe("mstar issue — the retired commands refuse with the migration path (G2b)", () => {
  test("plan residual-add|residual-close: retired, write nothing", async () => {
    const fixture = await makeFixture();
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

  test("status backlog-register|backlog-close and archive-residuals: removed, name the replacement", async () => {
    const fixture = await makeFixture();
    for (const [verb, replacement] of [
      ["backlog-register", "plan issue-add"],
      ["backlog-close", "plan issue-close"],
    ] as const) {
      const refused = runCli(["status", verb], fixture.root);
      expect(`${verb} -> ${refused.exitCode}`).toBe(`${verb} -> 1`);
      expect(jsonOf(refused).message).toContain(`status ${verb}: removed`);
      expect(jsonOf(refused).message).toContain(`mstar ${replacement}`);
    }

    const archived = runCli(["status", "archive-residuals"], fixture.root);
    expect(archived.exitCode).toBe(1);
    expect(jsonOf(archived).message).toContain("status archive-residuals: removed");
    expect(jsonOf(archived).message).toContain("mstar plan issue-close");
    expectNoRegister(fixture);
  });

  test("removed persist residuals and the json alias cannot write a register", async () => {
    const fixture = await makeFixture();
    const payloadPath = join(fixture.root, "register.json");
    writeJson(payloadPath, { entries: {} });

    const retiredKind = runCli(
      ["persist", "residuals", "--key", PROJECT_ID, "--file", payloadPath],
      fixture.root,
      { MSTAR_HARNESS_DIR: fixture.harness },
    );
    expect(retiredKind.exitCode).toBe(2);
    expect(jsonOf(retiredKind).code).toBe("command.invalid-input");

    const alias = runCli(
      ["persist", "json", "--key", fixture.registerPath, "--file", payloadPath],
      fixture.root,
      { MSTAR_HARNESS_DIR: fixture.harness },
    );
    expect(alias.exitCode).toBe(2);
    expect(jsonOf(alias).code).toBe("command.invalid-input");
    expectNoRegister(fixture);
  });
});

describe("mstar issue actor-only mutations", () => {
  test("issue close help omits execution and session-envelope options", () => {
    const help = runCli(["issue", "close", "--help"], process.cwd());
    expect(help.exitCode).toBe(0);
    expect(help.stdout).not.toMatch(/--execution|--session|--workflow|--plan|--coordinator|--session-id/);
    for (const flag of ["--operation-id", "--actor", "--expect", "--payload", "--file"]) expect(help.stdout).toContain(flag);
  });

  async function capture(fixture: Fixture, suffix: string): Promise<string> {
    const result = runCli([
      "issue", "add", "--operation-id", `add-${suffix}`, "--actor", "project-manager",
      "--payload", JSON.stringify(issueEntryOf({
        sourceIdentity: `active-${suffix}`, rootCauseKey: `active-root-${suffix}`,
        acceptanceKey: `active-accept-${suffix}`, occurrenceKey: `active-occ-${suffix}`,
      })),
      "--harness", fixture.harness,
    ], fixture.root);
    expect(result.exitCode).toBe(0);
    return String(jsonOf(result).issueId);
  }

  function mutate(fixture: Fixture, verb: string, issueId: string, operationId: string, payload: Record<string, unknown>): RunResult {
    return runCli([
      "issue", verb, "--operation-id", operationId, "--actor", "project-manager", "--expect", "1",
      "--id", issueId, "--payload", JSON.stringify(payload), "--harness", fixture.harness,
    ], fixture.root);
  }

  test("close, triage, supersede, and link succeed on ACTIVE authority with actor alone", async () => {
    const fixture = await makeFixture();
    const closedId = await capture(fixture, "close");
    expect(mutate(fixture, "close", closedId, "actor-close", {
      reason: "accepted", references: ["qa.md"], alignmentRef: "PM acceptance record",
    }).exitCode).toBe(0);
    expect(jsonOf(runCli(["issue", "show", "--id", closedId, "--harness", fixture.harness], fixture.root)).disposition).toBe("resolved");

    const triageId = await capture(fixture, "triage");
    expect(mutate(fixture, "triage", triageId, "actor-triage", { reason: "reclassify", severity: "medium" }).exitCode).toBe(0);
    expect(jsonOf(runCli(["issue", "show", "--id", triageId, "--harness", fixture.harness], fixture.root)).severity).toBe("medium");

    const canonicalId = await capture(fixture, "canonical");
    const supersededId = await capture(fixture, "superseded");
    expect(mutate(fixture, "supersede", supersededId, "actor-supersede", { reason: "replaced", canonicalIssueId: canonicalId }).exitCode).toBe(0);
    expect(jsonOf(runCli(["issue", "show", "--id", supersededId, "--harness", fixture.harness], fixture.root)).disposition).toBe("superseded");

    const linkedId = await capture(fixture, "linked");
    expect(mutate(fixture, "link", linkedId, "actor-link", { kind: "plan", target: "unregistered-plan-label" }).exitCode).toBe(0);
    expect(jsonOf(runCli(["issue", "show", "--id", linkedId, "--harness", fixture.harness], fixture.root)).provenance).toContainEqual(
      expect.objectContaining({ kind: "plan", target: "unregistered-plan-label", origin: "unscoped" }),
    );
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
    expect(jsonOf(rollup).code).toBe("store.not-initialized");
    expect(jsonOf(rollup).data).toBeUndefined();

    const gate = runCli(["status", "findings-cleanup", PLAN_ID, "--harness", harness], root);
    expect(gate.exitCode).toBe(1);
    expect(jsonOf(gate).code).toBe("store.not-initialized");
    expect(jsonOf(gate).data).toBeUndefined();
  });

  test("a corrupt store refuses the rollup instead of reporting no findings", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-corrupt-")));
    roots.push(root);
    const harness = join(root, ".mstar");
    writeText(join(harness, "store.db"), "this is not a SQLite database");
    // An empty WAL beside a hand-written file is what a torn copy looks like.
    const rollup = runCli(["status", "tech-debt", "--harness", harness], root);
    expect(rollup.exitCode).toBe(1);
    expect(jsonOf(rollup).code).toBe("store.corrupt");
    expect(jsonOf(rollup).data).toBeUndefined();
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
    expect(jsonOf(rollup).code).toBe("store.not-active");
    expect(jsonOf(rollup).data).toBeUndefined();

    const gate = runCli(["status", "findings-cleanup", PLAN_ID, "--harness", harness], root);
    expect(gate.exitCode).toBe(1);
    expect(jsonOf(gate).code).toBe("store.not-active");
  });

  test("no command in the cutover family leaves a residual register behind", async () => {
    const fixture = await makeFixture();
    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf()]);
    runCli(
      [
        "plan",
        "issue-add",
        "--session-ref",
        fixture.planSession,
        "--file",
        entriesPath,
        "--expect",
        planToken(fixture),
        "--operation",
        "issue-add-final",
        "--session-id",
        fixture.planSessionId,
        "--harness",
        fixture.harness,
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
