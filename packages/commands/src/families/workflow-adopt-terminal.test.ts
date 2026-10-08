import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { initializeExecutionAuthority, initializeStore, openStore, type StoreDb } from "@mstar-harness/engine";
import { activationAttestationDocumentSchema } from "../activation-attestation.js";
import { executeCommand, getCommandDefinitions } from "../definitions.js";
import type { CommandEnvelope, InvocationContext } from "../types.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function fixture(active = true): Promise<{ root: string; harness: string }> {
  const root = mkdtempSync(join(tmpdir(), "mstar-adopt-terminal-command-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const initial = await initializeStore({ harnessDir: harness });
  initial.close();
  if (active) await initializeExecutionAuthority({ harnessDir: harness });
  const writer = await openStore({ harnessDir: harness }, "write");
  try {
    writer.db.prepare(
      "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, null, ?, ?, ?)",
    ).run("wf-command", JSON.stringify({
      id: "wf-command", schema_version: 1, type: "plan", status: "stopped",
      started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z",
      updated_at: "2026-10-01T01:00:00.000Z", stop_reason: "fixture terminal stop",
    }), "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z");
  } finally { writer.close(); }
  return { root, harness };
}

function invocation(cwd: string): InvocationContext {
  return {
    cwd, controlRoot: null, sessionId: "caller-session",
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not available in this test"); },
      async openBrowser() { throw new Error("not available in this test"); },
    },
  };
}
function expectAdoptionRefusal(result: CommandEnvelope, firstLine: string, recovery: string): void {
  if (result.status !== "refused") throw new Error(`expected refusal, received ${result.status}`);
  expect(result.message).toBe(
    `${firstLine}\nHelp: mstar workflow adopt-terminal --help\nRecovery: ${recovery}`,
  );
  expect(result.details).toMatchObject({
    helpRoute: "mstar workflow adopt-terminal --help",
    recovery,
  });
}
function expectDeadEndMarkers(recovery: string, needsIssue397Residual: boolean): void {
  expect(recovery).toContain("No supported exit exists");
  expect(recovery).toContain("mstar issue add");
  if (needsIssue397Residual) expect(recovery).toContain("I-000397 residual surface");
}
async function withWriter(harness: string, action: (db: StoreDb) => void): Promise<void> {
  const writer = await openStore({ harnessDir: harness }, "write");
  try { action(writer.db); }
  finally { writer.close(); }
}

/** Plants one ACTIVE current-epoch coordinator holder row for the fixture workflow. */
async function withActiveHolder(harness: string, sessionId: string): Promise<void> {
  await withWriter(harness, (db) => {
    const epoch = (db.prepare("select authority_epoch from store_meta where id = 1").get() as { authority_epoch: number }).authority_epoch;
    db.prepare("insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', ?)")
      .run("wf-command", sessionId, epoch, "2026-10-01T00:00:00.000Z");
  });
}

/**
 * The genuine operator/consumer/stop facts of the fixture (declared
 * preconditions, not facts inferred from any refusal), shaped as the raw
 * document the FILE transport reads. Consumers that must consume the emitted
 * proof contract build this document and validate it against the published
 * JSON schema before writing it.
 */
function attestationDocument(stoppedSessionIds: readonly string[]): Record<string, unknown> {
  return {
    version: 1,
    attestedAt: "2026-10-08T00:00:00.000Z",
    operator: { actor: "recovery-operator", authorizationRef: "operator-authorization-fixture" },
    consumers: [{
      entryId: "mstar-cli", kind: "coordinator", entrypoint: "packages/cli/src/index.ts",
      runtime: "bun", runtimeVersion: "99.0.0", version: "0.0.0-test", current: true, disposition: "reloaded",
    }],
    stoppedSessions: stoppedSessionIds.map((sessionId) => ({ sessionId, host: "fixture-host", state: "stopped" })),
  };
}

/**
 * The operator stop document the transport reads, validated through the shared
 * structural contract before it is written.
 */
function writeAttestation(root: string, stoppedSessionIds: readonly string[], overrides: Record<string, unknown> = {}): string {
  const document = activationAttestationDocumentSchema.parse({ ...attestationDocument(stoppedSessionIds), ...overrides });
  const path = join(root, "attestation.json");
  writeFileSync(path, JSON.stringify(document, null, 2));
  return path;
}

test("workflow adopt-terminal publishes revision source, replays, and reports adopted terminal state", async () => {
  const { root, harness } = await fixture();
  const input = { workflow: "wf-command", harness, expect: "1", operation: "command-adopt-1", reason: "close imported terminal header" };
  const before = await executeCommand("status.validate", {}, invocation(root));
  expect(before.status).toBe("ok");
  if (before.status === "ok") {
    expect((before.data as { terminalUnregistered: unknown[]; terminalAdoptions: unknown[] }).terminalUnregistered)
      .toEqual([{ id: "wf-command", status: "stopped", revision: 1 }]);
    expect((before.data as { terminalAdoptions: unknown[] }).terminalAdoptions).toEqual([]);
  }
  const first = await executeCommand("workflow.adopt-terminal", input, invocation(root));
  expect(first).toMatchObject({ status: "ok" });
  const replay = await executeCommand("workflow.adopt-terminal", input, invocation(root));
  expect(replay.status).toBe("ok");
  if (replay.status === "ok") expect((replay.data as { replayed: boolean }).replayed).toBe(true);

  const status = await executeCommand("status.validate", {}, invocation(root));
  expect(status.status).toBe("ok");
  if (status.status === "ok") {
    expect((status.data as { terminalAdoptions: Array<{ id: string; status: string; revision: number; lifecycle_adopted_at: string; adopt_reason: string }> }).terminalAdoptions)
      .toMatchObject([{ id: "wf-command", status: "stopped", revision: 2, lifecycle_adopted_at: expect.any(String), adopt_reason: input.reason }]);
  }
  const definition = getCommandDefinitions().find((entry) => entry.id === "workflow.adopt-terminal");
  expect(definition).toBeDefined();
  expect(definition!.cli.options.find((option) => option.key === "expect")?.help)
    .toContain("when omitted the engine derives the current addressed revision");
  const schema = await executeCommand("schema", { command: "workflow.adopt-terminal" }, invocation(root));
  const descriptorSchema = z.object({
    id: z.string(),
    requirements: z.array(z.object({
      name: z.string(),
      route: z.string(),
      tokenKind: z.string().optional(),
    })),
    payloadSchemas: z.record(z.string(), z.unknown()),
  });
  const selectionSchema = z.object({ kind: z.literal("command"), descriptor: descriptorSchema });
  if (schema.status !== "ok") throw new Error("expected the public workflow.adopt-terminal schema descriptor");
  const descriptor = selectionSchema.parse(schema.data).descriptor;
  expect(descriptor.id).toBe("workflow.adopt-terminal");
  expect(descriptor.requirements.find((requirement) => requirement.name === "expect")?.tokenKind).toBe("revision");
  expect(descriptor.payloadSchemas.adoptionAttestation).toBeDefined();
});

test("fresh adoption operation against listed adopted revision gets the exact already-adopted refusal", async () => {
  const { root, harness } = await fixture();
  const original = { workflow: "wf-command", harness, expect: "1", operation: "already-adopted-original", reason: "adopt fixture" };
  const first = await executeCommand("workflow.adopt-terminal", original, invocation(root));
  expect(first.status).toBe("ok");
  const replay = await executeCommand("workflow.adopt-terminal", original, invocation(root));
  expect(replay.status).toBe("ok");
  if (replay.status === "ok") expect((replay.data as { replayed: boolean }).replayed).toBe(true);

  const read = await executeCommand("status.validate", {}, invocation(root));
  expect(read.status).toBe("ok");
  if (read.status !== "ok") throw new Error("expected status validate success");
  const adopted = (read.data as { terminalAdoptions: Array<{ id: string; revision: number }> }).terminalAdoptions
    .find((entry) => entry.id === "wf-command");
  expect(adopted).toBeDefined();
  const refused = await executeCommand("workflow.adopt-terminal", {
    ...original, expect: String(adopted!.revision), operation: "already-adopted-fresh-operation",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command already has a terminal-adoption record; read status validate and use the recorded result",
    "Read `mstar status validate`; the existing terminal-adoption record is already the close receipt, so no further adoption is needed.",
  );
  const after = await executeCommand("status.validate", {}, invocation(root));
  expect(after.status).toBe("ok");
  if (after.status === "ok") {
    expect((after.data as { terminalAdoptions: Array<{ id: string; revision: number }> }).terminalAdoptions)
      .toContainEqual(expect.objectContaining({ id: "wf-command", revision: adopted!.revision }));
  }
});

test("inactive-authority refusal names the supported status and store-upgrade recovery", async () => {
  const { root, harness } = await fixture(false);
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-inactive", reason: "inactive authority",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "terminal adoption requires an active execution authority",
    "Run `mstar status validate` to inspect the harness, then `mstar store upgrade --operator <name>` to import legacy execution state and activate the execution authority before retrying adoption.",
  );
});
test("a valid explicit revision reaches the engine while an explicit stale CAS is engine-rejected without mutation", async () => {
  const { root, harness } = await fixture();
  // A normal explicit positive revision is admitted by the command and reaches
  // the engine, which records the adoption on the addressed header.
  const before = await executeCommand("status.validate", {}, invocation(root));
  expect(before.status).toBe("ok");
  if (before.status === "ok") {
    expect((before.data as { terminalUnregistered: Array<{ revision: number }> }).terminalUnregistered)
      .toEqual([{ id: "wf-command", status: "stopped", revision: 1 }]);
  }
  const admitted = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "command-adopt-explicit", reason: "explicit revision",
  }, invocation(root));
  expect(admitted).toMatchObject({ status: "ok", code: "workflow.adopt-terminal.ok", exitCode: 0 });
  const afterAdoption = await executeCommand("status.validate", {}, invocation(root));
  expect(afterAdoption.status).toBe("ok");
  if (afterAdoption.status === "ok") {
    expect((afterAdoption.data as { terminalAdoptions: Array<{ id: string; revision: number }> }).terminalAdoptions)
      .toMatchObject([{ id: "wf-command", revision: 2 }]);
  }

  // A stale explicit revision is refused by the engine's CAS before any write:
  // the header and the recorded adoption are unchanged afterwards.
  const stale = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "command-adopt-stale", reason: "stale header",
  }, invocation(root));
  expect(stale).toMatchObject({ status: "refused", code: "execution.header-revision-conflict", exitCode: 1 });
  const afterStale = await executeCommand("status.validate", {}, invocation(root));
  expect(afterStale).toEqual(afterAdoption);
  await withWriter(harness, (db) => {
    expect(db.prepare("select revision from execution_workflows where workflow_id = ?").get("wf-command"))
      .toEqual({ revision: 2 });
    expect((db.prepare("select count(*) as n from execution_operations where operation_id = ?").get("command-adopt-stale") as { n: number }).n).toBe(0);
  });
});
test("registered-row refusal advertises the existing close path", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => {
    db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
      .run(JSON.stringify({
        id: "wf-command", schema_version: 1, type: "plan", status: "completed",
        started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z",
        updated_at: "2026-10-01T01:00:00.000Z",
      }), "wf-command");
    db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)")
      .run("wf-command", JSON.stringify({ id: "wf-command", type: "plan", started_at: "2026-10-01T00:00:00.000Z", dir: "workflows/wf-command" }));
    const epoch = (db.prepare("select authority_epoch from store_meta where id = 1").get() as { authority_epoch: number }).authority_epoch;
    db.prepare("insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', ?)")
      .run("wf-command", "caller-session", epoch, "2026-10-01T00:00:00.000Z");
  });
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-registered", reason: "already registered",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command is already registered; finish its lifecycle through mstar status workflow-close",
    "Run `mstar status workflow-close --workflow <id> --reason <text>` through the existing registered-workflow close path under the ACTIVE coordinator holder's binding.",
  );
  const close = await executeCommand("status.workflow-close", {
    workflow: "wf-command", harness, reason: "restating existing terminal lifecycle", operation: "registered-close",
  }, invocation(root));
  expect(close.status).toBe("ok");
});

test("ACTIVE-holder refusal publishes targets and full proof contract before a file correction and retry", async () => {
  const { root, harness } = await fixture();
  await withActiveHolder(harness, "stranded-holder");
  // Genuine preconditions are the caller identity, selected workflow, reason,
  // and — supplied to withActiveHolder above — the real holder row.
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, reason: "active holder",
  }, invocation(root));
  expect(refused).toMatchObject({ status: "refused", code: "execution.adoption-refused", exitCode: 1 });
  if (refused.status !== "refused") throw new Error("expected the ACTIVE-holder refusal");
  const details = refused.details;
  if (details === undefined || !("attestationContract" in details) || details.attestationContract === null || typeof details.attestationContract !== "object") {
    throw new Error("the first correction refusal must publish the proof contract");
  }
  // The published contract is consumed: the emitted JSON schema is converted
  // into a real validator and that validator checks the corrected file, so a
  // wrong/empty `required` or a missing document field fails the correction.
  const contractSchema = z.object({
    schema: z.record(z.string(), z.unknown()),
    constraints: z.array(z.object({ path: z.string(), rule: z.string() })).min(1),
  });
  const contract = contractSchema.parse(details.attestationContract);
  // Strip the zod transport annotation (`~standard`) so only the JSON Schema is
  // left; zod's own converter is its declared consumer, so the annotation below
  // supplies its input type rather than asserting a validated shape.
  const emittedJsonSchema: Record<string, unknown> = { ...contract.schema };
  delete emittedJsonSchema["~standard"];
  const jsonSchema = emittedJsonSchema as Parameters<typeof z.fromJSONSchema>[0];
  const emittedValidator = z.fromJSONSchema(jsonSchema);
  // The correction's stop targets come from the refusal, never a hardcoded list.
  if (!("active_holder_sessions" in details)) throw new Error("the refusal must name the addressed ACTIVE holders");
  const targets = z.array(z.string()).min(1).parse(details.active_holder_sessions);
  expect(targets).toEqual(["stranded-holder"]);
  await withWriter(harness, (db) => {
    expect(db.prepare("select state, revision from execution_sessions where session_id = ?").get("stranded-holder"))
      .toEqual({ state: "active", revision: 1 });
    expect(db.prepare("select revision from execution_workflows where workflow_id = ?").get("wf-command"))
      .toEqual({ revision: 1 });
  });

  // One proof file, built from the emitted contract and the refusal's own
  // targets; the operator/consumer facts are the genuine fixture preconditions
  // declared in writeAttestation, not facts invented here. The emitted validator
  // must reject a document missing a required field before the retry succeeds.
  const document = attestationDocument(targets);
  const { version: _omitted, ...missingRequired } = document;
  // A document missing an emitted required field must fail the emitted
  // validator, so the correction consumer cannot silently accept a broken
  // published contract.
  expect(emittedValidator.safeParse(missingRequired).success).toBe(false);
  expect(emittedValidator.safeParse(document).success).toBe(true);
  const attestation = join(root, "attestation.json");
  writeFileSync(attestation, JSON.stringify(document, null, 2));
  const applied = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, reason: "active holder", attestation,
  }, invocation(root));
  expect(applied).toMatchObject({ status: "ok", code: "workflow.adopt-terminal.ok", exitCode: 0 });
  await withWriter(harness, (db) => {
    expect(db.prepare("select state, revision from execution_sessions where session_id = ?").get("stranded-holder"))
      .toEqual({ state: "revoked", revision: 2 });
    expect(db.prepare("select revision from execution_workflows where workflow_id = ?").get("wf-command"))
      .toEqual({ revision: 2 });
    expect((db.prepare("select count(*) as n from execution_operations").get() as { n: number }).n).toBe(1);
  });
});

test("workflow adopt-terminal settles the attested ACTIVE holder through the command transport", async () => {
  const { root, harness } = await fixture();
  await withActiveHolder(harness, "stranded-holder");
  const attestation = writeAttestation(root, ["stranded-holder"]);
  const input = {
    workflow: "wf-command", harness, expect: "1", operation: "command-settle-1",
    reason: "settle the stranded holder", attestation,
  };
  const applied = await executeCommand("workflow.adopt-terminal", input, invocation(root));
  expect(applied).toMatchObject({ status: "ok", code: "workflow.adopt-terminal.ok", exitCode: 0 });
  if (applied.status !== "ok") throw new Error("expected the settled adoption");
  const receipt = applied.data as { replayed: boolean; recovery?: { outcome: string; applied: string[] } };
  expect(receipt.replayed).toBe(false);
  // The transport proof reached the real engine operation: the settled target
  // and the approving operator are on the receipt, and the row is revoked.
  expect(receipt.recovery).toMatchObject({
    outcome: "applied",
    applied: ["execution_sessions(wf-command, coordinator, stranded-holder) revoked"],
    resolvedFrom: [{ path: "attestation.operator", source: "recovery-operator (operator-authorization-fixture)" }],
  });
  const replay = await executeCommand("workflow.adopt-terminal", input, invocation(root));
  expect(replay).toMatchObject({ status: "ok" });
  expect(applied.data).not.toHaveProperty("operationRecovery");
  if (replay.status === "ok") {
    expect(replay.data).not.toHaveProperty("operationRecovery");
    const replayData = z.object({ replayed: z.boolean() }).passthrough().parse(replay.data);
    expect({ ...replayData, replayed: false }).toEqual(applied.data);
  }
  await withWriter(harness, (db) => {
    expect(db.prepare("select state, revision from execution_sessions where session_id = ?").get("stranded-holder"))
      .toEqual({ state: "revoked", revision: 2 });
    expect((db.prepare("select count(*) as n from execution_registry where workflow_id = ?").get("wf-command") as { n: number }).n).toBe(0);
    expect((db.prepare("select count(*) as n from execution_operations where operation_id = ?").get("command-settle-1") as { n: number }).n).toBe(1);
  });
});

test("the command transport refuses wrong, malformed and self-settling documents without mutation", async () => {
  const wrongHolder = await fixture();
  await withActiveHolder(wrongHolder.harness, "stranded-holder");
  const wrongProof = writeAttestation(wrongHolder.root, ["foreign-session"]);
  const wrong = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness: wrongHolder.harness, expect: "1", operation: "adopt-wrong", reason: "wrong holder",
    attestation: wrongProof,
  }, invocation(wrongHolder.root));
  expect(wrong).toMatchObject({ status: "refused", code: "execution.adoption-refused" });
  if (wrong.status !== "refused") throw new Error("expected the wrong-holder refusal");
  expect(wrong.details).toMatchObject({
    unattested_sessions: ["stranded-holder"],
    adoption_refusal: "active-session-proof-incomplete",
  });
  await withWriter(wrongHolder.harness, (db) => {
    expect(db.prepare("select state from execution_sessions where session_id = ?").get("stranded-holder"))
      .toEqual({ state: "active" });
  });

  const malformed = await fixture();
  await withActiveHolder(malformed.harness, "stranded-holder");
  const parserSchema = z.object({ parser: z.object({ cause: z.string().min(1), location: z.string().min(1).optional() }) });
  for (const [name, text] of [
    ["trailing-comma", "{\"token\":\"fixture-malformed-secret\",}"],
    ["truncated", "{\"version\":1,"],
    ["unexpected-token", "{\"version\":@}"],
  ] as const) {
    const brokenPath = join(malformed.root, `${name}.json`);
    writeFileSync(brokenPath, text);
    const unparseable = await executeCommand("workflow.adopt-terminal", {
      workflow: "wf-command", harness: malformed.harness, expect: "1", operation: `adopt-broken-${name}`, reason: "malformed",
      attestation: brokenPath,
    }, invocation(malformed.root));
    expect(unparseable).toMatchObject({ status: "refused", code: "workflow.adopt-terminal.attestation-malformed", exitCode: 1 });
    if (unparseable.status !== "refused") throw new Error("expected the malformed-document refusal");
    const parser = parserSchema.parse(unparseable.details).parser;
    // Compare against the parser's own reported interface for the SAME input,
    // independently of the production sanitizer.
    let actual = "";
    try { JSON.parse(text); } catch (error) { actual = error instanceof Error ? error.message : String(error); }
    expect(actual).not.toBe("");
    // Location is retained exactly when the runtime parser reports one, never
    // invented when it reports none.
    const actualPosition = actual.match(/\bposition\s+(\d+)\b/i)?.[1];
    const actualLineColumn = actual.match(/\bline\s+(\d+)\s+column\s+(\d+)\b/i);
    const actualLocation = actualPosition !== undefined
      ? `position ${actualPosition}`
      : actualLineColumn === null || actualLineColumn === undefined
        ? undefined
        : `line ${actualLineColumn[1]} column ${actualLineColumn[2]}`;
    expect(parser.location).toBe(actualLocation);
    // Safe parser-authored grammar (its quoted delimiters/keywords) survives the
    // sanitizer; only the source/token excerpt is removed.
    for (const grammar of actual.match(/'[^']*'/g) ?? []) expect(parser.cause).toContain(grammar);
    // No source/token/credential excerpt is echoed anywhere in the refusal.
    expect(parser.cause).not.toContain("fixture-malformed-secret");
    expect(JSON.stringify(unparseable)).not.toContain("fixture-malformed-secret");
  }
  // A relative document is caller input, not a filesystem read.
  const relative = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness: malformed.harness, expect: "1", operation: "adopt-relative", reason: "relative",
    attestation: "attestation.json",
  }, invocation(malformed.root));
  expect(relative).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });

  const selfSettling = await fixture();
  await withActiveHolder(selfSettling.harness, "caller-session");
  const selfProof = writeAttestation(selfSettling.root, ["caller-session"]);
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness: selfSettling.harness, expect: "1", operation: "adopt-self", reason: "self-settlement",
    attestation: selfProof,
  }, invocation(selfSettling.root));
  expect(refused).toMatchObject({ status: "refused", code: "execution.adoption-refused" });
  if (refused.status !== "refused") throw new Error("expected the self-settlement refusal");
  expect(refused.details).toMatchObject({
    caller_session_id: "caller-session",
    adoption_refusal: "self-settlement",
  });
  expect(refused.recovery).toContain("distinct operator identity");
  for (const probe of [malformed, selfSettling]) {
    await withWriter(probe.harness, (db) => {
      expect(db.prepare("select state from execution_sessions where session_id = ?").get(
        probe === malformed ? "stranded-holder" : "caller-session",
      )).toEqual({ state: "active" });
    });
  }
});

test("a changed proof under a committed operation id is an operation conflict, not a replay", async () => {
  const { root, harness } = await fixture();
  await withActiveHolder(harness, "stranded-holder");
  const committed = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-proof-1", reason: "settled",
    attestation: writeAttestation(root, ["stranded-holder"]),
  }, invocation(root));
  expect(committed.status).toBe("ok");
  const changed = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-proof-1", reason: "settled",
    attestation: writeAttestation(root, ["stranded-holder"], { attestedAt: "2026-10-08T09:00:00.000Z" }),
  }, invocation(root));
  expect(changed).toMatchObject({ status: "refused", code: "execution.operation-conflict" });
  await withWriter(harness, (db) => {
    expect(db.prepare("select state, revision from execution_sessions where session_id = ?").get("stranded-holder"))
      .toEqual({ state: "revoked", revision: 2 });
  });
});


test("nonterminal-header refusal routes through execution bind and normal close", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
    .run(JSON.stringify({ id: "wf-command", schema_version: 1, type: "plan", status: "running", started_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z" }), "wf-command"));
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-running", reason: "not terminal",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command is not terminal; no supported exit exists for a non-terminal header without registry membership",
    "No supported exit exists for a non-terminal header without registry membership — this is the I-000397 residual surface; capture an issue with `mstar issue add`.",
  );
  expectDeadEndMarkers(
    "No supported exit exists for a non-terminal header without registry membership — this is the I-000397 residual surface; capture an issue with `mstar issue add`.",
    true,
  );
});

test("missing terminal-reason refusal states the dead end and issue-capture route", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
    .run(JSON.stringify({ id: "wf-command", schema_version: 1, type: "plan", status: "failed", started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z" }), "wf-command"));
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-no-reason", reason: "missing provenance",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command has no recorded terminal reason in its header; no supported exit exists for a stopped/failed header missing the recorded reason",
    "No supported exit exists for a stopped/failed header missing its recorded terminal reason; capture an issue with `mstar issue add` and preserve the header.",
  );
  expectDeadEndMarkers(
    "No supported exit exists for a stopped/failed header missing its recorded terminal reason; capture an issue with `mstar issue add` and preserve the header.",
    false,
  );
});

test("missing-header refusal directs to new registration, not adoption", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => db.prepare("delete from execution_workflows where workflow_id = ?").run("wf-command"));
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-missing", reason: "header absent",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command has no terminal header to adopt; register the workflow through the supported workflow registration route",
    "The missing header cannot be adopted; create/register a new workflow through `mstar workflow register` with a valid catalog selection.",
  );
});
