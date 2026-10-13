import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  test("old loss payload refusal points to public preview regeneration", async () => {
    const root = fixture("execution-old-preview");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    expect((await invoke(definition("store.init"), { harness }, root)).status).toBe("ok");
    const backupPath = join(harness, "point.db");
    expect((await invoke(definition("store.backup"), { harness, out: backupPath }, root)).status).toBe("ok");
    const firstPreview = join(root, "first-preview.json");
    const first = await invoke(definition("store.execution.restore-preview"), { harness, backup: backupPath, out: firstPreview }, root);
    expect(first.status).toBe("ok");
    expect(dataOf(first).version).toBe(3);
    // An older loss-payload generation than the build's own protocol: the
    // public refusal must name the cause and the same-root verb that
    // regenerates a current preview, never the unrelated status self-check.
    const oldPreview = join(root, "old-preview.json");
    writeJson(oldPreview, { ...(JSON.parse(readFileSync(firstPreview, "utf8")) as Record<string, unknown>), version: 2 });
    const before = await storeSnapshot(harness);
    const refused = await invoke(definition("store.execution.restore"), {
      harness, preview: oldPreview, operator: "fixture-operator", authorization: "fixture-audit-reference",
    }, root);
    expect(refused).toMatchObject({ status: "refused", code: "execution.migration-conflict" });
    expect(refused.message).toContain("loss-payload version 2");
    const recovery = refused.status === "refused" ? refused.details?.recovery : undefined;
    expect(recovery).toContain("mstar store execution restore-preview --backup <backup> --out <preview>");
    expect(recovery).not.toContain("status validate");
    // The refusal changed nothing.
    expect(await storeSnapshot(harness)).toEqual(before);

    // The recovery the refusal names is a real public verb on this build: it
    // regenerates a current preview that a retry accepts.
    const regenerated = await invoke(definition("store.execution.restore-preview"), {
      harness, backup: backupPath, out: join(root, "regenerated-preview.json"),
    }, root);
    expect(regenerated.status).toBe("ok");
    expect(dataOf(regenerated).version).toBe(3);
    const retried = await invoke(definition("store.execution.restore"), {
      harness, preview: join(root, "regenerated-preview.json"), operator: "fixture-operator", authorization: "fixture-audit-reference",
    }, root);
    expect(retried.status).toBe("ok");
    expect(typeof dataOf(retried).restoredFromSha256).toBe("string");
  });
  test("store upgrade exposes source-scoped DSH recovery and reports the acknowledged loss", async () => {
    const root = fixture("store-upgrade-dsh-recovery");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const initialized = await initializeStore({ harnessDir: harness });
    initialized.close();
    const workflowDir = join(harness, "workflows", "wf-recovery");
    mkdirSync(workflowDir, { recursive: true });
    const identityPath = join(workflowDir, "agent-flow-ids.jsonl");
    const source = '{"id":"accepted","d":"digest"}\\nmalformed\\n';
    writeFileSync(identityPath, source);
    const command = definition("store.upgrade");
    const refused = await invoke(command, { harness, operator: "fixture" }, root);
    expect(refused).toMatchObject({ status: "refused", code: "store.upgrade-dsh-source-refused", exitCode: 1 });
    expect(refused.message).toContain("dsh-ledger:wf-recovery");
    expect(refused.message).toContain("Recovery:");
    expect(refused.details).toMatchObject({ recovery: expect.stringContaining("--ack-skip-dsh") });
    const unmatched = await invoke(command, { harness, operator: "fixture", ackSkipDsh: ["dsh-status"] }, root);
    expect(unmatched).toMatchObject({ status: "usage", code: "store.upgrade-dsh-ack-unmatched", exitCode: 2 });
    const recovered = await invoke(command, { harness, operator: "fixture", ackSkipDsh: ["dsh-ledger:wf-recovery"] }, root);
    expect(recovered.status).toBe("ok");
    const result = dataOf(recovered);
    expect(result.dsh).toMatchObject({ verdict: "partially-imported" });
    expect(JSON.parse(JSON.stringify(result.dsh))).toMatchObject({
      findings: [expect.objectContaining({ kind: "dropped-by-ack", selector: "dsh-ledger:wf-recovery" })],
    });
    expect(readFileSync(identityPath, "utf8")).toBe(source);
  });
  test("a refused DSH phase leaves the earlier execution import committed with its real workflow rows and reports it truthfully", async () => {
    const root = fixture("store-upgrade-dsh-partial");
    const harness = join(root, ".mstar");
    const workflowId = "wf-partial";
    const planId = `${workflowId}-plan`;
    const workflowDir = join(harness, "workflows", workflowId);
    const sessionsDir = join(workflowDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // A minimal recognizable legacy execution fixture (the store-upgrade-minimal
    // pattern): a registered workflow with a snapshot and plan the execution
    // importer commits in its own earlier transaction.
    writeFileSync(join(harness, `${planId}.md`), `# ${planId}\n`);
    writeFileSync(join(sessionsDir, "plan-pm.json"), JSON.stringify({
      schema_version: 1, role: "plan-pm", session_id: "session-partial", workflow_id: workflowId, plan_id: planId, harness_root: harness,
    }));
    writeFileSync(join(harness, "status.json"), JSON.stringify({
      version: 2, updated_at: "2026-10-04", workflows: [{ id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` }],
    }));
    writeFileSync(join(workflowDir, "snapshot.json"), JSON.stringify({
      schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04",
      delivery_kind: "development", branch: { source: `feature/${workflowId}`, target: "main" },
      plans: [{ id: planId, title: "Partial fixture plan", file: `${planId}.md`, status: "Todo",
        coordination: { revision: 1, session: { session_id: "session-partial", session_file: join(sessionsDir, "plan-pm.json"), bound_at: "2026-10-04T00:00:00Z" } },
        execution_lease: { holder: "session-partial", claimed_at: "2026-10-04T00:00:00Z", worktree_path: `${root}/worktree-partial`, working_branch: `feature/${workflowId}` } }],
    }));
    // The DSH source refuses: a malformed identity index line.
    writeFileSync(join(workflowDir, "agent-flow-ids.jsonl"), '{"id":"accepted","d":"digest"}\nmalformed\n');
    const command = definition("store.upgrade");
    const refused = await invoke(command, { harness, operator: "fixture" }, root);
    expect(refused).toMatchObject({ status: "refused", code: "store.upgrade-dsh-source-refused", exitCode: 1 });
    expect(refused.message).toContain("Execution-state import committed");
    expect(refused.message).toContain("dsh-ledger:wf-partial");
    const initialized = await openStore({ harnessDir: harness }, "read");
    try {
      // The execution phase's real workflow/plan rows and its receipt survive; the
      // DSH phase wrote nothing and left no DSH receipt.
      expect(initialized.db.prepare("select count(*) as n from execution_workflows where workflow_id = ?").get(workflowId)).toEqual({ n: 1 });
      expect(initialized.db.prepare("select count(*) as n from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId)).toEqual({ n: 1 });
      expect(initialized.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
      expect(initialized.db.prepare("select count(*) as n from store_operations where operation_id not like '%#dsh-host-state'").get()).toEqual({ n: 1 });
      expect(initialized.db.prepare("select count(*) as n from store_operations where operation_id like '%#dsh-host-state'").get()).toEqual({ n: 0 });
    } finally { initialized.close(); }
  });
  test("store upgrade exposes the execution-specific registered-source skip and keeps the DSH domain separate", async () => {
    const root = fixture("store-upgrade-workflow-skip");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const initialized = await initializeStore({ harnessDir: harness });
    initialized.close();
    const workflowId = "wf-skip-command";
    const planId = `${workflowId}-plan`;
    const workflowDir = join(harness, "workflows", workflowId);
    const sessionsDir = join(workflowDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(harness, `${planId}.md`), `# ${planId}\n`);
    writeFileSync(join(sessionsDir, "plan-pm.json"), JSON.stringify({
      schema_version: 1, role: "plan-pm", session_id: "session-skip", workflow_id: workflowId, plan_id: planId, harness_root: harness,
    }));
    writeFileSync(join(harness, "status.json"), JSON.stringify({
      version: 2, updated_at: "2026-10-04", workflows: [{ id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` }],
    }));
    const snapshot = {
      schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04",
      delivery_kind: "development", branch: { source: `feature/${workflowId}`, target: "main" },
      plans: [{ id: planId, title: "Skip fixture plan", file: `${planId}.md`, status: "Todo" }],
    };
    writeFileSync(join(workflowDir, "snapshot.json"), JSON.stringify(snapshot));
    // The registered workflow's directory becomes a symlink to an out-of-root
    // tree: nothing under it may be read, including by the DSH phase.
    const target = join(root, "outside-command-tree", workflowId);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "snapshot.json"), JSON.stringify(snapshot));
    const linkedSnapshot = readFileSync(join(target, "snapshot.json"));
    rmSync(workflowDir, { recursive: true, force: true });
    symlinkSync(target, workflowDir);

    const command = definition("store.upgrade");
    // Default refuses and names the exact supported recovery on the same entry.
    const refused = await invoke(command, { harness, operator: "fixture" }, root);
    expect(refused).toMatchObject({ status: "refused", code: "execution.migration-conflict", exitCode: 1 });
    expect(refused.message).toContain(`--ack-skip-workflow ${workflowId}`);
    // An acknowledgement that names no refused source is a caller-input error,
    // never a silent skip of a trusted source.
    const unmatched = await invoke(command, { harness, operator: "fixture", ackSkipWorkflow: ["wf-never-registered"] }, root);
    expect(unmatched).toMatchObject({ status: "usage", code: "execution.workflow-skip-unmatched", exitCode: 2 });
    // The execution skip does not dispose the DSH domain: the same linked child
    // is independently a DSH source, so it still refuses there under its own
    // selector even after the execution acknowledgement is supplied.
    const dshRefused = await invoke(command, { harness, operator: "fixture", ackSkipWorkflow: [workflowId] }, root);
    expect(dshRefused).toMatchObject({ status: "refused", code: "store.upgrade-dsh-source-refused" });
    expect(dshRefused.message).toContain("--ack-skip-dsh");
    expect(dshRefused.message).toContain(`dsh-ledger:${workflowId}`);
    // Both domains acknowledged: the registered source is skipped importing with
    // a truthful receipt, and the DSH source is dropped as its own acknowledged loss.
    const recovered = await invoke(command, {
      harness, operator: "fixture", ackSkipWorkflow: [workflowId], ackSkipDsh: [`dsh-ledger:${workflowId}`],
    }, root);
    expect(recovered.status).toBe("ok");
    const result = dataOf(recovered);
    expect(result.skipped).toContainEqual({
      path: `workflows/${workflowId}`,
      reason: `registered workflow ${workflowId} skipped by --ack-skip-workflow; its symlinked legacy source was not read and no execution row was imported for it`,
    });
    expect(result.dispositions).toContainEqual(expect.stringContaining(`workflow ${workflowId}: skipped by --ack-skip-workflow`));
    expect(JSON.parse(JSON.stringify(result.dsh))).toMatchObject({
      findings: [expect.objectContaining({ kind: "dropped-by-ack", selector: `dsh-ledger:${workflowId}` })],
    });
    const store = await openStore({ harnessDir: harness }, "read");
    try { expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 }); }
    finally { store.close(); }
    // The link and its target bytes are untouched — this proves no REWRITE. The
    // no-read / no-probe ordering for an acknowledged linked source is defended
    // by the engine regressions (the acknowledgement is honoured before any
    // child lstat or snapshot read).
    expect(lstatSync(workflowDir).isSymbolicLink()).toBe(true);
    expect([...readFileSync(join(target, "snapshot.json"))]).toEqual([...linkedSnapshot]);
  });
  test("an acknowledged DSH import replays its receipt without a second write", async () => {
    const root = fixture("store-upgrade-dsh-replay");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const initialized = await initializeStore({ harnessDir: harness });
    initialized.close();
    const workflowDir = join(harness, "workflows", "wf-replay");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, "agent-flow.jsonl"), '{"eventId":"wfc1:s:c:tool"}\n');
    const command = definition("store.upgrade");
    const first = await invoke(command, { harness, operator: "fixture" }, root);
    expect(first.status).toBe("ok");
    const replay = await invoke(command, { harness, operator: "fixture" }, root);
    expect(replay.status).toBe("ok");
    expect(dataOf(replay).dsh).toMatchObject({ verdict: "nothing-to-import", imported: { ledgerRows: 0 } });
    const store = await openStore({ harnessDir: harness }, "read");
    try {
      // A repeat upgrade reuses provenance (zero new tail rows) and, because the
      // fresh invocation mints a new operation id, adds one new receipt.
      expect(store.db.prepare("select count(*) as n from dsh_ledger_events where workflow_id = ?").get("wf-replay")).toEqual({ n: 1 });
      expect(store.db.prepare("select revision from store_meta where id=1").get()).toEqual({ revision: 1 });
    } finally { store.close(); }
  });

});
