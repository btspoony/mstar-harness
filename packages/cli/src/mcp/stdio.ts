import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { withToolCorrection } from "./correction.js";
import type { McpEffects } from "./effects.js";
import { createMcpServer } from "./server.js";
import type { ResolveContext } from "./register.js";

export const resolveContext: ResolveContext = (_definition, _input, signal, _services, effects: McpEffects) => ({
  cwd: process.cwd(),
  controlRoot: resolveProcessHarnessDir(process.cwd()),
  versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
  signal,
  effects,
});

export function serveMcpStdio(): StdioServerHandle {
  return serveMcpStdioOver(new StdioServerTransport());
}

/**
 * The production stdio assembly, parameterized over the transport so tests can
 * drive the exact serving path (real command catalog → catalog provider →
 * corrective transport) with an in-memory transport. The catalog must be
 * populated through the same `onNames` callback wiring the process entry uses;
 * a broken wiring shows up as a missing suggestion in end-to-end tests.
 */
export function serveMcpStdioOver(transport: Transport): StdioServerHandle {
  const catalog = new Set<string>();
  const corrected = withToolCorrection(transport, () => catalog);
  return serveStdio(() => createMcpServer(resolveContext, undefined, (names) => {
    for (const name of names) catalog.add(name);
  }), { legacy: "serve", transport: corrected });
}

if (import.meta.main) {
  await serveMcpStdio();
}
