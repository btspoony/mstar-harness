import { spawn } from 'node:child_process'
import {
  decodeExecutionSessionRef,
  executionContextFor,
  resumeExecutionSession,
  type ExecutionBinding,
  type ExecutionCaller,
  type ExecutionSessionRef,
} from '@mstar-harness/engine'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { adoptExecutionBinding, clearExecutionBinding } from './workflow-selection.ts'
import type { HarnessResolver } from './_shared.ts'

const SPOOF_KEYS = [
  'MSTAR_EXECUTION_IDENTITY',
  'MSTAR_EXECUTION_SESSION_ID',
  'MSTAR_HOST_SESSION_ID',
  'MSTAR_SESSION_ID',
  'MSTAR_CALLER_ID',
] as const

type SessionScope = Omit<ExecutionCaller, 'sessionId'>
type AdoptRequest = { operation: 'adopt'; sessionRef: string }
type ClearRequest = { operation: 'clear' }
type RunRequest = { operation: 'run'; workflowId: string; role: 'coordinator' | 'plan-pm'; planId: string | null; argv: string[] }
type ExecutionRequest = AdoptRequest | ClearRequest | RunRequest

type NativeSession = {
  id?: unknown
  header?: { id?: unknown; cwd?: unknown; origin?: unknown; delegationDepth?: unknown; parentSession?: unknown }
}

function nativeSessionOf(invocation: CommandInvocation): NativeSession {
  return invocation.agent.session as unknown as NativeSession
}

function nativeFacts(invocation: CommandInvocation): { sessionId: string; cwd: string; leaf: boolean } {
  const session = nativeSessionOf(invocation)
  const header = session.header
  const sessionId = typeof header?.id === 'string' && header.id.trim() !== '' ? header.id : undefined
  const cwd = typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd : undefined
  if (sessionId === undefined || cwd === undefined) throw new Error('native session identity and cwd are required')
  const leaf = header?.origin === 'subagent' || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)
  return { sessionId, cwd, leaf }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRequest(raw: string): ExecutionRequest {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('execution command input must be JSON') }
  if (!isRecord(value) || typeof value.operation !== 'string') throw new Error('execution command input must be a closed JSON object')
  if (value.operation === 'clear') {
    if (Object.keys(value).length !== 1) throw new Error('clear does not accept extra fields')
    return { operation: 'clear' }
  }
  if (value.operation === 'adopt') {
    if (Object.keys(value).length !== 2 || typeof value.sessionRef !== 'string' || value.sessionRef === '') throw new Error('adopt requires only a canonical sessionRef')
    return { operation: 'adopt', sessionRef: value.sessionRef }
  }
  if (value.operation === 'run') {
    if (Object.keys(value).length !== 5 || typeof value.workflowId !== 'string' || value.workflowId === '' || (value.role !== 'coordinator' && value.role !== 'plan-pm') || (value.planId !== null && (typeof value.planId !== 'string' || value.planId === '')) || !Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((arg) => typeof arg !== 'string' || arg === '')) {
      throw new Error('run requires workflowId, role, planId, and a non-empty argv')
    }
    return { operation: 'run', workflowId: value.workflowId, role: value.role, planId: value.planId, argv: value.argv as string[] }
  }
  throw new Error('unknown execution operation')
}

function identityEnv(base: NodeJS.ProcessEnv, scope: { sessionId: string } & SessionScope): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of SPOOF_KEYS) delete env[key]
  env.MSTAR_EXECUTION_IDENTITY = JSON.stringify(scope)
  return env
}

export function runExecutionCommand(argv: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  if (argv.length === 0 || argv.some((arg) => arg === '')) return Promise.reject(new Error('execution argv must be non-empty'))
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const abort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => { signal.removeEventListener('abort', abort); reject(error) })
    child.once('close', (code, signalName) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(new Error(`execution child cancelled (${signalName ?? 'SIGTERM'})`))
      else resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function handleExecutionCommand(invocation: CommandInvocation, resolver: HarnessResolver): Promise<CommandResult> {
  const request = parseRequest(invocation.rawInput.trim())
  const facts = nativeFacts(invocation)
  if (facts.leaf) throw new Error('leaf sessions cannot adopt, clear, or launch coordinator execution')
  const harnessDir = resolver.forWorkspace(facts.cwd)
  if (harnessDir === null) throw new Error('execution harness is unavailable for this native session')
  if (request.operation === 'clear') {
    if (!clearExecutionBinding(harnessDir, facts.sessionId, facts.cwd)) throw new Error('no clearable execution binding')
    return { kind: 'success', text: 'execution binding cleared' }
  }
  if (request.operation === 'adopt') {
    const ref = decodeExecutionSessionRef(request.sessionRef)
    if (ref.sessionId !== facts.sessionId) throw new Error('session reference does not match the native carrying session')
    const binding: ExecutionBinding = { version: 1, harnessRoot: harnessDir, session: ref }
    const resumed = await resumeExecutionSession(executionContextFor({ harnessDir }, { source: 'host', sessionId: ref.sessionId, workflowId: ref.workflowId, role: ref.role, planId: ref.planId }), ref)
    if (resumed.data.sessionId !== facts.sessionId || resumed.data.workflowId !== ref.workflowId) throw new Error('current execution session admission did not match the native session')
    if (!adoptExecutionBinding(harnessDir, facts.sessionId, facts.cwd, binding)) throw new Error('execution binding adoption refused')
    return { kind: 'success', text: `execution binding adopted for ${ref.workflowId}` }
  }
  const scope = { workflowId: request.workflowId, role: request.role, planId: request.planId }
  executionContextFor({ harnessDir }, { source: 'host', sessionId: facts.sessionId, ...scope })
  const result = await runExecutionCommand(request.argv, identityEnv(process.env, { sessionId: facts.sessionId, ...scope }), invocation.signal)
  return { kind: result.code === 0 ? 'success' : 'error', text: result.code === 0 ? result.stdout : result.stderr || `execution exited with code ${result.code}` }
}

export function registerExecutionSessionCommand(ctx: Context, resolver: HarnessResolver): void {
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register({
      name: 'mstar-execution',
      description: 'Adopt, clear, or run an execution session using native identity',
      input: { hint: '{operation JSON}' },
      handler: (invocation) => handleExecutionCommand(invocation, resolver),
    })
  })
}
