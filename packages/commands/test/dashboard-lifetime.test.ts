import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createExecutionWorkflow,
  initializeExecutionAuthority,
  initializeStore,
  registerCatalogEntity,
  type WorkflowEntry,
  type WorkflowSnapshot,
} from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import { startDashboard, type RunningDashboard } from "../src/dashboard/server.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";
import { readDashboardView } from "../src/dashboard/store-read.js";

function dashboardDefinition() {
  const definition = getCommandDefinitions().find(({ id }) => id === "dashboard");
  if (definition === undefined) throw new Error("dashboard command definition is missing");
  return definition;
}

function context(harnessDir: string, effects: CommandEffects): InvocationContext {
  return {
    cwd: harnessDir,
    controlRoot: harnessDir,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects,
  };
}

async function workspace(prefix: string): Promise<string> {
  const harnessDir = mkdtempSync(path.join(tmpdir(), prefix));
  const store = await initializeStore({ harnessDir });
  store.close();
  return harnessDir;
}

function serviceEffects(handles: RunningDashboard[], onOpen?: (url: string) => Promise<void>): CommandEffects {
  return {
    async readInput() { return ""; },
    async spawn() { throw new Error("dashboard must not spawn a process"); },
    async startDashboard(request) {
      const handle = await startDashboard({
        harnessDir: request.harnessDir,
        port: request.port,
        projectId: request.projectId,
      });
      handles.push(handle);
      return handle;
    },
    async openBrowser(url) {
      if (onOpen !== undefined) await onOpen(url);
    },
  };
}

describe("dashboard ACTIVE projection views", () => {
  test("all projection-backed views read seeded ACTIVE-authority data", async () => {
    const harnessDir = await workspace("dashboard-active-");
    const context = { harnessDir };
    try {
      const initialized = await initializeExecutionAuthority(context);
      const id = "wf-synthetic";
      await createExecutionWorkflow(
        { ...context, caller: { sessionId: "session-synthetic", role: "coordinator", workflowId: id, planId: null } },
        {
          entry: { id, type: "iteration", started_at: "2026-01-02T03:04:05.000Z", dir: `workflows/${id}` } as WorkflowEntry,
          snapshot: {
            schema_version: 1,
            id,
            type: "iteration",
            status: "running",
            started_at: "2026-01-02T03:04:05.000Z",
            updated_at: "2026-01-02T03:04:05.000Z",
            phase: "phase-1-prepare",
            plans: [],
          } as unknown as WorkflowSnapshot,
          expected: initialized.token,
          operationId: "dashboard-synthetic-create",
        },
      );
      await registerCatalogEntity(
        context,
        { kind: "iteration", id, title: "Synthetic iteration", rootKind: "iterations", relativePath: id },
        { operationId: "dashboard-synthetic-iteration", actor: "test" },
      );
      const workflows = await readDashboardView({ context, view: "workflows" });
      expect(workflows.projection.freshness).toBe("current");
      expect(workflows.data?.items).toContainEqual(expect.objectContaining({
        id,
        status: "running",
        phase: "phase-1-prepare",
      }));

      const workflow = await readDashboardView({ context, view: "workflow-detail", id });
      expect(workflow.projection.freshness).toBe("current");
      expect(workflow.data).toMatchObject({ id, status: "running", phase: "phase-1-prepare" });

      const iterations = await readDashboardView({ context, view: "iterations" });
      expect(iterations.projection.freshness).toBe("current");
      expect(iterations.data?.items).toContainEqual(expect.objectContaining({
        iterationId: id,
        workflow: { id, status: "running", phase: "phase-1-prepare", activeRegistration: true },
      }));

      const iteration = await readDashboardView({ context, view: "iteration-detail", id });
      expect(iteration.projection.freshness).toBe("current");
      expect(iteration.data).toMatchObject({
        iterationId: id,
        workflow: { id, status: "running", phase: "phase-1-prepare", activeRegistration: true },
      });
    } finally {
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });
});

describe("dashboard connection lifetime", () => {
  test("service lifetime reuses one same-root/port handle until connection close", async () => {
    const harnessDir = await workspace("dashboard-lifetime-");
    const handles: RunningDashboard[] = [];
    const effects = serviceEffects(handles);
    try {
      const definition = dashboardDefinition();
      const invocation = context(harnessDir, effects);
      const first = await definition.execute({ port: 0 }, invocation);
      expect(first).toMatchObject({ status: "ok", data: { lifetime: "connection" } });
      if (first.status !== "ok") throw new Error(first.message);
      const firstData = first.data as { url: string; lifetime: string };
      expect(new URL(firstData.url).hostname).toBe("127.0.0.1");
      expect(new URL(firstData.url).port).not.toBe("");
      const response = await fetch(firstData.url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Morning Star Dashboard");

      const duplicate = await definition.execute({ port: 0 }, invocation);
      expect(duplicate).toMatchObject({ status: "ok", data: { url: firstData.url, lifetime: "connection" } });
      expect(handles).toHaveLength(1);

      await handles[0]!.close();
      await expect(fetch(firstData.url)).rejects.toThrow();
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  test("preserves native loopback bind conflicts without closing the existing service", async () => {
    const harnessDir = await workspace("dashboard-conflict-");
    const existing = await startDashboard({ harnessDir, port: 0 });
    const handles: RunningDashboard[] = [];
    try {
      const port = Number(new URL(existing.url).port);
      const result = await dashboardDefinition().execute({ port }, context(harnessDir, serviceEffects(handles)));
      expect(result).toMatchObject({ status: "refused", code: "EADDRINUSE", exitCode: 1 });
      const response = await fetch(existing.url);
      expect(response.status).toBe(200);
      expect(handles).toHaveLength(0);
    } finally {
      await existing.close();
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  test("optional browser capability is not used unless requested", async () => {
    const harnessDir = await workspace("dashboard-optional-browser-");
    const handles: RunningDashboard[] = [];
    try {
      const result = await dashboardDefinition().execute({ port: 0 }, context(harnessDir, serviceEffects(handles)));
      expect(result).toMatchObject({ status: "ok", data: { lifetime: "connection" } });
      expect(handles).toHaveLength(1);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });
  test("cancellation before service start performs no service effect", async () => {
    const harnessDir = await workspace("dashboard-cancel-");
    const handles: RunningDashboard[] = [];
    const controller = new AbortController();
    controller.abort();
    try {
      const invocation = { ...context(harnessDir, serviceEffects(handles)), signal: controller.signal };
      const result = await dashboardDefinition().execute({ port: 0, open: true }, invocation);
      expect(result).toMatchObject({ status: "error", code: "command.cancelled" });
      expect(handles).toHaveLength(0);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  test("cancellation while the service starts stops that listener instead of leaking it", async () => {
    const harnessDir = await workspace("dashboard-cancel-during-");
    const handles: RunningDashboard[] = [];
    const controller = new AbortController();
    // Abort while the service effect is in flight: the listener is started and
    // published, then the request observes the cancellation. That handle
    // belongs to this aborted call, so it must be closed and evicted.
    const effects = serviceEffects(handles);
    const starting = { ...effects, async startDashboard(request: Parameters<CommandEffects["startDashboard"]>[0]) {
      const handle = await effects.startDashboard(request);
      controller.abort();
      return handle;
    } };
    try {
      const invocation = { ...context(harnessDir, starting), signal: controller.signal };
      const result = await dashboardDefinition().execute({ port: 0 }, invocation);
      expect(result).toMatchObject({ status: "error", code: "command.cancelled" });
      expect(handles).toHaveLength(1);
      await expect(fetch(handles[0]!.url)).rejects.toThrow();
      // The evicted handle is not reused after a later, non-cancelled call.
      const restarted = await dashboardDefinition().execute({ port: 0 }, context(harnessDir, effects));
      expect(restarted).toMatchObject({ status: "ok" });
      expect(handles).toHaveLength(2);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  test("a cancelled starter does not close a shared startup another caller is awaiting", async () => {
    const harnessDir = await workspace("dashboard-cancel-shared-");
    const handles: RunningDashboard[] = [];
    const upstream = serviceEffects(handles);
    const effects: CommandEffects = {
      ...upstream,
      async startDashboard(request: Parameters<CommandEffects["startDashboard"]>[0]) {
        const handle = await upstream.startDashboard(request);
        starterAbort.abort();
        return handle;
      },
    };
    // A starts the listener; B joins the SAME startup promise before it
    // settles. When A observes its cancellation the slot still has B as an
    // active waiter (and B will deliver the URL), so A must leave the
    // listener running instead of closing it out from under B.
    const starterAbort = new AbortController();
    const starter = dashboardDefinition().execute({ port: 0 }, { ...context(harnessDir, effects), signal: starterAbort.signal });
    const joiner = await dashboardDefinition().execute({ port: 0 }, context(harnessDir, effects));
    expect(joiner).toMatchObject({ status: "ok", data: { lifetime: "connection" } });
    const cancelled = await starter;
    expect(cancelled).toMatchObject({ status: "error", code: "command.cancelled" });
    expect(handles).toHaveLength(1);
    const joinerData: unknown = joiner.data;
    if (typeof joinerData !== "object" || joinerData === null || !("url" in joinerData) || typeof joinerData.url !== "string") {
      throw new Error("the joiner envelope did not carry a dashboard url");
    }
    const url: string = joinerData.url;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    await handles[0]!.close();
    await expect(fetch(url)).rejects.toThrow();
    rmSync(harnessDir, { recursive: true, force: true });
  });

  test("cancellation after a reused service starts leaves the shared listener running", async () => {
    const harnessDir = await workspace("dashboard-cancel-reused-");
    const handles: RunningDashboard[] = [];
    const first = await dashboardDefinition().execute({ port: 0 }, context(harnessDir, serviceEffects(handles)));
    expect(first).toMatchObject({ status: "ok" });
    const controller = new AbortController();
    controller.abort();
    try {
      // Same root/port: the call reuses the live handle. A cancelled reuse must
      // NOT stop a service the connection still owns.
      const result = await dashboardDefinition().execute({ port: 0 }, { ...context(harnessDir, serviceEffects(handles)), signal: controller.signal });
      expect(result).toMatchObject({ status: "error", code: "command.cancelled" });
      expect(handles).toHaveLength(1);
      const response = await fetch(handles[0]!.url);
      expect(response.status).toBe(200);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  test("optional browser failure is typed and closes its unrequested service", async () => {
    const harnessDir = await workspace("dashboard-opener-");
    const handles: RunningDashboard[] = [];
    const effects = serviceEffects(handles, async () => {
      throw Object.assign(new Error("platform opener unavailable"), { code: "capability.browser.unavailable" });
    });
    try {
      const result = await dashboardDefinition().execute({ port: 0, open: true }, context(harnessDir, effects));
      expect(result).toMatchObject({ status: "error", code: "capability.browser.unavailable", exitCode: 1 });
      expect(handles).toHaveLength(1);
      await expect(fetch(handles[0]!.url)).rejects.toThrow();
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });
});
