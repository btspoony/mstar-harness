/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-commands` — the
 * plugin-owned human-command registry consumed by `@mstar-harness/dsh` to
 * register the bundled mstar commands (iteration-start / iteration-drive /
 * iteration-loop / codebase-audit) on `ctx.commands`.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface — `CommandDefinition` /
 * `CommandInvocation` / `CommandResult` / `CommandDescriptor` /
 * `ParsedCommand`, `parseCommand()`, and the `ctx.commands` service with
 * `register` / `list` / `find` / `execute` — and implements just enough
 * runtime behavior for real-composition tests: name normalization, a
 * fiber-scoped registry, and handler execution through `parseCommand()`.
 * Pinned to dsh-private commit 9451be2 (2026-08-07 snapshot). Keep in sync
 * when the dsh-private baseline moves. (`Agent` comes from the
 * `@deepseek-ai/dsh-agent` peer stub; `UserMessage` from `@deepseek-ai/dsh-llm`.)
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Lowercase command name without the leading slash (real regex). */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** Optional free-form input hint advertised to capable clients. */
export interface CommandInputDescriptor {
  readonly hint: string
}

/** Invocation passed to one registered command handler. */
export interface CommandInvocation {
  /** Exact agent whose human-facing surface received the command. */
  readonly agent: Agent
  /** Exact text following the registered command name, including separator whitespace. */
  readonly rawInput: string
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
}

/** Expected command outcome rendered directly by the dispatching UI. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** One settled command execution: the handler's normalized outcome. */
export interface CommandExecution {
  /** Pairing id carried by this execution's lifecycle events. */
  readonly commandId: string
  /** The handler's normalized outcome. */
  readonly result: CommandResult
}

/** Plugin-owned command registration. */
export interface CommandDefinition {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: CommandInputDescriptor
  /** Whether `command/run` records `rawInput`. Defaults to true. */
  readonly recordInput?: boolean
  /** Execute against the receiving agent without sending the command to the model. */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** Handler-free immutable command view returned to UI adapters. */
export interface CommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: CommandInputDescriptor
}

/** Syntactically valid slash command before registry resolution. */
export interface ParsedCommand {
  readonly name: string
  readonly rawInput: string
}

/** Parse an exact slash command without normalizing its trailing input. */
export function parseCommand(line: string): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  return { name: match[1]!, rawInput: line.slice(match[0].length) }
}

/** Render arbitrary thrown values without trusting their string coercion. */
function renderThrown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/** Validate and detach an untrusted handler result at the registry boundary. */
function normalizeResult(command: string, value: unknown): CommandResult {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TypeError(`command "${command}" handler must return a CommandResult`)
  }
  const result = value as { kind?: unknown; text?: unknown }
  if (result.kind === 'success') {
    if (result.text !== undefined && typeof result.text !== 'string') {
      throw new TypeError(`command "${command}" success text must be a string when supplied`)
    }
    return Object.freeze({
      kind: 'success' as const,
      ...result.text === undefined ? {} : { text: result.text },
    })
  }
  if (result.kind === 'error') {
    if (typeof result.text !== 'string' || result.text.trim().length === 0) {
      throw new TypeError(`command "${command}" error text must be a non-empty string`)
    }
    return Object.freeze({ kind: 'error' as const, text: result.text })
  }
  throw new TypeError(`command "${command}" returned unknown result kind "${String(result.kind)}"`)
}

/** Reject invalid command metadata before it can reach a UI protocol. */
function normalizeDefinition(definition: CommandDefinition): CommandDefinition {
  if (!COMMAND_NAME.test(definition.name)) {
    throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`)
  }
  if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
    throw new TypeError(`command "${definition.name}" description must be a non-empty string`)
  }
  if (typeof definition.handler !== 'function') {
    throw new TypeError(`command "${definition.name}" handler must be a function`)
  }
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    ...definition.input === undefined ? {} : { input: Object.freeze({ hint: definition.input.hint }) },
    ...definition.recordInput === undefined ? {} : { recordInput: definition.recordInput },
    handler: definition.handler,
  })
}

/** Register one command definition per layer; duplicate names fail loudly. */
function insertDefinition(layer: Map<string, CommandDefinition>, definition: CommandDefinition): () => void {
  if (layer.has(definition.name)) {
    throw new Error(`command "${definition.name}" is already registered`)
  }
  layer.set(definition.name, definition)
  return () => { layer.delete(definition.name) }
}

declare module 'cordis' {
  interface Context {
    /** Plugin-owned human-command registry (`@deepseek-ai/dsh-commands`). */
    commands: CommandService
  }
}

/** Human-command registry (global layer only — agent-scoped shadowing is out of the consumed surface). */
export class CommandService extends Service {
  private readonly definitions = new Map<string, CommandDefinition>()
  private commandSeq = 0

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }
  /**
   * Register a global command definition.
   * @param definition - discovery metadata and direct UI handler.
   * @returns the exact effect disposer that unregisters this definition.
   */
  register(definition: CommandDefinition): () => void {
    const normalized = normalizeDefinition(definition)
    return insertDefinition(this.definitions, normalized)
  }

  /** List the name-sorted descriptors of every registered command. */
  list(_agent: Agent): readonly CommandDescriptor[] {
    return Object.freeze([...this.definitions.values()]
      .map(command => Object.freeze({
        name: command.name,
        description: command.description,
        ...command.input === undefined ? {} : { input: command.input },
      }))
      .sort((left, right) => left.name < right.name ? -1 : 1))
  }

  /** Resolve one effective command definition. */
  find(_agent: Agent, name: string): CommandDefinition | undefined {
    return this.definitions.get(name)
  }

  /**
   * Parse and execute a known command without sending it to the model.
   * @param agent - exact receiving agent.
   * @param line - complete slash-command line.
   * @param signal - cancellation signal owned by the UI request.
   * @returns the settled execution, or `undefined` when syntax or name does not resolve.
   */
  async execute(agent: Agent, line: string, signal: AbortSignal): Promise<CommandExecution | undefined> {
    const parsed = parseCommand(line)
    if (parsed === undefined) return undefined
    const command = this.definitions.get(parsed.name)
    if (command === undefined) return undefined
    if (signal.aborted) throw new Error('command aborted')
    this.commandSeq += 1
    const commandId = `stub-${this.commandSeq}`
    const invocation = Object.freeze({ agent, rawInput: parsed.rawInput, signal })
    let result: CommandResult
    try {
      result = normalizeResult(parsed.name, await command.handler(invocation))
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(renderThrown(error))
    }
    return Object.freeze({ commandId, result })
  }
}

/**
 * Service-class default export matching the real package shape (the dsh
 * Loader mounts a class plugin via its constructor — the stub's `super(ctx,
 * 'commands')` registers the service on the fiber, same as dsh-skill /
 * dsh-tools stubs).
 */
export default CommandService
