/**
 * OMP coordinator-identity adapter — ACTIVE DB coordinator operations.
 *
 * The adapter is tested as the boundary it is: caller input first (an extra
 * field is never partially honored), then the host-derived facts, then the
 * authority verbs. Every case asserts what the injected deps observed, so a
 * refusal that forgot to stop before the write is visible.
 *
 * The pre-activation / FILE recovery form is retired (T7a/T21). Live coverage
 * is the ACTIVE path only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COORDINATOR_BIND_INPUT_KEYS,
  COORDINATOR_SHOW_RECOVERY_INPUT_KEYS,
  COORDINATOR_ACTIVE_RECOVER_INPUT_KEYS,
  COORDINATOR_TOOL_NAME,
  bindCoordinatorIdentity,
  classifyCoordinatorShellCall,
  recoverCoordinatorIdentity,
  showCoordinatorRecovery,
  type CoordinatorIdentityFacts,
  type CoordinatorAuthorityDeps,
} from "../src/coordinator-identity";
import {
  initializeStore,
  type ExecutionPlanView,
  type ExecutionRead,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
} from "@mstar-harness/engine";

const FACTS: CoordinatorIdentityFacts = {
  sessionId: "native-session-a",
  cwd: "/repo/main",
  harnessRoot: "/repo/main/.mstar",
  leaf: false,
};

const STORE_ID = "3f2a1b0c-1111-4222-8333-444455556666";
const OPERATION_ID = "op-1";
/**
 * A synthetic `exec-v1:workflow:…` execution token (epoch 3, revision 1) used
 * only as a fixture value: the expected CAS token for the active coordinator
 * forms, asserted to be re-checked by the engine and NOT to appear in any
 * result (`expect(JSON.stringify(result)).not.toContain(WORKFLOW_TOKEN)`).
 *
 * It is COMPOSED from its parts so the source never holds a contiguous
 * token-shaped literal.
 */
const WORKFLOW_TOKEN = ["exec-v1", "workflow", STORE_ID, "3", "W", "1"].join(":");

function sessionRef(sessionId: string, workflowId: string) {
  return { storeId: STORE_ID, epoch: 3, workflowId, role: "coordinator" as const, sessionId };
}

function receiptOf(input: { sessionId: string; workflowId: string; operationId: string }, replayed = false) {
  return {
    data: sessionRef(input.sessionId, input.workflowId),
    token: WORKFLOW_TOKEN,
    storeId: STORE_ID,
    epoch: 3,
    operationId: input.operationId,
    replayed,
  } as unknown as ExecutionReceipt<ExecutionSessionRef>;
}

function readOf(workflowId: string, coordinatorSessionId: string | null) {
  return {
    data: {
      root: { version: 2, updated_at: "2026-09-16", workflows: [] },
      workflows: [
        {
          workflowToken: WORKFLOW_TOKEN,
          planTokens: {},
          state: {
            id: workflowId,
            status: "running",
            phase: "phase-2-execute",
            integration_worktree_path: "/repo/wt-integration",
          },
          plans: [],
          coordinator: coordinatorSessionId === null ? null : sessionRef(coordinatorSessionId, workflowId),
          integrationLease: null,
        },
      ],
    },
    token: WORKFLOW_TOKEN,
    storeId: STORE_ID,
    epoch: 3,
  } as unknown as ExecutionRead<ExecutionState | ExecutionPlanView>;
}

/** The active-form dependency surface, with every call recorded. */
function fakeAuthority(overrides: Partial<CoordinatorAuthorityDeps> = {}) {
  const calls = {
    bind: [] as Array<Record<string, unknown>>,
    recover: [] as Array<Record<string, unknown>>,
    read: [] as Array<Record<string, unknown>>,
  };
  const deps: CoordinatorAuthorityDeps = {
    bind: async (input) => {
      calls.bind.push(input as unknown as Record<string, unknown>);
      return receiptOf({
        sessionId: input.identity.sessionId,
        workflowId: input.workflowId,
        operationId: input.operationId,
      });
    },
    recover: async (input) => {
      calls.recover.push(input as unknown as Record<string, unknown>);
      return receiptOf({
        sessionId: input.identity.sessionId,
        workflowId: input.identity.workflowId,
        operationId: input.operationId,
      });
    },
    read: async (input) => {
      calls.read.push(input as unknown as Record<string, unknown>);
      return readOf(input.workflowId, "native-session-a");
    },
    ...overrides,
  };
  return { calls, deps };
}

/** One reviewed ACTIVE `recover` request. */
function recoverRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: "recover",
    workflowId: "wf-a",
    priorSessionId: "prior-session",
    reason: "the prior host session was cancelled",
    attestation: { version: 1, kind: "activation" },
    expected: WORKFLOW_TOKEN,
    operationId: OPERATION_ID,
    ...overrides,
  };
}

describe("prerequisite identity — coordinator identity adapter input", () => {
  test("accepts only its documented keys; every identity-shaped field is refused by name", async () => {
    expect(COORDINATOR_TOOL_NAME).toBe("mstar_coordinator");
    expect([...COORDINATOR_BIND_INPUT_KEYS]).toEqual(["operation", "workflowId", "expected", "operationId"]);
    for (const forged of [
      { operation: "bind", workflowId: "wf-a", sessionId: "attacker" },
      { operation: "bind", workflowId: "wf-a", harnessRoot: "/elsewhere/.mstar" },
      { operation: "bind", workflowId: "wf-a", root: "/elsewhere/.mstar" },
      { operation: "bind", workflowId: "wf-a", role: "coordinator" },
      { operation: "bind", workflowId: "wf-a", authority: true },
      { operation: "bind", workflowId: "wf-a", credentialPath: "/tmp/creds.json" },
    ]) {
      const engine = fakeAuthority();
      const result = await bindCoordinatorIdentity(forged, FACTS, engine.deps);
      expect({ forged, ok: result.ok, code: result.code }).toEqual({ forged, ok: false, code: "forbidden-field" });
      expect(engine.calls.bind).toHaveLength(0);
    }
  });

  test("a malformed call shape and a non-bind operation refuse without touching the engine", async () => {
    const engine = fakeAuthority();
    for (const bad of [null, "bind", 7, []]) {
      const result = await bindCoordinatorIdentity(bad, FACTS, engine.deps);
      expect(result.code).toBe("invalid-input");
    }
    expect((await bindCoordinatorIdentity({ operation: "recover", workflowId: "wf-a" }, FACTS, engine.deps)).code).toBe(
      "unknown-operation",
    );
    expect((await bindCoordinatorIdentity({ operation: "bind", workflowId: "  " }, FACTS, engine.deps)).code).toBe(
      "invalid-input",
    );
    expect(engine.calls.bind).toHaveLength(0);
  });

  test("host facts gate the bind: no native id and a leaf session refuse before the engine", async () => {
    const cases = [
      { facts: { ...FACTS, sessionId: "" }, code: "identity-missing" },
      { facts: { ...FACTS, leaf: true }, code: "leaf-session" },
      { facts: { ...FACTS, harnessRoot: null }, code: "harness-not-found" },
    ] as const;
    for (const entry of cases) {
      const engine = fakeAuthority();
      const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a" }, entry.facts, engine.deps);
      expect({ code: result.code, ok: result.ok }).toEqual({ code: entry.code, ok: false });
      expect(engine.calls.bind).toHaveLength(0);
    }
  });

  test("a lawful call binds the derived identity — never a caller value — through the engine", async () => {
    const engine = fakeAuthority();
    const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a", operationId: OPERATION_ID }, FACTS, engine.deps);
    expect(result.ok).toBe(true);
    expect(result.code).toBe("bound");
    expect(engine.calls.bind).toHaveLength(1);
    expect(engine.calls.bind[0]).toMatchObject({
      harnessDir: "/repo/main/.mstar",
      workflowId: "wf-a",
      operationId: OPERATION_ID,
      identity: {
        source: "host",
        sessionId: "native-session-a",
        workflowId: "wf-a",
        role: "coordinator",
      },
    });
    // Omitted expected stays omitted: the engine resolves the current token.
    expect(engine.calls.bind[0]).not.toHaveProperty("expected");
    expect(result.details).toMatchObject({
      workflowId: "wf-a",
      sessionId: "native-session-a",
      role: "coordinator",
      storeId: STORE_ID,
      epoch: 3,
      operationId: OPERATION_ID,
      replayed: false,
    });
    // The result IS the model-visible tool result: no path, token or credential.
    expect(result.details.sessionFile).toBeUndefined();
    expect(result.text).not.toContain("sessions/");
    expect(JSON.stringify(result.details)).not.toContain("sessions/");
    expect(JSON.stringify(result)).not.toContain(WORKFLOW_TOKEN);
  });

  test("an engine refusal is reported with its own code, and the adapter never fabricates a success", async () => {
    // The live code for this path: a workflow that already records a coordinator
    // refuses a second bind with `coordination.identity-mismatch`. The adapter is
    // a pure passthrough: it must surface the engine's own code and text.
    const refusal = Object.assign(
      new Error(
        "workflow wf-a already has coordinator native-session-a; recover the stopped coordinator through the supported recovery path",
      ),
      { code: "coordination.identity-mismatch" },
    );
    const engine = fakeAuthority({
      bind: async () => {
        throw refusal;
      },
    });
    const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a" }, FACTS, engine.deps);
    expect(result).toMatchObject({ ok: false, isError: true, code: "coordination.identity-mismatch" });
    expect(result.text).toBe(refusal.message);
  });
});

describe("prerequisite identity — managed coordinator bind transport classifier", () => {
  const bindCommand = "mstar plan bind --coordinator --workflow fixture-iteration";

  test("a bare or namespaced shell coordinator bind is refused before execution with a redirect to the tool", () => {
    for (const toolName of ["bash", "functions.bash"]) {
      const refusal = classifyCoordinatorShellCall({ toolName, input: { command: bindCommand } });
      expect(refusal?.block).toBe(true);
      expect(refusal?.reason).toContain("mstar_coordinator");
    }
  });

  test("unrelated shell calls and unsupported tool identities are left untouched", () => {
    for (const [toolName, input] of [
      ["bash", { command: "git status" }],
      ["bash", { command: "mstar plan bind --workflow wf-a --plan plan-a --session-id s" }],
      ["bash", { command: "true" }],
      ["bash", { command: 42 }],
      ["bash", "not-an-object"],
      ["bash", { command: "true", env: "FOO=bar" }],
      ["read", { command: bindCommand }],
      ["mstar_model_handoff", { command: bindCommand }],
    ] as const) {
      expect({ toolName, result: classifyCoordinatorShellCall({ toolName, input }) }).toEqual({ toolName, result: undefined });
    }
  });

  test("the classifier is pure: it never returns an input revision, so an absent env field cannot invalidate a call", () => {
    const refused = classifyCoordinatorShellCall({ toolName: "bash", input: { command: bindCommand } });
    expect(Object.keys(refused ?? {}).sort()).toEqual(["block", "reason"]);
    const untouched = classifyCoordinatorShellCall({ toolName: "bash", input: { command: "true" } });
    expect(untouched).toBeUndefined();
  });

  test("a bind is recognized by the command it runs, through env prefixes and joined commands", () => {
    for (const command of [
      "mstar plan bind --coordinator --workflow fixture-iteration",
      "mstar-harness plan bind --workflow fixture-iteration --coordinator",
      "MSTAR_QUIET=1 mstar plan bind --coordinator",
      "cd /tmp && mstar plan bind --coordinator; echo done",
    ]) {
      expect({ command, block: classifyCoordinatorShellCall({ toolName: "bash", input: { command } })?.block }).toEqual({
        command,
        block: true,
      });
    }
  });

  test("the same words as data — a quoted argument, a comment, a doc line — are left untouched", () => {
    for (const command of [
      'echo "plan bind --coordinator"',
      `printf '%s\\n' 'mstar plan bind --coordinator'`,
      "# mstar plan bind --coordinator --workflow fixture-iteration",
      "git commit -m \"stop using plan bind --coordinator\"",
      "grep -n 'plan bind --coordinator' docs/plan.md",
      "echo mstar plan bind --coordinator",
    ]) {
      expect({
        command,
        result: classifyCoordinatorShellCall({ toolName: "bash", input: { command } }),
      }).toEqual({ command, result: undefined });
    }
  });
});

/* ---------------------- active coordinator forms ------------------- */

describe("prerequisite identity — the active coordinator forms call the DB verbs directly", () => {
  test("the active bind derives the identity from host facts and calls the DB bind", async () => {
    const engine = fakeAuthority();
    const result = await bindCoordinatorIdentity(
      { operation: "bind", workflowId: "wf-a", expected: WORKFLOW_TOKEN, operationId: OPERATION_ID },
      FACTS,
      engine.deps,
    );
    expect({ ok: result.ok, code: result.code }).toEqual({ ok: true, code: "bound" });
    expect(result.details).toMatchObject({
      workflowId: "wf-a",
      sessionId: "native-session-a",
      storeId: STORE_ID,
      epoch: 3,
      operationId: OPERATION_ID,
      replayed: false,
    });
    expect(JSON.stringify(result)).not.toContain("sessions/");
    expect(JSON.stringify(result)).not.toContain(WORKFLOW_TOKEN);
  });

  test("the ACTIVE bind forwards an omitted expected and replays an identical operation id (BUG-101)", async () => {
    const engine = fakeAuthority();
    // The documented minimal shape: workflow + the caller's own operation id and
    // NO token. The adapter must NOT read the workflow token to synthesize a CAS
    // value — the engine resolves the current token from its own header.
    const result = await bindCoordinatorIdentity(
      { operation: "bind", workflowId: "wf-a", operationId: OPERATION_ID },
      FACTS,
      engine.deps,
    );
    expect({ ok: result.ok, code: result.code }).toEqual({ ok: true, code: "bound" });
    expect(engine.calls.read).toHaveLength(0);
    expect(engine.calls.bind).toHaveLength(1);
    expect(engine.calls.bind[0]?.operationId).toBe(OPERATION_ID);
    expect(engine.calls.bind[0]).not.toHaveProperty("expected");
  });

  test("the ACTIVE bind still forwards an explicit expected as a strict CAS", async () => {
    const engine = fakeAuthority();
    const result = await bindCoordinatorIdentity(
      { operation: "bind", workflowId: "wf-a", expected: WORKFLOW_TOKEN, operationId: OPERATION_ID },
      FACTS,
      engine.deps,
    );
    expect(result.ok).toBe(true);
    expect(engine.calls.bind[0]?.expected).toBe(WORKFLOW_TOKEN);
  });

  test("a combined forbidden and invalid call is refused whole before the authority", async () => {
    // One refusal names EVERY unusable field so a caller that follows it reaches
    // a working call without discovering a second defect.
    const engine = fakeAuthority();
    const result = await bindCoordinatorIdentity(
      { operation: "bind", expected: 7, sessionId: "forged" },
      FACTS,
      engine.deps,
    );
    expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "forbidden-field" });
    expect(result.details.forbidden).toEqual(["sessionId"]);
    expect(result.details.missing).toEqual(["workflowId"]);
    expect(result.details.fields).toEqual(["expected"]);
    expect(engine.calls.read).toHaveLength(0);
    expect(engine.calls.bind).toHaveLength(0);
  });

  test("host facts gate the active forms before any authority IO", async () => {
    for (const [facts, code] of [
      [{ ...FACTS, sessionId: "" }, "identity-missing"],
      [{ ...FACTS, leaf: true }, "leaf-session"],
      [{ ...FACTS, harnessRoot: null }, "harness-not-found"],
    ] as const) {
      const engine = fakeAuthority();
      const bound = await bindCoordinatorIdentity(
        { operation: "bind", workflowId: "wf-a", expected: WORKFLOW_TOKEN, operationId: OPERATION_ID },
        facts,
        engine.deps,
      );
      const recovered = await recoverCoordinatorIdentity(recoverRequest(), facts, engine.deps);
      expect({ code: bound.code, ok: bound.ok }).toEqual({ code, ok: false });
      expect({ code: recovered.code, ok: recovered.ok }).toEqual({ code, ok: false });
      expect(engine.calls.bind).toHaveLength(0);
      expect(engine.calls.recover).toHaveLength(0);
    }
  });

  test("the active recover reports every unusable field of one call in a single refusal", async () => {
    // One call, four defects across all three classes: a malformed holder, an
    // empty reason, an unusable optional CAS value and a non-object attestation.
    const engine = fakeAuthority();
    const result = await recoverCoordinatorIdentity(
      {
        operation: "recover",
        workflowId: "wf-a",
        priorSessionId: "",
        reason: "",
        attestation: "attestation.json",
        expected: 7,
      },
      FACTS,
      engine.deps,
    );
    expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "unauthorized" });
    expect(result.details).toMatchObject({ form: "active", forbidden: [], missing: [] });
    expect(result.details.fields).toEqual(["priorSessionId", "reason", "expected"]);
    expect(result.text).toContain("attestation");
    expect(engine.calls.read).toHaveLength(0);
    expect(engine.calls.recover).toHaveLength(0);
  });

  test("the active recover requires an explicit holder and the operator's own attestation document", async () => {
    const engine = fakeAuthority();
    const base = {
      operation: "recover",
      workflowId: "wf-a",
      reason: "stopped owner",
      attestation: { version: 1 },
      expected: WORKFLOW_TOKEN,
      operationId: OPERATION_ID,
    };
    // A missing or empty holder is never guessed; `null` is the explicit unowned
    // claim rather than an absent field.
    for (const priorSessionId of ["", undefined]) {
      const result = await recoverCoordinatorIdentity({ ...base, priorSessionId }, FACTS, engine.deps);
      expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "invalid-input" });
    }
    for (const attestation of [undefined, null, "attestation.json", 7]) {
      const result = await recoverCoordinatorIdentity(
        { ...base, priorSessionId: "prior-session", attestation },
        FACTS,
        engine.deps,
      );
      expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "unauthorized" });
    }
    // A public-session-id rule violation is refused without echoing the value.
    const smuggled = await recoverCoordinatorIdentity(
      { ...base, priorSessionId: "../creds/secret.json" },
      FACTS,
      engine.deps,
    );
    expect({ ok: smuggled.ok, code: smuggled.code }).toEqual({ ok: false, code: "invalid-input" });
    expect(JSON.stringify(smuggled)).not.toContain("secret.json");
    expect(engine.calls.recover).toHaveLength(0);
  });

  // retired file-route subject (T7a/T21): the JSON/pre-activation recover form is gone;
  // ACTIVE recover refuses the retired keys by name instead.
  test("retired FILE recovery keys are refused by the ACTIVE recover key set", async () => {
    const engine = fakeAuthority();
    const result = await recoverCoordinatorIdentity(
      {
        operation: "recover",
        workflowId: "wf-a",
        priorSessionId: "prior-session",
        reason: "stopped owner",
        attestation: { version: 1 },
        authorizationRef: "PM-authorization-1",
        stoppedSessionIds: ["prior-session"],
        force: true,
      },
      FACTS,
      engine.deps,
    );
    expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "forbidden-field" });
    expect(result.details).toMatchObject({ form: "active" });
    expect(result.details.forbidden).toEqual(
      expect.arrayContaining(["authorizationRef", "stoppedSessionIds", "force"]),
    );
    expect(engine.calls.recover).toHaveLength(0);
  });

  test("an explicitly unowned recovery forwards a null holder", async () => {
    const engine = fakeAuthority();
    const result = await recoverCoordinatorIdentity(
      {
        operation: "recover",
        workflowId: "wf-a",
        priorSessionId: null,
        reason: "no recorded holder",
        attestation: { version: 1 },
        expected: WORKFLOW_TOKEN,
        operationId: OPERATION_ID,
      },
      FACTS,
      engine.deps,
    );
    expect(result.ok).toBe(true);
    // The explicit "this workflow records no coordinator at all" claim crosses
    // the boundary as `null` — never a defaulted or guessed holder.
    expect(engine.calls.recover[0]?.priorSessionId).toBeNull();
  });

  test("the active show-recovery reads the DB workflow state and never a token or path", async () => {
    expect([...COORDINATOR_SHOW_RECOVERY_INPUT_KEYS]).toEqual(["operation", "workflowId"]);
    expect([...COORDINATOR_ACTIVE_RECOVER_INPUT_KEYS]).toEqual([
      "operation",
      "workflowId",
      "priorSessionId",
      "reason",
      "attestation",
      "expected",
      "operationId",
    ]);
    const engine = fakeAuthority();
    const result = await showCoordinatorRecovery({ operation: "show-recovery", workflowId: "wf-a" }, FACTS, engine.deps);
    expect(result.code).toBe("recovery-state");
    expect(engine.calls.read).toEqual([{ harnessDir: "/repo/main/.mstar", workflowId: "wf-a" }]);
    expect(result.details).toMatchObject({
      workflowId: "wf-a",
      storeId: STORE_ID,
      epoch: 3,
      status: "running",
      phase: "phase-2-execute",
      coordinatorSessionId: "native-session-a",
      coordinatorEpoch: 3,
    });
    expect(result.text).toContain("coordinator session native-session-a");
    expect(JSON.stringify(result)).not.toContain("sessions/");
    expect(JSON.stringify(result)).not.toContain(WORKFLOW_TOKEN);
  });

  test("an unowned workflow reports the explicit null-holder path instead of inventing a coordinator", async () => {
    const engine = fakeAuthority({
      read: async () => readOf("wf-a", null),
    });
    const result = await showCoordinatorRecovery({ operation: "show-recovery", workflowId: "wf-a" }, FACTS, engine.deps);
    expect(result.details).toMatchObject({ coordinatorSessionId: null, coordinatorEpoch: null });
    expect(result.text).toContain("no coordinator (recovery with priorSessionId null");
  });

  test("a stale, foreign or copied reference surfaces the engine's own refusal code", async () => {
    for (const [code, text] of [
      [
        "execution.session-unavailable",
        "workflow wf-a holds no ACTIVE coordinator session native-session-a in epoch 4. An execution session reference authorizes only the binding the store records at the current epoch; a legacy session envelope is never consulted.",
      ],
      ["execution.scope-mismatch", "the trusted caller does not match the supplied coordinator reference"],
      ["store.stale-epoch", "the execution session reference is not current"],
    ] as const) {
      const refusal = Object.assign(new Error(text), { code });
      const engine = fakeAuthority({
        bind: async () => {
          throw refusal;
        },
      });
      const result = await bindCoordinatorIdentity(
        { operation: "bind", workflowId: "wf-a", expected: WORKFLOW_TOKEN, operationId: OPERATION_ID },
        FACTS,
        engine.deps,
      );
      expect({ ok: result.ok, code: result.code, isError: result.isError }).toEqual({ ok: false, code, isError: true });
      expect(result.text).toBe(text);
    }
  });
});

/* ------------------------------- active execution authority --- */

const activeRoots: string[] = [];
afterAll(() => {
  for (const root of activeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prerequisite identity — coordinator recovery under an ACTIVE execution authority", () => {
  test("ACTIVE recover against a live empty authority surfaces the engine refusal, not a Prepare rewrite", async () => {
    // Single initializeStore activates the authority (never a second
    // initializeExecutionAuthority — it refuses execution.not-empty).
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-omp-coordinator-active-")));
    activeRoots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
    const harnessRoot = join(root, ".mstar");
    mkdirSync(harnessRoot, { recursive: true });
    const handle = await initializeStore({ harnessDir: harnessRoot });
    handle.close();

    // Default deps: the real engine verbs. There is no workflow, so the
    // recovery cannot succeed — but the refusal must be the engine's own code
    // (not a rewritten recovery-not-prepare / file-route mask).
    const result = await recoverCoordinatorIdentity(
      recoverRequest({
        workflowId: "wf-active",
        // No synthetic token: force the adapter to read the live authority.
        expected: undefined,
        operationId: "recover-active-empty",
      }),
      {
        ...FACTS,
        cwd: root,
        harnessRoot,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    // Dotted engine codes only — never a file-route Prepare rewrite.
    expect(result.code).toMatch(/^(execution|store|coordination)\./);
    expect(result.text).not.toContain("recovery-not-prepare");
    expect(typeof result.details.loadedEntry === "string" || result.details.loadedEntry === undefined).toBe(true);
  }, 60000);

  test("an incompatible store keeps its schema facts and loaded entry through the ACTIVE recover path (DEBT-104)", async () => {
    // A REAL store whose highest applied schema version this build cannot read.
    // The ACTIVE recovery reaches the authority and that refusal must travel
    // through the SAME provenance-aware engine path — schema-version facts and
    // `loadedEntry`, not a bare code/message pair.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-omp-coordinator-schema-")));
    activeRoots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
    const harnessRoot = join(root, ".mstar");
    mkdirSync(harnessRoot, { recursive: true });
    const store = await initializeStore({ harnessDir: harnessRoot });
    store.db.exec("insert into schema_version values(999, 'future', 'future', 'now')");
    store.close();

    const result = await recoverCoordinatorIdentity(
      recoverRequest({
        workflowId: "wf-schema",
        expected: undefined,
        operationId: "recover-schema",
      }),
      {
        ...FACTS,
        cwd: root,
        harnessRoot,
      },
    );
    expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "store.schema-unsupported" });
    expect(typeof result.details.storeSchemaVersion).toBe("number");
    expect(typeof result.details.supportedSchemaMax).toBe("number");
    expect(typeof result.details.firstUnsupportedMigration).toBe("number");
    expect(result.details.storeSchemaVersion as number).toBeGreaterThan(result.details.supportedSchemaMax as number);
    expect(typeof result.details.loadedEntry).toBe("string");
    expect(String(result.details.loadedEntry)).toMatch(/\.(ts|js)$/);
    expect(result.text).toContain("loaded entry below is the build that answered");
  }, 60000);
});
