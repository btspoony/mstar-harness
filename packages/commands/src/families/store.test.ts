import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore, WORKFLOW_SNAPSHOT_FILE } from "@mstar-harness/engine";
import type { CommandEnvelope, InvocationContext } from "../types.js";
import { getStoreCommandDefinitions } from "../index.js";
import { storeUpgradeFailure } from "./store.js";

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

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function olderSchema(store: Awaited<ReturnType<typeof initializeStore>>): number {
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
  return priorVersion;
}

async function runUpgradeHandler(harness: string, root: string, answer = "preserve for later review"): Promise<CommandEnvelope> {
  const definition = upgradeDefinition();
  const attestation = join(root, "attestation.json");
  writeFileSync(attestation, `${JSON.stringify(fixtureAttestation)}\n`);
  const parsed = definition.input.parse({ harness, operator: "fixture-operator", attestation });
  const { context } = invocation(root, answer);
  return definition.execute(parsed, context);
}

  test("rerun resumes retirement after activation committed and a retirement item failed", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const store = await initializeStore({ harnessDir: harness });
    store.close();

    const first = await withEnv({
      MSTAR_STORE_TEST_RUNNER: "1",
      MSTAR_STORE_FAIL_EXECUTION_RETIREMENT: "after-rename",
    }, () => runUpgradeHandler(harness, root));
    expect(first.status).toBe("refused");
    expect(existsSync(join(harness, "archived", "execution"))).toBe(true);

    const second = await runUpgradeHandler(harness, root);
    expect(second.status).toBe("ok");
    expect(second.exitCode).toBe(0);
    if (second.status === "ok") {
      expect(second.data).toMatchObject({ verdict: "upgraded", authorityState: "active", sourcesRetired: true });
      expect(second.data).not.toMatchObject({ verdict: "up-to-date" });
    }
    expect(existsSync(join(harness, "status.json"))).toBe(false);
    const archived = readdirSync(join(harness, "archived", "execution"));
    expect(archived).toHaveLength(1);
    const active = await openStore({ harnessDir: harness }, "read");
    try {
      expect(active.execution?.authorityState).toBe("active");
      expect(active.db.prepare("select phase from execution_migrations").get()).toEqual({ phase: "retired" });
    } finally {
      active.close();
    }
  });

  test("ACTIVE authority upgrades pending schema without routing retained legacy files to migration", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const store = await initializeStore({ harnessDir: harness });
    const priorVersion = olderSchema(store);
    store.db.prepare("update execution_meta set authority_state = 'active', manifest_id = 'manifest-active' where id = 1").run();
    store.db.prepare(`
      insert into execution_migrations(manifest_id, manifest_hash, phase, manifest_json, created_at, updated_at)
      values ('manifest-active', 'hash-active', 'retired', '{}', 'now', 'now')
    `).run();
    store.close();

    const result = await runUpgradeHandler(harness, root);
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    if (result.status === "ok") {
      expect(result.data).toMatchObject({
        verdict: "upgraded",
        schemaVersion: priorVersion + 1,
        executionMigration: "not-needed",
      });
    }
    expect(existsSync(join(harness, "status.json"))).toBe(true);
    const upgraded = await openStore({ harnessDir: harness }, "read");
    try {
      expect(upgraded.schemaVersion).toBe(priorVersion + 1);
      expect(upgraded.execution?.authorityState).toBe("active");
      expect(upgraded.db.prepare("select phase from execution_migrations").get()).toEqual({ phase: "retired" });
    } finally {
      upgraded.close();
    }
  });

  test("rerun progresses after execution import fails with the prior attempt backup retained", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const store = await initializeStore({ harnessDir: harness });
    store.close();

    const first = await withEnv({
      MSTAR_STORE_TEST_RUNNER: "1",
      MSTAR_STORE_FAIL_EXECUTION_IMPORT_AFTER: "1",
    }, () => runUpgradeHandler(harness, root));
    expect(first.status).toBe("refused");
    const backupDir = join(harness, "archived", "store-migration", "backups");
    expect(readdirSync(backupDir).some((name) => name.endsWith("-pre-schema.db"))).toBe(true);
    expect(existsSync(join(harness, "status.json"))).toBe(true);

    const second = await runUpgradeHandler(harness, root);
    expect(second.status).toBe("ok");
    expect(second.exitCode).toBe(0);
    if (second.status === "ok") {
      expect(second.data).toMatchObject({ verdict: "upgraded", authorityState: "active", sourcesRetired: true });
    }
    expect(existsSync(join(harness, "status.json"))).toBe(false);
  });

describe("store.upgrade unified entry", () => {
  test("reports an active store as up-to-date with exit 0 and no protocol prompt", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const store = await initializeStore({ harnessDir: harness });
    store.db.prepare("update execution_meta set authority_state = 'active', manifest_id = 'completed-manifest' where id = 1").run();
    store.db.prepare(`
      insert into execution_migrations(manifest_id, manifest_hash, phase, manifest_json, created_at, updated_at)
      values ('completed-manifest', 'completed-hash', 'retired', '{}', 'now', 'now')
    `).run();
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

  test("attestation file failures use safe diagnostics and distinguish absence from unreadable or malformed input", async () => {
    const root = fixture();
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const store = await initializeStore({ harnessDir: harness });
    store.close();
    const definition = upgradeDefinition();
    const { context } = invocation(root);
    const absentPath = join(root, "absent-session-secret.json");
    const missing = await definition.execute(
      definition.input.parse({ harness, operator: "fixture-operator", attestation: absentPath }),
      context,
    );
    const directoryPath = join(root, "unreadable-wf-private");
    mkdirSync(directoryPath);
    const unreadable = await definition.execute(
      definition.input.parse({ harness, operator: "fixture-operator", attestation: directoryPath }),
      context,
    );
    const malformedPath = join(root, "malformed-op-private.json");
    writeFileSync(malformedPath, "{ invalid json");
    const malformed = await definition.execute(
      definition.input.parse({ harness, operator: "fixture-operator", attestation: malformedPath }),
      context,
    );

    for (const result of [missing, unreadable, malformed]) {
      expect(result.status).toBe("usage");
      if (result.status !== "usage") throw new Error("expected usage envelope");
      expect(result.message).not.toContain(root);
    }
    if (missing.status !== "usage" || unreadable.status !== "usage" || malformed.status !== "usage") {
      throw new Error("expected usage envelopes");
    }
    expect(missing.message).not.toBe(unreadable.message);
    expect(unreadable.message).not.toBe(malformed.message);
    expect(unreadable.message).toContain("attestation file");
    expect(unreadable.message).toContain("could not be read");
    expect(unreadable.message).toContain("Provide a readable attestation file");
    expect(malformed.message).toContain("attestation file");
    expect(malformed.message).toContain("malformed");
    expect(malformed.message).toContain("Provide a readable, valid JSON attestation file");
    expect(missing.message).toContain("attestation file");
    expect(missing.message).toContain("not found");
    expect(missing.message).toContain("Provide an existing readable attestation file");
  });
  test("refusal mapping selects gap-specific recovery and excludes engine identifiers", () => {
    const conflict = Object.assign(new Error("workflow-private wf-abcdef op-private 123e4567-e89b-12d3-a456-426614174000 session-secret attestation.consumers[0]"), {
      code: "execution.migration-conflict",
    });
    const coverage = Object.assign(new Error("missing stopped-session evidence for session-secret 123e4567-e89b-12d3-a456-426614174000"), {
      code: "execution.coverage-incomplete",
    });
    const conflictResult = storeUpgradeFailure("store.upgrade", conflict);
    const coverageResult = storeUpgradeFailure("store.upgrade", coverage);
    expect(conflictResult.status).toBe("refused");
    expect(coverageResult.status).toBe("refused");
    if (conflictResult.status !== "refused" || coverageResult.status !== "refused") throw new Error("expected refusal envelopes");
    expect(conflictResult.message).toContain("legacy workflow");
    expect(conflictResult.message).toContain("pending change");
    expect(conflictResult.message).not.toContain("--inventory");
    expect(coverageResult.message).toContain("stop-session evidence");
    expect(coverageResult.message).toContain("only if discovery inventory is the missing item");
    expect(coverageResult.message).not.toContain("provide the required inventory");
    expect(coverageResult.message).not.toContain("--inventory,");
    for (const result of [conflictResult, coverageResult]) {
      expect(result.message).not.toMatch(/session-secret|wf-abcdef|op-private|123e4567-e89b-12d3-a456-426614174000|attestation\.consumers/);
    }
    expect(conflictResult.message).not.toBe(coverageResult.message);
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
