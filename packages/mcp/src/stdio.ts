import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server.js";
import type { ResolveContext } from "./register.js";

const resolveContext: ResolveContext = () => {
  throw new Error("MCP invocation context is not configured by this package entry yet.");
};

export function serveMcpStdio(): StdioServerHandle {
  return serveStdio(() => createMcpServer(resolveContext), { legacy: "serve" });
}

if (import.meta.main) {
  await serveMcpStdio();
}
