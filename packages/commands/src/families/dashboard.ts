import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition, CommandEffects, CommandEnvelope, InvocationContext } from "../types.js";
import type { RunningDashboard } from "../dashboard/server.js";

const id = "dashboard";
const inputSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(0),
  open: z.boolean().optional(),
  project: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;

// The effects object is connection-scoped by the host. Keep one live handle per
// root/port on that connection so repeated calls reuse the same listener.
const dashboards = new WeakMap<CommandEffects, Map<string, Promise<RunningDashboard>>>();

function failure(code: string, error: unknown, status: "refused" | "error" = "refused"): CommandEnvelope<never> {
  return {
    version: 1,
    command: id,
    status,
    code,
    exitCode: 1,
    message: error instanceof Error ? error.message : String(error),
  };
}

function serviceFor(context: InvocationContext, harnessDir: string, port: number, projectId?: string): { server: Promise<RunningDashboard>; reused: boolean } {
  let services = dashboards.get(context.effects);
  if (services === undefined) {
    services = new Map();
    dashboards.set(context.effects, services);
  }
  const key = JSON.stringify([harnessDir, port, projectId ?? null]);
  const existing = services.get(key);
  if (existing !== undefined) return { server: existing, reused: true };

  const starting = context.effects.startDashboard({
    harnessDir,
    port,
    ...(projectId === undefined ? {} : { projectId }),
  }).catch((error: unknown) => {
    services!.delete(key);
    throw error;
  });
  services.set(key, starting);
  return { server: starting, reused: false };
}
/** Drop one started handle from the connection cache by its own key. */
function forget(context: InvocationContext, harnessDir: string, port: number, projectId?: string): void {
  dashboards.get(context.effects)?.delete(JSON.stringify([harnessDir, port, projectId ?? null]));
}
async function execute(input: Input, context: InvocationContext): Promise<CommandEnvelope> {
  if (context.signal.aborted) {
    return { version: 1, command: id, status: "error", code: "command.cancelled", exitCode: 1, message: "cancelled" };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      version: 1,
      command: id,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: parsed.error.message,
    };
  }
  const harnessDir = context.controlRoot;
  if (harnessDir === null) {
    return failure("dashboard.harness-unavailable", new Error("no {HARNESS_DIR} found from the working directory"));
  }

  let server: RunningDashboard;
  let reused: boolean;
  try {
    const started = serviceFor(context, harnessDir, parsed.data.port, parsed.data.project);
    reused = started.reused;
    server = await started.server;
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "dashboard.start-failed";
    return failure(code, error);
  }
  if (context.signal.aborted) {
    // Cancellation arrived while this call was starting a listener: stop the
    // handle THIS call created and drop it from the cache, so the aborted
    // request leaves no connection-scoped service behind. A handle another
    // call already owns is reused, never stopped, because the connection still
    // holds it.
    if (!reused) {
      forget(context, harnessDir, parsed.data.port, parsed.data.project);
      await server.close();
    }
    return { version: 1, command: id, status: "error", code: "command.cancelled", exitCode: 1, message: "cancelled" };
  }

  if (parsed.data.open === true) {
    try {
      await context.effects.openBrowser(server.url);
    } catch (error) {
      forget(context, harnessDir, parsed.data.port, parsed.data.project);
      await server.close();
      return failure("capability.browser.unavailable", error, "error");
    }
  }

  return {
    version: 1,
    command: id,
    status: "ok",
    code: "dashboard.started",
    exitCode: 0,
    data: { url: server.url, lifetime: "connection" },
  };
}

export function getDashboardCommandDefinitions(): readonly CommandDefinition[] {
  return [{
    id,
    cli: {
      path: ["dashboard"],
      aliases: [],
      arguments: [],
      options: [
        { key: "port", flags: "--port <port>", required: false, defaultValue: 0 },
        { key: "open", flags: "--open", required: false },
        { key: "project", flags: "--project <projectId>", required: false },
      ],
    },
    input: inputSchema,
    output: commandEnvelopeSchema,
    effects: ["service"],
    description: "Start the read-only Morning Star dashboard on 127.0.0.1",
    execute,
  }];
}
