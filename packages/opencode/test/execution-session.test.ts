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
 *    host identity and carries it into the shared CLI invocation;
 *  - a missing native session, a missing scope, and an unsafe native id are
 *    explicit operational exclusions, never success-shaped;
 *  - a copied/foreign native session cannot resume another session's reference,
 *    and a CLI refusal is reported as a refusal, never as green;
 *  - the identity channel overwrites the legacy keys.
 *
 * The CLI fixture is a real subprocess (a temporary script), so env/argv/exit
 * propagation is exercised, not asserted from a mock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeExecutionSessionRef,
  ExecutionError,
  serializeExecutionValue,
  type ExecutionIdentity,
  type ExecutionSessionRef,
} from "@mstar-harness/engine";
import {
  EXECUTION_IDENTITY_ENV,
  LEGACY_SESSION_ID_ENV,
  openCodeAssociation,
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
const nativeIdentity: ExecutionIdentity = { source: "host", sessionId: reference.sessionId, ...scope };

/** Ambient scope the launcher would have installed (canonical producer form). */
const ambientEnv = (identity: ExecutionIdentity): NodeJS.ProcessEnv => ({
  [EXECUTION_IDENTITY_ENV]: serializeExecutionValue(identity),
  [LEGACY_SESSION_ID_ENV]: "legacy-value-that-must-not-survive",
  MSTAR_HARNESS_DIR: "/some/inherited/root",
});

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

describe("OpenCode native execution identity", () => {
  test("uses the hook sessionID and ignores the spawn target", () => {
    const identity = openCodeExecutionIdentity({ sessionID: reference.sessionId }, scope);
    expect(identity).toEqual(nativeIdentity);
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
    expect(association).toEqual({ kind: "bound", identity: nativeIdentity, capability: "decision-only" });
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
      { [EXECUTION_IDENTITY_ENV]: JSON.stringify({ ...nativeIdentity, role: "plan-pm", planId: null }) },
    );
    expect(association.kind).toBe("unavailable");
    expect(association.capability).toBe("decision-only");
  });
});

describe("OpenCode shared-CLI transport", () => {
  test("overwrites the identity channel and removes the legacy keys", () => {
    const overrides = openCodeExecutionEnvOverrides(nativeIdentity);
    expect(overrides[EXECUTION_IDENTITY_ENV]).toBe(serializeExecutionValue(nativeIdentity));
    expect(overrides[LEGACY_SESSION_ID_ENV]).toBeUndefined();
    expect(overrides.MSTAR_HARNESS_DIR).toBeUndefined();
  });

  test("invokes the shared CLI under the native identity and surfaces its envelope", () => {
    const project = mkdtempSync(join(tmpdir(), "mstar-opencode-cli-"));
    projects.push(project);
    const cli = join(project, "cli.mjs");
    // Fixture CLI: echo the identity it was handed, and its argv.
    writeFileSync(
      cli,
      [
        "const identity = process.env." + EXECUTION_IDENTITY_ENV + ";",
        "const legacy = process.env." + LEGACY_SESSION_ID_ENV + " ?? null;",
        "const root = process.env.MSTAR_HARNESS_DIR ?? null;",
        "console.log(JSON.stringify({ ok: true, route: 'execution', operation: 'fixture', identity: JSON.parse(identity), legacy, root, argv: process.argv.slice(2) }));",
      ].join("\n"),
    );

    const result = runOpenCodeExecutionCli([cli, "plan", "show", "--json"], nativeIdentity, {
      command: process.execPath,
      env: ambientEnv(nativeIdentity),
      cwd: project,
    });

    expect(result.status).toBe(0);
    const envelope = result.envelope ?? {};
    expect(envelope.identity).toEqual(nativeIdentity);
    // The legacy channels never reach the child — including an inherited root.
    expect(envelope.legacy).toBeNull();
    expect(envelope.root).toBeNull();
    expect(envelope.argv).toEqual(["plan", "show", "--json"]);
  });

  test("a refusing CLI stays a refusal with its own exit code and code", () => {
    const project = mkdtempSync(join(tmpdir(), "mstar-opencode-cli-refuse-"));
    projects.push(project);
    const cli = join(project, "cli.mjs");
    writeFileSync(
      cli,
      [
        "console.log(JSON.stringify({ ok: false, operation: 'plan show', code: 'execution.session-unavailable', message: 'the execution session is not the active current binding' }));",
        "process.exitCode = 1;",
      ].join("\n"),
    );

    const result = runOpenCodeExecutionCli([cli, "plan", "show", "--json"], nativeIdentity, {
      command: process.execPath,
      env: ambientEnv(nativeIdentity),
      cwd: project,
    });

    expect(result.status).toBe(1);
    expect(result.envelope?.ok).toBe(false);
    expect(result.envelope?.code).toBe("execution.session-unavailable");
  });
});
