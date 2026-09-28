import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { McpEffects } from "./effects.js";
import { createMcpServer } from "./server.js";
import type { ResolveContext } from "./register.js";

const resolveContext: ResolveContext = (_definition, _input, signal, _services, effects: McpEffects) => ({
  cwd: process.cwd(),
  controlRoot: resolveProcessHarnessDir(process.cwd()),
  versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
  signal,
  effects,
  ...(process.env.MSTAR_HOST_SESSION_ID === undefined ? {} : { sessionId: process.env.MSTAR_HOST_SESSION_ID }),
});

export function serveMcpStdio(): StdioServerHandle {
  return serveStdio(() => createMcpServer(resolveContext), { legacy: "serve" });
}

if (import.meta.main) {
  await serveMcpStdio();
}
