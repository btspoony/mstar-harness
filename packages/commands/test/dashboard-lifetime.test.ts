import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { initializeStore } from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import { startDashboard, type RunningDashboard } from "../src/dashboard/server.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";

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

describe("dashboard connection lifetime", () => {
  test("serves a real loopback response and reuses one same-root/port handle until close", async () => {
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

  test("refuses an unavailable opener and closes the partially started service", async () => {
    const harnessDir = await workspace("dashboard-opener-");
    const handles: RunningDashboard[] = [];
    const effects = serviceEffects(handles, async () => {
      throw Object.assign(new Error("platform opener unavailable"), { code: "capability.browser.unavailable" });
    });
    try {
      const result = await dashboardDefinition().execute({ port: 0, open: true }, context(harnessDir, effects));
      expect(result).toMatchObject({ status: "refused", code: "capability.browser.unavailable", exitCode: 1 });
      expect(handles).toHaveLength(1);
      await expect(fetch(handles[0]!.url)).rejects.toThrow();
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });
});
