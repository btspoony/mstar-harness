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

function serviceFor(context: InvocationContext, harnessDir: string, port: number, projectId?: string): Promise<RunningDashboard> {
  let services = dashboards.get(context.effects);
  if (services === undefined) {
    services = new Map();
    dashboards.set(context.effects, services);
  }
  const key = JSON.stringify([harnessDir, port, projectId ?? null]);
  const existing = services.get(key);
  if (existing !== undefined) return existing;

  const starting = context.effects.startDashboard({
    harnessDir,
    port,
    ...(projectId === undefined ? {} : { projectId }),
  }).catch((error: unknown) => {
    services!.delete(key);
    throw error;
  });
  services.set(key, starting);
  return starting;
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
  try {
    server = await serviceFor(context, harnessDir, parsed.data.port, parsed.data.project);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "dashboard.start-failed";
    return failure(code, error);
  }
  if (context.signal.aborted) {
    return { version: 1, command: id, status: "error", code: "command.cancelled", exitCode: 1, message: "cancelled" };
  }

  if (parsed.data.open === true) {
    try {
      await context.effects.openBrowser(server.url);
    } catch (error) {
      const services = dashboards.get(context.effects);
      services?.delete(JSON.stringify([harnessDir, parsed.data.port, parsed.data.project ?? null]));
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
