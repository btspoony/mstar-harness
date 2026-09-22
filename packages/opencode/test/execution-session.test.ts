/**
 * execution-session.test.ts — OpenCode native session association (S15).
 *
 * The host can decide but cannot veto: `tool.execute.before` returns void, so
 * the write hook advertises `decision-only`. What this consumer CAN do is
 * associate the native hook `sessionID` with an independently acquired scope
 * and then really invoke the shared CLI (the writer) under that identity.
 *
 * Covered here:
 *  - a bound native association (native sessionID + ambient scope) produces the
 *    host identity and carries it into a real shared-CLI invocation;
 *  - a missing native session, a missing scope, and an unsafe native id are
 *    explicit operational exclusions, never success-shaped;
 *  - a copied/foreign native session cannot resume another session's reference;
 *  - the identity channel is overwritten from native facts and the legacy
 *    identity key never reaches the child;
 *  - the REAL CLI (the checkout's own entrypoint) is invoked with real syntax:
 *    the gated-write consultation's argv is asserted against actual CLI exit
 *    codes, so an argv drift (an invented flag) fails here instead of logging a
 *    false "refused" state for a healthy association.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  ExecutionError,
  initializeExecutionAuthority,
  initializeStore,
  prepareExecutionPlan,
  readExecutionAuthority,
  registerCatalogEntity,
  serializeExecutionValue,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionIdentity,
  type ExecutionSessionRef,
} from "@mstar-harness/engine";
import {
  EXECUTION_IDENTITY_ENV,
  LEGACY_SESSION_ID_ENV,
  MorningStarHarnessPlugin,
  OPENCODE_EXECUTION_CLI_ENV,
  forgetOpenCodeSessionRef,
  observeOpenCodeSessionRefs,
  openCodeAssociation,
  openCodeConsultPlan,
  openCodeExecutionEnvOverrides,
  openCodeExecutionIdentity,
  resumeOpenCodeExecutionSession,
  runOpenCodeExecutionCli,
} from "../src/mstar.js";

const scope = { workflowId: "wf-opencode", role: "coordinator" as const, planId: null };
const reference: ExecutionSessionRef = {
  storeId: "11111111-1111-1111-1111-111111111111",
  epoch: 1,
  workflowId: scope.workflowId,
  role: scope.role,
  sessionId: "native-opencode-session",
  planId: null,
};
const planScope = { workflowId: "wf-opencode", role: "plan-pm" as const, planId: "plan-opencode" };
const TS = "2026-09-21T00:00:00.000Z";
const nativeIdentity: ExecutionIdentity = { source: "host", sessionId: reference.sessionId, ...scope };

/** The checkout's own CLI entry — the real syntax this consumer must speak. */
const CLI_ENTRY = fileURLToPath(new URL("../../../packages/cli/src/index.ts", import.meta.url));

const projects: string[] = [];
const previousCliEnv = process.env[OPENCODE_EXECUTION_CLI_ENV];
afterEach(() => {
  if (previousCliEnv === undefined) delete process.env[OPENCODE_EXECUTION_CLI_ENV];
  else process.env[OPENCODE_EXECUTION_CLI_ENV] = previousCliEnv;
  forgetOpenCodeSessionRef(reference.sessionId);
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

/** Ambient scope the launcher would have installed (canonical producer form). */
const ambientEnv = (identity: ExecutionIdentity): NodeJS.ProcessEnv => ({
  [EXECUTION_IDENTITY_ENV]: serializeExecutionValue(identity),
  [LEGACY_SESSION_ID_ENV]: "legacy-value-that-must-not-survive",
  MSTAR_HARNESS_DIR: "/some/inherited/root",
});

/** Temp repo with the default `.mstar` layout and a valid v2 root register. */
function makeHarnessProject(): { project: string; harness: string; statusPath: string } {
  const project = mkdtempSync(join(tmpdir(), "mstar-opencode-native-"));
  projects.push(project);
  execFileSync("git", ["init", "-q", project], { stdio: "ignore" });
  const harness = join(project, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  const statusPath = join(harness, "status.json");
  writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] }, null, 2));
  return { project, harness, statusPath };
}

/**
 * A launcher script running the checkout's real CLI exactly the way the CLI's
 * own suite does (`<runtime> run <src-entry> …`), so a fixture failure means
 * the consumer's argv, not a launcher difference.
 */
function makeCliLauncher(project: string): string {
  const launcher = join(project, "mstar-launcher");
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(CLI_ENTRY)} "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

/**
 * A REAL ACTIVE execution authority with a plan-pm session bound to the native
 * session id, and the canonical wire for that binding — the state a
 * session-authorized read needs to succeed, so the fixture can witness a real
 * success instead of a log-wording-only assertion. The row is PREPARED first
 * (a plan session never claims an unprepared row) and every token is read back
 * from the authority rather than reused from a creation receipt.
 */
async function seedBoundPlanSession(
  harness: string,
  nativeSessionId: string,
): Promise<{ wire: string; planId: string; workflowId: string }> {
  const handle = await initializeStore({ harnessDir: harness });
  handle.close();
  const initialized = await initializeExecutionAuthority({ harnessDir: harness });
  await registerCatalogEntity(
    { harnessDir: harness },
    {
      kind: "plan",
      id: planScope.planId,
      title: `${planScope.planId} title`,
      rootKind: "plans",
      relativePath: `plans/${planScope.planId}.md`,
    },
    { operationId: `register-${planScope.planId}`, actor: "execution-session.test" },
  );
  const coordinatorCaller: ExecutionCaller = {
    sessionId: "fixture-coordinator",
    role: "coordinator",
    workflowId: planScope.workflowId,
    planId: null,
  };
  const coordinatorContext: ExecutionContext = { harnessDir: harness, caller: coordinatorCaller };
  await createExecutionWorkflow(coordinatorContext, {
    entry: { id: planScope.workflowId, type: "plan", started_at: TS, dir: `workflows/${planScope.workflowId}` },
    snapshot: {
      schema_version: 1,
      id: planScope.workflowId,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      plans: [
        {
          id: planScope.planId,
          title: `${planScope.planId} title`,
          file: `plans/${planScope.planId}.md`,
          status: "Todo",
        },
      ],
      delivery_kind: "development",
      branch: { source: `feature/${planScope.workflowId}`, target: "main" },
    } as never,
    expected: initialized.token,
    operationId: `create-${planScope.workflowId}`,
  });

  const createdState = await readExecutionAuthority(coordinatorContext);
  const workflow = createdState.data.workflows.find((entry) => entry.state.id === planScope.workflowId);
  if (workflow === undefined) throw new Error("fixture: the workflow is not registered");
  const coordinatorRef = (
    await bindExecutionSession(coordinatorContext, {
      workflowId: planScope.workflowId,
      planId: null,
      role: "coordinator",
      expected: workflow.workflowToken,
      operationId: "bind-coordinator",
    })
  ).data;

  // The prepare prerequisite: a real Assignment document (absolute path, headers
  // the seal validates) and the plan token from the CURRENT authority read.
  const assignmentPath = writeAssignmentDocument(harness, planScope.planId, planScope.workflowId);
  const beforePrepare = await readExecutionAuthority(coordinatorContext, {
    workflowId: planScope.workflowId,
    planId: planScope.planId,
  });
  await prepareExecutionPlan(coordinatorContext, {
    operationId: "prepare-plan",
    session: coordinatorRef,
    expected: beforePrepare.token,
    planId: planScope.planId,
    operation: { kind: "prepare", assignmentPath },
  });

  const afterPrepare = await readExecutionAuthority(coordinatorContext, {
    workflowId: planScope.workflowId,
    planId: planScope.planId,
  });
  const bound = await bindExecutionSession(
    {
      harnessDir: harness,
      caller: { sessionId: nativeSessionId, role: "plan-pm", workflowId: planScope.workflowId, planId: planScope.planId },
    } satisfies ExecutionContext,
    {
      workflowId: planScope.workflowId,
      planId: planScope.planId,
      role: "plan-pm",
      expected: afterPrepare.token,
      operationId: `bind-${planScope.planId}`,
    },
  );
  return { wire: encodeExecutionSessionRef(bound.data), planId: planScope.planId, workflowId: planScope.workflowId };
}

/** One prepared Assignment document (the same header set the sibling suites seal). */
function writeAssignmentDocument(harness: string, planId: string, workflowId: string): string {
  const planPath = join(harness, "plans", `${planId}.md`);
  mkdirSync(join(harness, "plans"), { recursive: true });
  mkdirSync(join(harness, "sdd", planId), { recursive: true });
  mkdirSync(join(harness, "worktrees", planId), { recursive: true });
  writeFileSync(planPath, `# ${planId}\n`);
  const headers: Record<string, string> = {
    "Execution scope": "plan",
    "Execute as": "project-manager",
    Delegation: "allowed",
    "Control harness root": harness,
    "Workflow id": workflowId,
    "Plan id": planId,
    "Plan Path": planPath,
    "Worktree path": join(harness, "worktrees", planId),
    "Working branch": `feature/${planId}`,
    "SDD dir": join(harness, "sdd", planId),
    "QA gate": "mandatory",
    "Findings cleanup": "allow-residual",
    "Prepare gate": "go",
  };
  const assignmentPath = join(harness, "assignments", `${planId}.md`);
  mkdirSync(join(harness, "assignments"), { recursive: true });
  writeFileSync(
    assignmentPath,
    `${Object.entries(headers)
      .map(([header, value]) => `**${header}**: ${value}`)
      .join("\n")}\n`,
  );
  return assignmentPath;
}

/** Collect everything the plugin logs while a fixture runs. */
async function withCapturedLogs(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    for (const arg of args) if (typeof arg === "string") lines.push(arg);
  };
  const [realWarn, realError, realLog] = [console.warn, console.error, console.log];
  console.warn = push;
  console.error = push;
  console.log = push;
  try {
    await run();
  } finally {
    console.warn = realWarn;
    console.error = realError;
    console.log = realLog;
  }
  return lines;
}

describe("OpenCode native execution identity", () => {
  test("uses the hook sessionID and ignores the spawn target", () => {
    expect(openCodeExecutionIdentity({ sessionID: reference.sessionId }, scope)).toEqual(nativeIdentity);
  });

  test("missing and blank native identity refuse before any store access", () => {
    expect(() => openCodeExecutionIdentity({}, scope)).toThrow(/session id/);
    expect(() => openCodeExecutionIdentity({ sessionID: "   " }, scope)).toThrow(/session id/);
  });

  test("a copied native identity cannot resume a reference for another session", async () => {
    const wire = encodeExecutionSessionRef(reference);
    await expect(
      resumeOpenCodeExecutionSession(
        { harnessDir: "/fixture" },
        { sessionID: "copied-session" },
        scope,
        wire,
      ),
    ).rejects.toBeInstanceOf(ExecutionError);
  });
});

describe("OpenCode native association (decision-only)", () => {
  test("binds the native session to the independently acquired scope", () => {
    const association = openCodeAssociation({ sessionID: reference.sessionId }, ambientEnv(nativeIdentity));
    expect(association).toEqual({
      kind: "bound",
      identity: nativeIdentity,
      sessionRef: null,
      capability: "decision-only",
    });
  });

  test("a missing native session or missing scope is an explicit exclusion, never a success", () => {
    const noSession = openCodeAssociation({}, ambientEnv(nativeIdentity));
    expect(noSession.kind).toBe("unavailable");
    if (noSession.kind !== "unavailable") throw new Error("unreachable");
    expect(noSession.operationallyExcluded).toBe(true);
    expect(noSession.reason).toContain("sessionID");

    const noScope = openCodeAssociation({ sessionID: reference.sessionId }, {});
    expect(noScope.kind).toBe("unavailable");
    if (noScope.kind !== "unavailable") throw new Error("unreachable");
    expect(noScope.operationallyExcluded).toBe(true);
    expect(noScope.reason).toContain(EXECUTION_IDENTITY_ENV);
  });

  test("a malformed ambient scope is refused by the shared identity rules", () => {
    const association = openCodeAssociation(
      { sessionID: reference.sessionId },
      { [EXECUTION_IDENTITY_ENV]: JSON.stringify({ ...planScope, planId: null }) },
    );
    expect(association.kind).toBe("unavailable");
    expect(association.capability).toBe("decision-only");
  });

  test("a reference learned from this session's own CLI traffic selects the session-authorized read", () => {
    const planPmIdentity: ExecutionIdentity = { source: "host", sessionId: reference.sessionId, ...planScope };
    const wire = encodeExecutionSessionRef({ ...reference, role: "plan-pm", planId: planScope.planId });

    // Before any observation the plugin holds no reference: the weaker read.
    const withoutRef = openCodeAssociation({ sessionID: reference.sessionId }, ambientEnv(planPmIdentity));
    expect(withoutRef.kind).toBe("bound");
    if (withoutRef.kind !== "bound") throw new Error("unreachable");
    expect(withoutRef.sessionRef).toBeNull();
    expect(openCodeConsultPlan(withoutRef, "/root")).toEqual({
      argv: ["plan", "show", "--workflow", planScope.workflowId, "--plan", planScope.planId, "--json", "--harness", "/root"],
      proof: "authority-read",
    });

    // The session's own `bash` traffic names the reference it was issued.
    observeOpenCodeSessionRefs(reference.sessionId, `mstar plan show --session-ref ${wire} --json`);
    const withRef = openCodeAssociation({ sessionID: reference.sessionId }, ambientEnv(planPmIdentity));
    expect(withRef.kind).toBe("bound");
    if (withRef.kind !== "bound") throw new Error("unreachable");
    expect(withRef.sessionRef).toBe(wire);
    expect(openCodeConsultPlan(withRef, "/root")).toEqual({
      argv: ["plan", "show", "--session-ref", wire, "--plan", planScope.planId, "--json", "--harness", "/root"],
      proof: "session-authorized",
    });
  });

  test("a foreign or malformed wire is never remembered as this session's reference", () => {
    const foreign = encodeExecutionSessionRef({ ...reference, sessionId: "another-session" });
    observeOpenCodeSessionRefs(reference.sessionId, `mstar plan show --session-ref ${foreign}`);
    observeOpenCodeSessionRefs(reference.sessionId, "mstar plan show --session-ref exec-session-v1:not-base64url!!");
    const association = openCodeAssociation({ sessionID: reference.sessionId }, ambientEnv(nativeIdentity));
    expect(association.kind).toBe("bound");
    if (association.kind !== "bound") throw new Error("unreachable");
    expect(association.sessionRef).toBeNull();
  });
});

describe("OpenCode shared-CLI transport (real CLI syntax)", () => {
  test("overwrites the identity channel and removes BOTH legacy keys", () => {
    const overrides = openCodeExecutionEnvOverrides(nativeIdentity);
    expect(overrides[EXECUTION_IDENTITY_ENV]).toBe(serializeExecutionValue(nativeIdentity));
    expect(overrides[LEGACY_SESSION_ID_ENV]).toBeUndefined();
    // Root selection stays explicit (--harness / cwd): the env key never decides it.
    expect(overrides.MSTAR_HARNESS_DIR).toBeUndefined();
  });

  test("the coordinator register read is a real CLI invocation that really exits 0", () => {
    const { project } = makeHarnessProject();
    const result = runOpenCodeExecutionCli(["status", "validate"], nativeIdentity, {
      command: makeCliLauncher(project),
      env: ambientEnv(nativeIdentity),
      // No root env key: the CLI walks UP from its cwd, so the workspace root
      // (the directory holding `.mstar`) is the only root signal it gets.
      cwd: project,
    });
    // An invented flag on this verb would exit 2 with a commander usage error:
    // the real exit code IS the argv contract this consumer must speak.
    expect(result.stderr).not.toContain("unknown option");
    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("the plan-scope authority read keeps the CLI's own usage refusal on a legacy harness", () => {
    const { project, harness } = makeHarnessProject();
    const result = runOpenCodeExecutionCli(
      ["plan", "show", "--workflow", planScope.workflowId, "--plan", planScope.planId, "--json", "--harness", harness],
      { source: "host", sessionId: reference.sessionId, ...planScope },
      { command: makeCliLauncher(project), env: ambientEnv(nativeIdentity), cwd: project },
    );
    // The route decision is the real one: no ACTIVE execution authority here,
    // so the CLI refuses in its own words instead of printing an empty view.
    expect(result.status).toBe(2);
    expect(result.stderr + result.stdout).toContain("execution authority");
  });

  test("a gated write consults the real CLI and never claims a false refusal or a fence", async () => {
    const { project, statusPath } = makeHarnessProject();
    process.env[OPENCODE_EXECUTION_CLI_ENV] = makeCliLauncher(project);
    process.env[EXECUTION_IDENTITY_ENV] = serializeExecutionValue(nativeIdentity);

    try {
      const hooks = await MorningStarHarnessPlugin();
      const lines = await withCapturedLogs(async () => {
        await hooks["tool.execute.before"]!({ tool: "write", sessionID: reference.sessionId, callID: "c1" }, {
          args: {
            filePath: statusPath,
            content: JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] }),
          },
        });
      });
      // The consultation ran the REAL CLI argv (`status validate`, no invented
      // flags) against this harness, so it must report the register read and
      // state the currency limitation — not a false "not current" refusal.
      const consultation = lines.find((line) => line.includes("status validate")) ?? "";
      expect(consultation).toContain("register read");
      expect(consultation).toContain("NOT verified");
      expect(consultation).toContain("not a fence");
      expect(lines.some((line) => line.includes("refused or failed"))).toBe(false);
    } finally {
      delete process.env[EXECUTION_IDENTITY_ENV];
    }
  });

  test("a missing ambient scope is logged as an explicit exclusion on a gated write", async () => {
    const { statusPath } = makeHarnessProject();
    const previousIdentity = process.env[EXECUTION_IDENTITY_ENV];
    delete process.env[EXECUTION_IDENTITY_ENV];
    try {
      const hooks = await MorningStarHarnessPlugin();
      const lines = await withCapturedLogs(async () => {
        await hooks["tool.execute.before"]!({ tool: "write", sessionID: reference.sessionId, callID: "c2" }, {
          args: { filePath: statusPath, content: JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] }) },
        });
      });
      const exclusion = lines.find((line) => line.includes("operationally excluded")) ?? "";
      expect(exclusion).toContain(EXECUTION_IDENTITY_ENV);
      expect(exclusion).toContain("NOT stopped");
    } finally {
      if (previousIdentity !== undefined) process.env[EXECUTION_IDENTITY_ENV] = previousIdentity;
    }
  });

  test("a reference observed in this session's own CLI traffic makes the next gated write session-authorized, and the read really succeeds", async () => {
    const { project, harness, statusPath } = makeHarnessProject();
    // The execution initializer refuses a harness that still carries a live
    // execution source: seed the authority first, then restore the retired
    // register — exactly the on-disk state a real cutover leaves behind.
    rmSync(statusPath, { force: true });
    const seeded = await seedBoundPlanSession(harness, reference.sessionId);
    writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] }, null, 2));
    const planPmIdentity: ExecutionIdentity = { source: "host", sessionId: reference.sessionId, ...planScope };
    process.env[OPENCODE_EXECUTION_CLI_ENV] = makeCliLauncher(project);
    process.env[EXECUTION_IDENTITY_ENV] = serializeExecutionValue(planPmIdentity);

    try {
      const hooks = await MorningStarHarnessPlugin();
      const lines = await withCapturedLogs(async () => {
        // 1) The session's own bash call carries the reference it was issued.
        await hooks["tool.execute.before"]!({ tool: "bash", sessionID: reference.sessionId, callID: "c1" }, {
          args: { command: `mstar plan show --session-ref ${seeded.wire} --json` },
        });
        // 2) A gated write now consults the session-authorized read.
        await hooks["tool.execute.before"]!({ tool: "write", sessionID: reference.sessionId, callID: "c2" }, {
          args: {
            filePath: statusPath,
            content: JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] }),
          },
        });
      });

      const consultation = lines.find((line) => line.includes("plan show")) ?? "";
      expect(consultation).toContain("--session-ref");
      expect(consultation).toContain("session-authorized read");
      // The hook logs success ONLY for a zero-exit child: this is the witness
      // that the session-authorized branch really ran and really succeeded.
      expect(consultation).not.toContain("refused or failed");
      expect(consultation).toContain(" ok — ");

      // The same argv, run directly, returns the CLI's own success envelope —
      // the subprocess fact behind that log line.
      const bound = openCodeAssociation({ sessionID: reference.sessionId }, {
        [EXECUTION_IDENTITY_ENV]: serializeExecutionValue(planPmIdentity),
      });
      if (bound.kind !== "bound") throw new Error("fixture: the association must be bound");
      const direct = runOpenCodeExecutionCli(openCodeConsultPlan(bound, harness).argv, bound.identity, {
        command: makeCliLauncher(project),
        cwd: project,
      });
      expect(direct.status).toBe(0);
      expect(direct.envelope?.route).toBe("execution");
      expect(direct.envelope?.ok).toBe(true);
    } finally {
      delete process.env[EXECUTION_IDENTITY_ENV];
    }
  });
});
