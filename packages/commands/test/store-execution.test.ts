import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureIssue, getIssue, initializeStore, openStore } from "@mstar-harness/engine";
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

async function invoke(definition: CommandDefinition, input: Record<string, unknown>, cwd: string, control?: string): Promise<CommandEnvelope> {
  const parsed = definition.input.parse(input);
  return definition.execute(parsed, invocation(cwd, control));
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
  test("registers six surviving store verbs and three independent execution utilities", () => {
    expect(getStoreCommandDefinitions().map(({ id }) => id)).toEqual([
      "store.init", "store.upgrade", "store.migrate", "store.backup", "store.activate", "store.retire",
    ]);
    expect(getExecutionCommandDefinitions().map(({ id }) => id)).toEqual([
      "store.execution.restore-preview", "store.execution.restore", "store.execution.export",
    ]);
  });
  test("execution restore-preview preserves usage code, status, and authored message", async () => {
    const root = fixture("execution-usage");
    const result = await invoke(definition("store.execution.restore-preview"), { harness: join(root, ".mstar") }, root);
    expect(result).toMatchObject({
      status: "usage",
      code: "usage",
      exitCode: 2,
      message: "--backup is required",
    });
  });

  test("initializes despite symlinked project residuals, previews migration, upgrades and backs up an explicitly named fixture store", async () => {
    const root = fixture("store-lifecycle");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const linkedProject = join(root, "linked-project");
    mkdirSync(linkedProject);
    writeFileSync(join(linkedProject, "residuals.json"), "{}\n");
    const projectsDir = join(harness, "projects");
    mkdirSync(projectsDir);
    symlinkSync(linkedProject, join(projectsDir, "linked"));
    const initialized = await invoke(definition("store.init"), { harness }, root);
    if (initialized.status !== "ok") throw new Error(JSON.stringify(initialized));
    expect(dataOf(initialized).authorityState).toBe("active");
    expect(existsSync(join(harness, "store.db"))).toBe(true);

    const migrate = await invoke(definition("store.migrate"), { harness }, root);
    expect(migrate.status).toBe("ok");
    expect(dataOf(migrate).blocksApply).toBe(false);
    expect(dataOf(migrate).manifestFile).toBe(null);

    const upgraded = await invoke(definition("store.upgrade"), { harness, operator: "fixture-operator" }, root);
    expect(upgraded.status).toBe("ok");
    expect(dataOf(upgraded)).toMatchObject({ verdict: "upgraded", authorityState: "active" });

    const backup = await invoke(definition("store.backup"), { harness, out: join(root, "recovery.db") }, root);
    expect(backup.status).toBe("ok");
    expect(existsSync(join(root, "recovery.db"))).toBe(true);
    expect(typeof dataOf(backup).storeId).toBe("string");
  });
  test("backs up the explicitly selected control-root store without changing its content", async () => {
    const root = fixture("store-admin-backup");
    const harness = join(root, ".mstar");
    mkdirSync(harness);
    const initialized = await initializeStore({ harnessDir: harness });
    initialized.close();
    const finding = await captureIssue({ harnessDir: harness }, {
      projectId: "_default",
      title: "Canonical store finding",
      kind: "bug",
      severity: "medium",
      impact: "The canonical store backup must preserve this finding.",
      acceptance: "The recovery image contains the original issue.",
      sourceIdentity: "fixture/canonical-backup",
      rootCauseKey: "canonical-backup",
      acceptanceKey: "recoverable-content",
      occurrenceKey: "canonical-backup-first",
      sourceKind: "review",
      location: "fixture/canonical-backup",
      observedBehavior: "The explicitly selected canonical store is the administration target.",
      evidence: ["fixture finding"],
      discoveredAt: "2026-10-07T00:00:00Z",
    }, { operationId: "canonical-backup-issue", actor: "project-manager" });
    const before = await storeSnapshot(harness);
    const out = join(root, "recovery.db");
    const caller = fixture("store-admin-caller");
    const backup = await invoke(definition("store.backup"), { harness, out }, caller, harness);
    expect(backup.status).toBe("ok");
    expect(await storeSnapshot(harness)).toEqual(before);

    const recoveryHarness = fixture("store-admin-recovery");
    copyFileSync(out, join(recoveryHarness, "store.db"));
    expect(await getIssue({ harnessDir: recoveryHarness }, finding.issueId)).toMatchObject({
      id: finding.issueId,
      title: "Canonical store finding",
      disposition: "open",
    });
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



  test("refuses activation of an unapplied migration at the control-root store", async () => {
    const root = fixture("store-barriers");
    const control = join(root, "control");
    mkdirSync(control, { recursive: true });
    const init = await invoke(definition("store.init"), { harness: control }, root);
    expect(init.status).toBe("ok");
    const before = await storeSnapshot(control);

    const manifestPath = join(root, "manifest.json");
    const preview = await invoke(definition("store.migrate"), { harness: control, out: manifestPath }, root, control);
    expect(preview.status).toBe("ok");
    const attestationPath = join(root, "attestation.json");
    writeJson(attestationPath, { attestedAt: "2026-09-26T00:00:00.000Z", operator: "fixture-operator", consumers: [], stoppedSessions: [] });
    const activation = await invoke(definition("store.activate"), { harness: control, manifest: manifestPath, attestation: attestationPath }, root, control);
    expect(activation.status).toBe("refused");
    if (activation.status === "refused") expect(activation.code).toBe("store.activation-stale");
    expect(await storeSnapshot(control)).toEqual(before);
  });

  test("restore preview exports redacted state and a preview whose recovery point is gone refuses without mutation", async () => {
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
      acceptance: "The preview reports the loss the replacement would cause.",
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

    const exported = await invoke(definition("store.execution.export"), { harness }, root);
    expect(exported.status).toBe("ok");
    const exportData = dataOf(exported);
    expect(exportData.format).toBe("execution-diagnostic-v1");
    expect(typeof exportData.sha256).toBe("string");
    const artifact = JSON.parse(String(exportData.canonicalJson)) as { redactedKeys?: unknown };
    expect(Array.isArray(artifact.redactedKeys)).toBe(true);

    const before = await storeSnapshot(harness);
    const orphanedPreview = join(root, "loss-preview-orphaned.json");
    writeJson(orphanedPreview, {
      ...(JSON.parse(readFileSync(previewPath, "utf8")) as Record<string, unknown>),
      backupPath: join(harness, "absent-point.db"),
    });
    const rejected = await invoke(definition("store.execution.restore"), {
      harness,
      preview: orphanedPreview,
      operator: "fixture-operator",
      authorization: "fixture-audit-reference",
    }, root);
    expect(rejected.status).toBe("refused");
    expect(rejected.message.split("\n", 1)[0]).toBe(
      `[store.activation-stale] no recovery point exists at ${join(realpathSync(harness), "absent-point.db")}. Select an existing recovery point or create one with store backup --out <path> inside ${realpathSync(harness)}; run store execution restore-preview against that point before retrying restore.`,
    );
    expect(rejected.details).toHaveProperty("helpRoute");
    if (rejected.status === "refused") expect(rejected.code).toBe("store.activation-stale");
    expect(await storeSnapshot(harness)).toEqual(before);
  });

});
