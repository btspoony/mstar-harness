import { dirname } from "node:path";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import { withToolCorrection } from "./correction.js";
import type { McpEffects } from "./effects.js";
import { createMcpServer } from "./server.js";
import type { ResolveContext } from "./register.js";

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
 * is `process.cwd()` and the control root is its probe.
 *
 * The pin is also published as `harnessPin` (the exact harness dir, not its
 * parent), so a command that owns root placement — `harness.scaffold` with no
 * explicit path — initializes the pinned harness itself instead of
 * re-discovering a root from the workspace anchor.
 */
export function createContextResolver(options: McpStdioOptions = {}): ResolveContext {
  const resolver: ResolveContext = (_definition, _sessionId, signal, _services, effects: McpEffects) => {
    const sessionId = declaredSessionId(options.identityEnv);
    return {
      cwd: options.harnessRoot === undefined ? process.cwd() : dirname(options.harnessRoot),
      controlRoot: options.harnessRoot ?? resolveProcessHarnessDir(process.cwd()),
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
