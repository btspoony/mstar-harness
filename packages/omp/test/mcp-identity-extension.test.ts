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
 *   schemas (including the folded family's `x-mstar-selectors` index), which is
 *   the schema authority the extension must consult.
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
import mcpIdentityFactory, {
  MSTAR_SELECTORS_KEYWORD,
  MSTAR_TOOL_PREFIX,
  actionDeclaresSessionId,
  mcpIdentityInjection,
} from "../src/extensions/mcp-identity";
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
function schemaWith(fields: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { type: "object", properties: fields, ...extra };
}

/**
 * The published shape of one folded Morning Star family: `action` selects the
 * command, the field set is the union of the members', and the selector is
 * published ONCE for the tool — with the per-action index saying which actions
 * actually declare it (`packages/cli/src/mcp/fold.ts`).
 */
function familySchema(actions: readonly string[], selectorActions: readonly string[], fields: Record<string, unknown>): unknown {
  return schemaWith(
    { action: { type: "string", enum: actions }, sessionId: { type: "string" }, ...fields },
    {
      required: ["action"],
      [MSTAR_SELECTORS_KEYWORD]: [{ key: "sessionId", actions: selectorActions }],
    },
  );
}

const MIXED = "mcp__morning_star_mstar_status";
const UNIFORM = "mcp__morning_star_mstar_plan";
const UNINDEXED = "mcp__morning_star_mstar_issue";
const FOREIGN = "mcp__other_server__mstar_plan_bind";

/** One fixture registry: a mixed family, a uniform one, an unindexed one, a foreign tool. */
function fixtureTools(): Array<{ name: string; description: string; parameters: unknown }> {
  return [
    // `mstar_status` in miniature: `workflow-close` declares the selector,
    // `tech-debt` does not, and both share one published `sessionId` property.
    {
      name: MIXED,
      description: "status",
      parameters: familySchema(["tech-debt", "workflow-close"], ["workflow-close"], { workflow: { type: "string" } }),
    },
    // Every action declares it: the index lists the whole family.
    {
      name: UNIFORM,
      description: "plan",
      parameters: familySchema(["bind", "progress"], ["bind", "progress"], { execution: { type: "boolean" } }),
    },
    // A selector property with no per-action index cannot be qualified per
    // action, so no call to it is eligible.
    {
      name: UNINDEXED,
      description: "issue",
      parameters: schemaWith({ sessionId: { type: "string" }, id: { type: "string" } }),
    },
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
  test("injects the session's own id into the action that declares the selector", async () => {
    const { runner, sessionId } = await createHarness("mcp-id-capable");
    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t1",
      toolName: MIXED,
      input: { action: "workflow-close", workflow: "wf-1" },
    } as never);
    expect(result).toEqual({
      input: { action: "workflow-close", workflow: "wf-1", sessionId },
    });
    // A uniform family is eligible for every action it publishes.
    const uniform = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t2",
      toolName: UNIFORM,
      input: { action: "progress", execution: true },
    } as never);
    expect(uniform).toEqual({ input: { action: "progress", execution: true, sessionId } });
  });

  /**
   * The P1: the family publishes `sessionId` for the whole tool, but only
   * `workflow-close` declares it. Injecting it into `tech-debt` made the CLI
   * refuse every non-identity action of a mixed family with a recovery ("drop
   * `sessionId`") this hook would undo on the next call. The untouched return is
   * the whole guarantee: no key is added, so what reaches the transport is byte
   * for byte what the model sent.
   */
  test("leaves a sibling action that declares no selector untouched, even when the caller supplies one", async () => {
    const { runner } = await createHarness("mcp-id-mixed-sibling");
    const plain = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t3",
      toolName: MIXED,
      input: { action: "tech-debt" },
    } as never);
    expect(plain).toBeUndefined();
    // A caller-supplied id is passed through, never rewritten: the CLI refuses
    // it before admission (the claim cannot reach the engine), and stripping it
    // here would hide the caller's mistake instead of naming it.
    const claimed = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t4",
      toolName: MIXED,
      input: { action: "tech-debt", sessionId: "claimed-id" },
    } as never);
    expect(claimed).toBeUndefined();
  });

  test("replaces a caller-supplied FOREIGN live id with the host session's own id", async () => {
    const host = await createHarness("mcp-id-host-wins");
    // A second, genuinely live session: the id a hostile caller would put on the
    // wire to execute as another coordinator. The host's own id must win, or the
    // trusting connection would attribute the execution to that session.
    const foreign = await createHarness("mcp-id-foreign-live");
    expect(foreign.sessionId).not.toBe(host.sessionId);
    const result = await host.runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t5",
      toolName: MIXED,
      input: { action: "workflow-close", workflow: "wf-1", sessionId: foreign.sessionId },
    } as never);
    expect(result).toEqual({ input: { action: "workflow-close", workflow: "wf-1", sessionId: host.sessionId } });
    // Never a block, never a reason: the revision is the whole mechanism.
    expect((result as { block?: unknown }).block).toBeUndefined();
    expect((result as { reason?: unknown }).reason).toBeUndefined();
    // The pure decision pins the same rule: the host id replaces the claim.
    const injected = mcpIdentityInjection(
      { toolName: MIXED, input: { action: "workflow-close", sessionId: foreign.sessionId } },
      host.sessionId,
      true,
    );
    expect(injected?.input).toEqual({ action: "workflow-close", sessionId: host.sessionId });
  });

  test("prefilters the name prefix and requires a resolvable per-action registry answer", async () => {
    const { runner } = await createHarness("mcp-id-prefilter");
    // A foreign server's tool never qualifies, even with a declaring schema.
    expect(
      await runner.emitToolCall({
        type: "tool_call",
        toolCallId: "t6",
        toolName: FOREIGN,
        input: { action: "bind" },
      } as never),
    ).toBeUndefined();
    // A Morning Star name the registry does not list is not eligible either.
    expect(
      await runner.emitToolCall({
        type: "tool_call",
        toolCallId: "t7",
        toolName: "mcp__morning_star_mstar_unknown_verb",
        input: { action: "bind" },
      } as never),
    ).toBeUndefined();
    // A selector without a per-action index cannot be qualified, so it is not
    // filled: a wrong guess would refuse the call it tried to help.
    expect(
      await runner.emitToolCall({
        type: "tool_call",
        toolCallId: "t8",
        toolName: UNINDEXED,
        input: { action: "close" },
      } as never),
    ).toBeUndefined();
  });

  test("each session carries its own id (leaf attribution)", async () => {
    const first = await createHarness("mcp-id-leaf-a");
    const second = await createHarness("mcp-id-leaf-b");
    expect(first.sessionId).not.toBe(second.sessionId);
    const [resultA, resultB] = await Promise.all([
      first.runner.emitToolCall({
        type: "tool_call",
        toolCallId: "t9",
        toolName: MIXED,
        input: { action: "workflow-close" },
      } as never),
      second.runner.emitToolCall({
        type: "tool_call",
        toolCallId: "t10",
        toolName: MIXED,
        input: { action: "workflow-close" },
      } as never),
    ]);
    expect(resultA).toEqual({ input: { action: "workflow-close", sessionId: first.sessionId } });
    expect(resultB).toEqual({ input: { action: "workflow-close", sessionId: second.sessionId } });
  });
});

describe("mcp-identity pure decision and per-action schema probe", () => {
  test("the host's own MCP name minter composes names this extension's prefix matches (naming drift guard)", () => {
    // The extension's prefilter hardcodes the `mcp__<sanitized server>_<tool>`
    // spelling for the shipped `morning-star` server; the HOST mints tool
    // names with `createMCPToolName`. If either side's convention drifts, this
    // fails instead of every injection silently skipping.
    const minted = createMCPToolName("morning-star", "mstar_workflow_register");
    expect(minted).toBe(`${MSTAR_TOOL_PREFIX}workflow_register`);
    expect(minted.startsWith(MSTAR_TOOL_PREFIX)).toBe(true);
  });

  test("actionDeclaresSessionId answers per selected action, never per family", () => {
    const mixed = familySchema(["tech-debt", "workflow-close"], ["workflow-close"], {});
    expect(actionDeclaresSessionId(mixed, "workflow-close")).toBe(true);
    expect(actionDeclaresSessionId(mixed, "tech-debt")).toBe(false);
    // The union property alone is not the answer: an action absent from the
    // index, an unknown action, and a missing action all declare nothing.
    expect(actionDeclaresSessionId(mixed, "no-such-action")).toBe(false);
    expect(actionDeclaresSessionId(mixed, undefined)).toBe(false);
    expect(actionDeclaresSessionId(mixed, "")).toBe(false);
    // A selector property with no index, and a non-object schema, declare
    // nothing.
    expect(actionDeclaresSessionId(schemaWith({ sessionId: { type: "string" } }), "close")).toBe(false);
    expect(actionDeclaresSessionId({ type: "string" }, "close")).toBe(false);
    expect(actionDeclaresSessionId(null, "close")).toBe(false);
    expect(actionDeclaresSessionId("schema", "close")).toBe(false);
    // A different selector key never qualifies as `sessionId`.
    expect(
      actionDeclaresSessionId(
        schemaWith({}, { [MSTAR_SELECTORS_KEYWORD]: [{ key: "harness", actions: ["bind"] }] }),
        "bind",
      ),
    ).toBe(false);
  });

  test("the pure decision refuses non-object input and non-prefixed names", () => {
    expect(mcpIdentityInjection({ toolName: MIXED, input: "not-an-object" }, "s", true)).toBeUndefined();
    expect(mcpIdentityInjection({ toolName: "mstar_plan_bind", input: {} }, "s", true)).toBeUndefined();
    expect(mcpIdentityInjection({ toolName: MIXED, input: { action: "tech-debt" } }, "s", false)).toBeUndefined();
  });
});
