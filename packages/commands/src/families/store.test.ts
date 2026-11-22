import { expect, beforeAll, afterAll, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import {
  COLLABORATION_MIGRATIONS,
  WORKFLOW_SNAPSHOT_FILE,
  initializeStore,
  listIssues,
  MIGRATIONS,
  migrationChecksum,
  openStore,
  resolveCollaborationLocation,
  SCHEMA_VERSION_TABLE_SQL,
  writeCollaborationBinding,
} from "@mstar-harness/engine";
import type { InvocationContext } from "../types.js";
import { executeCommand, getCommandDefinitions } from "../definitions.js";
import { getStoreCommandDefinitions } from "../index.js";


type EngineManifest = { engines?: { node?: string } };
// Repo manifest read at runtime: no test pins the runtime floor, and
// package.json stays the sole version authority.
const engineManifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "engine", "package.json"), "utf8"),
) as EngineManifest;
const declaredNodeFloor = (engineManifest.engines?.node ?? "").replace(/^>=\s*/, "").trim();
const floorMajor = Number.parseInt(declaredNodeFloor.split(".")[0]!, 10);
/** Injected current runtime: at/above the declared floor. */
const atOrAboveRuntime = `${floorMajor + 1}.0.0`;
/** Injected below-floor runtime: the floor major minus one, minor/patch zeroed. */
const belowFloorRuntime = `${floorMajor - 1}.0.0`;


/** note: The user-level collaboration lane is resolved through `homedir`; isolate it. */
const LANE_HOME = mkdtempSync(join(tmpdir(), "mstar-store-command-home-"));
let laneHomeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  laneHomeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => LANE_HOME);
});
afterAll(() => {
  laneHomeSpy?.mockRestore();
  rmSync(LANE_HOME, { recursive: true, force: true });
});

let repoSequence = 0;

/**
 * why: Give a fixture root its repository identity: these store verbs need the
 * collaboration scope (`store.upgrade` establishes the lane before it imports),
 * so a GIT ORIGINLESS fixture declares one explicitly.
 */
function identify(root: string): void {
  if (!existsSync(join(root, ".git"))) execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(join(root, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=fixture-${repoSequence++}\n`);
}

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
    controlRoot: join(cwd, ".mstar"),
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

async function protectedStoreState(harness: string) {
  const store = await openStore({ harnessDir: harness }, "read");
  try {
    const schema = z.array(z.object({
      type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable(),
    })).parse(store.db.prepare(
      "select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name",
    ).all());
    // Capture every stored surface, including registry, inputs, operations,
    // sessions, claims, authority metadata and migration records, not counts.
    const tables = Object.fromEntries(schema.filter(({ type }) => type === "table").map(({ name }) => [
      name,
      store.db.prepare(`select * from "${name.replaceAll('"', '""')}"`).all(),
    ]));
    return { schemaVersion: store.schemaVersion, schema, tables };
  } finally {
    store.close();
  }
}

test("store.upgrade discovers the canonical project harness and imports its legacy workflow without attestation", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-command-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    identify(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const result = await definition.execute(definition.input.parse({ operator: "fixture-operator" }), invocation(root));
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
      recovery: "Run mstar store upgrade --help and correct the flagged input. Owning skill: mstar-conventions.",
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

for (const legacySurface of ["status.json", "workflows/workflow-only/snapshot.json"] as const) {
  test(`store.init refuses legacy ${legacySurface} without creating a store`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-store-init-legacy-"));
    const harness = join(root, ".mstar");
    const historicalPath = join(harness, ...legacySurface.split("/"));
    const historicalBytes = Buffer.from('{"historical":"preserve exactly"}\n');
    try {
      mkdirSync(join(historicalPath, ".."), { recursive: true });
      writeFileSync(historicalPath, historicalBytes);
      const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.init");
      if (definition === undefined) throw new Error("missing store.init definition");
      const result = await definition.execute(definition.input.parse({ harness }), invocation(root));

      expect(result).toMatchObject({ status: "refused", code: "store.already-exists", exitCode: 1 });
      if (result.status === "ok" || result.status === "usage") throw new Error(`expected a refusal, got ${result.status}`);
      expect(result.message).toContain(historicalPath);
      expect(result.message).toContain("mstar harness scaffold");
      expect(result.message).toContain("mstar store init");
      expect(result.message).toContain("mstar store upgrade");
      expect(existsSync(join(harness, "store.db"))).toBe(false);
      expect(readFileSync(historicalPath)).toEqual(historicalBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

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

test("a held retired schema-8 claim refuses without mutation and settles on the same public command's attested retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-retired-claim-"));
  try {
    identify(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const workflowId = "retired-claim-workflow";
    const planId = `${workflowId}-plan`;
    const sessionId = "retired-plan-holder";
    const worktreePath = join(root, "wt-retired");
    const workingBranch = `feature/${planId}`;
    const businessPlan = { id: planId, title: "Retired claim plan", file: `${planId}.md`, status: "InProgress" };
    const workflowState = {
      schema_version: 1, id: workflowId, type: "plan", status: "running",
      started_at: "2026-10-04", updated_at: "2026-10-04",
      delivery_kind: "development", branch: { source: workingBranch, target: "main" },
    };
    const prepared = {
      qa_gate: "mandatory", findings_cleanup: "allow-residual",
      prepared_by: "host-coord", prepared_at: "2026-10-04T00:00:00Z",
    };
    // Reconstruct the ACTUAL schema-8 store from the owning engine's own
    // migration SQL: versions 1..8 applied verbatim, so the historical
    // execution_sessions (plan-pm seat), execution_leases and
    // execution_integration_leases exist exactly as migration 8 left them, and
    // the attested retry below applies migrations 9..11 — including the
    // retirement normalize — against true history rather than a demolished
    // schema-11 file.
    const db = new DatabaseSync(join(harness, "store.db"));
    db.exec("pragma foreign_keys=on");
    db.exec("begin immediate");
    db.exec(SCHEMA_VERSION_TABLE_SQL);
    for (const migration of MIGRATIONS.slice(0, 8)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        "2026-10-04T00:00:00.000Z",
      );
    }
    db.exec("commit");
    db.close();
    const initialized = await openStore({ harnessDir: harness }, "write");
    try {
      initialized.db.prepare("update execution_meta set authority_state = 'active' where id = 1").run();
      // Historical FK order: workflow, registry/business row, then identities
      // and claims. Retirement is keyed by this actual workflow/session pair.
      initialized.db.prepare(
        "insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, ?, ?, ?)",
      ).run(workflowId, JSON.stringify(workflowState), "2026-10-04", "2026-10-04");
      initialized.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run(
        workflowId,
        JSON.stringify({ id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` }),
      );
      initialized.db.prepare(
        "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 0, ?, ?)",
      ).run(workflowId, planId, JSON.stringify(businessPlan), JSON.stringify({
        revision: 1,
        prepared,
        session: { session_id: sessionId, session_file: join(root, "plan-pm.json"), bound_at: "2026-10-04T00:00:00Z" },
      }));
      initialized.db.prepare(
        "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
          "values (?, 'coordinator', 'host-coord', null, 1, 1, 'active', '2026-10-04T00:00:00Z')",
      ).run(workflowId);
      initialized.db.prepare(
        "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
          "values (?, 'plan-pm', ?, ?, 1, 1, 'suspended', '2026-10-04T00:00:00Z')",
      ).run(workflowId, sessionId, planId);
      initialized.db.prepare(
        "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, 1, ?)",
      ).run(workflowId, planId, JSON.stringify({
        holder: sessionId, holder_session_id: sessionId, holder_role: "plan-pm",
        claimed_at: "2026-10-04T00:00:00Z",
        worktree_path: worktreePath, working_branch: workingBranch, status: "held",
      }));
      initialized.db.prepare(
        "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, 1, ?)",
      ).run(workflowId, JSON.stringify({
        holder: sessionId, plan_id: planId, claimed_at: "2026-10-04T00:30:00Z",
        source_branch: workingBranch, target_branch: "main", status: "held",
      }));
    } finally {
      initialized.close();
    }

    const before = await protectedStoreState(harness);
    expect(before.schemaVersion).toBe(8);
    // Without an attestation the upgrade GENERATES the operator document
    // (I-000297); the Bun test runtime is never an admissible attested
    // consumer, so this commands-level run refuses with the named cause and
    // the installed-Node-CLI recovery — the documented escape, not a dead end.
    const refused = await executeCommand("store.upgrade", { harness, operator: "fixture-operator" }, invocation(root));
    expect(refused).toMatchObject({ status: "refused", code: "store.attestation-invalid", exitCode: 1 });
    expect(refused.status === "ok" ? undefined : refused.message).toContain("the running process is Bun");
    expect(refused.status === "ok" ? undefined : (refused.details as { recovery?: string }).recovery)
      .toContain("mstar store upgrade --operator <name>");
    expect(await protectedStoreState(harness)).toEqual(before);

    // The same protected store also witnesses the public file-input boundary:
    // none of these caller mistakes may start the schema cutover.
    const malformedPath = join(root, "malformed-attestation.json");
    writeFileSync(malformedPath, "{");
    const malformedBytes = readFileSync(malformedPath);
    for (const attestation of ["attestation.json", join(root, "absent-attestation.json"), malformedPath]) {
      const invalid = await executeCommand("store.upgrade", {
        harness, operator: "fixture-operator", attestation,
      }, invocation(root));
      expect(invalid).toMatchObject({ status: "usage", code: "usage", exitCode: 2 });
      expect(await protectedStoreState(harness)).toEqual(before);
    }
    expect(readFileSync(malformedPath)).toEqual(malformedBytes);

    // Every invalid document reaches the real engine validator through the
    // store command's absolute-file transport; none may start the cutover.
    const validAttestation = {
      version: 1,
      attestedAt: "2026-10-04T04:00:00Z",
      operator: { actor: "fixture-operator", authorizationRef: "fixture-authorization" },
      consumers: [{
        entryId: "coordinator-cli", kind: "coordinator" as const,
        entrypoint: "packages/cli/src/index.ts", runtime: "node" as const, runtimeVersion: atOrAboveRuntime,
        // Synthetic carried plugin version, not a release number.
        version: "0.0.0-synthetic", current: true, disposition: "reloaded" as const,
      }],
      stoppedSessions: [{ sessionId, host: "omp", state: "stopped" as const }],
    };
    const nonCoordinator = {
      ...validAttestation,
      consumers: [{ ...validAttestation.consumers[0]!, kind: "cli" as const }],
    };
    const multipleCurrent = {
      ...validAttestation,
      consumers: [
        ...validAttestation.consumers,
        { ...validAttestation.consumers[0]!, entryId: "second-current" },
      ],
    };
    const credentialMarker = "synthetic-secret-marker-do-not-disclose-9f3b";
    const invalidDocuments: unknown[] = [
      { ...validAttestation, operator: { ...validAttestation.operator, actor: "   " } },
      { ...validAttestation, attestedAt: "not-an-instant" },
      { ...validAttestation, consumers: [{ ...validAttestation.consumers[0]!, runtimeVersion: belowFloorRuntime }] },
      { ...validAttestation, consumers: [{ ...validAttestation.consumers[0]!, current: false }] },
      multipleCurrent,
      nonCoordinator,
      { ...validAttestation, sessionCredential: credentialMarker },
      { ...validAttestation, consumers: [{ ...validAttestation.consumers[0]!, sessionCredential: credentialMarker }] },
    ];
    const attestationPath = join(root, "attestation.json");
    for (const invalidDocument of invalidDocuments) {
      writeFileSync(attestationPath, JSON.stringify(invalidDocument));
      const invalid = await executeCommand("store.upgrade", {
        harness, operator: "fixture-operator", attestation: attestationPath,
      }, invocation(root));
      expect(invalid.status).toBe("refused");
      expect(JSON.stringify(invalid)).not.toContain(credentialMarker);
      expect(await protectedStoreState(harness)).toEqual(before);
    }
    // The same actual consumer accepts the corrected proof after all failures.
    writeFileSync(attestationPath, JSON.stringify(validAttestation));
    const attestationBytes = readFileSync(attestationPath);
    const result = await executeCommand("store.upgrade", {
      harness, operator: "fixture-operator", attestation: attestationPath,
    }, invocation(root));
    expect(result.status, result.status !== "ok" ? JSON.stringify(result) : "").toBe("ok");
    expect(readFileSync(attestationPath)).toEqual(attestationBytes);

    const store = await openStore({ harnessDir: harness }, "read");
    try {
      // The attested retry applies every pending migration of this build.
      expect(store.schemaVersion).toBe(MIGRATIONS.length);
      expect(store.db.prepare("select name from sqlite_schema where type = 'table' and name = 'execution_leases'").get()).toBeUndefined();
      expect(store.db.prepare("select * from execution_sessions where workflow_id = ? and session_id = ?").get(workflowId, sessionId)).toBeUndefined();
      expect(store.db.prepare("select * from execution_sessions where workflow_id = ?").all(workflowId)).toEqual([{
        workflow_id: workflowId, role: "coordinator", session_id: "host-coord",
        epoch: 1, revision: 1, state: "active", bound_at: "2026-10-04T00:00:00Z",
      }]);
      const plan = z.object({ revision: z.number(), state_json: z.string(), coordination_json: z.string() }).parse(
        store.db.prepare(
          "select revision, state_json, coordination_json from execution_plans where workflow_id = ? and plan_id = ?",
        ).get(workflowId, planId),
      );
      expect(plan.revision).toBe(1);
      expect(JSON.parse(plan.state_json)).toEqual({
        ...businessPlan, metadata: { worktree_path: worktreePath, working_branch: workingBranch },
      });
      expect(JSON.parse(plan.coordination_json)).toEqual({ prepared });
      const workflow = z.object({ state_json: z.string() }).parse(
        store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId),
      );
      expect(JSON.parse(workflow.state_json)).toEqual(workflowState);
      expect(store.db.prepare("select * from execution_registry where workflow_id = ?").get(workflowId))
        .toEqual(before.tables.execution_registry[0]);
      const claim = z.object({ revision: z.number(), owner_epoch: z.number(), lease_json: z.string() }).parse(
        store.db.prepare(
          "select revision, owner_epoch, lease_json from execution_integration_leases where workflow_id = ?",
        ).get(workflowId),
      );
      expect(claim.revision).toBe(2);
      expect(claim.owner_epoch).toBe(1);
      expect(JSON.parse(claim.lease_json)).toEqual({
        holder: sessionId, plan_id: planId, claimed_at: "2026-10-04T00:30:00Z",
        source_branch: workingBranch, target_branch: "main", status: "released",
        prior_holder: sessionId, released_by: "store-upgrade",
        // The supplied document's own authorizationRef, copied verbatim.
        released_at: "2026-10-04T04:00:00Z", release_reason: "fixture-authorization",
      });
      for (const table of ["execution_lease_cutover", "execution_session_cutover", "execution_integration_cutover"]) {
        expect(store.db.prepare("select name from sqlite_schema where type = 'table' and name = ?").get(table)).toBeUndefined();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report destination is create-only: an existing file is never truncated, even by the read-only plan verb", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-report-"));
  try {
    identify(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const destination = join(root, "operator-file.json");
    writeFileSync(destination, "operator bytes\n");
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.migrate");
    if (definition === undefined) throw new Error("missing store.migrate definition");
    const result = await definition.execute(definition.input.parse({ harness, out: destination }), invocation(root));
    // why: The PREVIEW ran; only its report could not be published, and that is
    // disclosed instead of the preview's own outcome.
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected the preview to succeed");
    expect(result.data).toMatchObject({ manifestFile: null, reportError: { code: "store.report-not-published" } });
    expect(readFileSync(destination, "utf8")).toBe("operator bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * note: A real v1 collaboration lane at this checkout's canonical path, plus the v2
 * checkout binding a normal activation records. The history it seeds is what the
 * public upgrade must advance rather than refuse with its own recovery text.
 */
function writeV1Lane(root: string): string {
  const context = { harnessDir: join(root, ".mstar"), checkoutRoot: root };
  const location = resolveCollaborationLocation(context);
  mkdirSync(dirname(location.dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(location.dbPath);
  try {
    db.exec(SCHEMA_VERSION_TABLE_SQL);
    const v1 = COLLABORATION_MIGRATIONS[0]!;
    db.exec(v1.sql);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      v1.version,
      v1.name,
      migrationChecksum(v1),
      "2026-11-21T00:00:00.000Z",
    );
    db.prepare(
      "insert into collaboration_meta(id, repository_key, mode, store_id, authority_state, authority_epoch, revision, " +
        "catalog_revision, created_at, activated_at) values (1, ?, 'local', 'v1-store', 'active', 1, 1, 0, ?, ?)",
    ).run(location.repoKey, "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
    db.prepare(
      "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, " +
        "identity_key) values ('I-000001', 'proj-issues', 'Retained v1 finding', 'bug', 'high', 'open', 'i', 'a', ?, ?, 'v1-key')",
    ).run("2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
  } finally {
    db.close();
  }
  chmodSync(location.dbPath, 0o600);
  writeCollaborationBinding(context, { repoKey: location.repoKey, mode: "local", storeId: "v1-store", epoch: 1 });
  return location.dbPath;
}

test("store.upgrade advances an admitted v1 collaboration lane and replays without losing history", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-v1-lane-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    identify(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    writeV1Lane(root);
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const upgrade = (operator: string) =>
      definition.execute(definition.input.parse({ harness, operator }), invocation(root));

    // invariant: The public verb advances the old lane; it never refuses with the command it just ran.
    const first = await upgrade("fixture-operator");
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error(`expected the upgrade to succeed: ${first.message}`);
    expect(first.data).toMatchObject({
      verdict: "upgraded",
      collaboration: { version: 1, fromVersion: 1, toVersion: 2, issuesBackfilled: 1 },
    });

    // note: A committed upgrade replays by revalidating instead of re-backfilling.
    const replay = await upgrade("fixture-operator");
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") throw new Error(`expected the replay to succeed: ${replay.message}`);
    expect(replay.data).toMatchObject({ collaboration: { fromVersion: 2, toVersion: 2, issuesBackfilled: 0 } });

    // invariant: The retained issue is readable through the public read interface.
    const listed = await listIssues({ harnessDir: harness, checkoutRoot: root }, { disposition: "open" });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: "I-000001", title: "Retained v1 finding", projectId: "proj-issues" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** note: The v1 lane's schema and data facts a refusal must leave untouched. */
function v1LaneState(dbPath: string): { versions: number[]; issueRef: boolean; issues: number } {
  const db = new DatabaseSync(dbPath);
  try {
    const versions = (db.prepare("select version from schema_version order by version").all() as Array<{ version?: unknown }>)
      .map((row) => (typeof row.version === "number" ? row.version : -1));
    const columns = (db.prepare("pragma table_info(issues)").all() as Array<{ name?: unknown }>)
      .map((row) => row.name);
    const count = db.prepare("select count(*) as n from issues").get() as { n?: unknown } | undefined;
    return { versions, issueRef: columns.includes("issue_ref"), issues: typeof count?.n === "number" ? count.n : -1 };
  } finally {
    db.close();
  }
}

test("store.upgrade refuses a v1 lane this checkout is not bound to and leaves it untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-stale-binding-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    identify(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const dbPath = writeV1Lane(root);
    const context = { harnessDir: harness, checkoutRoot: root };
    const location = resolveCollaborationLocation(context);
    const untouched = { versions: [1], issueRef: false, issues: 1 };
    expect(v1LaneState(dbPath)).toEqual(untouched);

    // note: The canonical lane is a same-repository generation this checkout does not record.
    writeCollaborationBinding(context, {
      repoKey: location.repoKey,
      mode: "local",
      storeId: "superseded-store",
      epoch: 4,
    });

    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const upgrade = () =>
      definition.execute(definition.input.parse({ harness, operator: "fixture-operator" }), invocation(root));

    const stale = await upgrade();
    expect(stale).toMatchObject({ status: "refused", code: "collaboration.stale-binding", exitCode: 1 });
    // invariant: No DDL, backfill or receipt landed on another generation's bytes.
    expect(v1LaneState(dbPath)).toEqual(untouched);

    // note: An unbound checkout (a replacement clone) reads the lane but never upgrades it.
    rmSync(join(harness, "collaboration-binding.json"), { force: true });
    const unbound = await upgrade();
    expect(unbound).toMatchObject({ status: "refused", code: "collaboration.stale-binding", exitCode: 1 });
    expect(v1LaneState(dbPath)).toEqual(untouched);

    // invariant: The owning checkout still advances exactly that lane.
    writeCollaborationBinding(context, { repoKey: location.repoKey, mode: "local", storeId: "v1-store", epoch: 1 });
    const owned = await upgrade();
    expect(owned.status).toBe("ok");
    if (owned.status !== "ok") throw new Error(`expected the owned upgrade to succeed: ${owned.message}`);
    expect(owned.data).toMatchObject({ collaboration: { version: 1, fromVersion: 1, toVersion: 2, issuesBackfilled: 1 } });
    expect(v1LaneState(dbPath)).toEqual({ versions: [1, 2], issueRef: true, issues: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
