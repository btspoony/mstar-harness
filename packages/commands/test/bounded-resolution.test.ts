/**
 * Bounded-resolution scenario ledger and deterministic call-depth witnesses.
 *
 * This suite is an evaluation consumer of the published command registry: it
 * inventories every canonical CLI/MCP definition and every supported
 * slash-command document with a semantic scenario disposition, then proves a
 * selected subset of routes with real handlers over isolated local fixtures.
 * It is not a production authority and does not claim model compliance; the
 * aggregate <=3-call compliance gate stays unverified until an unchanged
 * scenario set supplies post-change evidence from real interactions.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore, initializeStore, openStore, setArtifactStore, WORKFLOW_SNAPSHOT_FILE } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions, getPayloadSchema } from "../src/index.js";
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

type WitnessVerdict = "resolved" | "grouped-missing-facts" | "safety-refusal" | "partial-application-then-resolved";

type LedgerEntry =
  | { route: string; disposition: "witnessed"; witness: string; context: "cold" | "warm"; countedCalls: number; verdict: WitnessVerdict }
  | { route: string; disposition: "unverified"; reason: string };

const witnessed = (
  route: string,
  witness: string,
  context: "cold" | "warm",
  countedCalls: number,
  verdict: WitnessVerdict,
): LedgerEntry => ({ route, disposition: "witnessed", witness, context, countedCalls, verdict });

const unverified = (route: string, reason: string): LedgerEntry => ({ route, disposition: "unverified", reason });

/**
 * Canonical CLI/MCP scenario ledger. Keys are enforced against the live
 * registry enumeration at runtime — the ledger must name a semantic route for
 * every published command (witnessed or explicitly unverified) and may not
 * outlive the registry it describes.
 */
const canonicalLedger: Record<string, LedgerEntry> = {
  // status family
  "status.validate": unverified("validate a status.json corpus variant", "requires a live status corpus; no deterministic fixture in this baseline suite"),
  "status.workflow-close": unverified("close an execution workflow under a bound session ref", "requires an active execution workflow with a bound session; no in-package fixture"),
  "status.archive-residuals": witnessed("retired command refuses without mutation", "retired-refusal", "warm", 1, "safety-refusal"),
  "status.findings-cleanup": unverified("findings cleanup gate over a plan corpus", "requires seeded findings evidence; fixture deferred to the versioned scenario set"),
  "status.tech-debt": unverified("issue-store rollup read", "requires a populated issue store fixture; deferred to the versioned scenario set"),
  "status.backlog-register": unverified("register a backlog entry", "requires registered backlog state; fixture deferred"),
  "status.backlog-close": unverified("close a backlog entry", "requires registered backlog state; fixture deferred"),
  // persist family
  "persist.write": witnessed("explicit whole-document replacement is last-write-wins in one call; a malformed document is refused by the validator without any write", "explicit-replacement (replace leg 1 call; malformed refusal leg 1 call)", "warm", 2, "resolved"),
  "persist.get": witnessed("file-authority read resolves the stored document in one call", "file-authority-read", "warm", 1, "resolved"),
  "persist.list": unverified("store listing read", "same authority family as the persist.get witness; the listing route is not separately exercised"),
  "persist.delete": witnessed("protected kind deletion is refused and the document survives", "protected-deletion", "warm", 1, "safety-refusal"),
  migrate: unverified("rewrite a legacy v1 status tree in place", "destructive whole-tree rewrite; fixture deferred to the versioned scenario set"),
  // lease / coordination
  "lease.verify": witnessed("foreign-holder lease receipt stops the interaction; malformed lease and missing snapshot refuse", "foreign-holder-lease", "warm", 3, "resolved"),
  "lease.verify-integration": unverified("integration merge-lease verification", "requires a snapshot carrying a top-level integration_merge_lease; no fixture in this baseline suite"),
  "iteration.gate": unverified("evaluate a workflow phase gate", "requires an active workflow iteration; no in-package fixture"),
  "iteration.push-cadence": unverified("probe push cadence state", "requires workflow history state; no in-package fixture"),
  "iteration.register": unverified("register an iteration workflow", "requires control-root write authority; no in-package fixture"),
  // plan family
  "plan.bind": unverified("bind a plan file to a workflow", "requires coordinator session authority; no in-package fixture"),
  "plan.show": unverified("read a registered plan snapshot", "requires a registered plan fixture; deferred to the versioned scenario set"),
  "plan.prepare": unverified("write a locked prepare bundle", "requires a bound plan and coordinator authority; no in-package fixture"),
  "plan.progress": unverified("advance plan progress", "requires a bound plan and coordinator authority; no in-package fixture"),
  "plan.issue-add": unverified("add a plan register issue", "requires plan register authority; no in-package fixture"),
  "plan.issue-close": unverified("close a plan register issue", "requires plan register authority; no in-package fixture"),
  "plan.handoff": unverified("record a plan handoff", "requires accepted plan state; no in-package fixture"),
  "plan.accept": unverified("accept a prepared plan", "requires coordinator authority; no in-package fixture"),
  "plan.return": unverified("return a plan for rework", "requires coordinator authority; no in-package fixture"),
  "plan.integration-start": unverified("open the integration lane for a plan", "requires integration worktree state; no in-package fixture"),
  "plan.integration-accept": unverified("accept the integration lane outcome", "requires integration worktree state; no in-package fixture"),
  "plan.complete": unverified("complete plan delivery", "requires sealed prepare and integration evidence; no in-package fixture"),
  "plan.repair-delivery-source": unverified("repair delivery source metadata", "requires a registered plan; no in-package fixture"),
  "plan.reconcile": unverified("reconcile plan state with snapshots", "requires workflow state; no in-package fixture"),
  "plan.release": unverified("release the caller's own execution claim", "requires an active bound plan claim; no in-package fixture"),
  "plan.residual-add": unverified("append a residual register entry", "requires a project register; no in-package fixture"),
  "plan.residual-close": unverified("close a residual register entry", "requires a project register; no in-package fixture"),
  // session family
  "session.run": unverified("spawn a real host session", "process effect against real hosts; never deterministic in-process"),
  "session.recover": unverified("recover an interrupted host session", "requires an interrupted session artifact; no in-package fixture"),
  // workflow family
  "workflow.register": unverified("register a workflow", "requires control-root write authority; no in-package fixture"),
  "workflow.evidence": unverified("append workflow evidence", "requires an active workflow ledger; no in-package fixture"),
  "workflow.show-prepare": unverified("read a sealed prepare bundle", "requires a sealed prepare artifact; no in-package fixture"),
  "workflow.amend-prepare": unverified("amend a sealed prepare bundle", "requires a sealed prepare artifact and coordinator authority; no in-package fixture"),
  "workflow.recover-coordinator": unverified("recover a crashed coordinator", "requires a crashed coordinator session; no in-package fixture"),
  "workflow.phase": unverified("advance a workflow phase", "requires coordinator session authority; no in-package fixture"),
  "workflow.lifecycle": unverified("drive the workflow lifecycle", "requires coordinator session authority; no in-package fixture"),
  "workflow.execution-policy": unverified("set workflow execution policy", "requires coordinator session authority; no in-package fixture"),
  "workflow.integration-worktree": unverified("configure the integration worktree", "requires coordinator session authority; no in-package fixture"),
  // issue family
  "issue.add": witnessed("malformed capture is refused with the exact missing contract fields; the listing leg verifies nothing was created", "issue-capture (malformed refusal + no-mutation listing leg, 2 calls)", "warm", 2, "grouped-missing-facts"),
  "issue.list": witnessed("a single store page read reflects the controlled setup capture", "issue-list (1 call after a controlled setup capture)", "warm", 1, "resolved"),
  "issue.show": witnessed("bound identity reads back; unknown identity refuses truthfully", "issue-identity (2 instruction calls after a controlled setup capture)", "warm", 2, "grouped-missing-facts"),
  "issue.occurrence": unverified("append an occurrence under mutation scope", "mutation scope and authorization matrix not exercised in this baseline suite"),
  "issue.triage": witnessed("current revision accepted and stale revision refused with no state change", "issue-cas (stale refusal + readback, 2 calls after a controlled setup capture)", "warm", 2, "safety-refusal"),
  "issue.close": witnessed("actor-only terminal disposition succeeds and readback verifies the resolved issue", "issue-disposition-guard (successful close + readback, 2 calls after a controlled setup capture)", "warm", 2, "resolved"),
  "issue.waive": unverified("waive an issue", "terminal disposition behavior is exercised by actor-only close but this verb has no separate fixture"),
  "issue.duplicate": unverified("mark an issue duplicate", "terminal disposition behavior is exercised by actor-only close but this verb has no separate fixture"),
  "issue.supersede": unverified("supersede an issue", "actor-only supersede is exercised in the CLI acceptance test, not this witness suite"),
  "issue.link": unverified("record a plan or iteration provenance label", "actor-only link is exercised in the CLI acceptance test, not this witness suite"),
  "issue.export": unverified("export issue records", "requires a populated issue store fixture; deferred to the versioned scenario set"),
  // milestone family
  "milestone.add": unverified("add a milestone", "requires a populated milestone store; no in-package fixture"),
  "milestone.update": unverified("update a milestone", "requires a populated milestone store; no in-package fixture"),
  "milestone.assign": unverified("assign a milestone", "requires a populated milestone store; no in-package fixture"),
  "milestone.list": unverified("list milestones", "requires a populated milestone store; no in-package fixture"),
  "milestone.status": unverified("milestone rollup read", "requires a populated milestone store; no in-package fixture"),
  // catalog / roadmap families
  "catalog.discover": unverified("discover catalog candidates", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "catalog.import": unverified("import a catalog corpus", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "catalog.register": unverified("register a catalog entry", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "catalog.update": unverified("update a catalog entry", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "catalog.link": unverified("link catalog entries", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "catalog.list": unverified("list catalog entries", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "catalog.purge-registration": unverified("purge a producer-written invalid registration snapshot", "identity-guarded destructive verb; fail-first/round-trip/isolation coverage lives in catalog-registration.test.ts"),
  "catalog.purge-registration": unverified("purge a producer-written invalid registration snapshot", "identity-guarded destructive verb; fail-first/round-trip/isolation coverage lives in catalog-registration.test.ts"),
  "catalog.show": unverified("show a catalog entry", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "catalog.export": unverified("export the catalog", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "catalog.reconcile": unverified("reconcile catalog with sources", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "roadmap.import": unverified("import a roadmap corpus", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "roadmap.replace": unverified("replace roadmap content", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "roadmap.show": unverified("show roadmap content", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  "roadmap.export": unverified("export the roadmap", "hybrid file/store authority; fixture deferred to the versioned scenario set"),
  // store family
  "store.init": unverified("initialize an empty workspace store", "requires an empty workspace fixture; the legacy-state refusal family is covered by the store.upgrade path"),
  "store.upgrade": unverified("one-command static import of legacy execution state", "covered by packages/commands/src/families/store.test.ts"),
  "store.migrate": unverified("plan or apply a catalog migration", "requires manifests and catalog fixtures; independent of execution upgrade"),
  "store.backup": unverified("back up the store", "requires an initialized store fixture; deferred to the versioned scenario set"),
  "store.activate": unverified("activate a catalog migration", "requires an applied catalog manifest and attestation; no in-package fixture"),
  "store.retire": unverified("retire catalog migration sources", "requires an activated catalog migration; no in-package fixture"),
  "store.execution.restore-preview": unverified("preview restoring a plain store backup", "requires a standalone store backup fixture; covered in store-execution.test.ts"),
  "store.execution.restore": unverified("restore from a plain store backup", "requires a standalone store backup and operator authorization; covered in store-execution.test.ts"),
  "store.execution.export": unverified("export live execution state", "reporting utility over live state; covered in store-execution.test.ts"),
  // sdd family
  "sdd.workspace": unverified("bootstrap an SDD workspace", "requires plan/iteration artifacts; no in-package fixture"),
  "sdd.task-brief": unverified("emit a task brief", "requires SDD workspace state; no in-package fixture"),
  "sdd.review-package": unverified("assemble a review package", "spawns packaging process effects; not deterministic in-process"),
  "sdd.check-context": unverified("check dispatch context", "requires SDD artifacts; no in-package fixture"),
  "sdd.evidence.capture": unverified("capture SDD evidence", "spawns process effects; not deterministic in-process"),
  "sdd.evidence.verify": unverified("verify SDD evidence", "requires captured evidence artifacts; no in-package fixture"),
  "sdd.exec": unverified("execute an SDD script", "process effect; not deterministic in-process"),
  // audit family
  "audit.scaffold": unverified("scaffold an audit workspace", "requires an audit corpus; fixture deferred to the versioned scenario set"),
  "audit.promote": unverified("promote audit findings", "requires an audit corpus; fixture deferred to the versioned scenario set"),
  "audit.secret-scan": unverified("scan a corpus for secrets", "spawns external scanners (process effect); not deterministic in-process"),
  "audit.supply-chain": unverified("evaluate the supply chain gate", "requires lockfile corpus; no in-package fixture"),
  // validation gates
  "dispatch.validate": unverified("validate dispatch role bindings", "requires SDD artifacts; no in-package fixture"),
  "worktree.check": unverified("check worktree state", "spawns git (process effect); not deterministic in-process"),
  "worktree.qc-alignment": unverified("check QC alignment", "requires QC report artifacts; no in-package fixture"),
  "worktree.cleanup": unverified("remove merged worktrees", "removes real git worktrees (process effect); never fixture-backed in-process"),
  "review.seats": unverified("read the QC seat registry", "requires QC seat artifacts; no in-package fixture"),
  lint: unverified("lint a file corpus", "requires a lintable target file; fixture deferred to the versioned scenario set"),
  "design-md.validate": unverified("validate DESIGN.md tokens", "requires a design corpus; no in-package fixture"),
  "compound.validate": unverified("validate a compound report", "requires a report corpus; no in-package fixture"),
  "skill.lint": unverified("lint a SKILL.md corpus", "requires a skill corpus; no in-package fixture"),
  "roles.validate": unverified("validate role presets", "requires role preset artifacts; no in-package fixture"),
  "qc.validate-report": unverified("validate a QC report", "requires a QC report corpus; no in-package fixture"),
  // pr-review family
  "pr-review.tally": unverified("tally review seats", "requires a review report corpus; no in-package fixture"),
  "pr-review.report-path": unverified("resolve the review report path", "requires review sidecar state; no in-package fixture"),
  "pr-review.validate-report": unverified("validate a review report", "requires a review report corpus; no in-package fixture"),
  "pr-review.post": unverified("post a review", "requires a real PR service and browser effects; external authorization absent"),
  "pr-review.worktree-cleanup": unverified("remove a review worktree", "real git worktree process effect; foreign-branch guard not exercised in-process"),
  "pr-review.size": unverified("size a review diff", "spawns git diff (process effect); not deterministic in-process"),
  "pr-review.seat-prompt": unverified("render a seat prompt", "requires the seat registry; no in-package fixture"),
  "pr-review.budget": unverified("read review budget state", "requires review state; no in-package fixture"),
  "pr-review.worktree-setup": unverified("create a review worktree", "creates real git worktrees (process effect); not deterministic in-process"),
  // external-service and host families
  "judgment.review-advice": unverified("request judgment advice", "requires an external judgment provider over stdin/service; external authorization absent"),
  dashboard: unverified("start the dashboard service", "starts a long-lived HTTP service; not deterministic in-process"),
  "harness.scaffold": unverified("scaffold a consumer host tree", "writes into a host tree; destructive fixture deferred to the versioned scenario set"),
  doctor: unverified("read host health", "host-environment dependent read; result depends on the invoking machine"),
  "plugin.validate": unverified("validate a plugin manifest", "requires a plugin tree corpus; no in-package fixture"),
  "path.resolve": unverified("resolve harness paths", "host-environment dependent read; result depends on the invoking machine"),
  "host.detect": unverified("detect the installed host", "host-environment dependent read; result depends on the invoking machine"),
  "host.skill-root": unverified("resolve the host skill root", "host-environment dependent read; result depends on the invoking machine"),
  schema: witnessed("resolve one payload contract by exact type name; unknown type is a truthful grouped-facts result", "schema-contract", "warm", 2, "grouped-missing-facts"),
  report: unverified("validate a harness report", "requires a report corpus; no in-package fixture"),
};

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
// Slash-command document ledger
// ---------------------------------------------------------------------------

const commandsDir = join(import.meta.dir, "..", "..", "..", "commands");

/**
 * Slash-command intentions are inventoried from the supported command
 * documents, independently of the CLI registry. These orchestrate live host
 * sessions and real repositories, so every entry is currently an explicit gap
 * rather than a silent exclusion; the versioned scenario set owns their
 * behavioral oracles.
 */
const slashCommandLedger: Record<string, LedgerEntry> = {
  "iteration-start": unverified("register and open an iteration against a live control root", "orchestrates host session bootstrap; cold-start reads are causally loaded and not deterministic in-process"),
  "iteration-drive": unverified("drive a live iteration across phases", "requires coordinator session authority over a live workflow"),
  "iteration-loop": unverified("run the long-form iteration loop", "requires coordinator session authority over a live workflow"),
  "amazing-test-audit": unverified("orchestrate an audit across a real worktree", "requires the repository under audit and QC artifacts"),
  "codebase-audit": unverified("run a read-only audit sweep", "requires the repository under audit"),
  "amazing-e2e-check": unverified("run end-to-end checks", "requires installed deployments and real devices/browsers"),
  "amazing-pr-review": unverified("orchestrate multi-seat PR review", "requires real git worktrees and live PR state"),
};

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


function writeLeaseSnapshot(harness: string, workflowId: string, plans: unknown[]): void {
  const workflowDir = join(harness, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1,
    id: workflowId,
    plans,
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
// Inventory tests
// ---------------------------------------------------------------------------

describe("bounded-resolution canonical ledger", () => {
  test("every published definition carries a semantic scenario disposition, and no entry outlives the registry", () => {
    const definitions = getCommandDefinitions();
    for (const definition of definitions) {
      const entry = canonicalLedger[definition.id];
      // The ledger is enforced against the live enumeration: a published
      // command without a disposition fails here, not silently.
      if (entry === undefined) throw new Error(`missing ledger entry for published command ${definition.id}`);
      if (entry.disposition === "witnessed") {
        expect(entry.route.length).toBeGreaterThan(0);
        expect(entry.witness.length).toBeGreaterThan(0);
        expect(entry.countedCalls).toBeGreaterThan(0);
      } else {
        expect(entry.reason.length).toBeGreaterThan(0);
        expect(entry.reason).not.toEqual(definition.id);
      }
    }
    const published = new Set(definitions.map((definition) => definition.id));
    for (const id of Object.keys(canonicalLedger)) {
      expect(published.has(id)).toBe(true);
    }
  });
});

describe("bounded-resolution slash-command document ledger", () => {
  test("every supported command document has an explicit disposition, and every entry names a real document", () => {
    const documents = readdirSync(commandsDir).filter((name) => name.endsWith(".md")).map((name) => name.replace(/\.md$/, ""));
    for (const document of documents) {
      const entry = slashCommandLedger[document];
      if (entry === undefined) throw new Error(`missing slash-command disposition for ${document}.md`);
      expect(entry.route.length).toBeGreaterThan(0);
      if (entry.disposition === "witnessed") expect(entry.witness.length).toBeGreaterThan(0);
      else expect(entry.reason.length).toBeGreaterThan(0);
    }
    for (const document of Object.keys(slashCommandLedger)) {
      expect(documents).toContain(document);
    }
  });
});

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
    expect(missing).toMatchObject({ status: "refused", code: "issue.revision-conflict", exitCode: 1 });
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
  test("a foreign-holder receipt stops the interaction; malformed leases and missing snapshots refuse truthfully", async () => {
    const { harness, context } = leaseContext();
    const workflowId = "bounded-lease-workflow";
    const foreignLease = {
      holder: "session-foreign-fixture",
      claimed_at: "2026-09-30T00:00:00Z",
      worktree_path: join(harness, "foreign-worktree"),
      working_branch: "feature/foreign-fixture",
    };
    writeLeaseSnapshot(harness, workflowId, [
      { id: "plan-a", plan_id: "plan-a", title: "Lease fixture", file: "plan.md", status: "InProgress", execution_lease: foreignLease },
    ]);
    const interaction: Interaction = { label: "lease verification", context: "warm", extraDependency: "", calls: [] };

    // The foreign holder is surfaced verbatim; the honest interaction stops —
    // the write is withheld pending explicit user authorization.
    const verified = await countedCall(interaction, "execute", "lease.verify", { workflow: workflowId, plan: "plan-a" }, context);
    expect(verified.status).toBe("ok");
    if (verified.status === "ok") {
      const leaseReceipt = verified.data as { lease: { holder: string } }; // verify receipt echoes the stored lease
      expect(leaseReceipt.lease.holder).toBe("session-foreign-fixture");
    }

    // A malformed lease refuses with its violations instead of passing.
    writeLeaseSnapshot(harness, workflowId, [
      { id: "plan-a", plan_id: "plan-a", title: "Lease fixture", file: "plan.md", status: "InProgress", execution_lease: { claimed_at: "2026-09-30T00:00:00Z" } },
    ]);
    const malformed = await countedCall(interaction, "execute", "lease.verify", { workflow: workflowId, plan: "plan-a" }, context);
    expect(malformed).toMatchObject({ status: "refused", exitCode: 1 });

    // A missing snapshot refuses with the exact target named.
    const absent = await countedCall(interaction, "execute", "lease.verify", { workflow: "bounded-absent-workflow" }, context);
    expect(absent).toMatchObject({ status: "refused", code: "lease.verify.snapshot-not-found", exitCode: 1 });
    if (absent.status === "refused") expect(absent.message).toContain("bounded-absent-workflow");

    // The write was withheld: no route toward the leased plan was executed.
    expect(audit(interaction, { unvalidatedMutation: false, refusalBypassed: false, receiptsMatchStore: true, complete: true })).toMatchObject({ compliant: true, countedCalls: 3 });
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
