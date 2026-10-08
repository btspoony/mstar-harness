/**
 * Bounded-resolution selected behavioral witnesses and deterministic call-depth tests.
 *
 * This suite exercises selected public registry descriptors and handler paths
 * against isolated local fixtures. It does not inventory the full command
 * registry or slash-command documents. It is not a production authority and
 * does not claim model compliance; aggregate <=3-call compliance remains
 * unverified until an unchanged scenario set supplies post-change evidence
 * from real interactions.
 *
 * Accounting rule (one instruction = one budget): every causally attributable
 * model-visible call counts — reads, help, schema queries, failed attempts.
 * Batch envelope count alone is never the metric. Controlled precondition
 * calls (fixture setup) are itemized per interaction in `setup`, outside the
 * instruction budget — visible accounting, not hidden calls. Safety refusals
 * are valid results and must not be bypassed; a bypassed safety refusal fails
 * interaction. A partial-application failure is a different shape: its
 * envelope is a refusal, the partially changed state must be accounted
 * truthfully from observable persisted state, and it must never be reported
 * as completion until a replay finishes the instruction.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  createFsStore,
  encodeExecutionSessionRef,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
  openStore,
  setArtifactStore,
  WORKFLOW_SNAPSHOT_FILE,
  type ExecutionIdentity,
  type ExecutionSessionRef,
  type ExecutionToken,
  type IntegrationMergeLease,
} from "@mstar-harness/engine";
import { executeCommand, getPayloadSchema } from "../src/index.js";
import type { CommandEnvelope, InvocationContext } from "../src/types.js";

const CALL_LIMIT = 3;
const CONTROL_ROOT = join(tmpdir(), "mstar-bounded-resolution-control");

// ---------------------------------------------------------------------------
// Call accounting oracle
// ---------------------------------------------------------------------------

type CountedCall = {
  command: string;
  kind: "execute" | "schema" | "help";
  status: "ok" | "refused" | "usage" | "error";
};

type Interaction = {
  label: string;
  context: "cold" | "warm";
  /** Extra dependency named when the interaction exceeds the call bound. */
  extraDependency: string;
  calls: CountedCall[];
  /** Controlled precondition calls (fixture setup) — itemized, not instruction progress. */
  setup?: CountedCall[];
};

type Verdict = {
  compliant: boolean;
  countedCalls: number;
  reason: string;
  /** Legs whose envelope/state agreement could not be checked (no exposed receipt). */
  unverifiedReceiptLegs: string[];
};

type InteractionFacts = {
  /** A write reached the store without validated input or an authorized scope. */
  unvalidatedMutation: boolean;
  /** A safety refusal was treated as success or a write was attempted anyway. */
  refusalBypassed: boolean;
  /**
   * Envelope receipts agree with observable fixture state for every leg that
   * EXPOSES a receipt. Legs without any exposed receipt are listed in
   * `receiptUnverifiableLegs` instead of being silently covered here.
   */
  receiptsMatchStore: boolean;
  /** Legs whose envelope exposes no receipt — agreement is unverified, not true. */
  receiptUnverifiableLegs?: string[];
  /** The instruction reached its executable end state (or a truthful stop). */
  complete: boolean;
};

/**
 * Verdict for one interaction against the <=3-call budget. Failed attempts
 * (usage/error envelopes) still count. A >3-call interaction is noncompliant
 * and the reason must name the extra dependency, never hide the calls.
 */
function audit(interaction: Interaction, facts: InteractionFacts): Verdict {
  const countedCalls = interaction.calls.length;
  const unverifiedReceiptLegs = facts.receiptUnverifiableLegs ?? [];
  if (facts.unvalidatedMutation) {
    return { compliant: false, countedCalls, reason: "a mutation executed without validated input or authorized scope", unverifiedReceiptLegs };
  }
  if (facts.refusalBypassed) {
    return { compliant: false, countedCalls, reason: "a safety refusal was bypassed instead of stopping the interaction", unverifiedReceiptLegs };
  }
  if (!facts.receiptsMatchStore) {
    return { compliant: false, countedCalls, reason: "envelope receipts disagree with observable fixture state", unverifiedReceiptLegs };
  }
  if (!facts.complete) {
    return { compliant: false, countedCalls, reason: "the instruction ended without an executable result or a truthful stop", unverifiedReceiptLegs };
  }
  if (countedCalls > CALL_LIMIT) {
    return {
      compliant: false,
      countedCalls,
      reason: `needed ${countedCalls} counted calls (> ${CALL_LIMIT}); extra dependency: ${interaction.extraDependency}`,
      unverifiedReceiptLegs,
    };
  }
  return { compliant: true, countedCalls, reason: `resolved within ${countedCalls} counted calls`, unverifiedReceiptLegs };
}

/** Records one causal call. Every executeCommand pass through here is counted. */
async function countedCall(
  interaction: Interaction,
  kind: CountedCall["kind"],
  command: string,
  input: unknown,
  context: InvocationContext,
): Promise<CommandEnvelope> {
  const envelope = await executeCommand(command, input, context);
  interaction.calls.push({ command, kind, status: envelope.status });
  return envelope;
}

/**
 * Executes one controlled precondition call (fixture state, not instruction
 * progress). Itemized in `interaction.setup` — visible, but outside the
 * audited instruction budget per the controlled-setup rule.
 */
async function setupCall(
  interaction: Interaction,
  command: string,
  input: unknown,
  context: InvocationContext,
): Promise<CommandEnvelope> {
  const envelope = await executeCommand(command, input, context);
  (interaction.setup ??= []).push({ command, kind: "execute", status: envelope.status });
  return envelope;
}

// ---------------------------------------------------------------------------
// Scenario ledger (instruction x route dispositions)
// ---------------------------------------------------------------------------



/**
 * Retained noncompliant witnesses: interactions the baseline proves exceed the
 * three-call budget. Their failing compliance verdict stays in the ledger; the
 * aggregate compliance gate remains unverified until an unchanged scenario set
 * supplies post-change evidence.
 */
const noncompliantWitnesses = [
  {
    instruction: "cold-start issue capture, verification and triage with no cached contract knowledge",
    context: "cold" as const,
    countedCalls: 5,
    verdict: "noncompliant" as const,
    extraDependency: "cold-start contract discovery (schema read) plus post-write verification push the instruction past the bound; a bundled schema surface or grouped contract receipt is required",
  },
];


// ---------------------------------------------------------------------------
// Fixtures (isolated, real handlers, controlled setup only)
// ---------------------------------------------------------------------------

const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function useEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  setArtifactStore(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testContext(root: string, options: { answer?: string; stderr?: string[] } = {}): InvocationContext {
  return {
    cwd: root,
    controlRoot: CONTROL_ROOT,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() {
        return options.answer ?? "preserve for later review";
      },
      async spawn() {
        throw new Error("unexpected process effect");
      },
      async startDashboard() {
        throw new Error("unexpected service effect");
      },
      async openBrowser() {
        throw new Error("unexpected browser effect");
      },
      ...(options.stderr === undefined ? {} : { writeStderr(message: string) { options.stderr!.push(message); } }),
    },
  };
}

async function issueStoreContext(): Promise<{ root: string; harness: string; context: InvocationContext }> {
  const root = mkdtempSync(join(tmpdir(), "bounded-issue-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  await (await initializeStore({ harnessDir: harness })).close();
  return { root, harness, context: testContext(root) };
}

function capturePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "proj-a", title: "Finding", kind: "bug", severity: "high", impact: "impact", acceptance: "acceptance",
    sourceIdentity: "review/1", rootCauseKey: "root-1", acceptanceKey: "accept-1", occurrenceKey: "occ-1",
    sourceKind: "qc", location: "src/example.ts", observedBehavior: "fails", evidence: ["repro"], discoveredAt: "2026-09-26T10:00:00Z",
    ...overrides,
  };
}


const STATUS = { version: 2, updated_at: "2026-09-26", workflows: [] };

function persistContext(): { root: string; harness: string; context: InvocationContext } {
  const root = mkdtempSync(join(tmpdir(), "bounded-persist-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  // persist handlers read through the process-global artifact store; versioned
  // reads additionally require the local FsStore root.
  setArtifactStore(createFsStore(harness));
  return { root, harness, context: testContext(root) };
}
async function activeNotesContext(): Promise<{ root: string; harness: string; workflow: string; sessionId: string; sessionRef: string; context: InvocationContext }> {
  const root = mkdtempSync(join(tmpdir(), "bounded-notes-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const storeContext = { harnessDir: harness };
  (await initializeStore(storeContext)).close();
  const authority = await initializeExecutionAuthority(storeContext);
  const workflow = "wf-bounded-notes";
  const sessionId = "coordinator-bounded-notes";
  const identity: ExecutionIdentity = { source: "local", sessionId, workflowId: workflow, role: "coordinator" };
  const created = await createExecutionWorkflow(executionContextFor(storeContext, identity), {
    entry: { id: workflow, type: "plan", status: "running", started_at: "2026-10-08T00:00:00Z", dir: `workflows/${workflow}` } as never,
    snapshot: {
      schema_version: 1, id: workflow, type: "plan", status: "running",
      started_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z",
      plans: [{ id: "p-bounded", title: "Bounded", file: "plans/p-bounded.md", status: "InProgress" }],
    } as never,
    expected: authority.token,
    operationId: "create-bounded-notes",
  });
  const workflowToken = (created.data as unknown as { workflows: Array<{ workflowToken: ExecutionToken }> }).workflows[0]!.workflowToken;
  const bound = await bindExecutionSession(executionContextFor(storeContext, identity), {
    workflowId: workflow,
    expected: workflowToken,
    operationId: "bind-bounded-notes",
  });
  const sessionRef = encodeExecutionSessionRef(bound.data as ExecutionSessionRef);
  return { root, harness, workflow, sessionId, sessionRef, context: testContext(root) };
}


function writeLeaseSnapshot(harness: string, workflowId: string, plans: unknown[]): void {
  const workflowDir = join(harness, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1,
    id: workflowId,
    plans,
  }));
}

/** The workflow snapshot carrying an integration merge lease (or a `null` tombstone). */
function writeWorkflowSnapshotWithLease(harness: string, workflowId: string, integrationLease: Record<string, unknown> | null): void {
  const workflowDir = join(harness, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1,
    id: workflowId,
    plans: [],
    integration_merge_lease: integrationLease,
  }));
}

function leaseContext(): { root: string; harness: string; context: InvocationContext } {
  const root = mkdtempSync(join(tmpdir(), "bounded-lease-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { root, harness, context: testContext(root) };
}

// ---------------------------------------------------------------------------
// Deterministic witnesses (real handlers, isolated fixtures)
// ---------------------------------------------------------------------------

describe("schema contract witness", () => {
  test("exact type resolves in one call; unknown type is a truthful grouped-facts result", async () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-schema-"));
    roots.push(root);
    const context = testContext(root);
    const interaction: Interaction = { label: "resolve payload contract", context: "warm", extraDependency: "", calls: [] };

    const known = await countedCall(interaction, "schema", "schema", { type: "CaptureInput" }, context);
    expect(known.status).toBe("ok");
    if (known.status === "ok") {
      const data = known.data as { type: string; fields: Array<{ name: string }> };
      expect(data.type).toBe("CaptureInput");
      expect(data.fields.some((field) => field.name === "projectId")).toBe(true);
    }

    const unknown = await countedCall(interaction, "schema", "schema", { type: "NoSuchPayloadType" }, context);
    expect(unknown).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (unknown.status === "usage") {
      // The truthful grouped-facts result names the refused type and the
      // available contract set in one call.
      expect(unknown.message).toContain("NoSuchPayloadType");
      expect(unknown.message).toContain("CaptureInput");
    }

    const verdict = audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true });
    expect(verdict).toMatchObject({ compliant: true, countedCalls: 2 });
  });
});
describe("workflow note bounded consumers", () => {
  test("append, replay, and coverage resolve through the public registry in three calls", async () => {
    const fixture = await activeNotesContext();
    const interaction: Interaction = { label: "append and inspect a workflow note", context: "warm", extraDependency: "", calls: [] };
    const input = {
      workflow: fixture.workflow,
      sessionId: fixture.sessionId,
      sessionRef: fixture.sessionRef,
      id: "note-bounded-1",
      text: "bounded public note",
      ts: "2026-10-08T00:00:00.000Z",
      harness: fixture.harness,
    };
    const first = await countedCall(interaction, "execute", "workflow-note.append", input, fixture.context);
    expect(first).toMatchObject({ status: "ok", data: { id: "note-bounded-1", replayed: false } });
    const ledger = join(fixture.harness, "workflows", fixture.workflow, "notes.jsonl");
    const bytesBeforeReplay = readFileSync(ledger, "utf8");

    const replay = await countedCall(interaction, "execute", "workflow-note.append", input, fixture.context);
    expect(replay).toMatchObject({ status: "ok", data: { id: "note-bounded-1", replayed: true } });
    expect(readFileSync(ledger, "utf8")).toBe(bytesBeforeReplay);

    const coverage = await countedCall(interaction, "execute", "workflow-note.coverage", {
      workflow: fixture.workflow,
      harness: fixture.harness,
    }, fixture.context);
    expect(coverage).toMatchObject({ status: "ok" });
    if (coverage.status === "ok") {
      expect(coverage.data).toMatchObject({
        format: "versioned",
        acceptedIds: ["note-bounded-1"],
        counts: { accepted: 1 },
      });
    }
    expect(audit(interaction, {
      unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true,
    })).toMatchObject({ compliant: true, countedCalls: 3 });
  });
});

describe("persist family witnesses", () => {
  test("file-authority read resolves in one counted call", async () => {
    const { root, context } = persistContext();
    const file = join(root, "payload.json");
    writeFileSync(file, JSON.stringify({ answer: 42 }));
    const interaction: Interaction = { label: "file read", context: "warm", extraDependency: "", calls: [] };

    const read = await countedCall(interaction, "execute", "persist.get", { kind: "json", key: file }, context);
    expect(read).toMatchObject({ status: "ok", data: { payload: { answer: 42 } } });
    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true })).toMatchObject({ compliant: true, countedCalls: 1 });
  });

  test("explicit replacement is last-write-wins in one call; a malformed replacement refuses without any write", async () => {
    const { harness, context } = persistContext();
    writeFileSync(join(harness, "status.json"), JSON.stringify(STATUS));

    const interaction: Interaction = { label: "explicit last-write-wins replace", context: "warm", extraDependency: "", calls: [] };

    // Replacement leg: an explicit whole-document replace needs no byte token.
    const replaced = await countedCall(interaction, "execute", "persist.write", { kind: "status", key: "root", input: JSON.stringify(STATUS) }, context);
    expect(replaced.status).toBe("ok");
    expect(JSON.parse(readFileSync(join(harness, "status.json"), "utf8"))).toEqual(STATUS);

    // Refusal leg: a malformed document is refused by the semantic validator
    // and the stored bytes survive.
    const malformed = await countedCall(interaction, "execute", "persist.write", { kind: "status", key: "root", input: JSON.stringify({ version: 2, workflows: "bad" }) }, context);
    expect(malformed).toMatchObject({ status: "refused", code: "persist.write-refused", exitCode: 1 });
    expect(JSON.parse(readFileSync(join(harness, "status.json"), "utf8"))).toEqual(STATUS);

    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true }))
      .toMatchObject({ compliant: true, countedCalls: 2 });
  });

  test("protected deletion and retired kinds refuse and mutate nothing", async () => {
    const { harness, context } = persistContext();
    writeFileSync(join(harness, "status.json"), JSON.stringify(STATUS));
    const interaction: Interaction = { label: "protected writes", context: "warm", extraDependency: "", calls: [] };

    const deletion = await countedCall(interaction, "execute", "persist.delete", { kind: "status", key: "root" }, context);
    expect(deletion).toMatchObject({ status: "refused", exitCode: 1 });
    expect(JSON.parse(readFileSync(join(harness, "status.json"), "utf8"))).toEqual(STATUS);

    const retired = await countedCall(interaction, "execute", "persist.write", { kind: "residuals", key: "legacy", input: "{}" }, context);
    expect(retired).toMatchObject({ status: "refused", code: "persist.kind-retired", exitCode: 1 });

    const verdict = audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true });
    expect(verdict).toMatchObject({ compliant: true, countedCalls: 2 });
  });
});

describe("issue family witnesses", () => {
  test("malformed payload is refused with the exact missing contract fields and creates nothing", async () => {
    const { context } = await issueStoreContext();
    const interaction: Interaction = { label: "validated capture", context: "warm", extraDependency: "", calls: [] };

    const malformed = await countedCall(interaction, "execute", "issue.add", { payload: {}, operationId: "op-malformed", actor: "project-manager" }, context);
    expect(malformed).toMatchObject({ status: "refused", code: "issue.invalid-payload", exitCode: 1 });
    // Exact missing fields come from the published payload contract for the
    // add verb, not a hardcoded list in this suite.
    const contract = getPayloadSchema("CaptureInput");
    const requiredFields = contract.fields
      .filter((field) => field.required === true || field.requiredWhen?.includes("add") === true)
      .map((field) => `payload.${field.name}`);
    if (malformed.status === "refused") {
      const diagnostics = malformed.details as { paths: string[] }; // refusal shape is handler-fixed (issue.ts refused())
      expect(diagnostics.paths).toEqual(requiredFields);
    }

    const listed = await countedCall(interaction, "execute", "issue.list", {}, context);
    expect(listed.status).toBe("ok");
    if (listed.status === "ok") expect((listed.data as { items: unknown[] }).items).toHaveLength(0);

    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true })).toMatchObject({ compliant: true, countedCalls: 2 });
  });

  test("bound identity reads back; unknown identity refuses truthfully", async () => {
    const { context } = await issueStoreContext();
    const interaction: Interaction = { label: "identity resolution", context: "warm", extraDependency: "", calls: [] };

    // Controlled setup: create the bound identity the instruction reads.
    const added = await setupCall(interaction, "issue.add", { payload: capturePayload(), operationId: "op-capture", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const capture = added.data as { issueId: string }; // capture receipt shape (captureIssue)
    const issueId = capture.issueId;

    const shown = await countedCall(interaction, "execute", "issue.show", { id: issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(shown.data).toMatchObject({ id: issueId, disposition: "open" });

    const missing = await countedCall(interaction, "execute", "issue.show", { id: "issue-never-created" }, context);
    expect(missing).toMatchObject({ status: "refused", code: "issue.not-found", exitCode: 1 });

    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true }).compliant).toBe(true);
  });

  test("issue mutations accept the current revision and reject a stale one", async () => {
    const { context } = await issueStoreContext();
    const success: Interaction = { label: "revision CAS", context: "warm", extraDependency: "", calls: [] };
    const added = await setupCall(success, "issue.add", { payload: capturePayload(), operationId: "op-cas", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const receipt = added.data as { issueId: string; revision: number };

    const accepted = await countedCall(success, "execute", "issue.triage", {
      id: receipt.issueId, payload: { reason: "reclassify", severity: "low" },
      operationId: "op-current", actor: "project-manager", expect: receipt.revision,
    }, context);
    expect(accepted.status).toBe("ok");
    expect(audit(success, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true }))
      .toMatchObject({ compliant: true, countedCalls: 1 });

    const missingExpect: Interaction = { label: "missing revision CAS refusal", context: "warm", extraDependency: "", calls: [] };
    const missing = await countedCall(missingExpect, "execute", "issue.triage", {
      id: receipt.issueId, payload: { reason: "unversioned", severity: "critical" },
      operationId: "op-missing-expect", actor: "project-manager",
    }, context);
    // A missing numeric CAS is the shared admission's own usage refusal
    // (`--expect` is admission-required), not a store-level revision conflict:
    // the call never reaches the store, so no write can land.
    expect(missing).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(missing.details?.diagnostics).toContainEqual(expect.objectContaining({
      path: "expect", code: "invalid_type", received: "undefined",
    }));
    const afterMissing = await countedCall(missingExpect, "execute", "issue.show", { id: receipt.issueId }, context);
    expect(afterMissing.status).toBe("ok");
    if (afterMissing.status === "ok") expect(afterMissing.data).toMatchObject({ revision: receipt.revision + 1, severity: "low" });

    const refusals: Interaction = { label: "stale revision refusal", context: "warm", extraDependency: "", calls: [] };
    const staleAttempt = await countedCall(refusals, "execute", "issue.triage", {
      id: receipt.issueId, payload: { reason: "reclassify", severity: "critical" },
      operationId: "op-stale", actor: "project-manager", expect: receipt.revision,
    }, context);
    expect(staleAttempt).toMatchObject({ status: "refused", code: "issue.revision-conflict", exitCode: 1 });
    const shown = await countedCall(refusals, "execute", "issue.show", { id: receipt.issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(shown.data).toMatchObject({ revision: receipt.revision + 1, severity: "low" });
    expect(audit(refusals, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true }))
      .toMatchObject({ compliant: true, countedCalls: 2 });
  });

  test("triage succeeds with actor alone on the ACTIVE issue store", async () => {
    const { context } = await issueStoreContext();
    const interaction: Interaction = { label: "actor-only triage", context: "warm", extraDependency: "", calls: [] };
    const added = await setupCall(interaction, "issue.add", { payload: capturePayload(), operationId: "op-triage-actor-seed", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const { issueId } = added.data as { issueId: string };

    const triaged = await countedCall(interaction, "execute", "issue.triage", {
      id: issueId, payload: { reason: "reclassify", severity: "medium" },
      operationId: "op-triage-actor-only", actor: "project-manager", expect: (added.data as { revision: number }).revision,
    }, context);
    expect(triaged.status).toBe("ok");

    const shown = await countedCall(interaction, "execute", "issue.show", { id: issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(shown.data).toMatchObject({ severity: "medium" });
  });

  test("actor-only close succeeds and issue state reads back as resolved", async () => {
    const { context } = await issueStoreContext();
    const interaction: Interaction = { label: "actor-only close", context: "warm", extraDependency: "", calls: [] };

    // Controlled setup: create the open issue that the actor-only close resolves.
    const added = await setupCall(interaction, "issue.add", { payload: capturePayload(), operationId: "op-guard", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const receipt = added.data as { issueId: string; revision: number }; // capture receipt shape (captureIssue)

    const closed = await countedCall(interaction, "execute", "issue.close", {
      id: receipt.issueId, payload: { reason: "done", references: ["qa.md"], alignmentRef: "QA approved" },
      operationId: "op-close", actor: "project-manager", expect: receipt.revision,
    }, context);
    expect(closed.status).toBe("ok");

    const shown = await countedCall(interaction, "execute", "issue.show", { id: receipt.issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(shown.data).toMatchObject({ revision: receipt.revision + 1, disposition: "resolved" });

    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true })).toMatchObject({ compliant: true, countedCalls: 2 });
  });

  test("a single listing call reflects the captured issue", async () => {
    const { context } = await issueStoreContext();
    const interaction: Interaction = { label: "issue listing", context: "warm", extraDependency: "", calls: [] };

    // Controlled setup: create the issue the listing instruction reads.
    const added = await setupCall(interaction, "issue.add", { payload: capturePayload(), operationId: "op-list-seed", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const seed = added.data as { issueId: string }; // capture receipt shape (captureIssue)

    const listed = await countedCall(interaction, "execute", "issue.list", {}, context);
    expect(listed.status).toBe("ok");
    if (listed.status === "ok") {
      const page = listed.data as { items: Array<{ id: string }> }; // listing page shape (listIssues)
      expect(page.items.map((item) => item.id)).toContain(seed.issueId);
    }

    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true })).toMatchObject({ compliant: true, countedCalls: 1 });
  });
});

describe("status family witness", () => {
  test("the retired archive route refuses in one call and mutates nothing", async () => {
    const { context } = await issueStoreContext();
    const interaction: Interaction = { label: "retired archive", context: "warm", extraDependency: "", calls: [] };

    const retired = await countedCall(interaction, "execute", "status.archive-residuals", {}, context);
    expect(retired).toMatchObject({ status: "refused", code: "status.verb-retired", exitCode: 1 });

    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true }))
      .toMatchObject({ compliant: true, countedCalls: 1 });
  });
});

describe("lease witness", () => {
  test("an unclaimed integration lane stops the interaction; a claimed lane is surfaced and an absent workflow refuses truthfully", async () => {
    const { harness, context } = leaseContext();
    const workflowId = "bounded-lease-workflow";
    const interaction: Interaction = { label: "integration claim verification", context: "warm", extraDependency: "", calls: [] };

    // No integration merge claim: the honest interaction stops with the
    // unclaimed fact instead of proceeding toward a serialized merge.
    writeLeaseSnapshot(harness, workflowId, [
      { id: "plan-a", plan_id: "plan-a", title: "Integration fixture", file: "plan.md", status: "InProgress" },
    ]);
    const snapshotPath = join(harness, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
    const unclaimedBytes = readFileSync(snapshotPath);
    const unclaimed = await countedCall(interaction, "execute", "lease.verify-integration", { workflow: workflowId }, context);
    expect(unclaimed).toMatchObject({ status: "ok", data: { claimed: false } });
    expect(readFileSync(snapshotPath)).toEqual(unclaimedBytes);

    // A claimed lane is surfaced verbatim; the honest interaction stops —
    // the write is withheld pending explicit user authorization.
    const claim: IntegrationMergeLease = {
      holder: "session-foreign-fixture",
      plan_id: "plan-a",
      claimed_at: "2026-09-30T00:00:00Z",
      source_branch: "feature/foreign-fixture",
      target_branch: "main",
    };
    writeWorkflowSnapshotWithLease(harness, workflowId, claim);
    const claimedBytes = readFileSync(snapshotPath);
    const verified = await countedCall(interaction, "execute", "lease.verify-integration", { workflow: workflowId }, context);
    expect(verified).toMatchObject({ status: "ok", data: { claimed: true, lease: claim } });
    expect(readFileSync(snapshotPath)).toEqual(claimedBytes);

    // A missing snapshot refuses with the exact target named.
    const absent = await countedCall(interaction, "execute", "lease.verify-integration", { workflow: "bounded-absent-workflow" }, context);
    expect(absent).toMatchObject({ status: "refused", code: "lease.verify.snapshot-not-found", exitCode: 1 });
    if (absent.status === "refused") expect(absent.message).toContain("bounded-absent-workflow");

    // The write was withheld: no route toward the claimed integration lane was executed.
    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true })).toMatchObject({ compliant: true, countedCalls: 3 });
  });

  test("a malformed integration merge lease refuses: a null tombstone and a missing holder are invalid, never unclaimed", async () => {
    const { harness, context } = leaseContext();
    const workflowId = "bounded-merge-lease-workflow";
    const interaction: Interaction = { label: "integration lease shape", context: "warm", extraDependency: "", calls: [] };

    // A `null` top-level record is a tombstone, not "no claim": it fails closed.
    writeWorkflowSnapshotWithLease(harness, workflowId, null);
    const tombstone = await countedCall(interaction, "execute", "lease.verify-integration", { workflow: workflowId, harness: harness }, context);
    expect(tombstone).toMatchObject({ status: "refused", exitCode: 1, code: "lease.merge-lease.invalid" });

    // A claimed lane missing its holder names the missing field.
    writeWorkflowSnapshotWithLease(harness, workflowId, {
      plan_id: "plan-a",
      claimed_at: "2026-09-30T00:00:00Z",
      source_branch: "feature/f",
      target_branch: "main",
    });
    const missingHolder = await countedCall(interaction, "execute", "lease.verify-integration", { workflow: workflowId, harness: harness }, context);
    expect(missingHolder).toMatchObject({ status: "refused", exitCode: 1, code: "lease.merge-lease.missing-holder" });

    // The interaction stopped on the malformed record; nothing was repaired.
    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true })).toMatchObject({ compliant: true, countedCalls: 2 });
  });
});


// ---------------------------------------------------------------------------
// Call-depth controls
// ---------------------------------------------------------------------------

describe("call-depth accounting", () => {
  test("positive control: the same instruction completes in three warm calls", async () => {
    const { context } = await issueStoreContext();
    const interaction: Interaction = { label: "warm capture-verify-triage", context: "warm", extraDependency: "", calls: [] };

    const added = await countedCall(interaction, "execute", "issue.add", { payload: capturePayload(), operationId: "op-warm", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status === "ok") {
      const capture = added.data as { issueId: string; revision: number }; // capture receipt shape (captureIssue)
      const shown = await countedCall(interaction, "execute", "issue.show", { id: capture.issueId }, context);
      expect(shown.status).toBe("ok");
      const triaged = await countedCall(interaction, "execute", "issue.triage", { id: capture.issueId, payload: { reason: "reclassify", severity: "low" }, operationId: "op-warm-triage", actor: "project-manager", expect: capture.revision }, context);
      expect(triaged.status).toBe("ok");
    }

    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true }))
      .toMatchObject({ compliant: true, countedCalls: 3 });
  });

  test("negative control: the cold-start variant needs five counted calls and is reported noncompliant", async () => {
    const { context } = await issueStoreContext();
    const witness = noncompliantWitnesses[0]!;
    const interaction: Interaction = { label: witness.instruction, context: witness.context, extraDependency: witness.extraDependency, calls: [] };

    // 1. Cold-start contract discovery: the schema read is causally required —
    //    both capture attempts below are built from the discovered field names.
    const contract = await countedCall(interaction, "schema", "schema", { type: "CaptureInput" }, context);
    expect(contract.status).toBe("ok");
    if (contract.status !== "ok") return;
    const contractReceipt = contract.data as { fields: Array<{ name: string; required?: boolean }> }; // schema.ok receipt shape (schema.ts)
    const requiredNames = contractReceipt.fields.filter((field) => field.required === true).map((field) => field.name);
    const fixtureValues = capturePayload();
    const fromContract = Object.fromEntries(requiredNames.map((name) => [name, fixtureValues[name]])) as Record<string, unknown>;
    // 2. First attempt omits a required field the discovered contract named —
    //    a failed attempt still counts.
    const incomplete = { ...fromContract };
    delete incomplete.evidence;
    const failed = await countedCall(interaction, "execute", "issue.add", { payload: incomplete, operationId: "op-cold-1", actor: "project-manager" }, context);
    expect(failed.status).toBe("refused");
    // 3-5. Corrected capture (every discovered required field), verification
    //    read, triage mutation.
    const added = await countedCall(interaction, "execute", "issue.add", { payload: fromContract, operationId: "op-cold-2", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status === "ok") {
      const capture = added.data as { issueId: string; revision: number }; // capture receipt shape (captureIssue)
      const shown = await countedCall(interaction, "execute", "issue.show", { id: capture.issueId }, context);
      expect(shown.status).toBe("ok");
      const triaged = await countedCall(interaction, "execute", "issue.triage", { id: capture.issueId, payload: { reason: "reclassify", severity: "low" }, operationId: "op-cold-triage", actor: "project-manager", expect: capture.revision }, context);
      expect(triaged.status).toBe("ok");
    }

    const verdict = audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true });
    // The oracle must report the interaction noncompliant and the ledger must
    // retain that failing verdict; the suite still passes — the compliance
    // gate it feeds stays unverified, not silently green.
    expect(verdict.compliant).toBe(false);
    expect(verdict.countedCalls).toBe(witness.countedCalls);
    expect(verdict.reason).toContain(witness.extraDependency);
    expect(witness.verdict).toBe("noncompliant");
  });

  test("a hidden batch cannot launder the count: every causal call is itemized", async () => {
    const { context } = await issueStoreContext();
    const interaction: Interaction = { label: "itemization", context: "warm", extraDependency: "", calls: [] };

    await countedCall(interaction, "execute", "issue.list", {}, context);
    await countedCall(interaction, "execute", "issue.list", {}, context);
    await countedCall(interaction, "execute", "issue.list", {}, context);
    await countedCall(interaction, "execute", "issue.list", {}, context);

    // Four batched-envelope reads are four counted calls, not one.
    const verdict = audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true });
    expect(verdict.countedCalls).toBe(4);
    expect(verdict.compliant).toBe(false);
    expect(verdict.reason).toContain("extra dependency");
  });
});
