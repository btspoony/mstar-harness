import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureIssue, openStore } from "@mstar-harness/engine";
import { getCommandDefinitions, getExecutionCommandDefinitions, getStoreCommandDefinitions } from "../src/index.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../src/types.js";

const roots: string[] = [];
const controlRoot = join(tmpdir(), "mstar-command-control-root-not-a-target");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `mstar-${label}-`));
  roots.push(root);
  return root;
}

function invocation(cwd: string, control = controlRoot): InvocationContext {
  return {
    cwd,
    controlRoot: control,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not available in this command family"); },
      async openBrowser() { throw new Error("not available in this command family"); },
    },
  };
}

async function invoke(definition: CommandDefinition, input: Record<string, unknown>, cwd: string): Promise<CommandEnvelope> {
  const parsed = definition.input.parse(input);
  return definition.execute(parsed, invocation(cwd));
}

function definition(id: string): CommandDefinition {
  const found = getCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function dataOf(result: CommandEnvelope): Record<string, unknown> {
  if (result.status !== "ok" || result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw new Error(`expected successful object result, got ${JSON.stringify(result)}`);
  }
  return result.data as Record<string, unknown>;
}

async function storeSnapshot(harnessDir: string): Promise<{ revision: number; epoch: number }> {
  const store = await openStore({ harnessDir }, "read");
  try {
    return store.db.prepare("select revision, authority_epoch as epoch from store_meta where id = 1").get() as { revision: number; epoch: number };
  } finally {
    store.close();
  }
}

describe("store and execution command surface", () => {
  test("registers the six store and eight store execution identities", () => {
    expect(getStoreCommandDefinitions().map(({ id }) => id)).toEqual([
      "store.init", "store.migrate", "store.safe-upgrade", "store.backup", "store.activate", "store.retire",
    ]);
    expect(getExecutionCommandDefinitions().map(({ id }) => id)).toEqual([
      "store.execution.preview", "store.execution.apply", "store.execution.activate", "store.execution.retire",
      "store.execution.abort", "store.execution.restore-preview", "store.execution.restore", "store.execution.export",
    ]);
  });

  test("initializes, previews migration, upgrades and backs up an explicitly named fixture store", async () => {
    const root = fixture("store-lifecycle");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const initialized = await invoke(definition("store.init"), { harness }, root);
    if (initialized.status !== "ok") throw new Error(JSON.stringify(initialized));
    expect(dataOf(initialized).authorityState).toBe("active");
    expect(existsSync(join(harness, "store.db"))).toBe(true);

    const migrate = await invoke(definition("store.migrate"), { harness }, root);
    expect(migrate.status).toBe("ok");
    expect(dataOf(migrate).blocksApply).toBe(false);
    expect(dataOf(migrate).manifestFile).toBe(null);

    const upgraded = await invoke(definition("store.safe-upgrade"), { harness }, root);
    expect(upgraded.status).toBe("ok");
    expect(typeof dataOf(upgraded).schemaVersion).toBe("number");

    const backup = await invoke(definition("store.backup"), { harness, out: join(root, "recovery.db") }, root);
    expect(backup.status).toBe("ok");
    expect(existsSync(join(root, "recovery.db"))).toBe(true);
    expect(typeof dataOf(backup).storeId).toBe("string");
  });
  test("store init refuses catalog migration inputs", async () => {
    for (const [label, legacyPath, contents] of [
      ["project residuals", join("projects", "alpha", "residuals.json"), "{}\n"],
      ["iterations catalog index", join("iterations", "README.md"), "# Iterations\n"],
    ] as const) {
      const root = fixture(`store-init-${label.replaceAll(" ", "-")}`);
      const harness = join(root, ".mstar");
      const legacyFile = join(harness, legacyPath);
      mkdirSync(dirname(legacyFile), { recursive: true });
      writeFileSync(legacyFile, contents);

      const result = await invoke(definition("store.init"), { harness }, root);
      expect(result.status).toBe("refused");
      expect(result.code).toBe("store.already-exists");
      expect(result.message).toContain("staged catalog migration");
      expect(result.message).toContain("not store init");
      expect(existsSync(join(harness, "store.db"))).toBe(false);
    }
  });

  test("a control-root-only manifest without --coverage is a usage refusal naming the flag", async () => {
    const root = fixture("execution-control-root-only");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    // No inventoryPath: the reviewed scope is control-root-only, so coverage
    // cannot be derived and must be supplied explicitly. The adapter decides
    // this before the engine is entered, so the operator sees the flag it needs
    // rather than an engine-internal "inventory is not closed" verdict.
    const manifestPath = join(root, "control-root-manifest.json");
    writeJson(manifestPath, { version: 3, id: "control-root-manifest", root: harness, surfaces: [] });
    const apply = await invoke(definition("store.execution.apply"), {
      harness,
      operation: "control-root-only",
      operator: "ops-engineer",
      manifest: manifestPath,
      backup: join(root, "unused-recovery-receipt.json"),
    }, root);
    expect(apply.status).toBe("usage");
    if (apply.status === "usage") expect(apply.message).toContain("--coverage");
  });

  test("maintenance input derives inventory from the reviewed manifest and aggregates irreducible requirements", async () => {
    const root = fixture("execution-sparse-maintenance");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const inventory = join(harness, "execution-inventory", "inventory.json");
    const evidenceRoot = dirname(inventory);
    for (const name of ["sdd", "host", "package"]) mkdirSync(join(evidenceRoot, name), { recursive: true });
    writeJson(inventory, {
      version: 2,
      roots: {
        sdd: join(evidenceRoot, "sdd"),
        host: join(evidenceRoot, "host"),
        package: join(evidenceRoot, "package"),
      },
      hostSessions: [],
      sddEvidence: [],
      consumers: [],
      injectors: [],
      injectorInventory: null,
      backup: null,
    });
    const manifestPath = join(root, "execution-manifest.json");
    writeJson(manifestPath, { version: 3, id: "fixture-manifest", root: harness, inventoryPath: inventory, surfaces: [] });
    const apply = await invoke(definition("store.execution.apply"), {
      harness,
      operation: "sparse-apply",
      operator: "ops-engineer",
      manifest: manifestPath,
      backup: join(root, "unused-recovery-receipt.json"),
    }, root);
    expect(apply.status).toBe("refused");
    if (apply.status === "refused") {
      expect(apply.code).toBe("execution.coverage-incomplete");
      expect(apply.message).not.toContain("--inventory");
    }

    const missingStoreMaintenance = await invoke(definition("store.activate"), { harness }, root);
    expect(missingStoreMaintenance.status).toBe("usage");
    if (missingStoreMaintenance.status === "usage") {
      expect(missingStoreMaintenance.message).toContain("--manifest");
      expect(missingStoreMaintenance.message).toContain("--attestation");
    }
    const missingExecutionMaintenance = await invoke(definition("store.execution.apply"), { harness }, root);
    expect(missingExecutionMaintenance.status).toBe("usage");
    if (missingExecutionMaintenance.status === "usage") {
      expect(missingExecutionMaintenance.message).toContain("--operation");
      expect(missingExecutionMaintenance.message).toContain("--operator");
      expect(missingExecutionMaintenance.message).toContain("--manifest");
      expect(missingExecutionMaintenance.message).toContain("--backup");
    }
  });


  test("refuses the control-root store and refuses an un-applied migration at activation", async () => {
    const root = fixture("store-barriers");
    const control = join(root, "control");
    mkdirSync(control, { recursive: true });
    const init = await invoke(definition("store.init"), { harness: control }, root);
    expect(init.status).toBe("ok");
    const before = await storeSnapshot(control);
    const forbidden = await definition("store.backup").execute(
      definition("store.backup").input.parse({ harness: control }), invocation(root, control),
    );
    expect(forbidden.status).toBe("usage");
    if (forbidden.status === "usage") expect(forbidden.message).toContain("control-root store");
    expect(await storeSnapshot(control)).toEqual(before);

    const manifestPath = join(root, "manifest.json");
    const preview = await invoke(definition("store.migrate"), { harness: control, out: manifestPath }, root);
    expect(preview.status).toBe("ok");
    const attestationPath = join(root, "attestation.json");
    writeJson(attestationPath, { attestedAt: "2026-09-26T00:00:00.000Z", operator: "fixture-operator", consumers: [], stoppedSessions: [] });
    const activation = await invoke(definition("store.activate"), { harness: control, manifest: manifestPath, attestation: attestationPath }, root);
    expect(activation.status).toBe("refused");
    if (activation.status === "refused") expect(activation.code).toBe("store.activation-stale");
    expect(await storeSnapshot(control)).toEqual(before);
  });

  test("restore preview exports redacted state and rejects a wrong loss digest without mutation", async () => {
    const root = fixture("execution-recovery");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const initialized = await invoke(definition("store.init"), { harness }, root);
    expect(initialized.status).toBe("ok");
    const backupPath = join(harness, "point.db");
    const backup = await invoke(definition("store.backup"), { harness, out: backupPath }, root);
    expect(backup.status).toBe("ok");
    await captureIssue({ harnessDir: harness }, {
      projectId: "_default",
      title: "A finding created after the recovery point",
      kind: "bug",
      severity: "high",
      impact: "The restore preview must include this lost row.",
      acceptance: "The loss digest gates replacement.",
      sourceIdentity: "fixture/post-backup.md",
      rootCauseKey: "post-backup-loss",
      acceptanceKey: "restore-loss-test",
      occurrenceKey: "post-backup-occurrence",
      sourceKind: "qc",
      location: "fixture/post-backup.md:1",
      observedBehavior: "A later row would be lost by restore.",
      evidence: ["fixture evidence"],
      discoveredAt: "2026-09-26T00:00:00.000Z",
    }, { operationId: "post-backup-issue", actor: "project-manager" });

    const previewPath = join(root, "loss-preview.json");
    const restorePreview = await invoke(definition("store.execution.restore-preview"), { harness, backup: backupPath, out: previewPath }, root);
    if (restorePreview.status !== "ok") throw new Error(JSON.stringify(restorePreview));
    const previewData = dataOf(restorePreview);
    expect(typeof previewData.lossDigest).toBe("string");
    expect(previewData.previewFile).toBe(previewPath);
    const preview = JSON.parse(readFileSync(previewPath, "utf8")) as { lossDigest: string };

    const exported = await invoke(definition("store.execution.export"), { harness }, root);
    expect(exported.status).toBe("ok");
    const exportData = dataOf(exported);
    expect(exportData.format).toBe("execution-diagnostic-v1");
    expect(typeof exportData.sha256).toBe("string");
    const artifact = JSON.parse(String(exportData.canonicalJson)) as { redactedKeys?: unknown };
    expect(Array.isArray(artifact.redactedKeys)).toBe(true);

    const before = await storeSnapshot(harness);
    const wrongDigest = preview.lossDigest === "f".repeat(64) ? "0".repeat(64) : "f".repeat(64);
    const rejected = await invoke(definition("store.execution.restore"), {
      harness,
      preview: previewPath,
      acceptLossDigest: wrongDigest,
      operator: "fixture-operator",
      authorization: "fixture-audit-reference",
    }, root);
    expect(rejected.status).toBe("refused");
    if (rejected.status === "refused") expect(rejected.code).toBe("execution.recovery-loss-unaccepted");
    expect(await storeSnapshot(harness)).toEqual(before);
  });

  test("execution activation does not accept a caller-only control-root target", async () => {
    const root = fixture("execution-control-root");
    const harness = join(root, "control");
    mkdirSync(harness, { recursive: true });
    const init = await invoke(definition("store.init"), { harness }, root);
    expect(init.status).toBe("ok");
    const before = await storeSnapshot(harness);
    const activateDefinition = definition("store.execution.activate");
    const activate = await activateDefinition.execute(activateDefinition.input.parse({
      harness,
      operation: "fixture-operation",
      operator: "fixture-operator",
      manifest: join(root, "manifest.json"),
      coverage: join(root, "coverage.json"),
      attestation: join(root, "attestation.json"),
    }), invocation(root, harness));
    expect(activate.status).not.toBe("ok");
    if (activate.status !== "ok") expect(activate.message).toContain("control-root");
    expect(await storeSnapshot(harness)).toEqual(before);
  });
});
