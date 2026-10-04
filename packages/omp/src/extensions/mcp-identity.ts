/**
 * mcp-identity — omp extension: the host's per-call `sessionId` supply for the
 * Morning Star MCP tools (issue #383, option (a)).
 *
 * The MCP layer of `@mstar-harness/cli` declares an optional `sessionId`
 * parameter on exactly the tools whose command carries a session identity; the
 * parameter IS the caller identity the engine sees. omp never filled it, so a
 * standalone plan workflow registered from an omp primary session could not
 * carry its creator's identity through `workflow register -> coordinator bind
 * -> plan prepare -> plan-pm bind -> progress`. This extension closes that gap
 * host-side: every eligible `mcp__morning_star_mstar_*` call whose input lacks
 * `sessionId` is revised to include the calling session's own native id.
 *
 * Eligibility is schema-aware, and it must be: the host revalidates a
 * `tool_call` input revision against the tool's declared schema, so an added
 * key the tool does not declare is rejected before the call is ever scheduled.
 * The tool's own `ToolInfo.parameters` is the authority — a matching name
 * prefix is a prefilter, never sufficient alone.
 *
 * The revision is additive-only: `{ ...input, sessionId }`. An explicit
 * caller-supplied id is never overridden, `block` is never set, and the id is
 * read per event from `ctx.sessionManager.getSessionId()`, so leaf sessions
 * carry their own id and never their parent's.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";

/**
 * Sanitized MCP tool prefix minted by the host's `createMCPToolName` for the
 * shipped `morning-star` server (`mcp__<sanitized server>_<tool>`); the MCP
 * tool itself is `mstar_<command id>` (e.g. `mcp__morning_star_mstar_plan_bind`).
 */
const MSTAR_TOOL_PREFIX = "mcp__morning_star_mstar_";

/** The plain-object input record of one tool call; narrows for keyed access. */
function isInputRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

/**
 * Whether one tool's declared parameter schema declares `sessionId`. TypeBox
 * object schemas carry their fields on `properties`; a schema of any other
 * shape declares nothing and is never eligible.
 */
export function toolDeclaresSessionId(parameters: unknown): boolean {
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) return false;
  if (!("properties" in parameters)) return false;
  const properties: unknown = parameters.properties;
  return typeof properties === "object" && properties !== null && !Array.isArray(properties) && "sessionId" in properties;
}

/**
 * The pure injection decision for one `tool_call`, factored so the tests can
 * pin each rule against real tool metadata: `undefined` leaves the call
 * untouched; a result revises the executed input additively and never blocks.
 * `toolDeclaresSessionId` is the resolved schema answer for `event.toolName`.
 */
export function mcpIdentityInjection(
  event: Pick<ToolCallEvent, "toolName" | "input">,
  sessionId: string,
  toolDeclaresSessionId: boolean,
): ToolCallEventResult | undefined {
  if (!event.toolName.startsWith(MSTAR_TOOL_PREFIX)) return undefined;
  if (!isInputRecord(event.input)) return undefined;
  if (event.input.sessionId !== undefined) return undefined;
  if (!toolDeclaresSessionId) return undefined;
  return { input: { ...event.input, sessionId } };
}

/** Whether the host's tool registry declares `sessionId` on this exact tool. */
function registryDeclaresSessionId(pi: ExtensionAPI, toolName: string): boolean {
  try {
    return pi.getAllTools().some((tool) => tool.name === toolName && toolDeclaresSessionId(tool.parameters));
  } catch {
    return false;
  }
}

export default function mcpIdentity(pi: ExtensionAPI): void {
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    // Prefilter first: only Morning Star MCP tool names can ever be eligible.
    if (!event.toolName.startsWith(MSTAR_TOOL_PREFIX)) return undefined;
    if (!isInputRecord(event.input) || event.input.sessionId !== undefined) return undefined;
    // Schema-aware eligibility from the host's own tool metadata: a tool the
    // registry cannot resolve (or an unreadable registry) is never eligible.
    const declares = registryDeclaresSessionId(pi, event.toolName);
    if (!declares) return undefined;
    return mcpIdentityInjection(event, ctx.sessionManager.getSessionId(), true);
  });
}
