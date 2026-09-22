/**
 * CLI active workflow transport (phase 2b execution contract §3.2) — the
 * workflow-level half of the active DB route: the direct workflow writer
 * entries of `index.ts` (registration, delivery evidence, terminal close) and
 * the closed workflow verb grammar (`phase`, `lifecycle`, `execution-policy`,
 * `integration-worktree`).
 *
 * Everything here consumes a landed engine verb; nothing re-implements one:
 *
 * - registration calls `commitExecutionRegistration`, which publishes the
 *   reviewed producer call, its catalog delta, the workflow header, its plan
 *   rows and the operation receipt in ONE transaction. The catalog delta is
 *   derived here exactly as the file journal derives it (`catalogDeltaFor`), so
 *   both routes register the same catalog identity.
 * - transitions call `mutateExecutionWorkflow` with the landed closed
 *   `WorkflowExecutionOperation` union. There is no header-patch member: an
 *   arbitrary snapshot replacement, a one-time delivery-kind declaration and
 *   the legacy `--declare-kind` repair have no operation, so they are refused
 *   visibly while the authority is active rather than disguised as a DB patch.
 *
 * Transport shape is validated before any IO (contract §3.2): the active flags
 * are `--expect` (a FULL execution token) plus `--operation`, and — for an
 * existing session's writes — `--session-ref`. The pre-activation flags
 * (`--session`, `--ended-at`, `--declare-kind`) belong to the file route only.
 * A mixed invocation is a usage refusal (exit 2), and a pre-activation `--expect`
 * revision integer is never coerced into a token.
 */
import { isAbsolute } from "node:path";
import { Command } from "commander";
import {
  SddScriptError,
  WORKFLOW_LIFECYCLE_STATUSES,
  commitExecutionRegistration,
  executionContextFor,
  mutateExecutionWorkflow,
  readCatalogRevisions,
  type CatalogExecutionCatalogDelta,
  type CatalogExecutionReceipt,
  type CatalogExecutionRequest,
  type CatalogExecutionWorkflow,
  type ExecutionContext,
  type ExecutionIdentity,
  type ExecutionIdentityScope,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
  type StoreContext,
  type WorkflowExecutionOperation,
} from "@mstar-harness/engine";
import {
  failExecutionVerb,
  printExecutionSuccess,
  requireExecutionIdentity,
  requireExecutionRoot,
  requireExecutionToken,
  requireJsonFile,
  requireSessionRef,
} from "./execution-session";

type CliOptions = Record<string, string | boolean | undefined>;

function optionalFlag(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The three flags an existing session's active workflow write carries. */
export type ActiveWorkflowFlags = { ref: ExecutionSessionRef; expected: ExecutionToken; operationId: string };

/** The active flags of one workflow CREATION: the caller's identity plus the root CAS. */
export type ActiveRegistrationFlags = { expected: ExecutionToken; operationId: string };

function refuseMixedTransport(options: CliOptions, verb: string, activeFlags: readonly string[]): void {
  if (optionalFlag(options, "session") === undefined) return;
  throw new SddScriptError(
    `${verb}: --session (a pre-activation session file) and the active flags (${activeFlags.join("/")}) are disjoint ` +
      "transports \u2014 pass one of them, never both",
    2,
  );
}

function requireDefinedFlags<T extends Record<string, string | undefined>>(verb: string, flags: T): { [K in keyof T]: string } {
  const missing = Object.entries(flags)
    .filter(([, value]) => value === undefined)
    .map(([flag]) => flag);
  if (missing.length === 0) {
    // Validated by the check above; the caller's flags are now all present.
    return flags as { [K in keyof T]: string };
  }
  throw new SddScriptError(
    `usage: ${verb} takes all active flags together \u2014 missing ${missing.join(", ")} (the scope's full execution token ` +
      "and this call's operation id)",
    2,
  );
}

/**
 * Read the active flags of one workflow WRITE against an existing session.
 * Returns `null` when none is present — the caller then keeps its
 * pre-activation route — and refuses a partial set or a mix with `--session`
 * instead of guessing which transport the caller meant.
 */
export function readActiveWorkflowFlags(options: CliOptions, verb: string): ActiveWorkflowFlags | null {
  const sessionRef = optionalFlag(options, "sessionRef");
  const expect = optionalFlag(options, "expect");
  const operation = optionalFlag(options, "operation");
  if (sessionRef === undefined && expect === undefined && operation === undefined) return null;
  refuseMixedTransport(options, verb, ["--session-ref", "--expect", "--operation"]);
  const flags = requireDefinedFlags(verb, { "--session-ref": sessionRef, "--expect": expect, "--operation": operation });
  // Cheap flag-shape checks first, then the wire codec: a malformed --expect is
  // a usage refusal, never a wire-decoding domain refusal.
  return {
    expected: requireExecutionToken(flags["--expect"], "--expect", verb),
    operationId: flags["--operation"],
    ref: requireSessionRef(flags["--session-ref"], "--session-ref", verb),
  };
}

/**
 * Read the active flags of one workflow CREATION. A creation is a root-token
 * operation whose caller is the identity that creates the lifecycle, so it
 * carries no session reference: a session row cannot exist before the workflow
 * does, and accepting one here would invite exactly that inference.
 */
export function readActiveRegistrationFlags(options: CliOptions, verb: string): ActiveRegistrationFlags | null {
  const expect = optionalFlag(options, "expect");
  const operation = optionalFlag(options, "operation");
  if (expect === undefined && operation === undefined) return null;
  refuseMixedTransport(options, verb, ["--expect", "--operation"]);
  if (optionalFlag(options, "sessionRef") !== undefined) {
    throw new SddScriptError(
      `${verb}: a registration is a root-token creation \u2014 it takes no --session-ref (the creating coordinator identity ` +
        "comes from the independently acquired identity channel, and no session row exists before the workflow does)",
      2,
    );
  }
  const flags = requireDefinedFlags(verb, { "--expect": expect, "--operation": operation });
  return { expected: requireExecutionToken(flags["--expect"], "--expect", verb), operationId: flags["--operation"] };
}

/**
 * The identity scope a workflow write addresses. The caller is acquired for the
 * workflow the reference actually names, so a reference copied from another
 * workflow refuses in the engine's own caller comparison instead of being
 * re-scoped here; the named `--workflow` must agree with the reference.
 */
export function activeWorkflowScope(workflowId: string, ref: ExecutionSessionRef, verb: string): ExecutionIdentityScope {
  if (ref.workflowId !== workflowId) {
    throw new SddScriptError(
      `${verb}: --workflow names ${workflowId}, but the session reference addresses ${ref.workflowId} \u2014 a reference is ` +
        "never re-scoped to another workflow",
      2,
    );
  }
  return { workflowId: ref.workflowId, role: ref.role, planId: ref.planId };
}

/**
 * The acquired caller context of one active workflow write. `--harness` is
 * validated and resolved exactly like every other active form; the identity is
 * validated against the scope the write addresses.
 */
export function activeWorkflowContext(
  scope: ExecutionIdentityScope,
  harnessArg: string | undefined,
  verb: string,
): ExecutionContext {
  const root = requireExecutionRoot(harnessArg, verb);
  const identity = requireExecutionIdentity(scope, verb);
  return executionContextFor({ harnessDir: root }, identity);
}

/* ------------------------------------------------------------------------ *
 * § Registration — the direct writer entry used by `workflow register` /
 *   `iteration register`
 * ------------------------------------------------------------------------ */

/**
 * The catalog delta a producer's own reviewed inputs imply, mirroring the file
 * journal's derivation: one plan entity (or the iteration's own entity) plus the
 * binding that names it. `binding.catalogKind` is the workflow's own family,
 * never another one.
 */
export function workflowCatalogDelta(workflow: CatalogExecutionWorkflow): CatalogExecutionCatalogDelta {
  if (workflow.kind === "plan") {
    return {
      entities: [
        {
          kind: "plan",
          id: workflow.options.plan.id,
          title: workflow.options.plan.title,
          rootKind: "plans",
          relativePath: workflow.options.plan.file,
        },
      ],
      binding: { catalogKind: "plan", catalogId: workflow.options.plan.id },
    };
  }
  if (workflow.kind === "iteration") {
    return {
      entities: [
        {
          kind: "iteration",
          id: workflow.workflowId,
          title: workflow.workflowId,
          rootKind: "iterations",
          relativePath: workflow.workflowId,
        },
      ],
      binding: { catalogKind: "iteration", catalogId: workflow.workflowId },
    };
  }
  // These verbs register a plan or an iteration; an audit promotion is not a
  // shape this transport invents a delta for.
  throw new SddScriptError("the active registration route registers a plan or iteration workflow", 2);
}

/**
 * The ACTIVE registration of one reviewed producer call, under the coordinator
 * identity that creates the lifecycle. The exact root token is the CAS, and the
 * catalog delta is reviewed against the CURRENT catalog revision exactly as the
 * file journal reviews it.
 */
export async function registerActiveWorkflow(
  context: StoreContext,
  input: {
    workflow: CatalogExecutionWorkflow;
    actor: string;
    flags: ActiveRegistrationFlags;
    identity: ExecutionIdentity;
  },
): Promise<CatalogExecutionReceipt> {
  const { catalogRevision } = await readCatalogRevisions(context);
  const request: CatalogExecutionRequest & { expected: ExecutionToken } = {
    operationId: input.flags.operationId,
    actor: input.actor,
    expectedCatalogRevision: catalogRevision,
    workflow: input.workflow,
    delta: workflowCatalogDelta(input.workflow),
    expected: input.flags.expected,
  };
  return commitExecutionRegistration(executionContextFor(context, input.identity), request);
}

/* ------------------------------------------------------------------------ *
 * § Transitions — the shared body of every active workflow write
 * ------------------------------------------------------------------------ */

/** One active workflow transition: the landed operation plus its §3.1 envelope. */
export function mutateActiveWorkflow(
  context: ExecutionContext,
  input: { workflowId: string; flags: ActiveWorkflowFlags; operation: WorkflowExecutionOperation },
): Promise<ExecutionReceipt<ExecutionState>> {
  return mutateExecutionWorkflow(context, {
    operationId: input.flags.operationId,
    session: input.flags.ref,
    expected: input.flags.expected,
    workflowId: input.workflowId,
    operation: input.operation,
  });
}

/** `workflow evidence --file` on the ACTIVE authority: the `delivery` transition. */
export function recordActiveDelivery(
  context: ExecutionContext,
  workflowId: string,
  flags: ActiveWorkflowFlags,
  delivery: Record<string, unknown>,
): Promise<ExecutionReceipt<ExecutionState>> {
  // The payload is operator JSON; the engine's own delivery rules merge and
  // refuse it (`applyDeliveryEvidence`), so the CLI never pre-judges it.
  const patch = delivery as Extract<WorkflowExecutionOperation, { kind: "delivery" }>["delivery"];
  return mutateActiveWorkflow(context, { workflowId, flags, operation: { kind: "delivery", delivery: patch } });
}

/**
 * `status workflow-close` on the ACTIVE authority: the terminal `lifecycle`
 * transition. There is deliberately no file close, no unregister step and no
 * `--ended-at` rewrite behind this path — the DB lifecycle owns its terminal
 * state and its registry membership.
 */
export function closeActiveWorkflow(
  context: ExecutionContext,
  workflowId: string,
  flags: ActiveWorkflowFlags,
  reason: string,
): Promise<ExecutionReceipt<ExecutionState>> {
  return mutateActiveWorkflow(context, { workflowId, flags, operation: { kind: "lifecycle", status: "completed", reason } });
}

/** The status one committed transition reports, for the human-mode line only. */
export function workflowStatusOf(receipt: ExecutionReceipt<ExecutionState>, workflowId: string): string {
  const entry = receipt.data.workflows.find((candidate) => candidate.state.id === workflowId);
  return entry === undefined ? "updated" : String(entry.state.status);
}

/* ------------------------------------------------------------------------ *
 * § The closed workflow verb grammar (§3.2)
 * ------------------------------------------------------------------------ */

type LifecycleOperation = Extract<WorkflowExecutionOperation, { kind: "lifecycle" }>;
type ExecutionPolicyOperation = Extract<WorkflowExecutionOperation, { kind: "execution-policy" }>;

/** The verb, its own flags, and the operation each `workflow` verb carries. */
function workflowTransitions(): ReadonlyArray<{
  verb: string;
  description: string;
  options: ReadonlyArray<readonly [string, string]>;
  operation: (options: CliOptions) => WorkflowExecutionOperation;
}> {
  return [
    {
      verb: "phase",
      description:
        "Request the next lifecycle phase: the named phase is evaluated against the lifecycle's own registered compass and " +
        "its committed rows by the existing phase gate, so a phase the gate does not produce refuses",
      options: [
        ["--phase <phase>", "The phase this call requests (the gate decides whether it is the produced transition)"],
        ["--compass <path>", "Absolute path of the lifecycle's registered compass (the gate's input)"],
      ],
      operation: (options) => {
        const phase = optionalFlag(options, "phase");
        const compassPath = optionalFlag(options, "compass");
        if (phase === undefined) throw new SddScriptError("usage: workflow phase requires --phase <phase>", 2);
        if (compassPath === undefined || !isAbsolute(compassPath)) {
          throw new SddScriptError(
            "workflow phase requires --compass <absolute-path> (the lifecycle's registered compass; the received value is " +
              "not echoed when it is not absolute)",
            2,
          );
        }
        return { kind: "phase", phase, compassPath };
      },
    },
    {
      verb: "lifecycle",
      description:
        "Move the lifecycle status: the terminal rules (every owned row Done, the delivery-evidence consultation for a " +
        "completed close, no lease on a terminal lifecycle) run unchanged behind this verb",
      options: [
        ["--status <status>", "The lifecycle status to move to (running | paused | completed | failed | stopped)"],
        ["--reason <text>", "The reason recorded with this transition"],
      ],
      operation: (options) => {
        const status = optionalFlag(options, "status");
        const reason = optionalFlag(options, "reason");
        if (status === undefined || !(WORKFLOW_LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
          throw new SddScriptError(`workflow lifecycle requires --status one of ${WORKFLOW_LIFECYCLE_STATUSES.join(" | ")}`, 2);
        }
        if (reason === undefined) throw new SddScriptError("workflow lifecycle requires --reason <text>", 2);
        // Already checked against the engine's closed list just above.
        const lifecycle = status as LifecycleOperation["status"];
        return { kind: "lifecycle", status: lifecycle, reason };
      },
    },
    {
      verb: "execution-policy",
      description: "Record the lifecycle's execution policy (the same policy shape the snapshot validator owns)",
      options: [["--file <path>", "Absolute path of the execution-policy JSON payload"]],
      operation: (options) => {
        const policy = requireJsonFile(options.file, "--file", "workflow execution-policy", "policy-json-path");
        // The engine's `assertWorkflowOperationShape` owns the policy shape.
        return { kind: "execution-policy", policy: policy as ExecutionPolicyOperation["policy"] };
      },
    },
    {
      verb: "integration-worktree",
      description:
        "Record the reviewed integration checkout: the existing worktree/branch validators require an existing checkout of " +
        "this repository, distinct from the main/control checkout, on the registered integration branch",
      options: [["--path <path>", "Absolute path of the reviewed integration checkout"]],
      operation: (options) => {
        const integrationPath = optionalFlag(options, "path");
        if (integrationPath === undefined || !isAbsolute(integrationPath)) {
          throw new SddScriptError(
            "workflow integration-worktree requires --path <absolute-path> (the received value is not echoed when it is not absolute)",
            2,
          );
        }
        return { kind: "integration-worktree", path: integrationPath };
      },
    },
  ];
}

/**
 * Register the active workflow verbs on the EXISTING `mstar workflow` group
 * (created by `registerWorkflowCommands`): commander aborts the whole CLI on a
 * duplicate command name, so these verbs join that group instead of creating a
 * second one.
 */
export function registerExecutionWorkflowCommands(target: Command): void {
  const group = target.commands.find((command) => command.name() === "workflow");
  if (group === undefined) {
    throw new Error("registerExecutionWorkflowCommands: the `workflow` command group must be registered first");
  }
  group.description(
    `${group.description()} The active DB forms (\`phase\`, \`lifecycle\`, \`execution-policy\`, \`integration-worktree\`) ` +
      "take --session-ref/--expect/--operation under an independently acquired identity.",
  );

  for (const { verb, description, options: verbOptions, operation } of workflowTransitions()) {
    const command = group
      .command(verb)
      .description(`${description} (active DB route; coordinator identity)`)
      .option("--workflow <id>", "Workflow id")
      .option("--session-ref <wire>", "Canonical execution session reference (exec-session-v1:<base64url>)")
      .option("--expect <token>", "The workflow's full execution token from the current read (the CAS)")
      .option("--operation <id>", "Caller-supplied id of this one operation (the replay key)")
      .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
      .option("--json", "Machine-readable JSON on stdout");
    // Each verb declares ITS OWN flags: a flag another member owns is an
    // unknown option (usage, exit 2), never silently ignored input.
    for (const [flag, blurb] of verbOptions) command.option(flag, blurb);
    command
      .exitOverride()
      .action(async (options: CliOptions) => {
        const json = options.json === true;
        try {
          const workflowId = optionalFlag(options, "workflow");
          if (workflowId === undefined) throw new SddScriptError(`usage: workflow ${verb} requires --workflow <id>`, 2);
          const flags = readActiveWorkflowFlags(options, `workflow ${verb}`);
          if (flags === null) {
            throw new SddScriptError(
              `usage: workflow ${verb} is the ACTIVE DB form \u2014 pass --session-ref/--expect/--operation under an ` +
                "independently acquired identity (the pre-activation Prepare forms are `show-prepare` and `amend-prepare`)",
              2,
            );
          }
          // The operation shape is decided before any IO, like the rest of this transport.
          const request = operation(options);
          const context = activeWorkflowContext(
            activeWorkflowScope(workflowId, flags.ref, `workflow ${verb}`),
            optionalFlag(options, "harness"),
            `workflow ${verb}`,
          );
          const receipt = await mutateActiveWorkflow(context, { workflowId, flags, operation: request });
          printExecutionSuccess(
            `workflow ${verb}`,
            receipt,
            json,
            `workflow ${verb}: ${workflowId} is now ${workflowStatusOf(receipt, workflowId)}`,
          );
        } catch (error) {
          failExecutionVerb(`workflow ${verb}`, error, json);
        }
      });
  }
}
