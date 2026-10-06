import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_SNAPSHOT_FILE, initializeStore } from "@mstar-harness/engine";
import type { InvocationContext } from "../types.js";
import { getCommandDefinitions } from "../definitions.js";
import { getStoreCommandDefinitions } from "../index.js";

const controlRoot = join(tmpdir(), "mstar-store-upgrade-test-control");

function legacyWorkspace(harness: string): void {
  const workflowId = "upgrade-fixture-workflow";
  const workflowDir = join(harness, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(harness, "status.json"), JSON.stringify({
    version: 2,
    updated_at: "2026-10-04",
    workflows: [{ id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` }],
  }));
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: "2026-10-04",
    updated_at: "2026-10-04",
    delivery_kind: "development",
    project: "_default",
    branch: { source: "feature/upgrade-fixture", target: "main" },
    plans: [{ id: `${workflowId}-plan`, title: "Upgrade fixture", file: "plan.md", status: "Todo", metadata: {} }],
  }));
}

function invocation(cwd: string): InvocationContext {
  const messages: string[] = [];
  return {
    cwd,
    controlRoot,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not available in this command family"); },
      async openBrowser() { throw new Error("not available in this command family"); },
      writeStderr(message) { messages.push(message); },
    },
  };
}

test("store.upgrade is the one-command minimal default and does not require attestation", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-command-"));
  try {
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const result = await definition.execute(definition.input.parse({ harness, operator: "fixture-operator" }), invocation(root));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toMatchObject({ verdict: "upgraded", authorityState: "active", imported: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store.upgrade names the required operator input before writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-missing-operator-"));
  try {
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const result = await definition.execute(definition.input.parse({ harness: join(root, ".mstar") }), invocation(root));
    expect(result).toMatchObject({ status: "usage", message: "--operator is required" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store usage refusal carries the shared factory metadata and keeps its code", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-usage-shape-"));
  try {
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const result = await definition.execute(definition.input.parse({ harness: join(root, ".mstar") }), invocation(root));
    expect(result).toMatchObject({ status: "usage", code: "usage", exitCode: 2 });
    if (result.status !== "usage") throw new Error("expected usage envelope");
    expect(result.message.split("\n")[0]).toBe("--operator is required");
    expect(result.details).toMatchObject({
      helpRoute: "mstar store upgrade --help",
      recovery: "Run mstar store upgrade --help and correct the flagged input.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store engine refusal keeps its code, exit 1 and message through the factory", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-refused-shape-"));
  try {
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.init");
    if (definition === undefined) throw new Error("missing store.init definition");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    // An existing store makes `store.init` refuse from the engine (exit 1).
    const seeded = await initializeStore({ harnessDir: harness });
    seeded.close();
    const result = await definition.execute(definition.input.parse({ harness }), invocation(root));
    expect(result).toMatchObject({ status: "refused", code: "store.already-exists", exitCode: 1 });
    if (result.status === "ok" || result.status === "usage") throw new Error(`expected a refusal, got ${result.status}`);
    expect(result.message.split("\n")[0]).not.toContain("Help:");
    expect(result.message).toContain("Help: mstar store init --help");
    expect(result.details).toMatchObject({ helpRoute: "mstar store init --help" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default registration removes only staged protocol faces and keeps independent restore/export", () => {
  const definitions = getCommandDefinitions();
  const ids = new Set(definitions.map(({ id }) => id));
  expect(ids.has("store.safe-upgrade")).toBe(false);
  for (const verb of ["preview", "apply", "activate", "retire", "abort"]) {
    expect(ids.has(`store.execution.${verb}`)).toBe(false);
  }
  expect(ids.has("store.execution.restore-preview")).toBe(true);
  expect(ids.has("store.execution.restore")).toBe(true);
  expect(ids.has("store.execution.export")).toBe(true);
});

test("store.upgrade reads the operator's --attestation document and passes it to the engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-attestation-"));
  try {
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const attestationPath = join(root, "attestation.json");
    writeFileSync(attestationPath, JSON.stringify({
      version: 1,
      attestedAt: "2026-10-04T00:00:00.000Z",
      operator: { actor: "fixture-operator", authorizationRef: "fixture-authorization" },
      consumers: [{
        entryId: "mstar-cli",
        kind: "coordinator",
        entrypoint: "packages/cli/src/index.ts",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "0.0.0-test",
        current: true,
        disposition: "reloaded",
      }],
      stoppedSessions: [{ sessionId: "fixture-coordinator", host: "omp", state: "stopped" }],
    }));
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");

    // The published CLI surface exposes the option.
    expect(definition.cli.options.some((option) => option.key === "attestation")).toBe(true);
    // The file path must be absolute (the adapter reads the source).
    const relative = await definition.execute(
      definition.input.parse({ harness, operator: "fixture-operator", attestation: "attestation.json" }),
      invocation(root),
    );
    expect(relative).toMatchObject({ status: "usage", message: "--attestation must be an absolute path" });

    const result = await definition.execute(
      definition.input.parse({ harness, operator: "fixture-operator", attestation: attestationPath }),
      invocation(root),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toMatchObject({ verdict: "upgraded", authorityState: "active" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
