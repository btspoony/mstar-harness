/**
 * mcp-identity extension tests — `packages/omp/src/extensions/mcp-identity.ts`.
 *
 * ## What is real here, and what the test supplies
 *
 * - `loadExtensionFromFactory` binds the module's real factory through the
 *   host's `ConcreteExtensionAPI`; `ExtensionRunner` is the host's runner, so
 *   `emitToolCall` dispatches through the host's own `tool_call` path with the
 *   host's `ExtensionContext` (per-session `sessionManager`).
 * - `SessionManager.create` writes the real session file: the injected id IS
 *   that session's own `getSessionId()`, so the leaf-attribution case is the
 *   host's identity semantics, not a mock.
 * - The test supplies the tool registry through the real `getAllTools` action
 *   seam — `ToolInfo.parameters` fixtures shaped like the host's TypeBox
 *   schemas — which is the schema authority the extension must consult.
 *
 * Not exercised here: a live MCP connection or a real `omp` process — the
 * registry content is supplied, and process-level loading belongs to the
 * bundle smoke suite.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionActions, ExtensionContextActions } from "@oh-my-pi/pi-coding-agent";
import { ExtensionRunner, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import mcpIdentityFactory, { MSTAR_TOOL_PREFIX, mcpIdentityInjection, toolDeclaresSessionId } from "../src/extensions/mcp-identity";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";

const SCRATCH: string[] = [];

afterAll(() => {
  for (const dir of SCRATCH.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(dir);
  return dir;
}

/** A TypeBox-shaped parameter schema like the host's tool metadata carries. */
function schemaWith(fields: Record<string, unknown>): unknown {
  return { type: "object", properties: fields };
}

const CAPABLE = "mcp__morning_star_mstar_plan_bind";
const INCAPABLE = "mcp__morning_star_mstar_status_validate";
const FOREIGN = "mcp__other_server__mstar_plan_bind";

/** One fixture registry: capable, incapable and foreign tools. */
function fixtureTools(): Array<{ name: string; description: string; parameters: unknown }> {
  return [
    { name: CAPABLE, description: "bind", parameters: schemaWith({ sessionId: { type: "string" }, workflow: { type: "string" } }) },
    { name: INCAPABLE, description: "validate", parameters: schemaWith({ harness: { type: "string" } }) },
    { name: FOREIGN, description: "foreign", parameters: schemaWith({ sessionId: { type: "string" } }) },
  ];
}

/**
 * A runner bound through the host's own loader with a real per-session
 * `SessionManager` and the fixture registry behind `getAllTools`.
 */
async function createHarness(label: string): Promise<{ runner: ExtensionRunner; sessionId: string }> {
  const cwd = scratchDir(`${label}-cwd-`);
  const sessionDir = join(cwd, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(cwd, sessionDir);
  // One runtime instance binds the loader, the API the factory receives and
  // the runner — the same wiring the model-handoff harness uses.
  const runtime = new ExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    mcpIdentityFactory,
    cwd,
    new EventBus(),
    runtime,
    "mstar-harness-mcp-identity",
  );
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    cwd,
    sessionManager,
    {} as unknown as ModelRegistry,
    undefined,
    undefined,
  );
  const untouched = (name: string) => () => {
    throw new Error(`${name} must not be called by the mcp-identity extension`);
  };
  const actions: ExtensionActions = {
    sendMessage: untouched("sendMessage"),
    sendUserMessage: untouched("sendUserMessage"),
    appendEntry: untouched("appendEntry"),
    setLabel: untouched("setLabel"),
    getActiveTools: untouched("getActiveTools"),
    getAllTools: () => fixtureTools() as never,
    setActiveTools: untouched("setActiveTools"),
    getCommands: untouched("getCommands"),
    setModel: untouched("setModel"),
    getThinkingLevel: untouched("getThinkingLevel"),
    setThinkingLevel: untouched("setThinkingLevel"),
    getSessionName: untouched("getSessionName"),
    setSessionName: untouched("setSessionName"),
  };
  const contextActions: ExtensionContextActions = {
    getModel: () => undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: async () => {},
    getSystemPrompt: () => [],
  };
  runner.initialize(actions, contextActions, undefined, undefined, "tui");
  return { runner, sessionId: sessionManager.getSessionId() };
}

describe("mcp-identity extension (host tool_call path)", () => {
  test("injects the session's own id into a schema-capable Morning Star call, additively", async () => {
    const { runner, sessionId } = await createHarness("mcp-id-capable");
    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t1",
      toolName: CAPABLE,
      input: { execution: true, workflow: "wf-1", coordinator: true },
    } as never);
    expect(result).toEqual({
      input: { execution: true, workflow: "wf-1", coordinator: true, sessionId },
    });
  });

  test("leaves a non-declaring schema untouched (no injection, no block)", async () => {
    const { runner } = await createHarness("mcp-id-incapable");
    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t2",
      toolName: INCAPABLE,
      input: { workflow: "wf-1" },
    } as never);
    expect(result).toBeUndefined();
  });

  test("preserves an explicit sessionId and never sets block or reason", async () => {
    const { runner, sessionId } = await createHarness("mcp-id-explicit");
    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t3",
      toolName: CAPABLE,
      input: { workflow: "wf-1", sessionId: "caller-chosen" },
    } as never);
    expect(result).toBeUndefined();
    // The pure decision pins the additive-only shape: no block/reason key ever.
    const injected = mcpIdentityInjection(
      { toolName: CAPABLE, input: { workflow: "wf-1" } },
      sessionId,
      true,
    );
    expect(injected).toBeDefined();
    expect(injected?.block).toBeUndefined();
    expect(injected?.reason).toBeUndefined();
    expect(injected?.input).toEqual({ workflow: "wf-1", sessionId });
  });

  test("prefilters the name prefix and requires a resolvable registry entry", async () => {
    const { runner } = await createHarness("mcp-id-prefilter");
    // A foreign server's tool never qualifies, even with a declaring schema.
    expect(
      await runner.emitToolCall({ type: "tool_call", toolCallId: "t4", toolName: FOREIGN, input: {} } as never),
    ).toBeUndefined();
    // A Morning Star name the registry does not list is not eligible either.
    expect(
      await runner.emitToolCall({
        type: "tool_call",
        toolCallId: "t5",
        toolName: "mcp__morning_star_mstar_unknown_verb",
        input: {},
      } as never),
    ).toBeUndefined();
  });

  test("each session carries its own id (leaf attribution)", async () => {
    const first = await createHarness("mcp-id-leaf-a");
    const second = await createHarness("mcp-id-leaf-b");
    expect(first.sessionId).not.toBe(second.sessionId);
    const [resultA, resultB] = await Promise.all([
      first.runner.emitToolCall({ type: "tool_call", toolCallId: "t6", toolName: CAPABLE, input: {} } as never),
      second.runner.emitToolCall({ type: "tool_call", toolCallId: "t7", toolName: CAPABLE, input: {} } as never),
    ]);
    expect(resultA).toEqual({ input: { sessionId: first.sessionId } });
    expect(resultB).toEqual({ input: { sessionId: second.sessionId } });
  });
});

describe("mcp-identity pure decision and schema probe", () => {
  test("the host's own MCP name minter composes names this extension's prefix matches (naming drift guard)", () => {
    // The extension's prefilter hardcodes the `mcp__<sanitized server>_<tool>`
    // spelling for the shipped `morning-star` server; the HOST mints tool
    // names with `createMCPToolName`. If either side's convention drifts, this
    // fails instead of every injection silently skipping.
    const minted = createMCPToolName("morning-star", "mstar_workflow_register");
    expect(minted).toBe(`${MSTAR_TOOL_PREFIX}workflow_register`);
    expect(minted.startsWith(MSTAR_TOOL_PREFIX)).toBe(true);
  });

  test("toolDeclaresSessionId reads TypeBox-shaped parameters only", () => {
    expect(toolDeclaresSessionId(schemaWith({ sessionId: { type: "string" } }))).toBe(true);
    expect(toolDeclaresSessionId(schemaWith({ workflow: { type: "string" } }))).toBe(false);
    expect(toolDeclaresSessionId({ type: "string" })).toBe(false);
    expect(toolDeclaresSessionId(null)).toBe(false);
    expect(toolDeclaresSessionId("schema")).toBe(false);
  });

  test("the pure decision refuses non-object input and non-prefixed names", () => {
    expect(mcpIdentityInjection({ toolName: CAPABLE, input: "not-an-object" }, "s", true)).toBeUndefined();
    expect(mcpIdentityInjection({ toolName: "mstar_plan_bind", input: {} }, "s", true)).toBeUndefined();
  });
});
