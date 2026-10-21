import { dirname, resolve } from "node:path";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import { withToolCorrection } from "./correction.js";
import type { McpEffects } from "./effects.js";
import { createMcpServer } from "./server.js";
import type { ResolveContext, ResolveContextCall } from "./register.js";

/**
 * Commands whose own operation establishes a harness root in a workspace that
 * has none: a null control root is their premise, not a misresolution, so the
 * resolver admits them without one (the bootstrap channel a fresh workspace
 * uses to establish its harness over MCP). Every other command is refused.
 */
const NULL_ROOT_BOOTSTRAP_COMMANDS = new Set(["harness.scaffold"]);

/**
 * The named refusal for a call on a connection that DECLARED no control root
 * and named none itself: the resolver refuses with the cause and every recovery
 * instead of letting the host's launch directory stand in for the caller's
 * workspace. The stdio transport surfaces the message as a tool error.
 */
export class McpControlRootError extends Error {
  readonly code = "mcp.control-root-unresolved";
  constructor(
    message: string,
    readonly details: { cwd: string },
  ) {
    super(message);
    this.name = "McpControlRootError";
  }
}

function unresolvedControlRootMessage(cwd: string): string {
  return (
    `[mcp.control-root-unresolved] No control root was DECLARED for this MCP connection. ` +
    `The launch cwd (${cwd}) is the HOST's directory and is never used as one: it says nothing about which workspace a caller belongs to, so adopting it would root writes on an unrelated project. ` +
    "Recovery — declare the root once for the connection, or per call: " +
    "launch the server with `mstar mcp --harness <absolute path>`; " +
    "set MSTAR_HARNESS_DIR in the server environment to the harness directory; " +
    "or pass the call's `harness` selector naming the workspace's harness."
  );
}

/** The seat values a launcher can declare; a leaf connection refuses the coordinator-seat commands. */
export type McpSeat = "leaf";

export interface McpStdioOptions {
  /**
   * Harness root the launcher DECLARES for the whole connection (`--harness`).
   * It pins every call's `controlRoot` and is the admission default for any
   * command that resolves its own root from `input.harness`. A non-blank
   * `MSTAR_HARNESS_DIR` in the server environment is the same declaration when
   * this option is unset; a call's own `harness` selector is used only when the
   * launch declared neither. The launch cwd is never a root candidate.
   */
  harnessRoot?: string;
  /**
   * Session workspace every call runs from (the invocation `cwd`). Unset
   * anchors it on the declared root's parent directory, so cwd-derived paths
   * land under the declared harness. The launch process cwd is used only by the
   * bootstrap family, which has no root yet to anchor on.
   */
  workspace?: string;
  /**
   * The connection's seat. `leaf` refuses the coordinator-seat commands
   * (`plan.bind`, `plan.complete`) before execution with the named cause and
   * recovery; every other command stays reachable, so a leaf session keeps
   * its writable subset instead of having no route at all.
   */
  seat?: McpSeat;
}

/**
 * The root the launch declared for the whole connection, or undefined when it
 * declared none. The `--harness` flag wins over `MSTAR_HARNESS_DIR`: both are
 * launcher facts, and the explicit flag is the stronger one; neither is
 * overridable by a caller. A blank variable is not a declaration. Read ONCE
 * when the factory runs — the declared root is a launch fact.
 */
function declaredRoot(options: McpStdioOptions): string | undefined {
  if (options.harnessRoot !== undefined) return options.harnessRoot;
  const fromEnv = process.env.MSTAR_HARNESS_DIR;
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? resolve(fromEnv) : undefined;
}

/**
 * Build the stdio context resolver for one launch. The exported `resolveContext`
 * below is this factory with no options: a generic shared connection that
 * declares no root and carries no identity.
 *
 * Root selection is one ordered rule, and the launch cwd is never a candidate:
 *
 * 1. the connection pin — `--harness`, else a non-blank `MSTAR_HARNESS_DIR`;
 * 2. the root the ADMITTED CALL named (`harness` selector, validated by shared
 *    admission);
 * 3. the bootstrap exception — `harness.scaffold` runs with a null root because
 *    establishing one is its own operation;
 * 4. otherwise the call is REFUSED (`mcp.control-root-unresolved`) with the
 *    cause and all three recoveries.
 *
 * A connection pin always beats a per-call selector, so a caller can never root
 * a call on a workspace the launcher did not declare. The order matters:
 * testing the call selector before `MSTAR_HARNESS_DIR` would let a caller
 * override a launcher-declared pin — the bug this rule exists to prevent.
 *
 * The rule the resolution uses also anchors the invocation **workspace**: `cwd`
 * is the root's parent directory, never `process.cwd()`, so every implicit
 * harness-derived path — a command's review root (e.g. `audit.scaffold` without
 * `--reviews-dir`), a relative `--dir` / findings path — follows the root the
 * call actually uses instead of the host's directory. The bootstrap exception,
 * which has no root yet, is the only path that keeps `process.cwd()`.
 *
 * The `--harness` pin is also published as `harnessPin` (the exact harness dir,
 * not its parent), so a command that owns root placement — `harness.scaffold`
 * with no explicit path — initializes the pinned harness itself instead of
 * re-discovering a root from the workspace anchor. An environment-declared root
 * needs no separate pin: the command's own resolution reads the same variable.
 */
export function createContextResolver(options: McpStdioOptions = {}): ResolveContext {
  const pinned = declaredRoot(options);
  const resolver: ResolveContext = (definition, _sessionId, signal, _services, effects: McpEffects, call?: ResolveContextCall) => {
    // The root the ADMITTED CALL named. A blank value is not a declaration:
    // the command resolvers treat it as absent, so it must not become a root
    // candidate here either.
    const callHarness = typeof call?.harness === "string" && call.harness.trim() !== "" ? call.harness : undefined;
    let controlRoot: string | null;
    if (pinned !== undefined) controlRoot = pinned;
    else if (callHarness !== undefined) controlRoot = callHarness;
    else if (NULL_ROOT_BOOTSTRAP_COMMANDS.has(definition.id)) controlRoot = null;
    else {
      const cwd = process.cwd();
      throw new McpControlRootError(unresolvedControlRootMessage(cwd), { cwd });
    }
    return {
      cwd: options.workspace ?? (controlRoot === null ? process.cwd() : dirname(controlRoot)),
      controlRoot,
      // A pin is also the exact harness dir: commands that own root placement
      // (e.g. `harness.scaffold`) must target it verbatim, not re-derive it.
      ...(options.harnessRoot === undefined ? {} : { harnessPin: options.harnessRoot }),
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal,
      effects,
    };
  };
  // The declared root is the connection's default for admission: a command that
  // resolves its own root from `input.harness` has that field filled from it,
  // and registration publishes `harness` as REQUIRED when this is undefined —
  // an unpinned connection, where the caller must name the root on every call.
  Object.defineProperty(resolver, "defaultHarness", {
    get: () => pinned,
    enumerable: true,
  });
  return resolver;
}

export const resolveContext: ResolveContext = createContextResolver();

export function serveMcpStdio(options: McpStdioOptions = {}): StdioServerHandle {
  return serveMcpStdioOver(new StdioServerTransport(), options);
}

/**
 * The production stdio assembly, parameterized over the transport so tests can
 * drive the exact serving path (real command catalog → catalog provider →
 * corrective transport) with an in-memory transport. The catalog must be
 * populated through the same `onNames` callback wiring the process entry uses;
 * a broken wiring shows up as a missing suggestion in end-to-end tests.
 */
export function serveMcpStdioOver(transport: Transport, options: McpStdioOptions = {}): StdioServerHandle {
  const catalog = new Set<string>();
  const corrected = withToolCorrection(transport, () => catalog);
  return serveStdio(() => createMcpServer(createContextResolver(options), undefined, (names) => {
    for (const name of names) catalog.add(name);
  }, options.seat), { legacy: "serve", transport: corrected });
}

if (import.meta.main) {
  await serveMcpStdio();
}
