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
 *  - the retired verbs (`status backlog-register|backlog-close`,
 *    `status archive-residuals`, `persist residuals`) refuse with the migration
 *    path and write nothing —
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
import { dirname, join } from "node:path";
import {
  encodeExecutionSessionRef,
  initializeCollaborationStore,
  initializeStore,
  openStore,
  readExecutionAuthority,
  resolveCollaborationLocation,
  type ExecutionSessionRef,
} from "@mstar-harness/engine";
import { CLI_ROOT, cliEnv, runCli as spawnCli, writeFixtureRepoId, type RunResult } from "./harness";

const WORKFLOW_ID = "wf-issues";
const PLAN_ID = "plan-issues";
const PROJECT_ID = "proj-issues";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  return spawnCli(args.filter((arg) => arg !== "--json"), { cwd, env });
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

interface Fixture {
  root: string;
  harness: string;
  registerPath: string;
  snapshotPath: string;
  coordinatorRef: string;
  coordinatorSessionId: string;
}
function initializeFixtureStore(harness: string, cwd: string): void {
  const engineEntry = join(CLI_ROOT, "../engine/src/index.ts");
  const script = `import { createExecutionWorkflow, ensureCollaborationAuthority, initializeStore, readExecutionAuthority, registerCatalogEntity } from ${JSON.stringify(engineEntry)};
const context = { harnessDir: ${JSON.stringify(harness)} };
const store = await initializeStore(context); store.close();
await ensureCollaborationAuthority(context);
const initialized = await readExecutionAuthority(context);
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
  writeFixtureRepoId(root);
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
  // A REAL checkout on the branch prepare records: prepare validates the actual
  // checkout and branch, not merely that a directory exists.
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/plan-issues", worktreePath], { cwd: root });

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
  const prepareToken = (await readExecutionAuthority({ harnessDir: harness }, { workflowId: WORKFLOW_ID, planId: PLAN_ID })).token;
  const prepared = runCli(
    [
      "plan",
      "prepare",
      "--session-ref",
      coordinatorRef,
      "--plan",
      PLAN_ID,
      "--worktree-path",
      worktreePath,
      "--working-branch",
      "feature/plan-issues",
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

  return { root, harness, registerPath, snapshotPath, coordinatorRef, coordinatorSessionId };
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
    ["plan", "show", "--session-ref", fixture.coordinatorRef, "--plan", PLAN_ID, "--session-id", fixture.coordinatorSessionId, "--harness", fixture.harness],
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
  test("captures into the issue store, links the plan, and closes under the issue CAS without a register", async () => {
    const fixture = await makeFixture();
    const before = readFileSync(fixture.snapshotPath, "utf8");

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf()]);
    const added = runCli(
      [
        "plan",
        "issue-add",
        "--session-ref",
        fixture.coordinatorRef,
        "--plan",
        PLAN_ID,
        "--file",
        entriesPath,
        "--expect",
        planToken(fixture),
        "--operation",
        "issue-add-1",
        "--session-id",
        fixture.coordinatorSessionId,
        "--harness",
        fixture.harness,
      ],
      fixture.root,
    );
    expect(added.exitCode, added.stdout).toBe(0);
    expect(jsonOf(added).status).toBe("ok");

    // The DB is the only target: the CLI's own `issue list` reads it back, and
    // no project register appeared anywhere under the harness.
    const open = listedIssues(fixture);
    expect(open).toHaveLength(1);
    const issueId = String(open[0]!.id);

    const evidencePath = join(fixture.root, "evidence.json");
    writeJson(evidencePath, {
      reason: "fixed by the reviewer round",
      references: ["packages/cli/src/index.ts"],
      alignmentRef: "QA gate acceptance 2026-09-19",
    });
    const closed = runCli(
      [
        "plan",
        "issue-close",
        "--session-ref",
        fixture.coordinatorRef,
        "--plan",
        PLAN_ID,
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
        fixture.coordinatorSessionId,
        "--harness",
        fixture.harness,
      ],
      fixture.root,
    );
    expect(closed.exitCode, closed.stdout).toBe(0);
    expect(jsonOf(closed).status).toBe("ok");

    expect(listedIssues(fixture)).toHaveLength(0);
    expect(listedIssues(fixture, ["--disposition", "resolved"])).toHaveLength(1);
    const emptyRollup = runCli(["status", "tech-debt", "--harness", fixture.harness], fixture.root);
    expect(jsonOf(emptyRollup).total_open).toBe(0);
    const released = runCli(
      ["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"],
      fixture.root,
    );
    expect(released.exitCode, released.stdout).toBe(0);
    expect(jsonOf(released).data).toMatchObject({ planId: PLAN_ID, violations: [] });
    expectNoRegister(fixture);
  }, 30000);
});

describe("mstar issue — the retired commands refuse with the migration path (G2b)", () => {

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
    );
    expect(retiredKind.exitCode).toBe(2);
    expect(jsonOf(retiredKind).code).toBe("command.invalid-input");

    const alias = runCli(
      ["persist", "json", "--key", fixture.registerPath, "--file", payloadPath],
      fixture.root,
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

  test("close succeeds on ACTIVE authority with actor alone", async () => {
    const fixture = await makeFixture();
    const closedId = await capture(fixture, "close");
    expect(mutate(fixture, "close", closedId, "actor-close", {
      reason: "accepted", references: ["qa.md"], alignmentRef: "PM acceptance record",
    }).exitCode).toBe(0);
    expect(jsonOf(runCli(["issue", "show", "--id", closedId, "--harness", fixture.harness], fixture.root)).disposition).toBe("resolved");
  });

  test("triage succeeds on ACTIVE authority with actor alone", async () => {
    const fixture = await makeFixture();
    const triageId = await capture(fixture, "triage");
    expect(mutate(fixture, "triage", triageId, "actor-triage", { reason: "reclassify", severity: "medium" }).exitCode).toBe(0);
    expect(jsonOf(runCli(["issue", "show", "--id", triageId, "--harness", fixture.harness], fixture.root)).severity).toBe("medium");
  });

  test("supersede succeeds on ACTIVE authority with actor alone", async () => {
    const fixture = await makeFixture();
    const canonicalId = await capture(fixture, "canonical");
    const supersededId = await capture(fixture, "superseded");
    expect(mutate(fixture, "supersede", supersededId, "actor-supersede", { reason: "replaced", canonicalIssueId: canonicalId }).exitCode).toBe(0);
    expect(jsonOf(runCli(["issue", "show", "--id", supersededId, "--harness", fixture.harness], fixture.root)).disposition).toBe("superseded");
  });

  test("link succeeds on ACTIVE authority with actor alone", async () => {
    const fixture = await makeFixture();
    const linkedId = await capture(fixture, "linked");
    expect(mutate(fixture, "link", linkedId, "actor-link", { kind: "plan", target: "unregistered-plan-label" }).exitCode).toBe(0);
    expect(jsonOf(runCli(["issue", "show", "--id", linkedId, "--harness", fixture.harness], fixture.root)).provenance).toContainEqual(
      expect.objectContaining({ kind: "plan", target: "unregistered-plan-label", origin: "unscoped" }),
    );
  });
});
describe("mstar status — the issue authority is never read as an empty rollup (G2b)", () => {
  test("a missing authority refuses the rollup and the findings gate", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-nostore-")));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    writeFixtureRepoId(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });

    const rollup = runCli(["status", "tech-debt", "--harness", harness], root);
    expect(rollup.exitCode).toBe(1);
    expect(jsonOf(rollup).code).toBe("collaboration.not-initialized");
    expect(jsonOf(rollup).data).toBeUndefined();

    const gate = runCli(["status", "findings-cleanup", PLAN_ID, "--harness", harness], root);
    expect(gate.exitCode).toBe(1);
    expect(jsonOf(gate).code).toBe("collaboration.not-initialized");
    expect(jsonOf(gate).data).toBeUndefined();
  });

  test("a remote-selected checkout refuses the rollup at selection, never reading local rows", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-remote-")));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    // invariant: An origin-less scope cannot enroll in remote, so selection refuses before any
    // collaboration lane is opened; no local row or empty rollup may stand in for it.
    writeFileSync(
      join(root, ".mstarc"),
      "[linear]\nenabled=true\nworkspace=acme\nteam=ENG\n[collaboration]\nmode=remote\nrepo_id=remote-fixture\n",
    );
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });

    const rollup = runCli(["status", "tech-debt", "--harness", harness], root);
    expect(rollup.exitCode).toBe(1);
    expect(jsonOf(rollup).code).toBe("remote.selector-unavailable");
    expect(jsonOf(rollup).data).toBeUndefined();

    // invariant: The mirror delivery lane opens the same collaboration store, so a remote
    // selection never becomes its route: it refuses at selection, before any ledger work.
    const sync = runCli(["issue-sync", "pending", "--project", PROJECT_ID, "--harness", harness], root);
    expect(sync.exitCode).toBe(1);
    expect(jsonOf(sync).code).toBe("remote.selector-unavailable");
  });

  test("a corrupt lane refuses the rollup instead of reporting no findings", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-corrupt-")));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    writeFixtureRepoId(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const context = { harnessDir: harness };
    const handle = await initializeStore(context);
    handle.close();
    await initializeCollaborationStore(resolveCollaborationLocation(context));
    // invariant: The issue authority is the repository lane: a torn copy of ITS database
    // is the failure the rollup must surface, never a zeroed success.
    writeText(resolveCollaborationLocation(context).dbPath, "this is not a SQLite database");
    const rollup = runCli(["status", "tech-debt", "--harness", harness], root);
    expect(rollup.exitCode).toBe(1);
    expect(jsonOf(rollup).code).toBe("collaboration.unreadable");
    expect(jsonOf(rollup).data).toBeUndefined();
  });

  test("a staged lane is not the authority: the rollup and the gate both refuse", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-staged-")));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    writeFixtureRepoId(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const context = { harnessDir: harness };
    const handle = await initializeStore(context);
    handle.close();
    // invariant: A created-but-never-published lane is staged: no ACTIVE record, so no
    // issue read may pass through it.
    await initializeCollaborationStore(resolveCollaborationLocation(context));

    for (const args of [
      ["issue", "list", "--harness", harness],
      ["issue", "show", "--id", "I-staged-fixture", "--harness", harness],
    ]) {
      const result = runCli(args, root);
      expect(result.exitCode).toBe(1);
      expect(jsonOf(result).code).toBe("collaboration.not-active");
      expect(jsonOf(result).data).toBeUndefined();
    }
    const rollup = runCli(["status", "tech-debt", "--harness", harness], root);
    expect(rollup.exitCode).toBe(1);
    expect(jsonOf(rollup).code).toBe("collaboration.not-active");
    expect(jsonOf(rollup).data).toBeUndefined();

    const gate = runCli(["status", "findings-cleanup", PLAN_ID, "--harness", harness], root);
    expect(gate.exitCode).toBe(1);
    expect(jsonOf(gate).code).toBe("collaboration.not-active");
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
        fixture.coordinatorRef,
        "--file",
        entriesPath,
        "--expect",
        planToken(fixture),
        "--operation",
        "issue-add-final",
        "--session-id",
        fixture.coordinatorSessionId,
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

// ---------------------------------------------------------------------------
// note: The remote observation and outbox lane at the CLI boundary: admission, native
// detail, and the full provider-free loop from a durable intent to a recorded
// receipt. No provider is reachable from any command here.
// ---------------------------------------------------------------------------

describe("remote collaboration CLI", () => {
  const remoteIds = {
    projectId: "fixture-project",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    teamId: "22222222-2222-4222-8222-222222222222",
    providerProjectId: "33333333-3333-4333-8333-333333333333",
    journalIssueId: "44444444-4444-4444-8444-444444444444",
    writerId: "55555555-5555-4555-8555-555555555555",
    providerIssueId: "77777777-7777-4777-8777-777777777777",
  } as const;

  function remoteRepo(root: string): { repo: string; harness: string; home: string; publish: () => string } {
    const origin = `https://github.com/remote-cli/fixture.git`;
    const bare = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    for (const [key, value] of [["user.name", "Remote CLI"], ["user.email", "remote-cli@example.test"], ["remote.origin.url", origin], [`url.${bare}.insteadOf`, origin]] as const) {
      execFileSync("git", ["config", key, value], { cwd: repo });
    }
    writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=remote\n");
    mkdirSync(join(repo, ".mstar"), { recursive: true });
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    return {
      repo,
      harness: join(repo, ".mstar"),
      home,
      publish() {
        const publisher = join(root, "publisher");
        mkdirSync(publisher, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: publisher });
        execFileSync("git", ["config", "user.name", "Selector"], { cwd: publisher });
        execFileSync("git", ["config", "user.email", "selector@example.test"], { cwd: publisher });
        const payload = {
          version: 1,
          repoKey: "github.com/remote-cli/fixture",
          generation: 3,
          mode: "remote",
          phase: "active",
          projects: [
            {
              localProjectId: remoteIds.projectId,
              provider: "linear",
              workspaceId: remoteIds.workspaceId,
              teamId: remoteIds.teamId,
              projectId: remoteIds.providerProjectId,
              journalIssueId: remoteIds.journalIssueId,
              writerId: remoteIds.writerId,
            },
          ],
          previous: null,
          cutover: null,
        };
        writeFileSync(join(publisher, "authority.json"), `${JSON.stringify(payload)}\n`);
        execFileSync("git", ["add", "authority.json"], { cwd: publisher });
        execFileSync("git", ["commit", "-q", "-m", "selector"], { cwd: publisher });
        execFileSync("git", ["push", "-q", "--force", bare, "HEAD:refs/heads/mstar-collaboration-authority"], { cwd: publisher });
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: publisher, encoding: "utf8" }).trim();
      },
    };
  }

  test("status|bind|observe admit evidence, native detail is visible, and the outbox loop settles an adoption", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-remote-cli-")));
    roots.push(root);
    const fixture = remoteRepo(root);
    const commit = fixture.publish();
    const env = { HOME: fixture.home };
    const at = new Date(Date.now() - 1_000).toISOString();
    const scope = {
      provider: "linear",
      workspaceId: remoteIds.workspaceId,
      teamId: remoteIds.teamId,
      projectId: remoteIds.providerProjectId,
    };
    const check = {
      projectId: remoteIds.projectId,
      scope,
      journalIssueId: remoteIds.journalIssueId,
      checkedAt: at,
      outcome: {
        kind: "verified",
        readerId: "reader-one",
        writerId: remoteIds.writerId,
        capabilities: { fullRead: true, appendOnly: true, exactLookup: true, fieldFidelity: true, privateAudience: true },
      },
    };
    const snapshot = {
      asOf: new Date(Date.now() - 5_000).toISOString(),
      coverage: { kind: "complete" },
      project: {
        projectId: remoteIds.projectId,
        head: ["1".repeat(64)],
        binding: scope,
        milestones: [],
        catalogEntities: [
          { kind: "project", id: remoteIds.projectId, title: "Fixture", description: null, documentKind: null, lifecycle: "active", revision: 1 },
        ],
        catalogLinks: [],
      },
      issues: [
        {
          identity: { ...scope, issueId: remoteIds.providerIssueId },
          nativeTitle: "Unmarked native issue",
          nativeStatus: "Done",
          providerUpdatedAt: at,
          mstar: null,
        },
      ],
    };

    // note: Before any bind the status discloses an unbound checkout and creates nothing.
    const before = runCli(["store", "collaboration", "remote", "status", "--harness", fixture.harness], fixture.repo, env);
    expect(before.exitCode).toBe(0);
    expect(jsonOf(before).binding).toMatchObject({ state: "unbound" });
    expect(jsonOf(before).available).toBe(false);

    const bindInput = join(root, "bind.json");
    writeFileSync(bindInput, JSON.stringify({ version: 1, selectorCommit: commit, generation: 3, checks: [check] }));
    const bound = runCli(
      ["store", "collaboration", "remote", "bind", "--harness", fixture.harness, "--input", bindInput],
      fixture.repo,
      env,
    );
    expect(bound.exitCode).toBe(0);
    expect(jsonOf(bound).binding).toMatchObject({ version: 3, state: "active", generation: 3, selectorCommit: commit });

    const observeInput = join(root, "observe.json");
    writeFileSync(
      observeInput,
      JSON.stringify({ version: 1, selectorCommit: commit, generation: 3, check, expectRevision: 0, snapshot }),
    );
    const ingested = runCli(
      ["store", "collaboration", "remote", "observe", "--harness", fixture.harness, "--input", observeInput],
      fixture.repo,
      env,
    );
    expect(ingested.exitCode).toBe(0);
    expect(jsonOf(ingested)).toMatchObject({ projectId: remoteIds.projectId, revision: 1, completeness: "complete" });

    const status = runCli(["store", "collaboration", "remote", "status", "--harness", fixture.harness], fixture.repo, env);
    expect(status.exitCode).toBe(0);
    expect(jsonOf(status)).toMatchObject({
      available: true,
      binding: { state: "bound", generation: 3 },
      projects: [expect.objectContaining({ projectId: remoteIds.projectId, completeness: "complete", freshness: "fresh" })],
    });

    const listed = runCli(["issue", "list", "--harness", fixture.harness], fixture.repo, env);
    expect(listed.exitCode).toBe(0);
    const page = jsonOf(listed);
    expect(page.total).toBe(0);
    expect(page.providerIssues).toHaveLength(1);

    const shown = runCli(
      ["issue", "show", "--id", remoteIds.providerIssueId, "--project", remoteIds.projectId, "--harness", fixture.harness],
      fixture.repo,
      env,
    );
    expect(shown.exitCode).toBe(0);
    expect(jsonOf(shown)).toMatchObject({ kind: "provider-only", issueRef: null, nativeStatus: "Done" });
    const guessed = runCli(["issue", "show", "--id", remoteIds.providerIssueId, "--harness", fixture.harness], fixture.repo, env);
    expect(guessed.exitCode).toBe(1);
    expect(jsonOf(guessed).code).toBe("issue.scope-refused");

    // invariant: The unmarked native issue is never closed by its native status: it carries no
    // MStar subject, so no remote replacement addresses it (the enqueue refuses before writing).
    const closed = runCli(
      [
        "issue", "close",
        "--id", remoteIds.providerIssueId,
        "--operation-id", "88888888-8888-4888-8888-888888888888",
        "--actor", "project-manager",
        "--expect", "1",
        "--payload", JSON.stringify({ reason: "native done", references: ["native-status"], alignmentRef: "fixture" }),
        "--harness", fixture.harness,
      ],
      fixture.repo,
      env,
    );
    expect(jsonOf(closed)).toMatchObject({ code: "issue.not-found" });

    const adoption = {
      version: 1,
      kind: "new",
      capture: {
        kind: "bug",
        severity: "high",
        impact: "i",
        acceptance: "a",
        sourceIdentity: "review:cli-adoption",
        rootCauseKey: "remote.adoption",
        acceptanceKey: "remote.adoption.stored",
        occurrenceKey: "cli-adoption-occurrence",
        sourceKind: "review",
        location: "fixture",
        observedBehavior: "The cache refused the adoption.",
        evidence: ["fixture"],
        discoveredAt: at,
      },
    };
    const adoptInput = join(root, "adopt.json");
    writeFileSync(adoptInput, JSON.stringify(adoption));
    const operation = "99999999-9999-4999-8999-999999999999";
    const remote = ["store", "collaboration", "remote"];
    const adopted = runCli(
      [
        ...remote, "adopt-issue",
        "--project", remoteIds.projectId,
        "--issue", remoteIds.providerIssueId,
        "--operation", operation,
        "--input", adoptInput,
        "--harness", fixture.harness,
      ],
      fixture.repo,
      env,
    );
    // invariant: The adoption is ONE durable intent, and the command's exit 0 discloses the
    // outbox state instead of claiming the issue was adopted.
    expect(adopted.exitCode).toBe(0);
    expect(jsonOf(adopted)).toMatchObject({ operationId: operation, state: "enqueued", replayed: false });

    const pending = runCli([...remote, "outbox-pending", "--harness", fixture.harness, "--project", remoteIds.projectId], fixture.repo, env);
    expect(pending.exitCode).toBe(0);
    expect(jsonOf(pending).intents).toEqual([expect.objectContaining({ operationId: operation, projectId: remoteIds.projectId })]);

    const dispatched = runCli([...remote, "outbox-dispatch", "--harness", fixture.harness, "--operation", operation], fixture.repo, env);
    expect(dispatched.exitCode).toBe(0);
    const permit = jsonOf(dispatched).permit as Record<string, any>;
    // note: Assert field-by-field: Bun's `toMatchObject` writes asymmetric matchers into the
    // received object, which would replace the permit values this receipt is built from.
    expect(permit.operationId).toBe(operation);
    expect(typeof permit.attemptId).toBe("string");
    expect(typeof permit.requestHash).toBe("string");

    const receiptFile = join(root, "receipt.json");
    const receipt = {
      version: 1,
      selectorCommit: commit,
      generation: 3,
      projectId: remoteIds.projectId,
      operationId: operation,
      attemptId: permit.attemptId,
      requestHash: permit.requestHash,
      observedAt: new Date().toISOString(),
      outcome: { kind: "unconfirmed", reason: "no-response" },
    };
    writeFileSync(receiptFile, JSON.stringify(receipt));
    const recorded = runCli([...remote, "outbox-receipt", "--harness", fixture.harness, "--input", receiptFile], fixture.repo, env);
    // note: Exit 0 acknowledges the durable evidence; only `confirmed` is an effect success.
    expect(recorded.exitCode).toBe(0);
    expect(jsonOf(recorded)).toMatchObject({ state: "unconfirmed" });
    const shownIntent = runCli([...remote, "outbox-show", "--harness", fixture.harness, "--operation", operation], fixture.repo, env);
    expect(jsonOf(shownIntent)).toMatchObject({ state: "unconfirmed", attemptId: permit.attemptId, disclosure: "full" });

    // invariant: No cache-only adoption is performed: the observation revision and the
    // visible issue set are exactly what the admission recorded.
    const after = runCli(["store", "collaboration", "remote", "status", "--harness", fixture.harness], fixture.repo, env);
    expect(jsonOf(after).projects).toEqual([expect.objectContaining({ projectId: remoteIds.projectId, revision: 1, completeness: "complete" })]);
    const relisted = runCli(["issue", "list", "--harness", fixture.harness], fixture.repo, env);
    const afterPage = jsonOf(relisted);
    expect(afterPage.total).toBe(0);
    expect(afterPage.providerIssues).toHaveLength(1);

    // note: The host's provider effect is the exact frozen event on the addressed record.
    const confirmedFile = join(root, "confirmed.json");
    writeFileSync(confirmedFile, JSON.stringify({
      ...receipt,
      observedAt: new Date().toISOString(),
      outcome: {
        kind: "confirmed",
        identity: {
          provider: "linear",
          workspaceId: remoteIds.workspaceId,
          teamId: remoteIds.teamId,
          projectId: remoteIds.providerProjectId,
          issueId: remoteIds.providerIssueId,
        },
        recordId: "abababab-abab-4bab-8bab-abababababab",
        event: permit.frozenRequest.event,
      },
    }));
    const confirmed = runCli([...remote, "outbox-receipt", "--harness", fixture.harness, "--input", confirmedFile], fixture.repo, env);
    expect(confirmed.exitCode).toBe(0);
    expect(jsonOf(confirmed)).toMatchObject({ state: "confirmed" });
  }, 60_000);
});
