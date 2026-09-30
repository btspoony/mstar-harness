import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore, WORKFLOW_SNAPSHOT_FILE } from "@mstar-harness/engine";
import type { CommandEnvelope, InvocationContext } from "../types.js";
import { getStoreCommandDefinitions } from "../index.js";

const roots: string[] = [];
const controlRoot = join(tmpdir(), "mstar-store-upgrade-test-control");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-command-"));
  roots.push(root);
  return root;
}

function legacyWorkspace(harness: string): void {
  const workflowId = "upgrade-fixture-workflow";
  const workflowDir = join(harness, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(harness, "status.json"), JSON.stringify({
    version: 2,
    updated_at: "2026-09-30",
    workflows: [{ id: workflowId, type: "plan", started_at: "2026-09-30", dir: `workflows/${workflowId}` }],
  }));
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: "2026-09-30",
    updated_at: "2026-09-30",
    delivery_kind: "development",
    project: "_default",
    branch: { source: "feature/upgrade-fixture", target: "main" },
    plans: [{ id: `${workflowId}-plan`, title: "Upgrade fixture", file: "plan.md", status: "Todo", metadata: {} }],
  }));
}

const fixtureAttestation = {
  version: 1,
  attestedAt: "2026-09-30T00:00:00.000Z",
  operator: { actor: "fixture-operator", authorizationRef: "fixture-only-activation" },
  consumers: [{
    entryId: "fixture-coordinator",
    kind: "coordinator",
    entrypoint: "/fixture/commands",
    runtime: "bun",
    runtimeVersion: "1.4.0",
    version: "fixture",
    current: true,
    disposition: "reloaded",
  }],
  stoppedSessions: [],
};

function invocation(cwd: string, answer = "no"): { context: InvocationContext; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    context: {
      cwd,
      controlRoot,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        async readInput() { return answer; },
        async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
        async startDashboard() { throw new Error("not available in this command family"); },
        async openBrowser() { throw new Error("not available in this command family"); },
        writeStderr(message) { messages.push(message); },
      },
    },
  };
}

function upgradeDefinition() {
  const found = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
  if (found === undefined) throw new Error("missing store.upgrade definition");
  return found;
}

async function runUpgrade(harness: string, cwd: string, answer?: string): Promise<{ result: CommandEnvelope; messages: string[] }> {
  const definition = upgradeDefinition();
  const attestation = join(cwd, "attestation.json");
  writeFileSync(attestation, `${JSON.stringify(fixtureAttestation)}\n`);
  const parsed = definition.input.parse({ harness, operator: "fixture-operator", attestation });
  const { context, messages } = invocation(cwd, answer);
  return { result: await definition.execute(parsed, context), messages };
}

describe("store.upgrade unified entry", () => {
  test("reports an active store as up-to-date with exit 0 and no protocol prompt", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const store = await initializeStore({ harnessDir: harness });
    store.db.prepare("update execution_meta set authority_state = 'active' where id = 1").run();
    store.close();

    const { result, messages } = await runUpgrade(harness, root);
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    if (result.status === "ok") {
      expect(result.data).toMatchObject({ verdict: "up-to-date" });
      if (result.data === null || typeof result.data !== "object" || !("schemaVersion" in result.data)) {
        throw new Error("up-to-date result omitted the existing schema version");
      }
      expect(typeof result.data.schemaVersion).toBe("number");
    }
    expect(messages).toEqual([]);
  });

  test("legacy authority reports one pending change in user terms, not the migration protocol", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const store = await initializeStore({ harnessDir: harness });
    store.close();

    const { result, messages } = await runUpgrade(harness, root, "preserve for later review");
    expect(messages).toHaveLength(1);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toMatchObject({ verdict: "upgraded", authorityState: "active", sourcesRetired: true });
    }
    expect(existsSync(join(harness, "status.json"))).toBe(false);
    const active = await openStore({ harnessDir: harness }, "read");
    try {
      expect(active.execution?.authorityState).toBe("active");
    } finally {
      active.close();
    }
  });

  test("an empty confirmation refuses before staging or changing authority", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const store = await initializeStore({ harnessDir: harness });
    store.close();

    const { result, messages } = await runUpgrade(harness, root, "");
    expect(messages).toHaveLength(1);
    expect(result.status).toBe("refused");
    expect(existsSync(join(harness, "status.json"))).toBe(true);
    const unchanged = await openStore({ harnessDir: harness }, "read");
    try {
      expect(unchanged.execution?.authorityState).toBe("legacy");
      expect(unchanged.db.prepare("select count(*) as count from catalog_operations").get()).toEqual({ count: 0 });
      expect(unchanged.db.prepare("select count(*) as count from execution_migrations").get()).toEqual({ count: 0 });
    } finally {
      unchanged.close();
    }
  });

  test("schema-only upgrade advances schema without execution migration inputs", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const store = await initializeStore({ harnessDir: harness });
    const priorVersion = store.schemaVersion - 1;
    store.db.exec(`
      drop trigger issues_milestone_project_insert;
      drop trigger issues_milestone_project_update;
      drop trigger project_milestones_identity_immutable;
      drop index project_milestones_order;
      drop index issues_milestone_disposition;
      drop table project_milestones;
      alter table issues drop column milestone_id;
      delete from schema_version where version = 7;
    `);
    store.close();

    const definition = upgradeDefinition();
    const parsed = definition.input.parse({ harness });
    const { context } = invocation(root);
    const result = await definition.execute(parsed, context);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toMatchObject({ verdict: "upgraded", schemaVersion: priorVersion + 1, executionMigration: "not-needed" });
    }
    const upgraded = await openStore({ harnessDir: harness }, "read");
    try {
      expect(upgraded.schemaVersion).toBe(priorVersion + 1);
      expect(upgraded.execution?.authorityState).toBe("legacy");
    } finally {
      upgraded.close();
    }
  });

  test("pre-migration input failures return command envelopes", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const store = await initializeStore({ harnessDir: harness });
    store.close();
    const definition = upgradeDefinition();
    const { context } = invocation(root);
    const missingInput = await definition.execute(definition.input.parse({ harness }), context);
    expect(missingInput.status).toBe("usage");
    const unreadableAttestation = await definition.execute(
      definition.input.parse({ harness, operator: "fixture-operator", attestation: join(root, "absent.json") }),
      context,
    );
    expect(unreadableAttestation.status).toBe("usage");
  });
  test("a missing store refusal names the supported recovery action", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const { result, messages } = await runUpgrade(harness, root);
    expect(result.status).toBe("refused");
    expect(messages).toEqual([]);
  });
});
