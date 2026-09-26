import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { initializeStore } from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";

function context(cwd: string): InvocationContext {
  return {
    cwd,
    controlRoot: cwd,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 0, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { return { url: "http://127.0.0.1", async close() {} }; },
      async openBrowser() {},
    },
  };
}

function statusDefinition(id: string) {
  const definition = getCommandDefinitions().find((entry) => entry.id === id);
  if (definition === undefined) throw new Error(`missing ${id}`);
  return definition;
}

describe("status command family", () => {
  test("rejects malformed input with the shared invalid-input envelope", async () => {
    const result = await statusDefinition("status.validate").execute({ path: "" }, context(process.cwd()));
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });

  test("surfaces the engine refusal code for an invalid workflow without rewriting it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-close-"));
    try {
      const workflowDir = path.join(dir, "workflows", "closed-flow");
      mkdirSync(workflowDir, { recursive: true });
      const snapshotPath = path.join(workflowDir, "snapshot.json");
      writeFileSync(snapshotPath, JSON.stringify({ schema_version: 1, id: "closed-flow", type: "plan", status: "invalid", started_at: "2026-01-01", updated_at: "2026-01-01", plans: [] }));
      const before = readFileSync(snapshotPath, "utf8");
      const result = await statusDefinition("status.workflow-close").execute({ workflow: "closed-flow", harness: dir }, context(dir));
      expect(result).toMatchObject({ status: "refused", code: "workflow.snapshot.invalid-status", exitCode: 1 });
      expect(readFileSync(snapshotPath, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads tech-debt rollup data from the issue store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-tech-debt-"));
    try {
      const store = await initializeStore({ harnessDir: dir });
      store.close();
      const result = await statusDefinition("status.tech-debt").execute({ harness: dir }, context(dir));
      expect(result).toMatchObject({ status: "ok", code: "status.ok", data: { total_open: 0, by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, by_project: {} } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retired status verbs return stable refusals without mutating harness files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-retired-"));
    try {
      writeFileSync(path.join(dir, "sentinel"), "unchanged");
      const before = readdirSync(dir).sort();
      for (const id of ["status.archive-residuals", "status.backlog-register", "status.backlog-close"]) {
        const result = await statusDefinition(id).execute({}, context(dir));
        expect(result).toMatchObject({ status: "refused", code: "status.verb-retired", exitCode: 1 });
      }
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(readFileSync(path.join(dir, "sentinel"), "utf8")).toBe("unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
