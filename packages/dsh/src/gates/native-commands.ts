/**
 * Native writable command tools (#526) — the mstar command surface as dsh tools.
 *
 * The named writable set (plan bind/prepare/progress/complete + workflow
 * register + issue add/close) is registered over `ctx.tools.register` with the
 * same `defineTool` style as the read-only tools in `tools.ts`. Each tool
 * calls the shared `@mstar-harness/commands` implementation through its
 * programmatic entry (`executeCommand` — the same admission + execution path
 * the CLI uses) and injects `sessionId` from `exec.agent.id` (ADR
 * `dsh-native-identity-channels` constraints 1–2: `Agent.id` IS the session
 * id, and per-caller identity is available at the tool seam). A session id in
 * the tool arguments is STRIPPED before admission — identity is never
 * model-choosable on this surface.
 *
 * Beyond that mapping the surface carries exactly ONE dsh-native tool:
 * `mstar_execution_clear` (Task 5) — the replacement reachability for the
 * durable execution binding's clear after the slash command that hosted it was
 * removed. It wraps the dsh-side clear internals directly (there is no shared
 * `execution.clear` command to map through) and takes no parameters at all —
 * identity comes from `exec.agent.id` the same way.
 *
 * No shell anywhere in the path: `executeCommand` runs in-process, and the
 * injected `effects` carry no process/browser/dashboard implementation, so an
 * effect-taking command can only refuse.
 *
 * Engine refusal envelopes surface verbatim: the tool validates nothing
 * beyond the platform's own parameter schema (mechanically mirrored from the
 * command's published JSON Schema, with the session selector removed) and
 * returns the `CommandEnvelope` it received as the canonical value — no
 * second validation layer, no paraphrase.
 *
 * Module boundary: self-contained for the native adoption (Task 3 bind) and
 * the Task 5 clear — the only imports are the cordis context type, the
 * dsh-tools seam, `@mstar-harness/commands`, the engine's execution-session
 * primitives, the execution-session clear internals, and the shared cwd
 * reader / workflow-selection resolvers.
 */
import { type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { encodeExecutionSessionRef, executionContextFor, resumeExecutionSession } from '@mstar-harness/engine'
import type { ExecutionSessionRef } from '@mstar-harness/engine'
import { executeCommand, getCommandDefinitions, getCommandSchemas, refusalEnvelope } from '@mstar-harness/commands'
import type {
  CommandDefinition,
  CommandEffects,
  CommandEnvelope,
  CommandSchemaDescriptor,
  InvocationContext,
} from '@mstar-harness/commands'
import { sessionCwdOf } from './_shared.ts'
import { adoptExecutionBinding, refusalOf } from './workflow-selection.ts'
import { clearExecutionSessionBinding } from './execution-session.ts'

/** The named writable set (issue AC) — the shared command ids that map 1:1 onto tools, in registration order. The surface gains exactly one tool beyond this list: the dsh-native `mstar_execution_clear` (Task 5). */
const NATIVE_COMMAND_IDS = [
  'plan.bind',
  'plan.prepare',
  'plan.progress',
  'plan.complete',
  'workflow.register',
  'issue.add',
  'issue.close',
] as const

/** The tool name for one command id — the same mapping the MCP route uses. */
export function nativeCommandToolName(commandId: string): string {
  return `mstar_${commandId.replace(/[.-]/g, '_')}`
}

/**
 * The caller identity of one tool execution: `exec.agent.id` (ADR constraint
 * 1 — a dsh agent's identity and its session identity are the same value).
 */
function callerSessionIdOf(exec: ToolExecution): string {
  const id = (exec.agent as { id?: unknown } | null | undefined)?.id
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('the native mstar command tools require a calling agent identity (exec.agent.id); none is present on this execution')
  }
  return id
}

/**
 * Effects for the native surface: none. The shared implementation owns every
 * process/dashboard/browser effect; this surface provides refusing stubs so
 * an effect-taking command refuses by construction instead of reaching a
 * shell (the no-shell guarantee is the absence of the capability, not a rule
 * about it).
 */
const NATIVE_EFFECTS: CommandEffects = {
  readInput: () => {
    throw new Error('the stdin effect is not available on the dsh native command surface (no shell, no child process)')
  },
  spawn: () => {
    throw new Error('the process effect is not available on the dsh native command surface (no shell, no child process)')
  },
  startDashboard: () => {
    throw new Error('the dashboard effect is not available on the dsh native command surface')
  },
  openBrowser: () => {
    throw new Error('the browser effect is not available on the dsh native command surface')
  },
}

/**
 * The invocation context for one admitted command call: the session's
 * workspace cwd, the resolver's harness dir as the control root, and the
 * caller identity from `exec.agent.id` — never from the arguments.
 */
function invocationContextOf(exec: ToolExecution, resolver: { forAgent(agent: unknown): string | null }): InvocationContext {
  const cwd = sessionCwdOf(exec.agent)
  if (cwd === undefined) {
    throw new Error('the native mstar command tools require a session workspace (session.header.cwd); none is present on this execution')
  }
  return {
    cwd,
    controlRoot: resolver.forAgent(exec.agent),
    host: 'dsh',
    sessionId: callerSessionIdOf(exec),
    versions: { engine: null, cli: null, plugin: null, host: 'dsh', platform: 'dsh' },
    signal: exec.signal,
    effects: NATIVE_EFFECTS,
  }
}

/**
 * The dsh parameter spec for one command, mirrored MECHANICALLY from the
 * command's own published JSON Schema (the single source both transports
 * already serve) with the `sessionId` context selector removed. Scalars keep
 * their type so the model face is typed; every object/union payload stays the
 * annotation-only `json` node — the semantic validation is the shared
 * admission's, never duplicated here.
 */
function parameterSpecOf(descriptor: CommandSchemaDescriptor): Record<string, import('@deepseek-ai/dsh-tools').ParameterPropertySpec> {
  const jsonSchema = descriptor.input as { properties?: Record<string, { type?: string }> } | null | undefined
  const properties = jsonSchema?.properties ?? {}
  const helpByName = new Map(
    descriptor.requirements.filter((entry) => entry.ownership === 'caller').map((entry) => [entry.name, entry]),
  )
  const spec: Record<string, import('@deepseek-ai/dsh-tools').ParameterPropertySpec> = {}
  for (const [field, node] of Object.entries(properties)) {
    // The session selector is transport-resolved (exec.agent.id here), never
    // a published tool parameter (ADR constraints 1–3).
    if (field === 'sessionId') continue
    const scalar = node.type === 'string' ? { type: 'string' as const }
      : node.type === 'integer' ? { type: 'integer' as const }
      : node.type === 'number' ? { type: 'number' as const }
      : node.type === 'boolean' ? { type: 'boolean' as const }
      : { type: 'json' as const }
    const help = helpByName.get(field)?.help
    spec[field] = {
      ...scalar,
      ...(help === undefined ? {} : { description: help }),
      ...(descriptor.required.includes(field) ? { required: true as const } : {}),
    }
  }
  return spec
}

/** One-line summary of a command envelope for the model-facing render. */
function envelopeSummary(commandId: string, envelope: CommandEnvelope): string {
  if (envelope.status === 'ok') return `${commandId}: ok (exit ${envelope.exitCode})`
  return `${commandId}: ${envelope.status} ${envelope.code} (exit ${envelope.exitCode}) — ${envelope.message}`
}

/**
 * The lossless-JSON value domain the dsh-tools seam accepts as a canonical
 * value (the `json` output node's value domain).
 */
type JsonValue = import('@deepseek-ai/dsh-util-values').JsonValue

/**
 * Project an envelope onto the tool's canonical value: the dsh-tools seam
 * requires lossless JSON, and a shared envelope may carry `undefined` members
 * (e.g. a refusal `details.actual` that is absent). The JSON round-trip is the
 * SAME projection every other transport applies when it serializes the
 * envelope (the CLI writes it, MCP returns it as structured content) — the
 * content is untouched, only the lossy-for-JSON members go.
 */
function toCanonicalValue(envelope: CommandEnvelope): JsonValue {
  return JSON.parse(JSON.stringify(envelope)) as JsonValue
}

/**
 * The engine session reference inside a successful `plan bind` envelope: both
 * bind arms (execution and resume) answer the engine's
 * `ExecutionRead<ExecutionSessionRef>` receipt as the envelope `data`, whose
 * `data` member is the canonical ref. `undefined` — not a recognizable bind
 * receipt (a shared-command shape drift) — is never guessed into a ref.
 */
function bindReceiptRefOf(envelope: CommandEnvelope): ExecutionSessionRef | undefined {
  if (envelope.status !== 'ok') return undefined
  const receipt = (envelope as { data?: unknown }).data
  const candidate = (
    typeof receipt === 'object' && receipt !== null ? (receipt as Record<string, unknown>).data : undefined
  ) as ExecutionSessionRef | undefined
  if (typeof candidate !== 'object' || candidate === null) return undefined
  // The engine's own canonical-value validation (the same acceptance the wire
  // transport applies) — a drifted receipt is never adopted.
  try {
    encodeExecutionSessionRef(candidate)
  } catch {
    return undefined
  }
  return candidate
}

/**
 * The dsh-side adoption refusal: the engine coordinator seat the bind
 * committed stays bound, the durable slot is NOT written, and the message
 * names the cause plus the recovery (the model can re-run the bind).
 */
function adoptionRefusal(code: string, message: string, recovery: string): CommandEnvelope<never> {
  return refusalEnvelope({ command: 'plan.bind', status: 'refused', code, exitCode: 1, message, recovery })
}

/**
 * Task 3 (#527): persist the durable `executionBinding` slot after a native
 * `plan bind` succeeds — the adoption the removed slash command performed,
 * kept on the native path. The binding order's durable-selection
 * rung and the workflow ledger's explicit route
 * (`resolveExecutionLedgerTarget`) read exactly this slot, so ledger
 * attribution works with no slash command.
 *
 * The validation set is the slash command's, unchanged:
 * the reference must name the carrying session, the ENGINE resume must
 * succeed BEFORE the slot write (a foreign, copied, stale-epoch or
 * scope-mismatched reference is refused and never adopted), and the write
 * goes through `adoptExecutionBinding` — the session's user selection is
 * preserved and the exclusion floor merges by max. An adoption failure
 * returns a refused envelope carrying the engine's own code/message verbatim
 * plus the recovery; the command itself already committed engine-side.
 */
async function adoptNativeExecutionBinding(
  envelope: CommandEnvelope,
  input: Record<string, unknown>,
  exec: ToolExecution,
  resolver: { forAgent(agent: unknown): string | null },
): Promise<CommandEnvelope> {
  // Both bind arms adopt: the execution bind (the engine minted the ref) and
  // the resume bind (the caller supplied a reference). Any other command
  // input never reaches the envelope's bind arms, so this narrow check is
  // exact.
  if (input.execution !== true && input.resumeRef === undefined) return envelope
  const ref = bindReceiptRefOf(envelope)
  if (ref === undefined) {
    return adoptionRefusal(
      'binding.receipt-unrecognizable',
      'the plan bind envelope carried no recognizable execution session reference — the execution binding was NOT adopted',
      'Re-run the bind; if it repeats, run `mstar plan bind --execution true --coordinator true --workflow <workflow-id>` through the CLI and report the envelope.',
    )
  }
  const harnessDir = resolver.forAgent(exec.agent)
  const cwd = sessionCwdOf(exec.agent)
  if (harnessDir === null || cwd === undefined) {
    return adoptionRefusal(
      'binding.no-harness',
      'the carrying session has no resolved harness dir or workspace — the execution binding was NOT adopted',
      'Open the session in the workspace that declares the control harness (.mstar/ or .mstarc) and re-run the bind.',
    )
  }
  const sessionId = callerSessionIdOf(exec)
  // The reference names the carrying session — the same first check the slash
  // adoption made, before any engine round-trip.
  if (ref.sessionId !== sessionId) {
    return adoptionRefusal(
      'binding.foreign-reference',
      `the bound session reference names ${ref.sessionId}, not the carrying session ${sessionId} — the execution binding was NOT adopted`,
      'Run the bind as the carrying session itself; a reference to another session is never adoptable.',
    )
  }
  try {
    // The engine resume succeeds BEFORE the slot write: a copied store id, a
    // stale epoch or a scope mismatch refuses here and NOTHING is adopted.
    const resumed = await resumeExecutionSession(
      executionContextFor({ harnessDir }, { source: 'host', sessionId, workflowId: ref.workflowId, role: 'coordinator' }),
      ref,
    )
    if (resumed.data.sessionId !== sessionId || resumed.data.workflowId !== ref.workflowId) {
      throw new Error('the resumed execution session did not match the carrying session')
    }
    const adopted = adoptExecutionBinding(
      harnessDir,
      sessionId,
      cwd,
      { version: 1, harnessRoot: harnessDir, session: ref },
      { storeId: resumed.storeId, epoch: resumed.epoch },
    )
    if (!adopted) throw new Error('the execution binding store refused the adoption write')
  } catch (error) {
    // The engine's own refusal code/message surface verbatim; the seat the
    // bind committed stays bound, so re-running the bind recovers.
    const { code, message } = refusalOf(error)
    return adoptionRefusal(
      code,
      message,
      'The engine coordinator seat from the bind stays bound — re-run the bind to adopt again, or resume with your own session reference.',
    )
  }
  return envelope
}

/** Build the native tool for one shared command definition. */
function nativeCommandTool(
  definition: CommandDefinition,
  resolver: { forAgent(agent: unknown): string | null },
) {
  const descriptor = getCommandSchemas([definition])[0]!
  const commandId = definition.id
  const required = descriptor.required.length === 0 ? '' : ` Required inputs: ${descriptor.required.join(', ')}.`
  return defineTool({
    name: nativeCommandToolName(commandId),
    description:
      `${definition.description} Command id: ${commandId}.${required} ` +
      'The sessionId is injected from the calling agent identity (exec.agent.id) and a session id argument is ignored; ' +
      'engine refusals surface verbatim in the returned envelope (status refused/usage + message + recovery).',
    parameters: parameterSpecOf(descriptor),
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: envelopeSummary(commandId, value as CommandEnvelope) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Command ${commandId}`,
      kind: 'other',
      rawInput: JSON.stringify(args)?.slice(0, 160) ?? '',
    }),
    // Every command here mutates the execution authority — exclusive (never
    // parallel with siblings), matching the read-only tools' registry default.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args as Record<string, unknown>
      // Identity is never model-supplied: strip the session selector before
      // admission so the shared admission resolves it from the injected
      // context (exec.agent.id) instead of an argument value.
      const { sessionId: _ignored, ...commandInput } = input
      const envelope = await executeCommand(commandId, commandInput, invocationContextOf(exec, resolver))
      if (commandId === 'plan.bind') {
        // Task 3 (#527): on a successful bind, persist the durable
        // executionBinding slot (the adoption the slash command performed);
        // every other command returns its envelope untouched.
        return toCanonicalValue(await adoptNativeExecutionBinding(envelope, commandInput, exec, resolver))
      }
      return toCanonicalValue(envelope)
    },
  })
}

/**
 * The logical command id the native clear reports in its envelope. There is
 * no shared `execution.clear` command to map through `nativeCommandTool` —
 * the clear is a dsh-native tool wrapping the dsh-side binding internals, so
 * its envelope is assembled here with the same shape the shared commands
 * answer.
 */
const EXECUTION_CLEAR_COMMAND = 'execution.clear'

/** The ok envelope of a completed clear (the shared commands' ok shape). */
function executionClearOk(): CommandEnvelope {
  return { version: 1, command: EXECUTION_CLEAR_COMMAND, status: 'ok', code: 'execution.clear.ok', exitCode: 0, data: null }
}

/**
 * Task 5 (#530): the native `mstar_execution_clear` tool — the replacement
 * reachability for `clearExecutionBinding` after the removal of the slash
 * command whose `clear` arm was its only caller. It wraps
 * `clearExecutionSessionBinding` (the slash clear's validation set: readable
 * record guard, nothing-to-clear guard, and the observed-generation
 * `selectedGeneration` read) with the identity from `exec.agent.id` — the
 * parameter face is EMPTY, so identity is never model-choosable. The named
 * outcomes surface as envelopes: `cleared` → ok, `no-binding` → the named
 * refusal the slash arm threw, an unreadable/refused store → refusal carrying
 * the store's own reason.
 */
function executionClearTool(
  resolver: { forAgent(agent: unknown): string | null },
) {
  return defineTool({
    name: 'mstar_execution_clear',
    description:
      "Clear the calling session's own durable mstar execution binding (the one the native mstar_plan_bind tool adopted). " +
      'The session id comes from the calling agent identity (exec.agent.id) — there are no parameters and identity is never model-choosable; ' +
      "the user's workflow selection and exclusion floor are preserved. " +
      'Clearing a session with no adopted binding is a named refusal (no clearable execution binding), ' +
      'and an unreadable or refused binding record is a refusal carrying the store reason, never a silent no-op.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: envelopeSummary(EXECUTION_CLEAR_COMMAND, value as CommandEnvelope) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Command ${EXECUTION_CLEAR_COMMAND}`,
      kind: 'other',
      rawInput: JSON.stringify(args)?.slice(0, 160) ?? '',
    }),
    // Mutates the execution authority's binding slot — exclusive, matching
    // the command tools above.
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const harnessDir = resolver.forAgent(exec.agent)
      const cwd = sessionCwdOf(exec.agent)
      if (harnessDir === null || cwd === undefined) {
        return toCanonicalValue(refusalEnvelope({
          command: EXECUTION_CLEAR_COMMAND,
          status: 'refused',
          code: 'execution.clear.no-harness',
          exitCode: 1,
          message: 'the carrying session has no resolved harness dir or workspace — the execution binding could not be read for the clear',
          recovery: 'Open the session in the workspace that declares the control harness (.mstar/ or .mstarc) and re-run the clear.',
        }))
      }
      const outcome = await clearExecutionSessionBinding(harnessDir, callerSessionIdOf(exec), cwd)
      if (outcome.kind === 'cleared') return toCanonicalValue(executionClearOk())
      return toCanonicalValue(refusalEnvelope({
        command: EXECUTION_CLEAR_COMMAND,
        status: 'refused',
        code: outcome.kind === 'no-binding' ? 'execution.clear.no-binding' : 'execution.clear.store-refused',
        exitCode: 1,
        message: outcome.kind === 'no-binding' ? 'no clearable execution binding' : `no clearable execution binding (${outcome.reason})`,
        recovery: outcome.kind === 'no-binding'
          ? 'This session has no durable execution binding to clear — adopt one first with the native mstar_plan_bind tool if a binding was expected; otherwise no action is needed.'
          : 'Resolve the store refusal named in the message (the durable binding record must be readable and writable for this session and its exact cwd), then re-run the clear.',
      }))
    },
  })
}

/**
 * Register the native writable command tools. The registrations are deferred
 * with `ctx.inject(['tools'], …)` (the optional-unit pattern, as in
 * `tools.ts`) and each registration's disposer is returned as the inject
 * teardown, so an HMR reload of the plugin fiber unregisters the tools
 * cleanly (a post-dispose lookup finds none).
 * @param ctx - registrant context carrying the tool registry.
 * @param resolver - the per-workspace `{HARNESS_DIR}` resolver (the control
 * root resolves per the calling session's workspace — never the process cwd).
 */
export function registerNativeCommandTools(ctx: Context, resolver: { forAgent(agent: unknown): string | null }): void {
  ctx.inject(['tools'], (toolsCtx) => {
    const definitions = getCommandDefinitions()
    const disposers: Array<() => void> = []
    for (const commandId of NATIVE_COMMAND_IDS) {
      const definition = definitions.find((candidate) => candidate.id === commandId)
      if (definition === undefined) throw new Error(`no shared command definition for the native tool: ${commandId}`)
      disposers.push(toolsCtx.tools.register(nativeCommandTool(definition, resolver)))
    }
    // Task 5 (#530): the one dsh-native tool beyond the shared-command mapping
    // — the surface's total is these 7 command tools + mstar_execution_clear.
    disposers.push(toolsCtx.tools.register(executionClearTool(resolver)))
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
}
