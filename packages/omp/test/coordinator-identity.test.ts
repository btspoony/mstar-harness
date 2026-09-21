/**
 * OMP coordinator-identity adapter — prerequisite contract §3.2.
 *
 * The adapter is tested as the boundary it is: caller input first (an extra
 * field is never partially honored), then the host-derived facts, then the
 * engine verb. Every case asserts what the injected `bind` observed, so a
 * refusal that forgot to stop before the write is visible.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COORDINATOR_BIND_INPUT_KEYS,
  COORDINATOR_RECOVER_INPUT_KEYS,
  COORDINATOR_SHOW_RECOVERY_INPUT_KEYS,
  COORDINATOR_TOOL_NAME,
  bindCoordinatorIdentity,
  classifyCoordinatorShellCall,
  recoverCoordinatorIdentity,
  showCoordinatorRecovery,
  type CoordinatorIdentityFacts,
  type CoordinatorRecoveryDeps,
} from "../src/coordinator-identity";
import { initializeExecutionAuthority, initializeStore, type CoordinationResult, type RecoverPrepareCoordinatorResult } from "@mstar-harness/engine";

const FACTS: CoordinatorIdentityFacts = {
  sessionId: "native-session-a",
  cwd: "/repo/main",
  harnessRoot: "/repo/main/.mstar",
  leaf: false,
  scopedPlanEntry: false,
};

/** A fake engine verb that records its input and returns a plausible result. */
function fakeBind(): { calls: Array<Record<string, unknown>>; bind: (input: Record<string, unknown>) => Promise<CoordinationResult> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    bind: async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        ok: true,
        operation: "bind",
        outcome: "bound",
        session: { schema_version: 1, role: "coordinator", session_id: input.sessionId as string, workflow_id: input.workflowId as string, harness_root: input.harnessDir as string },
        session_file: "/repo/main/.mstar/workflows/wf-a/sessions/coordinator-native-session-a.json",
      } as unknown as CoordinationResult;
    },
  };
}

describe("prerequisite identity — coordinator identity adapter input", () => {
  test("accepts only operation and workflowId; every identity-shaped field is refused by name", async () => {
    expect([...COORDINATOR_BIND_INPUT_KEYS]).toEqual(["operation", "workflowId"]);
    expect(COORDINATOR_TOOL_NAME).toBe("mstar_coordinator");
    for (const forged of [
      { operation: "bind", workflowId: "wf-a", sessionId: "attacker" },
      { operation: "bind", workflowId: "wf-a", harnessRoot: "/elsewhere/.mstar" },
      { operation: "bind", workflowId: "wf-a", root: "/elsewhere/.mstar" },
      { operation: "bind", workflowId: "wf-a", role: "coordinator" },
      { operation: "bind", workflowId: "wf-a", authority: true },
      { operation: "bind", workflowId: "wf-a", credentialPath: "/tmp/creds.json" },
    ]) {
      const engine = fakeBind();
      const result = await bindCoordinatorIdentity(forged, FACTS, engine.bind);
      expect({ forged, ok: result.ok, code: result.code }).toEqual({ forged, ok: false, code: "forbidden-field" });
      expect(engine.calls).toHaveLength(0);
    }
  });

  test("a malformed call shape and a non-bind operation refuse without touching the engine", async () => {
    const engine = fakeBind();
    for (const bad of [null, "bind", 7, []]) {
      const result = await bindCoordinatorIdentity(bad, FACTS, engine.bind);
      expect(result.code).toBe("invalid-input");
    }
    expect((await bindCoordinatorIdentity({ operation: "recover", workflowId: "wf-a" }, FACTS, engine.bind)).code).toBe(
      "unknown-operation",
    );
    expect((await bindCoordinatorIdentity({ operation: "bind", workflowId: "  " }, FACTS, engine.bind)).code).toBe(
      "invalid-input",
    );
    expect(engine.calls).toHaveLength(0);
  });

  test("host facts gate the bind: no native id, a leaf session and a scoped-plan entry all refuse before the engine", async () => {
    const cases = [
      { facts: { ...FACTS, sessionId: "" }, code: "identity-missing" },
      { facts: { ...FACTS, leaf: true }, code: "leaf-session" },
      { facts: { ...FACTS, scopedPlanEntry: true }, code: "scoped-plan-route" },
      { facts: { ...FACTS, harnessRoot: null }, code: "harness-not-found" },
    ] as const;
    for (const entry of cases) {
      const engine = fakeBind();
      const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a" }, entry.facts, engine.bind);
      expect({ code: result.code, ok: result.ok }).toEqual({ code: entry.code, ok: false });
      expect(engine.calls).toHaveLength(0);
    }
  });

  test("a lawful call binds the derived identity — never a caller value — through the engine", async () => {
    const engine = fakeBind();
    const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a" }, FACTS, engine.bind);
    expect(result.ok).toBe(true);
    expect(result.code).toBe("bound");
    expect(engine.calls).toEqual([
      {
        coordinator: true,
        workflowId: "wf-a",
        harnessDir: "/repo/main/.mstar",
        source: "host",
        cwd: "/repo/main",
        sessionId: "native-session-a",
      },
    ]);
    expect(result.details).toMatchObject({ workflowId: "wf-a", sessionId: "native-session-a", role: "coordinator" });
  });

  test("an engine refusal is reported with its own code, and the adapter never fabricates a success", async () => {
    const refusal = Object.assign(new Error("duplicate coordinator holder"), { code: "coordination.duplicate-holder" });
    const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a" }, FACTS, async () => {
      throw refusal;
    });
    expect(result).toMatchObject({ ok: false, isError: true, code: "coordination.duplicate-holder" });
    expect(result.text).toBe("duplicate coordinator holder");
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
});

/* ---------------------------------------------- coordinator recovery adapter --- */

/** The prior holder every recovery fixture records. */
const PRIOR_SESSION = "cancelled-host-session";
const SNAPSHOT_VERSION = `sha256:${"a".repeat(64)}`;
const COMPASS_VERSION = `sha256:${"b".repeat(64)}`;

/** Fake `show`/`recover`/`target` engine seams that record what the adapter derived. */
function fakeRecovery(): {
  shown: Array<Record<string, unknown>>;
  recovered: Array<Record<string, unknown>>;
  deps: CoordinatorRecoveryDeps;
} {
  const shown: Array<Record<string, unknown>> = [];
  const recovered: Array<Record<string, unknown>> = [];
  const deps: CoordinatorRecoveryDeps = {
    show: async (input) => {
      shown.push(input);
      return {
        workflowId: input.workflowId,
        priorSessionId: PRIOR_SESSION,
        snapshotVersion: SNAPSHOT_VERSION,
        compassVersion: COMPASS_VERSION,
        allowed: true,
        blockers: [],
      };
    },
    recover: async (input) => {
      recovered.push(input);
      return {
        ok: true,
        operation: "recover-coordinator",
        outcome: "recovered",
        session: {
          schema_version: 1,
          role: "coordinator",
          session_id: input.identity.sessionId,
          workflow_id: input.identity.workflowId,
          harness_root: input.harnessDir,
        },
        session_file: "/repo/main/.mstar/workflows/wf-a/sessions/coordinator-native-session-a.json",
        recovery: {
          workflowId: input.identity.workflowId,
          priorSessionId: input.priorSessionId,
          sessionId: input.identity.sessionId,
          operationId: input.operationId,
          requestHash: "c".repeat(64),
          replay: false,
          snapshotVersion: SNAPSHOT_VERSION,
          compassVersion: input.expectedCompassVersion,
          recoveredAt: "2026-09-21T10:00:00.000Z",
        },
      } as unknown as RecoverPrepareCoordinatorResult;
    },
    target: ({ harnessRoot, workflowId }) => ({
      ok: true,
      target: {
        priorSessionPath: `${harnessRoot}/workflows/${workflowId}/sessions/coordinator-${PRIOR_SESSION}.json`,
        priorSessionId: PRIOR_SESSION,
      },
    }),
  };
  return { shown, recovered, deps };
}

/** One reviewed `recover` request (tokens and proof only). */
function recoverRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: "recover",
    workflowId: "wf-a",
    expectedSnapshotVersion: SNAPSHOT_VERSION,
    expectedCompassVersion: COMPASS_VERSION,
    operationId: "op-1",
    reason: "the prior host session was cancelled",
    authorizationRef: "PM-authorization-1",
    stoppedSessionIds: [PRIOR_SESSION],
    ...overrides,
  };
}

describe("prerequisite identity — coordinator recovery adapter input", () => {
  test("prepare coordinator recovery operations accept only their documented keys", async () => {
    expect([...COORDINATOR_SHOW_RECOVERY_INPUT_KEYS]).toEqual(["operation", "workflowId"]);
    expect([...COORDINATOR_RECOVER_INPUT_KEYS]).toEqual([
      "operation",
      "workflowId",
      "expectedSnapshotVersion",
      "expectedCompassVersion",
      "operationId",
      "reason",
      "authorizationRef",
      "stoppedSessionIds",
    ]);

    for (const forged of [
      { operation: "show-recovery", workflowId: "wf-a", sessionId: "attacker" },
      { operation: "show-recovery", workflowId: "wf-a", root: "/elsewhere/.mstar" },
      recoverRequest({ sessionId: "attacker" }),
      recoverRequest({ priorSessionPath: "/tmp/creds.json" }),
      recoverRequest({ priorSessionId: PRIOR_SESSION }),
      recoverRequest({ harnessRoot: "/elsewhere/.mstar" }),
      recoverRequest({ force: true }),
    ]) {
      const engine = fakeRecovery();
      const show = forged.operation === "show-recovery";
      const result = show
        ? await showCoordinatorRecovery(forged, FACTS, engine.deps)
        : await recoverCoordinatorIdentity(forged, FACTS, engine.deps);
      expect({ forged, ok: result.ok, code: result.code }).toEqual({ forged, ok: false, code: "forbidden-field" });
      expect(engine.shown).toHaveLength(0);
      expect(engine.recovered).toHaveLength(0);
    }
  });

  test("prepare coordinator recovery is gated by the same host facts as the bind", async () => {
    for (const entry of [
      { facts: { ...FACTS, sessionId: "" }, code: "identity-missing" },
      { facts: { ...FACTS, leaf: true }, code: "leaf-session" },
      { facts: { ...FACTS, scopedPlanEntry: true }, code: "scoped-plan-route" },
      { facts: { ...FACTS, harnessRoot: null }, code: "harness-not-found" },
    ] as const) {
      const engine = fakeRecovery();
      for (const raw of [{ operation: "show-recovery", workflowId: "wf-a" }, recoverRequest()]) {
        const result =
          raw.operation === "show-recovery"
            ? await showCoordinatorRecovery(raw, entry.facts, engine.deps)
            : await recoverCoordinatorIdentity(raw, entry.facts, engine.deps);
        expect({ raw, code: result.code }).toEqual({ raw, code: entry.code });
      }
      expect(engine.shown).toHaveLength(0);
      expect(engine.recovered).toHaveLength(0);
    }
  });

  test("prepare coordinator recovery derives the identity and the stored prior target, never a caller value", async () => {
    const engine = fakeRecovery();
    const viewed = await showCoordinatorRecovery({ operation: "show-recovery", workflowId: "wf-a" }, FACTS, engine.deps);
    expect(viewed.ok).toBe(true);
    expect(viewed.details).toMatchObject({
      workflowId: "wf-a",
      priorSessionId: PRIOR_SESSION,
      snapshotVersion: SNAPSHOT_VERSION,
      compassVersion: COMPASS_VERSION,
      allowed: true,
    });
    // The view carries no envelope path: it is coordinator-owned transport.
    expect(JSON.stringify(viewed.details)).not.toContain("sessions/");
    expect(engine.shown).toEqual([{ cwd: FACTS.cwd, harnessDir: FACTS.harnessRoot, workflowId: "wf-a" }]);

    const recovered = await recoverCoordinatorIdentity(recoverRequest(), FACTS, engine.deps);
    expect(recovered.ok).toBe(true);
    expect(recovered.code).toBe("recovered");
    expect(recovered.details).toMatchObject({
      workflowId: "wf-a",
      priorSessionId: PRIOR_SESSION,
      sessionId: "native-session-a",
      operationId: "op-1",
      replay: false,
    });
    // The engine saw the host-derived identity, the stored prior path and the
    // caller's stop assertion verbatim — nothing else.
    expect(engine.recovered).toEqual([
      {
        cwd: FACTS.cwd,
        harnessDir: FACTS.harnessRoot,
        identity: { source: "host", sessionId: "native-session-a", workflowId: "wf-a", role: "coordinator", planId: null },
        priorSessionPath: `${FACTS.harnessRoot}/workflows/wf-a/sessions/coordinator-${PRIOR_SESSION}.json`,
        priorSessionId: PRIOR_SESSION,
        expectedSnapshotVersion: SNAPSHOT_VERSION,
        expectedCompassVersion: COMPASS_VERSION,
        operationId: "op-1",
        reason: "the prior host session was cancelled",
        authorizationRef: "PM-authorization-1",
        stoppedSessionIds: [PRIOR_SESSION],
      },
    ]);
  });

  test("prepare coordinator recovery refuses an empty stop assertion and a missing workflow before the engine", async () => {
    const engine = fakeRecovery();
    for (const raw of [
      recoverRequest({ stoppedSessionIds: [] }),
      recoverRequest({ stoppedSessionIds: ["ok", 7] }),
      recoverRequest({ reason: "" }),
      recoverRequest({ operationId: "" }),
      recoverRequest({ authorizationRef: "" }),
      recoverRequest({ expectedCompassVersion: "" }),
      recoverRequest({ workflowId: "  " }),
      { operation: "show-recovery", workflowId: "  " },
    ]) {
      const result =
        raw.operation === "show-recovery"
          ? await showCoordinatorRecovery(raw, FACTS, engine.deps)
          : await recoverCoordinatorIdentity(raw, FACTS, engine.deps);
      expect({ raw, ok: result.ok }).toEqual({ raw, ok: false });
    }
    expect(engine.shown).toHaveLength(0);
    expect(engine.recovered).toHaveLength(0);
  });

  test("prepare coordinator recovery refuses a stop entry that is not a public session id before the engine", async () => {
    const engine = fakeRecovery();
    // Each entry is forwarded to the engine AND echoed by it, so the host
    // applies the one shared public-session-id rule (single safe path component,
    // bounded length) itself: an arbitrary string never reaches the request
    // digest, the audit record or a diagnostic.
    for (const entry of ["a/b", "../escape", "a".repeat(129), "with space"]) {
      const result = await recoverCoordinatorIdentity(recoverRequest({ stoppedSessionIds: [entry] }), FACTS, engine.deps);
      expect(`${JSON.stringify(entry)}: ${result.ok} ${result.code}`).toBe(
        `${JSON.stringify(entry)}: false invalid-input`,
      );
      expect(result.text).toContain("stoppedSessionIds entry");
    }
    expect(engine.recovered).toHaveLength(0);
  });

  test("prepare coordinator recovery reports an engine refusal with its own code and never fabricates success", async () => {
    const refusal = new Error("workflow wf-a is not in Prepare") as Error & { code: string };
    refusal.code = "coordination.identity-recovery.not-prepare";
    const deps: CoordinatorRecoveryDeps = {
      show: async () => {
        throw refusal;
      },
      recover: async () => {
        throw refusal;
      },
      target: () => ({ ok: false, code: "recovery-not-prepare", message: "workflow wf-a has no recorded coordinator binding" }),
    };
    const shown = await showCoordinatorRecovery({ operation: "show-recovery", workflowId: "wf-a" }, FACTS, deps);
    expect({ ok: shown.ok, code: shown.code }).toEqual({ ok: false, code: "coordination.identity-recovery.not-prepare" });
    const recovered = await recoverCoordinatorIdentity(recoverRequest(), FACTS, deps);
    expect({ ok: recovered.ok, code: recovered.code }).toEqual({ ok: false, code: "recovery-not-prepare" });

    // A host session whose workflow records no owner refuses before the engine
    // write path is reached at all.
    const engine = fakeRecovery();
    const noTarget: CoordinatorRecoveryDeps = { ...engine.deps, target: () => ({ ok: false, code: "recovery-not-prepare", message: "no binding" }) };
    const result = await recoverCoordinatorIdentity(recoverRequest(), FACTS, noTarget);
    expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "recovery-not-prepare" });
    expect(engine.recovered).toHaveLength(0);
  });
});

/* ------------------------------- active execution authority --- */

const activeRoots: string[] = [];
afterAll(() => {
  for (const root of activeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prerequisite identity — coordinator recovery under an ACTIVE execution authority", () => {
  test("prepare coordinator recovery surfaces the active-DB redirect instead of masking it as a Prepare refusal", async () => {
    // A REAL active execution authority in its own temporary Git root: the JSON
    // snapshot is retired there as a persistence route. The stored-target reader
    // must surface THAT refusal — with the redirect to the existing DB recovery
    // verb — instead of rewriting every read failure into `recovery-not-prepare`.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-omp-coordinator-active-")));
    activeRoots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
    const harnessRoot = join(root, ".mstar");
    mkdirSync(harnessRoot, { recursive: true });
    const handle = await initializeStore({ harnessDir: harnessRoot });
    handle.close();
    await initializeExecutionAuthority({ harnessDir: harnessRoot });

    // The DEFAULT deps: the real stored-target reader and the real engine verbs.
    const result = await recoverCoordinatorIdentity(recoverRequest({ workflowId: "wf-active" }), {
      ...FACTS,
      cwd: root,
      harnessRoot,
    });
    expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "execution.consumer-not-ready" });
    expect(result.text).toContain("mstar session recover");
    expect(result.text).not.toContain("recovery-not-prepare");
  }, 60000);
});
