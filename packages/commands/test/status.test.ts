import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS, encodeExecutionSessionRef, initializeStore } from "@mstar-harness/engine";
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

  test("the retired file-close inputs are refused by name, without touching the planted snapshot", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-close-"));
    try {
      const workflowDir = path.join(dir, "workflows", "closed-flow");
      mkdirSync(workflowDir, { recursive: true });
      const snapshotPath = path.join(workflowDir, "snapshot.json");
      writeFileSync(snapshotPath, JSON.stringify({ schema_version: 1, id: "closed-flow", type: "plan", status: "invalid", started_at: "2026-01-01", updated_at: "2026-01-01", plans: [] }));
      const before = readFileSync(snapshotPath, "utf8");
      // `--ended-at` belongs to the retired FILE close route: the named refusal
      // states the ACTIVE route instead of silently answering from a fallback.
      const result = await statusDefinition("status.workflow-close").execute({ workflow: "closed-flow", harness: dir, endedAt: "2026-01-01T00:00:00.000Z" }, { ...context(dir), sessionId: "close-session" });
      expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      if (result.status === "ok") throw new Error("expected a usage refusal");
      expect(String(result.message)).toContain("ACTIVE execution authority only");
      expect(String(result.message)).toContain("--ended-at");
      expect(readFileSync(snapshotPath, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a store-less control root refuses the close and names the ACTIVE bootstrap", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-close-sparse-"));
    try {
      const workflow = "wf-sparse";
      const workflowDir = path.join(dir, "workflows", workflow);
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(path.join(dir, "status.json"), JSON.stringify({
        version: 2,
        updated_at: "2026-08-19",
        workflows: [{ id: workflow, type: "plan", started_at: "2026-08-01", dir: `workflows/${workflow}` }],
      }));
      writeFileSync(path.join(workflowDir, "snapshot.json"), JSON.stringify({
        schema_version: 1,
        id: workflow,
        type: "plan",
        status: "running",
        started_at: "2026-08-01",
        updated_at: "2026-08-19",
        delivery_kind: "development",
        branch: { source: "feature/plan-a", target: "main" },
        delivery: {
          compound: { outcome: "created" },
          pr: { repo: "example/project", head: "feature/plan-a", target: "main" },
          merge: { provider: "github", evidence: "PR merged" },
        },
        plans: [{ id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: "Done" }],
      }));
      // No ACTIVE store exists here, and the FILE close route is retired: the
      // refusal names the cause and the supported bootstrap instead of
      // completing a file write.
      const result = await statusDefinition("status.workflow-close").execute({ workflow, harness: dir }, { ...context(dir), sessionId: "close-session" });
      expect(result).toMatchObject({ status: "refused", code: "store.not-initialized", exitCode: 1 });
      if (result.status !== "refused") throw new Error("expected a refusal");
      expect(String(result.details?.recovery ?? result.details?.helpRoute ?? "")).toContain("mstar store init");
      // Nothing was written: the planted register and snapshot stand untouched.
      expect(JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")).workflows).toHaveLength(1);
      expect(JSON.parse(readFileSync(path.join(workflowDir, "snapshot.json"), "utf8")).status).toBe("running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  test("a refused active workflow-close carries the engine's typed details and recovery sidecar", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-close-details-"));
    try {
      const store = await initializeStore({ harnessDir: dir });
      // `initializeStore` activates the execution authority (issue #428), so the
      // generation a session ref must match is read back instead of re-created.
      const authority = { storeId: store.storeId, epoch: store.epoch };
      store.close();
      const sessionRef = encodeExecutionSessionRef({
        storeId: authority.storeId,
        epoch: authority.epoch + 1,
        workflowId: "wf-close",
        role: "coordinator",
        sessionId: "main-session",
      });
      const result = await statusDefinition("status.workflow-close").execute(
        { workflow: "wf-close", harness: dir, sessionRef, expect: "token", operation: "close-1", reason: "wave complete" },
        { ...context(dir), sessionId: "main-session" },
      );
      // The authority fence of the DB frame refuses the superseded generation:
      // the command surface reports that typed cause, not a code and prose.
      expect(result).toMatchObject({ status: "refused", code: "store.stale-epoch", exitCode: 1 });
      const details = result.status === "ok" ? undefined : result.details;
      expect(details?.recoveryFacts).toMatchObject({ outcome: "unresolved", commitState: "none" });
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

  test("a status usage refusal carries the shared factory metadata", async () => {
    const result = await statusDefinition("status.workflow-close").execute({}, context(process.cwd()));
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (result.status !== "usage") throw new Error("expected usage envelope");
    expect(result.message.split("\n")[0]).toBe("workflow selector or acquired workflow identity is required");
    expect(result.details).toMatchObject({
      helpRoute: "mstar status workflow-close --help",
      recovery: "Run mstar status workflow-close --help and correct the flagged input.",
    });
  });

  test("a status engine refusal appends help and recovery without rewriting the engine line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-refusal-shape-"));
    try {
      // A harness root with no ACTIVE store: the engine's own typed cause is
      // forwarded verbatim and the refusal keeps the shared help/recovery shape.
      const result = await statusDefinition("status.workflow-close").execute({ workflow: "closed-flow", harness: dir }, { ...context(dir), sessionId: "close-session" });
      expect(result).toMatchObject({ status: "refused", code: "store.not-initialized", exitCode: 1 });
      if (result.status === "ok") throw new Error("expected a refusal");
      expect(result.message.split("\n")[0]).not.toContain("Help:");
      expect(result.message).toContain("Help: mstar status workflow-close --help");
      expect(result.details).toMatchObject({ helpRoute: "mstar status workflow-close --help" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * F7: the store-vs-build-vs-first-unknown facts are the engine's own machine
   * facts, and this command surface must forward them rather than reduce a
   * typed store refusal to its code and prose. The fixture is a real store
   * written past this build's supported maximum in an isolated OS-temp root
   * outside every Git worktree, observed with an explicit harness.
   */
  test("an unreadable store keeps the engine's code, machine details and recovery facts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-schema-facts-"));
    try {
      const harnessDir = path.join(dir, ".mstar");
      mkdirSync(harnessDir, { recursive: true });
      const store = await initializeStore({ harnessDir });
      const supportedMax = Math.max(...MIGRATIONS.map((migration) => migration.version));
      const insert = store.db.prepare("insert into schema_version(version, name, checksum, applied_at) values(?, ?, ?, ?)");
      insert.run(supportedMax + 1, "from-a-newer-build", "f".repeat(64), "2026-09-18T00:00:00.000Z");
      insert.run(supportedMax + 2, "from-an-even-newer-build", "e".repeat(64), "2026-09-18T00:00:00.000Z");
      store.close();

      const result = await statusDefinition("status.validate").execute({}, { ...context(dir), controlRoot: harnessDir });
      expect(result).toMatchObject({ status: "refused", code: "store.schema-unsupported", exitCode: 1 });
      if (result.status === "ok") throw new Error("expected the store refusal");
      if (result.status !== "refused") throw new Error("expected the store refusal");
      // The three distinct facts travel as machine facts, so an agent reads the
      // values instead of re-parsing the message.
      expect(result.details).toMatchObject({
        storeSchemaVersion: supportedMax + 2,
        supportedSchemaMax: supportedMax,
        firstUnsupportedMigration: supportedMax + 1,
      });
      expect(result.message).toContain(`highest applied schema version is ${supportedMax + 2}`);
      expect(result.message).toContain(`first unsupported migration is ${supportedMax + 1}`);

      // The guard refused before any mutation: every row still stands.
      const after = new DatabaseSync(path.join(harnessDir, "store.db"), { readOnly: true });
      const rows = after.prepare("select version from schema_version order by version").all();
      after.close();
      expect(rows.map((row) => Object.values(row)[0])).toEqual(
        Array.from({ length: supportedMax + 2 }, (_, index) => index + 1),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
