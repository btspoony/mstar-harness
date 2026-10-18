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
 * rebased or discovered, because the mounting process owns the root.
 */
export function createContextResolver(options: McpStdioOptions = {}): ResolveContext {
  const resolver: ResolveContext = (_definition, _sessionId, signal, _services, effects: McpEffects) => {
    const sessionId = declaredSessionId(options.identityEnv);
    return {
      cwd: process.cwd(),
      controlRoot: options.harnessRoot ?? resolveProcessHarnessDir(process.cwd()),
      ...(sessionId === undefined ? {} : { sessionId }),
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal,
      effects,
    };
  };
  // Admission reads this before the handler resolves the context, so a
  // launcher-declared default satisfies a required session selector. A getter
  // keeps it a live read of the declared channel, not a construction snapshot.
  return Object.defineProperty(resolver, "defaultSessionId", {
    get: () => declaredSessionId(options.identityEnv),
    enumerable: true,
  });
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
