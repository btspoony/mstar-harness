import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";
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
// Each slot tracks whether ANY call has already delivered its URL (a success
// return hands the listener to the connection, so no later cancellation may
// tear it down) and how many calls are still awaiting the shared startup —
// the starter that gets cancelled must not close the listener out from under
// a concurrent caller that is awaiting the same startup.
type DashboardSlot = {
  server: Promise<RunningDashboard>;
  delivered: boolean;
  waiters: number;
};
const dashboards = new WeakMap<CommandEffects, Map<string, DashboardSlot>>();

export function failure(code: string, error: unknown): CommandEnvelope<never> {
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message: error instanceof Error ? error.message : String(error),
    details: { operation: id },
   recovery: code === "dashboard.harness-unavailable"
        ? "Resolve the control harness root for the current dashboard invocation, then retry dashboard startup."
        : "Resolve the dashboard startup cause in the diagnostic, including the configured port or listener failure, then retry startup."});
}

function serviceFor(context: InvocationContext, harnessDir: string, port: number, projectId?: string): { slot: DashboardSlot; reused: boolean } {
  let services = dashboards.get(context.effects);
  if (services === undefined) {
    services = new Map();
    dashboards.set(context.effects, services);
  }
  const key = JSON.stringify([harnessDir, port, projectId ?? null]);
  const existing = services.get(key);
  if (existing !== undefined) return { slot: existing, reused: true };

  const slot = {} as DashboardSlot;
  slot.delivered = false;
  slot.waiters = 0;
  slot.server = context.effects.startDashboard({
    harnessDir,
    port,
    ...(projectId === undefined ? {} : { projectId }),
  }).catch((error: unknown) => {
    services!.delete(key);
    throw error;
  });
  services.set(key, slot);
  return { slot, reused: false };
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
    return refusalEnvelope({
      command: id,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: parsed.error.message,
    });
  }
  const harnessDir = context.controlRoot;
  if (harnessDir === null) {
    return failure("dashboard.harness-unavailable", new Error("no {HARNESS_DIR} found from the working directory"));
  }

  let server: RunningDashboard;
  let reused: boolean;
  const started = serviceFor(context, harnessDir, parsed.data.port, parsed.data.project);
  reused = started.reused;
  started.slot.waiters++;
  try {
    server = await started.slot.server;
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "dashboard.start-failed";
    return failure(code, error);
  } finally {
    started.slot.waiters--;
  }
  if (context.signal.aborted) {
    // Cancellation arrived while this call was starting a listener. Tear the
    // handle down ONLY when this call is the sole owner of an undelivered
    // startup: no concurrent caller is awaiting the same slot and no call has
    // already handed the URL to the connection (lifetime "connection" outlives
    // any single call). A shared or delivered listener is left running.
    if (!reused && !started.slot.delivered && started.slot.waiters === 0) {
      forget(context, harnessDir, parsed.data.port, parsed.data.project);
      await server.close();
    }
    return { version: 1, command: id, status: "error", code: "command.cancelled", exitCode: 1, message: "cancelled" };
  }
  started.slot.delivered = true;

  if (parsed.data.open === true) {
    try {
      await context.effects.openBrowser(server.url);
    } catch (error) {
      forget(context, harnessDir, parsed.data.port, parsed.data.project);
      await server.close();
      return { version: 1, command: id, status: "error", code: "capability.browser.unavailable", exitCode: 1, message: error instanceof Error ? error.message : String(error) };
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
