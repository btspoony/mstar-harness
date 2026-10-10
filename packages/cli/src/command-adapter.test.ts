import { encodeExecutionSessionRef, serializeExecutionValue, type ExecutionIdentity } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions, getCommandSchemas, type InvocationContext } from "@mstar-harness/commands";
import { mintedIdentityScopeProblem, renderCommandContract, resolveCliSessionIdentity } from "./command-adapter";
import { afterEach, expect, test } from "bun:test";
test("issue payload help uses registry field requiredness", () => {
  const definitions = getCommandDefinitions();
  const close = definitions.find((definition) => definition.id === "issue.close");
  const reopen = definitions.find((definition) => definition.id === "issue.reopen");
  if (close === undefined || reopen === undefined) throw new Error("issue definitions missing");
  const closeHelp = renderCommandContract(close, "cli");
  expect(closeHelp).toContain("reason (required) (string)");
  expect(closeHelp).toContain("references (requiredWhen: resolved) (string[])");
  expect(closeHelp).toContain("alignmentRef (requiredWhen: resolved or waived) (string)");
  expect(renderCommandContract(reopen, "cli")).toContain("reason (required) (string)");
});

const originalSessionId = process.env.MSTAR_HOST_SESSION_ID;
const originalMinted = process.env.MSTAR_EXECUTION_IDENTITY;

afterEach(() => {
  if (originalSessionId === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
  else process.env.MSTAR_HOST_SESSION_ID = originalSessionId;
  if (originalMinted === undefined) delete process.env.MSTAR_EXECUTION_IDENTITY;
  else process.env.MSTAR_EXECUTION_IDENTITY = originalMinted;
});

/** The canonical tuple a launcher writes, exactly as `session.run` serializes it. */
function mintedIdentity(overrides: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return { source: "local", sessionId: "minted-session", workflowId: "wf-launched", role: "coordinator", ...overrides };
}

test("CLI session identity accepts an explicit override without parsing a malformed launched identity", () => {
  process.env.MSTAR_HOST_SESSION_ID = "env-session";
  process.env.MSTAR_EXECUTION_IDENTITY = "not json";
  expect(resolveCliSessionIdentity("flag-session")).toEqual({
    sessionId: "flag-session",
    sessionIdSource: "flag",
  });
});

test("CLI session identity consumes the launcher-minted identity ahead of the ambient host value", () => {
  process.env.MSTAR_HOST_SESSION_ID = "env-session";
  const identity = mintedIdentity();
  process.env.MSTAR_EXECUTION_IDENTITY = serializeExecutionValue(identity);
  expect(resolveCliSessionIdentity(undefined)).toEqual({
    sessionId: identity.sessionId,
    sessionIdSource: "env",
    executionIdentity: identity,
  });
});

test("CLI session identity resolves and attributes the environment fallback", () => {
  delete process.env.MSTAR_EXECUTION_IDENTITY;
  process.env.MSTAR_HOST_SESSION_ID = "env-session";
  expect(resolveCliSessionIdentity(undefined)).toEqual({
    sessionId: "env-session",
    sessionIdSource: "env",
  });
});
test("CLI session identity treats empty and whitespace environment values as unset", () => {
  delete process.env.MSTAR_EXECUTION_IDENTITY;
  for (const value of ["", "   ", "\t\n"]) {
    process.env.MSTAR_HOST_SESSION_ID = value;
    expect(resolveCliSessionIdentity(undefined)).toEqual({});
  }
});


test("CLI session identity omits both value and source when unset", () => {
  delete process.env.MSTAR_HOST_SESSION_ID;
  delete process.env.MSTAR_EXECUTION_IDENTITY;
  expect(resolveCliSessionIdentity(undefined)).toEqual({});
});

test("CLI session identity refuses a malformed minted transport instead of downgrading to the ambient value", () => {
  process.env.MSTAR_HOST_SESSION_ID = "env-session";
  for (const malformed of [
    "not json",
    "[]",
    '"scalar"',
    serializeExecutionValue({ source: "local", sessionId: "", workflowId: "wf-launched", role: "coordinator" }),
    serializeExecutionValue({ source: "local", sessionId: "minted", workflowId: "wf-launched", role: "worker" }),
    serializeExecutionValue({ source: "local", sessionId: "../escape", workflowId: "wf-launched", role: "coordinator" }),
  ]) {
    process.env.MSTAR_EXECUTION_IDENTITY = malformed;
    // A broken launch refuses; it never silently binds the ambient host session
    // or a fabricated id.
    expect(() => resolveCliSessionIdentity(undefined)).toThrow();
  }
});

test("CLI scope gate constrains a minted identity to the scope it declares", () => {
  const identity = mintedIdentity();
  // The same workflow as a sessionRef, an active bind and an active token route
  // is accepted; only a genuinely different declared scope is refused.
  const sameWorkflowRef = encodeExecutionSessionRef({
    storeId: "stores/scope", epoch: 1, workflowId: identity.workflowId, role: "coordinator", sessionId: "s",
  });
  expect(mintedIdentityScopeProblem(identity, { sessionRef: sameWorkflowRef, operation: "op" }, "plan.progress")).toBeUndefined();
  expect(mintedIdentityScopeProblem(identity, { execution: true, workflow: identity.workflowId, coordinator: true }, "plan.bind")).toBeUndefined();
  expect(mintedIdentityScopeProblem(identity, { workflow: identity.workflowId, expect: "exec-v1:plan:x:1:k:1" }, "workflow.register")).toBeUndefined();
  // An ambient identity that addresses nothing derivable is never constrained.
  expect(mintedIdentityScopeProblem(undefined, { workflow: "wf-other" }, "workflow.register")).toBeUndefined();

  // A reference whose declared workflow differs is refused, and so is an active
  // bind to another workflow — the refusal is a presence, not a prose match.
  const otherRef = encodeExecutionSessionRef({
    storeId: "stores/scope", epoch: 1, workflowId: "wf-elsewhere", role: "coordinator", sessionId: "s",
  });
  expect(mintedIdentityScopeProblem(identity, { sessionRef: otherRef }, "plan.progress")).toBeDefined();
  expect(mintedIdentityScopeProblem(identity, { execution: true, workflow: "wf-elsewhere", coordinator: true }, "plan.bind")).toBeDefined();

  // A coordinator-seat registration addresses the coordinator seat regardless of
  // its registered plan selector: the registered plan is a row, not the caller
  // seat, so a selector the identity does not declare is never reinterpreted.
  expect(mintedIdentityScopeProblem(identity, { workflow: identity.workflowId, planId: "plan-registered", expect: "exec-v1:plan:x:1:k:1" }, "workflow.register")).toBeUndefined();
  // An active bind to another workflow states a seat the identity does not declare.
  expect(mintedIdentityScopeProblem(identity, {
    execution: true, workflow: "wf-elsewhere", coordinator: true,
  }, "plan.bind")).toBeDefined();

  // A legacy route that ignores the identity is not constrained by this gate.
  expect(mintedIdentityScopeProblem(identity, { coordinator: true, workflow: "wf-elsewhere" }, "plan.bind")).toBeUndefined();
  expect(mintedIdentityScopeProblem(identity, { resume: "/tmp/x.json", workflow: "wf-elsewhere" }, "plan.bind")).toBeUndefined();
  // A malformed reference stays the family's own typed refusal.
  expect(mintedIdentityScopeProblem(identity, { sessionRef: "not-a-wire", operation: "op" }, "plan.progress")).toBeUndefined();
});
test("registry exposes schema descriptors for supported operations", async () => {
  const definitions = getCommandDefinitions();
  const context: InvocationContext = {
    cwd: process.cwd(),
    controlRoot: process.cwd(),
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 0, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("unused"); },
      async openBrowser() { throw new Error("unused"); },
    },
  };
  for (const definition of definitions) {
    const published = await executeCommand("schema", { command: definition.id }, context);
    expect(published).toMatchObject({ status: "ok", data: { descriptor: { id: definition.id } } });
  }
});
