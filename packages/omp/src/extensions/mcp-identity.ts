/**
 * mcp-identity - omp extension: the host's per-call `sessionId` supply for the
 * Morning Star MCP tools (issue #383, option (a)).
 *
 * The MCP layer of `@mstar-harness/cli` declares an optional `sessionId`
 * parameter on exactly the tools whose command carries a session identity, and
 * only on a connection the launcher explicitly trusted
 * (`mcp.json` passes `--trust-caller-session-id`: this host owns the trust that
 * maps its session manager to the caller). The parameter IS the caller identity
 * the engine sees. omp never filled it, so a
 * standalone plan workflow registered from an omp primary session could not
 * carry its creator's identity through `workflow register -> coordinator bind
 * -> plan prepare -> plan progress`. This extension closes that gap
 * host-side: every eligible `mcp__morning_star_mstar_*` call is revised to
 * carry the calling session's own native id.
 *
 * Eligibility is schema-aware AND action-scoped, and it must be. The published
 * tools are folded command FAMILIES selected by a required `action`, and a
 * family publishes its selector ONCE for the whole tool because the JSON schema
 * is a union: `mstar_status` publishes `sessionId` only because
 * `workflow-close` accepts it. So the SELECTED action decides - the CLI refuses
 * a selector the selected action does not declare, and a call that carries one
 * anyway would be rejected with a recovery ("drop `sessionId`") this hook would
 * immediately undo by reinjecting. The per-action fact is published in the
 * tool's own `ToolInfo.parameters` as the `x-mstar-selectors` index
 * (`packages/cli/src/mcp/fold.ts`); a matching name prefix is a prefilter,
 * never sufficient alone, and an action that declares no selector passes
 * through untouched. The host also revalidates a `tool_call` input revision
 * against the tool's declared schema, so an added key the tool does not
 * declare at all is rejected before the call is ever scheduled.
 *
 * The revision is `{ ...input, sessionId }` with the HOST's id: the host
 * session ALWAYS wins, so a caller-supplied `sessionId` is deliberately
 * REPLACED, never honored. On the opted-in connection that value becomes the
 * execution identity (`packages/cli/src/mcp/register.ts` admits the wire
 * `sessionId`), so deferring to a caller's claim would let any agent act as
 * another live coordinator session - the host is the only identity authority
 * here. A caller-supplied id on an action that declares no selector is left
 * alone: that call is refused by the CLI before admission, so the claim never
 * reaches the engine. `block` is never set, and the id is read per event from
 * `ctx.sessionManager.getSessionId()`, so leaf sessions carry their own id and
 * never their parent's.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";

/**
 * Sanitized MCP tool prefix minted by the host's `createMCPToolName` for the
 * shipped `morning-star` server (`mcp__<sanitized server>_<tool>`); the MCP
 * tool itself is `mstar_<command id>` (e.g. `mcp__morning_star_mstar_plan_bind`).
 * Exported so tests can pin the host's own minter against this exact prefix.
 */
export const MSTAR_TOOL_PREFIX = "mcp__morning_star_mstar_";

/**
 * The published per-action selector index (`[{ key, actions }]`) of a folded
 * Morning Star family, as `packages/cli/src/mcp/fold.ts` publishes it. The
 * family-wide `properties` union cannot say which action accepts a selector;
 * this index is that fact.
 */
export const MSTAR_SELECTORS_KEYWORD = "x-mstar-selectors";

/** The plain-object input record of one tool call; narrows for keyed access. */
function isInputRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

/**
 * Whether the SELECTED action of one folded family tool declares `sessionId`.
 * The index is the whole per-action answer: an absent or unreadable index, or
 * an action its entry does not list, declares nothing - so a tool this host
 * cannot qualify never gets an injected key.
 */
export function actionDeclaresSessionId(parameters: unknown, action: unknown): boolean {
  if (!isInputRecord(parameters)) return false;
  if (typeof action !== "string" || action.length === 0) return false;
  const selectors = parameters[MSTAR_SELECTORS_KEYWORD];
  if (!Array.isArray(selectors)) return false;
  return selectors.some((entry) =>
    isInputRecord(entry)
    && entry.key === "sessionId"
    && Array.isArray(entry.actions)
    && entry.actions.includes(action));
}

/**
 * The pure injection decision for one `tool_call`, factored so the tests can
 * pin each rule against real tool metadata: `undefined` leaves the call
 * untouched; a result revises the executed input so the host's id is the one
 * the tool receives. `declaresSessionId` is the resolved per-action answer for
 * `event.toolName` and its `action`.
 */
export function mcpIdentityInjection(
  event: Pick<ToolCallEvent, "toolName" | "input">,
  sessionId: string,
  declaresSessionId: boolean,
): ToolCallEventResult | undefined {
  if (!event.toolName.startsWith(MSTAR_TOOL_PREFIX)) return undefined;
  // The concrete event union carries per-tool input types; the keyed rules
  // read it as the plain record it is at runtime.
  const input: unknown = event.input;
  if (!isInputRecord(input)) return undefined;
  if (!declaresSessionId) return undefined;
  // The caller's value, if any, is overwritten on purpose: see the header.
  return { input: { ...input, sessionId } };
}

/**
 * Whether the host's tool registry declares `sessionId` for this exact tool AND
 * this selected action.
 */
function registryActionDeclaresSessionId(pi: ExtensionAPI, toolName: string, action: unknown): boolean {
  try {
    return pi.getAllTools().some((tool) => tool.name === toolName && actionDeclaresSessionId(tool.parameters, action));
  } catch {
    return false;
  }
}

export default function mcpIdentity(pi: ExtensionAPI): void {
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    // Prefilter first: only Morning Star MCP tool names can ever be eligible.
    if (!event.toolName.startsWith(MSTAR_TOOL_PREFIX)) return undefined;
    // Read as the plain record it is at runtime: the event union carries
    // per-tool input types that do not all name `action`.
    const input: unknown = event.input;
    if (!isInputRecord(input)) return undefined;
    // Action-scoped eligibility from the host's own tool metadata: a family
    // publishes its selector once, so only the requested action can say whether
    // this call may carry one. A registry the host cannot resolve (or cannot
    // read) is never eligible.
    if (!registryActionDeclaresSessionId(pi, event.toolName, input.action)) return undefined;
    return mcpIdentityInjection(event, ctx.sessionManager.getSessionId(), true);
  });
}
