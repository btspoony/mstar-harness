/**
 * Task 3 (H3 / D49) — the human admission surface through its PRODUCTION
 * registration path.
 *
 * Every case registers `/mstar-execution` exactly the way the plugin does
 * (`registerExecutionSessionCommand` → `ctx.inject(['commands'])` → the real
 * `CommandDefinition.handler`) and drives that handler. The positive adopt /
 * clear cases run against the REAL execution authority (a temporary store built
 * by the engine's own producers plus one coordinator bind), never a stub.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import {
  bindExecutionSession,
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  initializeExecutionAuthority,
  initializeStore,
  registerCatalogEntity,
  serializeExecutionValue,
} from '@mstar-harness/engine'
import type { ExecutionCaller, ExecutionContext } from '@mstar-harness/engine'
import { parseExecutionRequest, registerExecutionSessionCommand, runExecutionCommand } from '../src/gates/execution-session.ts'
import { readWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { WorkflowSessionBinding } from '../src/engine-status-store.ts'
import { HarnessResolver } from '../src/gates/_shared.ts'

const TS = '2026-09-21T00:00:00.000Z'
const SESSION_ID = 'session-native'
const WORKFLOW_ID = 'wf-native'
const PLAN_ID = 'plan-native'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-${prefix}-`))
  roots.push(root)
  return root
}

/** The exact `CommandInvocation.agent` shape the handler reads (session.header). */
function agentOf(cwd: string, overrides: Record<string, unknown> = {}): unknown {
  return { id: 'agent-lease-holder', session: { id: SESSION_ID, header: { id: SESSION_ID, cwd, ...overrides } } }
}

function invocationOf(agent: unknown, rawInput: string, signal = new AbortController().signal): CommandInvocation {
  return { commandId: 'cmd-1', agent, rawInput, attachments: [], signal } as unknown as CommandInvocation
}

/**
 * The stored control record, narrowed through the read's OWN discriminant
 * (`unavailable` carries a reason instead of a binding).
 */
function storedBinding(harnessDir: string, cwd: string): WorkflowSessionBinding | undefined {
  const read = readWorkflowSessionBinding(harnessDir, SESSION_ID, cwd)
  return read.kind === 'ok' ? read.binding : undefined
}

/** Register through the PRODUCTION seam and return the registered handler. */
function productionHandler(harnessDir: string): CommandDefinition['handler'] {
  const registered: CommandDefinition[] = []
  const ctx = {
    inject: (_deps: string[], callback: (child: unknown) => void) =>
      callback({ commands: { register: (definition: CommandDefinition) => { registered.push(definition); return () => {} } } }),
  } as unknown as Context
  registerExecutionSessionCommand(ctx, new HarnessResolver(harnessDir))
  const definition = registered[0]
  if (definition === undefined) throw new Error('the execution command did not register')
  expect(definition.name).toBe('mstar-execution')
  return definition.handler
}

/**
 * The REAL execution authority: a temporary store, one registered catalog plan,
 * one created lifecycle whose CREATING identity is the native session, and that
 * identity bound as the workflow's coordinator session.
 */
async function seedNativeAuthority(harnessDir: string): Promise<string> {
  const handle = await initializeStore({ harnessDir })
  handle.close()
  const rootToken = (await initializeExecutionAuthority({ harnessDir })).token
  await registerCatalogEntity(
    { harnessDir },
    { kind: 'plan', id: PLAN_ID, title: `${PLAN_ID} title`, rootKind: 'plans', relativePath: `plans/${PLAN_ID}.md` },
    { operationId: `register-${PLAN_ID}`, actor: 'execution-session.spec' },
  )
  const created = await createExecutionWorkflow(
    {
      harnessDir,
      caller: { sessionId: SESSION_ID, role: 'coordinator', workflowId: WORKFLOW_ID, planId: null } satisfies ExecutionCaller,
    } satisfies ExecutionContext,
    {
      entry: { id: WORKFLOW_ID, type: 'plan', started_at: TS, dir: `workflows/${WORKFLOW_ID}` },
      snapshot: {
        schema_version: 1,
        id: WORKFLOW_ID,
        type: 'plan',
        status: 'running',
        started_at: TS,
        updated_at: TS,
        plans: [{ id: PLAN_ID, title: `${PLAN_ID} title`, file: `plans/${PLAN_ID}.md`, status: 'Todo' }],
        delivery_kind: 'development',
        branch: { source: `feature/${WORKFLOW_ID}`, target: 'main' },
      } as never,
      expected: rootToken,
      operationId: `create-${WORKFLOW_ID}`,
    },
  )
  const workflowToken = created.data.workflows[0]?.workflowToken
  if (workflowToken === undefined) throw new Error('the created lifecycle carries no workflow token')
  const bound = await bindExecutionSession(
    {
      harnessDir,
      caller: { sessionId: SESSION_ID, role: 'coordinator', workflowId: WORKFLOW_ID, planId: null } satisfies ExecutionCaller,
    } satisfies ExecutionContext,
    { workflowId: WORKFLOW_ID, planId: null, role: 'coordinator', expected: workflowToken, operationId: `bind-${WORKFLOW_ID}` },
  )
  return encodeExecutionSessionRef(bound.data)
}

describe('mstar-execution — authoritative non-leaf eligibility', () => {
  it('a known subagent leaf cannot adopt, clear, or run on any operation', async () => {
    const root = await tempRoot('exec-leaf')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const handler = productionHandler(harnessDir)
    const leafAgent = agentOf(root, { origin: 'subagent', delegationDepth: 1 })
    const ref = encodeExecutionSessionRef({
      storeId: '00000000-0000-4000-8000-000000000000', epoch: 1, workflowId: WORKFLOW_ID, role: 'coordinator', sessionId: SESSION_ID, planId: null,
    })
    for (const input of [
      JSON.stringify({ operation: 'adopt', sessionRef: ref }),
      '{"operation":"clear"}',
      JSON.stringify({ operation: 'run', workflowId: WORKFLOW_ID, role: 'coordinator', planId: null, argv: [process.execPath, '-e', '0'] }),
    ]) {
      await expect(handler(invocationOf(leafAgent, input))).rejects.toThrow('known leaf sessions cannot adopt, clear, or launch execution')
    }
  })

  it('delegation depth alone marks a leaf (origin absent)', async () => {
    const root = await tempRoot('exec-leaf-depth')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const handler = productionHandler(harnessDir)
    await expect(handler(invocationOf(agentOf(root, { delegationDepth: 2 }), '{"operation":"clear"}')))
      .rejects.toThrow('known leaf sessions cannot adopt, clear, or launch execution')
  })
})

describe('mstar-execution — native run and child identity transport', () => {
  it('a root run launches argv shell-free with the canonical identity and no spoof keys', async () => {
    const root = await tempRoot('exec-run')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const handler = productionHandler(harnessDir)
    const spoofs = {
      MSTAR_HOST_SESSION_ID: 'host-session-spoof',
      MSTAR_HARNESS_DIR: '/spoofed/harness',
      MSTAR_CALLER_ID: 'spoofed-caller',
      MSTAR_EXECUTION_SESSION_ID: 'spoofed-session',
    }
    const previous = Object.fromEntries(Object.keys(spoofs).map((key) => [key, process.env[key]]))
    Object.assign(process.env, spoofs)
    try {
      const source = 'const e=process.env;const slot=(key)=>{const v=e[key];return v===undefined?"<absent>":v};'
        + 'process.stdout.write([slot("MSTAR_EXECUTION_IDENTITY"),slot("MSTAR_HOST_SESSION_ID"),slot("MSTAR_HARNESS_DIR"),slot("MSTAR_CALLER_ID"),slot("MSTAR_EXECUTION_SESSION_ID")].join("|"))'
      const result = await handler(invocationOf(agentOf(root), JSON.stringify({
        operation: 'run', workflowId: WORKFLOW_ID, role: 'coordinator', planId: null,
        argv: [process.execPath, '-e', source],
      })))
      const identity = serializeExecutionValue({ source: 'host', sessionId: SESSION_ID, workflowId: WORKFLOW_ID, role: 'coordinator', planId: null })
      expect(result).toEqual({ kind: 'success', text: `${identity}|<absent>|<absent>|<absent>|<absent>` })
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('a cancelled execution run rejects instead of reporting success', async () => {
    const root = await tempRoot('exec-cancel')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const handler = productionHandler(harnessDir)
    const controller = new AbortController()
    controller.abort()
    await expect(handler(invocationOf(agentOf(root), JSON.stringify({
      operation: 'run', workflowId: WORKFLOW_ID, role: 'coordinator', planId: null,
      argv: [process.execPath, '-e', 'process.stdout.write("late")'],
    }), controller.signal))).rejects.toThrow('execution child cancelled')
  })
})

describe('mstar-execution — canonical native adoption', () => {
  it('adopts the current C1 session then clears it while preserving the selection', async () => {
    const root = await tempRoot('exec-adopt')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const ref = await seedNativeAuthority(harnessDir)
    const handler = productionHandler(harnessDir)

    await expect(handler(invocationOf(agentOf(root), JSON.stringify({ operation: 'adopt', sessionRef: ref }))))
      .resolves.toEqual({ kind: 'success', text: `execution binding adopted for ${WORKFLOW_ID}` })
    const adopted = storedBinding(harnessDir, root)
    expect(adopted?.selectedWorkflowId).toBe(WORKFLOW_ID)
    expect(adopted?.executionBinding?.session.workflowId).toBe(WORKFLOW_ID)

    await expect(handler(invocationOf(agentOf(root), '{"operation":"clear"}')))
      .resolves.toEqual({ kind: 'success', text: 'execution binding cleared' })
    const cleared = storedBinding(harnessDir, root)
    expect(cleared?.executionBinding ?? null).toBeNull()
    expect(cleared?.selectedWorkflowId).toBe(WORKFLOW_ID)
  })

  it('refuses a reference that does not name the carrying native session', async () => {
    const root = await tempRoot('exec-adopt-mismatch')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const ref = await seedNativeAuthority(harnessDir)
    const handler = productionHandler(harnessDir)
    const foreign = encodeExecutionSessionRef({
      storeId: '00000000-0000-4000-8000-000000000000', epoch: 1, workflowId: WORKFLOW_ID, role: 'coordinator', sessionId: 'other-session', planId: null,
    })
    const copied = encodeExecutionSessionRef({
      storeId: '00000000-0000-4000-8000-000000000001', epoch: 1, workflowId: WORKFLOW_ID, role: 'coordinator', sessionId: SESSION_ID, planId: null,
    })
    await expect(handler(invocationOf(agentOf(root), JSON.stringify({ operation: 'adopt', sessionRef: foreign }))))
      .rejects.toThrow('session reference does not match the native carrying session')
    // A copied reference names the right session but a foreign store: the engine
    // resume refuses it and nothing is adopted.
    await expect(handler(invocationOf(agentOf(root), JSON.stringify({ operation: 'adopt', sessionRef: copied }))))
      .rejects.toThrow(/scope-mismatch|store/)
    expect(storedBinding(harnessDir, root)?.executionBinding ?? null).toBeNull()
  })
})

describe('mstar-execution — closed input union and launcher guard', () => {
  it('accepts only the closed operation union and rejects model-shaped extras', () => {
    expect(parseExecutionRequest('{"operation":"clear"}')).toEqual({ operation: 'clear' })
    expect(() => parseExecutionRequest('{"operation":"clear","sessionId":"model-input"}')).toThrow('clear does not accept extra fields')
    expect(() => parseExecutionRequest('{"operation":"run","workflowId":"w","role":"coordinator","planId":null,"argv":["a"],"extra":1}'))
      .toThrow('run requires workflowId, role, planId, and a non-empty argv')
  })

  it('rejects an empty argv before launching a child', async () => {
    await expect(runExecutionCommand([], process.env, new AbortController().signal)).rejects.toThrow('execution argv must be non-empty')
  })
})
