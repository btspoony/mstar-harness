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
  encodeExecutionSessionRef,
  ExecutionError,
  serializeExecutionValue,
  type ExecutionIdentity,
  type ExecutionSessionRef,
} from "@mstar-harness/engine";
import {
  EXECUTION_IDENTITY_ENV,
  LEGACY_SESSION_ID_ENV,
  MorningStarHarnessPlugin,
  OPENCODE_EXECUTION_CLI_ENV,
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
const planScope = { workflowId: "wf-opencode", role: "plan-pm" as const, planId: "plan-opencode" };
const nativeIdentity: ExecutionIdentity = { source: "host", sessionId: reference.sessionId, ...scope };

/** The checkout's own CLI entry — the real syntax this consumer must speak. */
const CLI_ENTRY = fileURLToPath(new URL("../../../packages/cli/src/index.ts", import.meta.url));

const projects: string[] = [];
const previousCliEnv = process.env[OPENCODE_EXECUTION_CLI_ENV];
afterEach(() => {
  if (previousCliEnv === undefined) delete process.env[OPENCODE_EXECUTION_CLI_ENV];
  else process.env[OPENCODE_EXECUTION_CLI_ENV] = previousCliEnv;
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

/** A launcher script that runs the checkout's real CLI (the child command). */
function makeCliLauncher(project: string): string {
  const launcher = join(project, "mstar-launcher");
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI_ENTRY)} "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
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
});

describe("OpenCode shared-CLI transport (real CLI syntax)", () => {
  test("overwrites the identity channel and the root, and never inherits the legacy key", () => {
    const overrides = openCodeExecutionEnvOverrides(nativeIdentity, "/resolved/root");
    expect(overrides[EXECUTION_IDENTITY_ENV]).toBe(serializeExecutionValue(nativeIdentity));
    expect(overrides[LEGACY_SESSION_ID_ENV]).toBeUndefined();
    expect(overrides.MSTAR_HARNESS_DIR).toBe("/resolved/root");
    // With no resolved root the inherited global is removed, not forwarded.
    expect(openCodeExecutionEnvOverrides(nativeIdentity).MSTAR_HARNESS_DIR).toBeUndefined();
  });

  test("the coordinator register read is a real CLI invocation that really exits 0", () => {
    const { harness } = makeHarnessProject();
    const result = runOpenCodeExecutionCli(["status", "validate"], nativeIdentity, {
      command: makeCliLauncher(harness),
      env: ambientEnv(nativeIdentity),
      harnessRoot: harness,
    });
    // An invented flag on this verb would exit 2 with a commander usage error:
    // the real exit code IS the argv contract this consumer must speak.
    expect(result.stderr).not.toContain("unknown option");
    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("the plan-scope authority read keeps the CLI's own usage refusal on a legacy harness", () => {
    const { harness } = makeHarnessProject();
    const result = runOpenCodeExecutionCli(
      ["plan", "show", "--workflow", planScope.workflowId, "--plan", planScope.planId, "--json", "--harness", harness],
      { source: "host", sessionId: reference.sessionId, ...planScope },
      { command: makeCliLauncher(harness), env: ambientEnv(nativeIdentity), harnessRoot: harness },
    );
    // The route decision is the real one: no ACTIVE execution authority here,
    // so the CLI refuses in its own words instead of printing an empty view.
    expect(result.status).toBe(2);
    expect(result.stderr + result.stdout).toContain("execution authority");
  });

  test("a gated write consults the real CLI and never claims a false refusal or a fence", async () => {
    const { harness, statusPath } = makeHarnessProject();
    process.env[OPENCODE_EXECUTION_CLI_ENV] = makeCliLauncher(harness);
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
});
