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
 * Module boundary: self-contained for the Task 3 adoption (native bind) and
 * the Task 5 removal — the only imports are the cordis context type, the
 * dsh-tools seam, `@mstar-harness/commands`, and the shared cwd reader.
 */
import { type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { executeCommand, getCommandDefinitions, getCommandSchemas } from '@mstar-harness/commands'
import type {
  CommandDefinition,
  CommandEffects,
  CommandEnvelope,
  CommandSchemaDescriptor,
  InvocationContext,
} from '@mstar-harness/commands'
import { sessionCwdOf } from './_shared.ts'

/** The named writable set (issue AC) — command ids, in registration order. */
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
      return toCanonicalValue(await executeCommand(commandId, commandInput, invocationContextOf(exec, resolver)))
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
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
}
