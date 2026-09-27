import { basename } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  executeCommand,
  getCommandDefinitions,
  type CommandDefinition,
  type CommandEnvelope,
  type InvocationContext,
} from '@mstar-harness/commands'
import { createMcpEffects, mcpToolName, type McpEffects } from '@mstar-harness/mcp'
import type { HarnessResolver } from './gates/_shared.ts'

type JsonSchema = Record<string, unknown>
type ToolJsonValue = null | string | number | boolean | ToolJsonValue[] | { [key: string]: ToolJsonValue }
type NativeAgent = { session?: { id?: unknown; header?: { id?: unknown; cwd?: unknown } } }
type NativeExecution = Pick<ToolRunContext, 'agent' | 'signal'>

const versions: InvocationContext['versions'] = Object.freeze({
  engine: null,
  cli: null,
  plugin: null,
  host: null,
  platform: process.platform,
})

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valueSchema(schema: JsonSchema): ValueSchemaSpec {
  const annotations = {
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    ...(typeof schema.title === 'string' ? { title: schema.title } : {}),
    ...(schema.default !== undefined ? { default: schema.default as ToolJsonValue } : {}),
  }
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
  if (alternatives !== undefined) {
    // dsh's oneOf has exact-one semantics; an anyOf is intentionally exposed
    // as JSON and remains fully validated by the canonical command schema.
    if (Array.isArray(schema.anyOf)) return { type: 'json', ...annotations }
    return { oneOf: alternatives.map((part) => valueSchema(part as JsonSchema)) as [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]], ...annotations }
  }

  switch (schema.type) {
    case 'object': {
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [])
      const properties = record(schema.properties) ? schema.properties : {}
      return {
        type: 'object',
        additionalProperties: schema.additionalProperties === true,
        ...(Object.keys(properties).length === 0 ? {} : {
          properties: Object.fromEntries(Object.entries(properties).map(([key, property]) => [
            key,
            { ...valueSchema(property as JsonSchema), ...(required.has(key) ? { required: true } : {}) },
          ])),
        }),
        ...annotations,
      } as ValueSchemaSpec
    }
    case 'array':
      return { type: 'array', ...(record(schema.items) ? { items: valueSchema(schema.items) } : {}), ...annotations }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return {
        type: schema.type,
        ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
        ...(schema.const !== undefined ? { const: schema.const } : {}),
        ...annotations,
      } as ValueSchemaSpec
    default:
      return { type: 'json', ...annotations }
  }
}

function parameterSchema(definition: CommandDefinition): ParameterSchemaSpec {
  const json = definition.input.toJSONSchema() as JsonSchema
  const required = new Set(Array.isArray(json.required) ? json.required.filter((key): key is string => typeof key === 'string') : [])
  const properties = record(json.properties) ? json.properties : {}
  return Object.fromEntries(Object.entries(properties).map(([key, property]) => [
    key,
    { ...valueSchema(property as JsonSchema), ...(required.has(key) ? { required: true } : {}) },
  ])) as ParameterSchemaSpec
}


function nativeContext(execution: NativeExecution, definition: CommandDefinition, input: unknown, resolver: HarnessResolver): Omit<InvocationContext, 'effects'> {
  const agent = execution.agent as NativeAgent | undefined
  const header = agent?.session?.header
  const cwd = typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd : process.cwd()
  const sessionId = typeof header?.id === 'string' && header.id.trim() !== ''
    ? header.id
    : typeof agent?.session?.id === 'string' && agent.session.id.trim() !== '' ? agent.session.id : undefined
  const schema = definition.input.toJSONSchema() as JsonSchema
  const hasHostSelector = record(schema.properties) && Object.hasOwn(schema.properties, 'host')
  const host = definition.id !== 'report' && hasHostSelector && record(input) && typeof input.host === 'string'
    ? input.host
    : 'dsh'
  return Object.freeze({
    cwd,
    controlRoot: resolver.forWorkspace(cwd),
    host,
    ...(sessionId === undefined ? {} : { sessionId }),
    versions,
    signal: execution.signal,
  })
}

async function executeNativeCommand(
  definition: CommandDefinition,
  input: unknown,
  execution: NativeExecution,
  resolver: HarnessResolver,
  effects: McpEffects,
): Promise<CommandEnvelope> {
  const context: InvocationContext = Object.freeze({ ...nativeContext(execution, definition, input, resolver), effects })
  const normalized = record(input) ? { ...input } : input
  if (record(normalized)) {
    for (const option of definition.cli.options) {
      if (option.context === 'sessionId') delete normalized[option.key]
    }
  }
  return effects.withInput(input, context, () => executeCommand(definition.id, normalized, context))
}

export function registerDshMcpTools(ctx: Context, resolver: HarnessResolver): void {
  ctx.inject(['tools'], (toolsCtx) => {
    const definitions = getCommandDefinitions()
    const effects = createMcpEffects([])
    const registeredNames = new Set<string>()
    for (const definition of definitions) {
      const canonicalName = mcpToolName(definition.id)
      const name = toolsCtx.tools.get(canonicalName) === undefined
        ? canonicalName
        : `mstar_mcp_${definition.id.replace(/[.-]/g, '_')}`
      if (registeredNames.has(name)) throw new Error(`dsh MCP tool name collision: ${name} (from command ${definition.id})`)
      registeredNames.add(name)
      toolsCtx.tools.register(defineTool({
        name,
        description: definition.description,
        parameters: parameterSchema(definition),
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
        },
        async execute(args, execution) {
          return executeNativeCommand(definition, args, execution, resolver, effects) as unknown as ToolJsonValue
        },
      }))
    }
  })
}


function parseCommandArgs(definition: CommandDefinition, tokens: readonly string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  const positional: string[] = []
  const optionByName = new Map<string, CommandDefinition['cli']['options'][number]>()
  for (const option of definition.cli.options) {
    for (const flag of option.flags.split(/[ ,|]+/).filter((part) => part.startsWith('-'))) {
      const key = flag.replace(/^-+/, '').replace(/^no-/, '')
      optionByName.set(flag, option)
      optionByName.set(`--${key}`, option)
      optionByName.set(`-${key}`, option)
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') {
      positional.push(...tokens.slice(index + 1))
      break
    }
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const [flag, inlineValue] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined]
    const option = optionByName.get(flag)
    if (option === undefined) throw new Error(`unknown option: ${flag}`)
    const expectsValue = /[<[]/.test(option.flags)
    const value = expectsValue ? inlineValue ?? tokens[++index] : flag.startsWith('--no-') ? false : true
    if (expectsValue && value === undefined) throw new Error(`option ${flag} requires a value`)
    const key = option.key
    if (option.variadic) {
      const values = input[key] as string[] | undefined
      if (values === undefined) input[key] = [value as string]
      else values.push(value as string)
    } else input[key] = value
  }

  definition.cli.arguments.forEach((argument, index) => {
    const value = positional[index]
    if (value !== undefined) input[argument.key] = argument.variadic ? positional.slice(index) : value
  })
  for (const option of definition.cli.options) {
    if (input[option.key] === undefined && option.defaultValue !== undefined) input[option.key] = option.defaultValue
  }
  return input
}

export async function executeDshMstarArgv(
  argv: readonly string[],
  execution: NativeExecution,
  resolver: HarnessResolver,
): Promise<CommandEnvelope | null> {
  if (argv.length === 0 || !['mstar', 'mstar-harness'].includes(basename(argv[0]!))) return null
  if (argv[1] === 'init') return null
  const definitions = getCommandDefinitions()
  const definition = definitions
    .filter((entry) => argv.length - 1 >= entry.cli.path.length && entry.cli.path.every((part, index) => argv[index + 1] === part))
    .sort((a, b) => b.cli.path.length - a.cli.path.length)[0]
  if (definition === undefined) {
    return { version: 1, command: argv.slice(1).join('.'), status: 'error', code: 'command.unknown', exitCode: 1, message: `unknown command: ${argv.slice(1).join(' ')}` }
  }
  let input: Record<string, unknown>
  try {
    input = parseCommandArgs(definition, argv.slice(1 + definition.cli.path.length))
  } catch (error) {
    return { version: 1, command: definition.id, status: 'usage', code: 'command.invalid-input', exitCode: 2, message: error instanceof Error ? error.message : String(error) }
  }
  const services: Array<{ close(): Promise<void> }> = []
  const effects = createMcpEffects(services)
  return executeNativeCommand(definition, input, execution, resolver, effects)
}
