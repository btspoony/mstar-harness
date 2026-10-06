/**
 * execution-read.test.ts — S3: the omp provider surfaces read the EXECUTION
 * authority, or refuse not-ready (primary spec §§4.3/5/9).
 *
 * Run with
 * `bun test packages/omp/test/execution-read.test.ts --test-name-pattern 'execution-omp-read'`.
 *
 * Every case runs the REAL readiness contract and extension modules against a
 * REAL `node:sqlite` store in a per-test temporary Git workspace: the engine's
 * own producers (`initializeStore` → `initializeExecutionAuthority` →
 * `registerCatalogEntity` → `createExecutionWorkflow`) build the authority, and
 * the fixtures then plant LEFTOVER root/snapshot JSON at the exact paths the
 * retired file route used to read. That leftover is the discriminator — a
 * surface that answered from the file route could not produce the assertions
 * below, because the file and the authority disagree on every field asserted:
 *
 * - the phase2 observation (2b) adopts the DB coordinator binding when the
 *   authority is ACTIVE — no envelope or snapshot is opened on that route — and
 *   keeps the file route pre-activation, where it adopts the workflow's OWN
 *   recorded coordinator instead of a caller-supplied path. A legacy binding
 *   record on an ACTIVE root still refuses `execution.consumer-not-ready`.
 * - the model-handoff readiness contract (E1 binding / E2 checkpoint) refuses
 *   not-ready before opening the root register, the snapshot or the coordinator
 *   envelope — proven against the SAME fixture whose legacy artifacts would
 *   otherwise decide (E1 would answer `already-bound`, E2 would open them).
 * - the model-handoff START path asks the route before it classifies: on an
 *   ACTIVE root it answers from the DB workflow/coordinator view (the handoff
 *   arms from the adopted active binding) for the very workflow the retired
 *   register names, and neither the register nor the leftover snapshot is
 *   consulted for that decision.
 *
 * No OMP installation, no host launch, no GUI: the surfaces are driven directly
 * through their real modules.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  initializeExecutionAuthority,
  initializeStore,
  readExecutionAuthority,
  registerCatalogEntity,
} from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext, ExecutionSessionRef } from "@mstar-harness/engine";
import { inspectPhase1Readiness, reserveHandoffBinding } from "../src/model-handoff-readiness";
import type { HandoffBinding, Phase1CompletionInput } from "../src/model-handoff-readiness";
import { HANDOFF_CUSTOM_TYPE, handoffSeams, default as modelHandoff } from "../src/extensions/model-handoff";
import {
  PHASE2_ADVISORY_CUSTOM_TYPE,
  PHASE2_CUSTOM_TYPE,
  PHASE2_NOTICE_CUSTOM_TYPE,
  PHASE2_PHASE,
  default as phase2Orchestration,
  derivePhase2State,
} from "../src/extensions/phase2-orchestration";

const WORKFLOW_ID = "wf-omp-read";
const PLAN_ID = "20260000-omp-plan-a1";
const SESSION_ID = "omp-s3-session-0001";
const TS = "2026-09-21T00:00:00.000Z";

/** The leftover `status.json`: document-VALID, and it names ZERO workflows — a
 * surface that answered from the file route would report zero. */
const LEFTOVER_STATUS = JSON.stringify({ version: 2, updated_at: "2026-01-01", workflows: [] });

/** The leftover snapshot: names a plan the authority does not have, carries an
 * execution lease AND a merge lease the authority does not hold. */
const LEFTOVER_SNAPSHOT = JSON.stringify({
  schema_version: 1,
  id: WORKFLOW_ID,
  type: "plan",
  status: "running",
  started_at: "2026-01-01",
  updated_at: "2026-01-01",
  plans: [
    {
      id: "plan-leftover",
      title: "leftover",
      file: "plans/plan-leftover.md",
      status: "Todo",
      metadata: {
        worktree_path: "/tmp/leftover",
        working_branch: "feature/leftover",
      },
    },
  ],
  integration_merge_lease: {
    holder: "leftover-holder",
    claimed_at: "2026-01-01",
    plan_id: "plan-leftover",
    source_branch: "feature/leftover",
    target_branch: "main",
  },
});

const COMPASS = ["---", `iteration_id: ${WORKFLOW_ID}`, "---", "", "leftover compass", ""].join("\n");

const HARNESS_ENV = process.env.MSTAR_HARNESS_DIR;
const roots: string[] = [];

beforeAll(() => {
  // The module resolves the harness through the engine's documented
  // precedence; an operator-set override must not decide this fixture's root.
  delete process.env.MSTAR_HARNESS_DIR;
});

afterAll(() => {
  if (HARNESS_ENV !== undefined) process.env.MSTAR_HARNESS_DIR = HARNESS_ENV;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ *
 * Fixture: a real Git main checkout whose `.mstar` carries an ACTIVE
 * execution authority plus the retired file evidence it replaced.
 * ------------------------------------------------------------------------ */

interface Fixture {
  /** The temp root; `main` is its only working tree. */
  root: string;
  /** The canonical Git main checkout (== the process control root). */
  main: string;
  harness: string;
  snapshotPath: string;
  compassPath: string;
  storeDb: string;
}

function git(args: readonly string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

/**
 * A disposable repository with one empty commit, a matching `.mstar` layout
 * (`status.json` + `workflows/` + `projects/_default/`) and the canonical
 * paths the tools resolve. The harness starts EMPTY of execution sources
 * (primary spec §3: the initializer refuses a harness that still holds them),
 * so the leftover evidence is planted by the caller after activation.
 */
function makeFixture(label: string): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `omp-s3-${label}-`)));
  roots.push(root);
  const main = join(root, "main");
  mkdirSync(main, { recursive: true });
  git(["init", "-q", "-b", "main"], main);
  git(
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "init"],
    main,
  );
  const harness = join(main, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  return {
    root,
    main,
    harness,
    snapshotPath: join(harness, "workflows", WORKFLOW_ID, "snapshot.json"),
    compassPath: join(main, "delivery-compass.md"),
    storeDb: join(harness, "store.db"),
  };
}

/** The leftover file evidence at the exact paths the file route reads. */
function plantLeftoverEvidence(fixture: Fixture, status: string = LEFTOVER_STATUS): void {
  writeFileSync(join(fixture.harness, "status.json"), status);
  mkdirSync(join(fixture.harness, "workflows", WORKFLOW_ID), { recursive: true });
  writeFileSync(fixture.snapshotPath, LEFTOVER_SNAPSHOT);
  writeFileSync(fixture.compassPath, COMPASS);
}

/**
 * REAL ACTIVE execution authority: `initializeStore` + the empty-execution
 * initializer + one registered plan + one created workflow holding it, plus the
 * coordinator session bound through the DB verb under the SAME native session id
 * the phase2 observation uses (a host session observes only its own binding).
 *
 * `lifecycleType` defaults to `"plan"` — the lifecycle every phase2 case in this
 * file seeds. The model-handoff start case seeds the SAME authority as an
 * `"iteration"`, the only lifecycle a model handoff can target, so that the start
 * path is proved to answer from the DB rather than from the retired register.
 */
function seedActiveAuthority(fixture: Fixture, lifecycleType?: "plan" | "iteration"): Promise<ExecutionSessionRef>;
async function seedActiveAuthority(
  fixture: Fixture,
  lifecycleType: "plan" | "iteration" = "plan",
): Promise<ExecutionSessionRef | null> {
  const handle = await initializeStore({ harnessDir: fixture.harness });
  handle.close();
  const initialized = await initializeExecutionAuthority({ harnessDir: fixture.harness });
  await registerCatalogEntity(
    { harnessDir: fixture.harness },
    {
      kind: "plan",
      id: PLAN_ID,
      title: `${PLAN_ID} title`,
      rootKind: "plans",
      relativePath: `plans/${PLAN_ID}.md`,
    },
    { operationId: `register-${PLAN_ID}`, actor: "execution-read.test" },
  );
  const context: ExecutionContext = {
    harnessDir: fixture.harness,
    caller: { sessionId: SESSION_ID, role: "coordinator", workflowId: WORKFLOW_ID } satisfies ExecutionCaller,
  };
  await createExecutionWorkflow(context, {
    entry: { id: WORKFLOW_ID, type: lifecycleType, started_at: TS, dir: `workflows/${WORKFLOW_ID}` },
    snapshot: {
      schema_version: 1,
      id: WORKFLOW_ID,
      type: lifecycleType,
      status: "running",
      phase: PHASE2_PHASE,
      started_at: TS,
      updated_at: TS,
      plans: [{ id: PLAN_ID, title: `${PLAN_ID} title`, file: `plans/${PLAN_ID}.md`, status: "Todo" }],
      delivery_kind: "development",
      branch: { source: `feature/${WORKFLOW_ID}`, target: "main" },
    } as never,
    // Creation is a ROOT-scoped CAS: its receipt token is a root token, so the
    // workflow-scoped bind reads the WORKFLOW token from the authority instead.
    expected: initialized.token,
    operationId: `create-${WORKFLOW_ID}`,
  });
  const workflowToken = (await readExecutionAuthority({ harnessDir: fixture.harness }, { workflowId: WORKFLOW_ID })).token;
  const bound = await bindExecutionSession(context, {
    workflowId: WORKFLOW_ID,
    role: "coordinator",
    expected: workflowToken,
    operationId: `bind-${SESSION_ID}`,
  });
  return bound.data;
}

/* ------------------------------------------------------------------------ *
 * execution-omp-readiness — the credential-dependent consumers
 * ------------------------------------------------------------------------ */

describe("execution-omp-readiness — file-credential consumers refuse not-ready under an ACTIVE authority (S3)", () => {
  const bindingInput = {
    workflowId: WORKFLOW_ID,
    entry: "iteration-start",
    intent: "new-iteration",
    authority: "coordinator",
  } as const;

  test("reserveHandoffBinding refuses the file binding before it reads the register or the snapshot", async () => {
    const fixture = makeFixture("e1-active");
    await seedActiveAuthority(fixture);
    plantLeftoverEvidence(fixture);

    const result = await reserveHandoffBinding(bindingInput, { sessionId: SESSION_ID, cwd: fixture.main, taskSession: false }, "reserve");

    // Without the authority gate this fixture would answer `already-bound` (the
    // leftover snapshot sits at the derived path) — i.e. the file route, not the
    // authority, would have decided.
    if (result.ok) throw new Error("the file binding must refuse under an ACTIVE execution authority");
    expect(result.code).toBe("execution.consumer-not-ready");
    expect(result.message).toContain("ACTIVE");
  });

  test("inspectPhase1Readiness refuses not-ready instead of checking the retired artifacts", async () => {
    const fixture = makeFixture("e2-active");
    await seedActiveAuthority(fixture);
    plantLeftoverEvidence(fixture);
    const binding: HandoffBinding = {
      sessionId: SESSION_ID,
      workflowId: WORKFLOW_ID,
      controlRoot: fixture.main,
      harnessRoot: fixture.harness,
      snapshotPath: fixture.snapshotPath,
      compassPath: fixture.compassPath,
    };

    const readiness = await inspectPhase1Readiness(binding, completionInput(fixture));

    if (readiness.ready) throw new Error("the checkpoint must refuse under an ACTIVE execution authority");
    expect([...readiness.codes]).toEqual(["execution.consumer-not-ready"]);
  });

  test("a harness with NO store keeps the unchanged file binding (E1 reserves)", async () => {
    const fixture = makeFixture("e1-legacy");

    const result = await reserveHandoffBinding(bindingInput, { sessionId: SESSION_ID, cwd: fixture.main, taskSession: false }, "reserve");

    if (!result.ok) throw new Error(`the pre-activation binding must reserve: ${result.code} ${result.message}`);
    expect(result.binding.workflowId).toBe(WORKFLOW_ID);
    expect(result.binding.harnessRoot).toBe(fixture.harness);
    expect(result.binding.snapshotPath).toBe(fixture.snapshotPath);
  });
});

/** A completion assertion shaped as E2's frozen input. The E1/E2 not-ready gate
 * fires before any of it is consumed, so the references stay inert fixtures. */
function completionInput(fixture: Fixture): Phase1CompletionInput {
  const receipt = (role: "product-manager" | "architect" | "writing-specialist") => ({
    role,
    agentId: `${role}-1`,
    resultRef: `agent://${role}-1`,
    reportPath: join(fixture.harness, "reports", `${role}.md`),
  });
  return {
    workflowId: WORKFLOW_ID,
    coordinatorSessionPath: join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `${SESSION_ID}.json`),
    mainWorktreeBranch: "main",
    reviews: [receipt("product-manager"), receipt("architect"), receipt("writing-specialist")],
    plans: [{ planId: PLAN_ID, planPath: join(fixture.main, "plans", `${PLAN_ID}.md`), prepareEvidencePath: join(fixture.main, "plans", `${PLAN_ID}.prepare.md`) }],
  };
}

/* ------------------------------------------------------------------------ *
 * execution-omp-read-phase2 — the phase2 observation extension (plan S3)
 * ------------------------------------------------------------------------ */

const COORDINATOR_SESSION_ID = "engine-coordinator-0001";

/** The retired root register as the file route left it: it NAMES this workflow,
 * which is exactly what the start path's structural classifier reads before E1.
 * The row mirrors the planted snapshot field for field, so the document is
 * VALID — an invalid register would classify as `reserve` for the wrong reason. */
const PHASE2_LEFTOVER_STATUS = JSON.stringify({
  version: 2,
  updated_at: "2026-01-01",
  workflows: [{ id: WORKFLOW_ID, status: "running", type: "iteration", started_at: TS, dir: `workflows/${WORKFLOW_ID}` }],
});

/** A disposable directory with no Git work tree and no harness (a caller checkout
 * that resolves no control harness at all). */
function scratchDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `omp-s3-${label}-`)));
  roots.push(dir);
  return dir;
}

/**
 * The retired file evidence the phase2 observation consumes: the coordinator
 * ENVELOPE (a file session credential), the snapshot that binds it, and the root
 * register. Returns the envelope path.
 */
function plantPhase2Evidence(fixture: Fixture): string {
  const workflowDir = join(fixture.harness, "workflows", WORKFLOW_ID);
  const envelopePath = join(workflowDir, "sessions", `coordinator-${COORDINATOR_SESSION_ID}.json`);
  writeFileSync(join(fixture.harness, "status.json"), PHASE2_LEFTOVER_STATUS);
  mkdirSync(join(workflowDir, "sessions"), { recursive: true });
  writeFileSync(
    envelopePath,
    JSON.stringify({
      schema_version: 1,
      role: "coordinator",
      session_id: COORDINATOR_SESSION_ID,
      workflow_id: WORKFLOW_ID,
      harness_root: fixture.harness,
    }),
  );
  writeFileSync(
    fixture.snapshotPath,
    JSON.stringify({
      schema_version: 1,
      id: WORKFLOW_ID,
      type: "iteration",
      status: "running",
      started_at: TS,
      updated_at: TS,
      phase: "phase-2-execute",
      plans: [],
      coordination: { coordinator: { session_id: COORDINATOR_SESSION_ID, session_file: envelopePath, bound_at: TS } },
    }),
  );
  return envelopePath;
}

/** The pre-activation identity pointer the old `bind` wrote, as the ledger replays it: history only. */
function phase2BindingEntry(fixture: Fixture, coordinatorSessionPath: string): SessionEntry {
  return {
    type: "custom",
    customType: PHASE2_CUSTOM_TYPE,
    data: {
      version: 1,
      kind: "bind",
      workflowId: WORKFLOW_ID,
      hostSessionId: SESSION_ID,
      coordinatorSessionPath,
      coordinatorSessionId: COORDINATOR_SESSION_ID,
      harnessRoot: fixture.harness,
    },
  } as unknown as SessionEntry;
}

/** The ACTIVE binding record the migrated `bind` writes: the session's own §3.1 `ExecutionBinding`. */
function phase2ActiveBindingEntry(fixture: Fixture, ref: ExecutionSessionRef): SessionEntry {
  return {
    type: "custom",
    customType: PHASE2_CUSTOM_TYPE,
    data: {
      version: 2,
      kind: "bind",
      workflowId: WORKFLOW_ID,
      hostSessionId: SESSION_ID,
      // A canonical PLAIN copy: the engine's canonical-value rule accepts only
      // Object.prototype/null prototypes, and the extension re-serializes the
      // binding it compares, so the record never carries the engine's own object.
      executionBinding: {
        version: 1,
        harnessRoot: fixture.harness,
        session: {
          storeId: ref.storeId,
          epoch: ref.epoch,
          workflowId: ref.workflowId,
          role: ref.role,
          sessionId: ref.sessionId,
        },
      },
    },
  } as unknown as SessionEntry;
}

/* ------------------------------------------------------------------------ *
 * A minimal host surface for the two OMP extensions: the real factories, the
 * real tool definitions and the real event callbacks, with the host's ledger and
 * message channels reduced to what these cases assert. No host launch.
 * ------------------------------------------------------------------------ */

type ExtensionToolResult = Readonly<{
  content: ReadonlyArray<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}>;

type HostToolDefinition = Readonly<{
  name: string;
  parameters: { parse: (value: unknown) => unknown };
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<ExtensionToolResult>;
}>;

interface ExtensionHost {
  callTool: (params: Record<string, unknown>) => Promise<ExtensionToolResult>;
  emit: (event: string) => Promise<void>;
  messages: ReadonlyArray<{ customType: string; content: string }>;
  /** The session ledger this host appended to, as the extension's own replay reads it. */
  entries: readonly SessionEntry[];
}

function extensionHost(options: {
  factory: (pi: ExtensionAPI) => void;
  cwd: string;
  sessionId: string;
  entries?: readonly SessionEntry[];
  /**
   * Opt-in working model facade for the model-handoff START path: `resolve`
   * answers the configured role specs, and `setModel` records the switch in the
   * native ledger the way the host's own model controls do — the arm requires a
   * matching live model AND a matching `model_change` entry. Omitted (every
   * other case), the double keeps its previous behavior exactly.
   */
  modelRoles?: Readonly<Record<string, string>>;
}): ExtensionHost {
  const entries: SessionEntry[] = [...(options.entries ?? [])];
  let live: Readonly<{ provider: string; id: string }> | undefined;
  const messages: Array<{ customType: string; content: string }> = [];
  const handlers: Record<string, (payload: unknown, ctx: ExtensionContext) => unknown> = {};
  const tools: Record<string, HostToolDefinition> = {};
  const pi = {
    zod,
    registerTool: (definition: HostToolDefinition) => {
      tools[definition.name] = definition;
    },
    on: (event: string, handler: (payload: unknown, ctx: ExtensionContext) => unknown) => {
      handlers[event] = handler;
    },
    sendMessage: (message: { customType: string; content: unknown }) => {
      messages.push({ customType: message.customType, content: String(message.content) });
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data } as unknown as SessionEntry);
    },
    setModel: (model: { provider: string; id: string }) => {
      if (options.modelRoles === undefined) return undefined;
      live = { provider: model.provider, id: model.id };
      entries.push({
        id: `model-change-${entries.length + 1}`,
        type: "model_change",
        model: `${model.provider}/${model.id}`,
      } as unknown as SessionEntry);
      return true;
    },
  } as unknown as ExtensionAPI;
  options.factory(pi);
  const ctx = {
    cwd: options.cwd,
    sessionManager: { getSessionId: () => options.sessionId, getEntries: () => entries },
    models:
      options.modelRoles === undefined
        ? undefined
        : {
            resolve: (spec: string) => {
              const id = options.modelRoles?.[spec];
              return id === undefined ? undefined : { provider: "probe", id };
            },
            current: () => live,
          },
    getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } }),
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
  return {
    messages,
    entries,
    callTool: async (params) => {
      const tool = Object.values(tools)[0];
      if (tool === undefined) throw new Error("the extension registered no tool");
      return tool.execute("fixture-tool-call", tool.parameters.parse(params), undefined, undefined, ctx);
    },
    emit: async (event) => {
      const handler = handlers[event];
      if (handler === undefined) throw new Error(`the extension registered no ${event} handler`);
      await handler({}, ctx);
    },
  };
}

/** The scoped `code` of an extension tool result, whichever extension produced it. */
function extensionCodeOf(result: ExtensionToolResult): string {
  const scoped = (result.details.mstarPhase2 ?? result.details.mstarModelHandoff) as { code?: unknown } | undefined;
  return typeof scoped?.code === "string" ? scoped.code : "";
}

function textOfExtension(result: ExtensionToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("execution-omp-read-phase2 — the phase2 observation runs on the DB authority when ACTIVE and on the file route pre-activation (S3/2b)", () => {
  test("bind adopts the DB coordinator binding and never opens the retired envelope", async () => {
    const fixture = makeFixture("phase2-bind-active");
    const coordinator = await seedActiveAuthority(fixture);
    // Nothing is planted on disk: a route decision that ran after a file read
    // would refuse `phase2.envelope-unreadable` / `phase2.snapshot-unreadable`
    // here, so the success itself is the ordering proof.
    const host = extensionHost({ factory: phase2Orchestration, cwd: fixture.main, sessionId: SESSION_ID });

    const result = await host.callTool({ operation: "bind", workflowId: WORKFLOW_ID });

    expect(extensionCodeOf(result)).toBe("bound");
    expect(result.details.mstarPhase2).toMatchObject({ applied: true, workflowId: WORKFLOW_ID, storeId: coordinator.storeId, epoch: coordinator.epoch });
    // The ledger holds the ACTIVE generation, and it is the binding the DB owns.
    const state = derivePhase2State(host.entries, SESSION_ID);
    expect(state.binding?.executionBinding.session).toEqual(coordinator);
    expect(state.legacy).toBeNull();
  });

  test("bind refuses when the caller's checkout resolves no control harness", async () => {
    const fixture = makeFixture("phase2-bind-elsewhere");
    await seedActiveAuthority(fixture);
    plantPhase2Evidence(fixture);
    // A caller outside any harness: there is no addressed root, so no authority
    // can be selected and no evidence may be read on its behalf.
    const host = extensionHost({ factory: phase2Orchestration, cwd: scratchDir("phase2-bind-elsewhere"), sessionId: SESSION_ID });

    const result = await host.callTool({ operation: "bind", workflowId: WORKFLOW_ID });

    expect(extensionCodeOf(result)).toBe("phase2.harness-not-found");
  });

  test("checkpoint records against the DB authority instead of reporting not-ready", async () => {
    const fixture = makeFixture("phase2-checkpoint-active");
    const coordinator = await seedActiveAuthority(fixture);
    const host = extensionHost({
      factory: phase2Orchestration,
      cwd: fixture.main,
      sessionId: SESSION_ID,
      entries: [phase2ActiveBindingEntry(fixture, coordinator)],
    });

    const result = await host.callTool({ operation: "checkpoint", reason: "before-wait", decision: "wait", note: "probe" });

    expect(extensionCodeOf(result)).toBe("recorded");
    expect(textOfExtension(result)).toContain("checkpoint recorded");
  });

  test("a v2 bind whose declared pairing the engine could never accept is never adopted", async () => {
    const fixture = makeFixture("phase2-binding-pairing");
    const coordinator = await seedActiveAuthority(fixture, "iteration");
    const goodBinding = { version: 1, harnessRoot: realpathSync(fixture.harness), session: coordinator };
    // The engine's own reference shape (`execution-session.ts` `assertRefShape`)
    // admits the workflow's coordinator seat and no per-plan scope. A record
    // declaring a per-plan scope, or the removed plan-pm seat, is history, not a
    // binding — the restore guard admits it exactly as it admits any other
    // malformed shape.
    const impossiblePairings = [
      { ...goodBinding, session: { ...coordinator, role: "coordinator", planId: PLAN_ID } },
      { ...goodBinding, session: { ...coordinator, role: "plan-pm" } },
      { ...goodBinding, session: { ...coordinator, planId: null } },
      { ...goodBinding, session: { ...coordinator, planId: PLAN_ID } },
    ];
    for (const executionBinding of impossiblePairings) {
      const host = extensionHost({
        factory: phase2Orchestration,
        cwd: fixture.main,
        sessionId: SESSION_ID,
        entries: [
          {
            type: "custom",
            customType: PHASE2_CUSTOM_TYPE,
            data: { version: 2, kind: "bind", workflowId: WORKFLOW_ID, hostSessionId: SESSION_ID, executionBinding },
          } as unknown as SessionEntry,
        ],
      });
      const state = derivePhase2State(host.entries, SESSION_ID);
      expect(state.binding).toBeNull();
      expect(state.legacy).toBeNull();
    }
  });

  test("a LEGACY envelope binding on an ACTIVE root still refuses not-ready, and never reads the retired documents", async () => {
    const fixture = makeFixture("phase2-checkpoint-legacy-record");
    await seedActiveAuthority(fixture);
    // Only the pre-activation record exists: it is history, so the §5 readiness
    // check refuses it and the envelope is never opened.
    const host = extensionHost({
      factory: phase2Orchestration,
      cwd: fixture.main,
      sessionId: SESSION_ID,
      entries: [phase2BindingEntry(fixture, join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", "coordinator-absent.json"))],
    });

    const result = await host.callTool({ operation: "checkpoint", reason: "before-wait", decision: "wait", note: "probe" });

    expect(extensionCodeOf(result)).toBe("execution.consumer-not-ready");
    expect(textOfExtension(result)).toContain("checkpoint was not recorded");
  });

  test("a STALE active binding refuses through the engine's own code and stays silent", async () => {
    const fixture = makeFixture("phase2-checkpoint-stale");
    const coordinator = await seedActiveAuthority(fixture);
    const host = extensionHost({
      factory: phase2Orchestration,
      cwd: fixture.main,
      sessionId: SESSION_ID,
      // The same store, an epoch the authority does not record: a reference is a
      // lookup, never a bearer credential.
      entries: [phase2ActiveBindingEntry(fixture, { ...coordinator, epoch: coordinator.epoch + 1 })],
    });

    const result = await host.callTool({ operation: "checkpoint", reason: "before-wait", decision: "wait", note: "probe" });

    expect(["execution.session-unavailable", "store.stale-epoch"]).toContain(extensionCodeOf(result));
    expect(textOfExtension(result)).toContain("checkpoint was not recorded");
    expect(textOfExtension(result)).toContain("not-current");
  });

  test("the advisory sampler samples the DB authority and never reports the retired route", async () => {
    const fixture = makeFixture("phase2-sampler-active");
    const coordinator = await seedActiveAuthority(fixture);
    const host = extensionHost({
      factory: phase2Orchestration,
      cwd: fixture.main,
      sessionId: SESSION_ID,
      entries: [phase2ActiveBindingEntry(fixture, coordinator)],
    });

    await host.emit("agent_end");

    const scoped = host.messages.filter((message) => message.customType === PHASE2_NOTICE_CUSTOM_TYPE);
    expect(scoped.map((message) => message.content).join("\n")).not.toContain("execution.consumer-not-ready");
    // No running work, no latched baseline and nothing new to report: silence.
    expect(host.messages.filter((message) => message.customType === PHASE2_ADVISORY_CUSTOM_TYPE)).toEqual([]);
  });

  test("a harness with NO store keeps the file route and adopts the workflow's OWN recorded coordinator", async () => {
    const fixture = makeFixture("phase2-bind-legacy");
    const envelopePath = plantPhase2Evidence(fixture);
    const host = extensionHost({ factory: phase2Orchestration, cwd: fixture.main, sessionId: SESSION_ID });

    // The caller supplies no path at all: the host resolves the recorded
    // coordinator from the snapshot, and the record is the legacy generation.
    const result = await host.callTool({ operation: "bind", workflowId: WORKFLOW_ID });

    expect(extensionCodeOf(result)).toBe("bound");
    const state = derivePhase2State(host.entries, SESSION_ID);
    expect(state.binding).toBeNull();
    expect(state.legacy).toMatchObject({ coordinatorSessionId: COORDINATOR_SESSION_ID, coordinatorSessionPath: envelopePath });
  });
});

describe("execution-omp-read-handoff — the start path classifies only after the route answers (S3)", () => {
  test("the structural classifier never derives its branch from the retired register", async () => {
    const fixture = makeFixture("handoff-classifier-active");
    await seedActiveAuthority(fixture);
    // The leftover register NAMES this workflow: an authority-blind classifier
    // answered `attach` (adopt the named row) from retired bytes.
    plantPhase2Evidence(fixture);

    expect(await handoffSeams.bindingModeFor(WORKFLOW_ID, fixture.main)).toBe("reserve");
  });

  test("the same register still classifies as attach while the file route serves it", async () => {
    const fixture = makeFixture("handoff-classifier-legacy");
    plantPhase2Evidence(fixture);

    expect(await handoffSeams.bindingModeFor(WORKFLOW_ID, fixture.main)).toBe("attach");
  });

  test("the start path answers the ACTIVE authority for a workflow the retired register names", async () => {
    const fixture = makeFixture("handoff-start-active");
    // The authority holds a real ITERATION lifecycle (a model handoff can only
    // target an iteration) and it is the one bound to this native session id.
    await seedActiveAuthority(fixture, "iteration");
    // The retired witnesses stay exactly where the file route read them: the
    // register NAMES this workflow (an authority-blind classifier answered
    // `attach`), the snapshot at the derived path names a foreign plan and
    // carries leases this authority does not hold, and the compass is there. A
    // file-route answer could therefore only be a refusal — `already-bound` from
    // the reservation, `invalid-root` from that snapshot, or
    // `execution.consumer-not-ready` — never a successful arm.
    plantPhase2Evidence(fixture);
    mkdirSync(join(fixture.main, ".omp"), { recursive: true });
    writeFileSync(
      join(fixture.main, ".omp", "plugin-overrides.json"),
      JSON.stringify({ settings: { "@mstar-harness/omp": { modelHandoff: true, handoffTarget: "@default" } } }),
    );
    const host = extensionHost({
      factory: modelHandoff,
      cwd: fixture.main,
      sessionId: SESSION_ID,
      modelRoles: { "@slow": "slow-model" },
    });

    // Order evidence, asserted before the start: the structural classifier asks
    // the route FIRST, so on this ACTIVE root the retired register can never
    // select a branch.
    expect(await handoffSeams.bindingModeFor(WORKFLOW_ID, fixture.main)).toBe("reserve");
    const registerBefore = readFileSync(join(fixture.harness, "status.json"), "utf8");
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

    const result = await host.callTool({ operation: "start", workflowId: WORKFLOW_ID });

    // The DB/route answered: the handoff armed from the ADOPTED active binding,
    // which no file-route branch can produce — so the retired register and
    // snapshot were not consulted for the decision, and they are left exactly as
    // planted (never read for a verdict, never rewritten).
    expect(extensionCodeOf(result)).toBe("armed");
    expect(result.details.mstarModelHandoff).toMatchObject({ state: "pending", workflowId: WORKFLOW_ID });
    const records = host.entries.filter((entry) => entry.type === "custom" && entry.customType === HANDOFF_CUSTOM_TYPE);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      data: {
        state: "attempting",
        action: "arm",
        binding: { workflowId: WORKFLOW_ID, executionBinding: { harnessRoot: realpathSync(fixture.harness) } },
      },
    });
    expect(records[1]).toMatchObject({ data: { state: "pending", binding: { workflowId: WORKFLOW_ID } } });
    expect(readFileSync(join(fixture.harness, "status.json"), "utf8")).toBe(registerBefore);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
  });
});

/* ------------------------------------------------------------------------ *
 * The pre-hook's own channel is exercised where its fixture helpers live
 * (`store-cutover.test.ts`, group `execution-authority`).
 * ------------------------------------------------------------------------ */
