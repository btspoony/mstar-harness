import { dirname } from "node:path";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import { withToolCorrection } from "./correction.js";
import type { McpEffects } from "./effects.js";
import { createMcpServer } from "./server.js";
import type { ResolveContext } from "./register.js";

/**
 * Commands whose own operation establishes a harness root in a workspace that
 * has none: a null control root is their premise, not a misresolution, so the
 * unpinned resolver keeps the launch-cwd fallback for them alone (the
 * bootstrap channel a fresh workspace uses to establish its harness over MCP).
 */
const NULL_ROOT_BOOTSTRAP_COMMANDS = new Set(["harness.scaffold"]);

/**
 * The named refusal for an unpinned server whose launch cwd resolves to no
 * harness root (#533): the resolver refuses with the cause and the recovery
 * instead of letting a command present the launch cwd as the caller's control
 * root. The stdio transport surfaces the message as a tool error.
 */
export class McpControlRootError extends Error {
  readonly code = "mcp.control-root-unresolved";
  constructor(
    message: string,
    readonly details: { cwd: string; cause: string },
  ) {
    super(message);
    this.name = "McpControlRootError";
  }
}

/** The unpinned control-root probe outcome: a root, or the named cause. */
type UnpinnedProbe = { root: string; cause: null } | { root: null; cause: string };

/**
 * Probe the process cwd the way the unpinned branch always has, but keep the
 * probe's verdict instead of collapsing it: a null answer and a refusing probe
 * (`coordination.not-in-git`) are distinct named causes for the resolver's
 * refusal, never a root to hand a command.
 */
function probeUnpinnedControlRoot(cwd: string): UnpinnedProbe {
  try {
    const root = resolveProcessHarnessDir(cwd);
    if (root !== null) return { root, cause: null };
    return { root: null, cause: "no harness directory found within the workspace boundary of the launch cwd" };
  } catch (error) {
    return { root: null, cause: error instanceof Error ? error.message : String(error) };
  }
}

function unresolvedControlRootMessage(cwd: string, cause: string): string {
  return (
    `[mcp.control-root-unresolved] This MCP server was launched from ${cwd}, which resolves to no harness root (${cause}). ` +
    "The server cannot know which workspace a caller belongs to, so it refuses instead of probing a root the caller never named. " +
    "Recovery: launch the server with `mstar mcp --harness <absolute path>` (or set MSTAR_HARNESS_DIR for the server process) to pin the root, " +
    "or launch the host from the session workspace so the cwd probe resolves that workspace's root."
  );
}

export interface McpStdioOptions {
  /**
   * Environment variable the launcher declares as the default session-id
   * channel. Unset means the server reads no ambient identity at all: an MCP
   * connection is process-level, so any same-host process can set a variable;
   * a launcher that mounts a scoped server declares the channel explicitly.
   */
  identityEnv?: string;
  /**
   * Harness root the mounting process owns. Unset keeps the `process.cwd()`
   * probe: the plugin is installed once for many repositories, so a root is
   * passed per mount rather than inferred from whatever cwd the host chose.
   * A pinned root also becomes the invocation's workspace root (its parent
   * directory), so implicit harness-derived paths anchor on the pinned
   * harness instead of the launch cwd.
   */
  harnessRoot?: string;
}

function declaredSessionId(identityEnv: string | undefined): string | undefined {
  if (identityEnv === undefined) return undefined;
  const value = process.env[identityEnv];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Build the stdio context resolver for one launch. The exported `resolveContext`
 * below is this factory with no options, so the unparameterized server keeps
 * reading no ambient identity and probing `process.cwd()` for its harness root.
 *
 * A declared identity is only a default: `registerMcpCommands` merges a
 * per-call `sessionId` ahead of `resolved.sessionId`. A malformed declared value
 * is not repaired here — it reaches the same safe-session-id guard as a per-call
 * value, which refuses loudly.
 *
 * An explicit `harnessRoot` is used verbatim as `controlRoot`; it is never
 * rebased or discovered, because the mounting process owns the root. The same
 * root is also the admission default for any command that resolves its own root
 * from `input.harness`, so a pinned server cannot fall back to the process cwd's
 * harness.
 *
 * The pin also anchors the invocation's **workspace**: `cwd` becomes the pinned
 * root's parent directory, not `process.cwd()`. Every implicit harness-derived
 * path then follows the pin — a command that derives its review root from the
 * cwd (e.g. `audit.scaffold` without `--reviews-dir`), a relative `--dir` /
 * findings path, and `resolveProcessHarnessDir(cwd)` — so a pinned call cannot
 * write into the launch cwd's harness. Unpinned keeps today's behavior: `cwd`
 * is `process.cwd()` and the control root is its probe — but only while that
 * probe ANSWERS a root. A launch cwd that resolves to no harness root cannot
 * be silently adopted as the caller's control root (#533): commands would fall
 * back to the launch cwd as the store root and report `store.not-initialized`
 * for a workspace the caller never named. The resolver refuses instead with
 * the cause and the recovery (`mcp.control-root-unresolved`), except for
 * bootstrap commands whose own operation establishes a harness in a workspace
 * that has none.
 *
 * The pin is also published as `harnessPin` (the exact harness dir, not its
 * parent), so a command that owns root placement — `harness.scaffold` with no
 * explicit path — initializes the pinned harness itself instead of
 * re-discovering a root from the workspace anchor.
 */
export function createContextResolver(options: McpStdioOptions = {}): ResolveContext {
  const resolver: ResolveContext = (definition, _sessionId, signal, _services, effects: McpEffects) => {
    const sessionId = declaredSessionId(options.identityEnv);
    let controlRoot: string | null;
    if (options.harnessRoot === undefined) {
      const probe = probeUnpinnedControlRoot(process.cwd());
      if (probe.root === null && !NULL_ROOT_BOOTSTRAP_COMMANDS.has(definition.id)) {
        const cwd = process.cwd();
        throw new McpControlRootError(unresolvedControlRootMessage(cwd, probe.cause), { cwd, cause: probe.cause });
      }
      controlRoot = probe.root;
    } else {
      controlRoot = options.harnessRoot;
    }
    return {
      cwd: options.harnessRoot === undefined ? process.cwd() : dirname(options.harnessRoot),
      controlRoot,
      // A pin is also the exact harness dir: commands that own root placement
      // (e.g. `harness.scaffold`) must target it verbatim, not re-derive it.
      ...(options.harnessRoot === undefined ? {} : { harnessPin: options.harnessRoot }),
      ...(sessionId === undefined ? {} : { sessionId }),
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal,
      effects,
    };
  };
  // Admission reads these before the handler resolves the context, so a
  // launcher-declared default satisfies a required session selector and fills an
  // unset root input. Getters keep them live reads of the launch options, not
  // construction snapshots.
  Object.defineProperty(resolver, "defaultSessionId", {
    get: () => declaredSessionId(options.identityEnv),
    enumerable: true,
  });
  Object.defineProperty(resolver, "defaultHarness", {
    get: () => options.harnessRoot,
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
  }), { legacy: "serve", transport: corrected });
}

if (import.meta.main) {
  await serveMcpStdio();
}
