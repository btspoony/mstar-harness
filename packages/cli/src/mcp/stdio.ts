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
  const catalog = new Set<string>();
  const transport = withToolCorrection(new StdioServerTransport(), () => catalog);
  return serveStdio(() => createMcpServer(resolveContext, undefined, (names) => {
    for (const name of names) catalog.add(name);
  }), { legacy: "serve", transport });
}

if (import.meta.main) {
  await serveMcpStdio();
}
