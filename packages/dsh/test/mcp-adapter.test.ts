import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import {
  createExecutionWorkflow,
  initializeExecutionAuthority,
  initializeStore,
  type ExecutionCaller,
  type ExecutionContext,
} from '@mstar-harness/engine'
import { getCommandDefinitions } from '@mstar-harness/commands'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { mcpToolName } from '@mstar-harness/mcp'
import { registerExecutionSessionCommand } from '../src/gates/execution-session.ts'
import { HarnessResolver } from '../src/gates/_shared.ts'
import { bootApp, type BootResult } from '../tests/harness.ts'

const SESSION_ID = 'mcp-main-session'
const WORKFLOW_ID = 'mcp-native-workflow'
const PLAN_ID = 'mcp-native-plan'
const STARTED_AT = '2026-09-26T00:00:00.000Z'
const roots: string[] = []
let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agentIn(cwd: string, overrides: Record<string, unknown> = {}): Agent {
  return {
    id: 'mcp-test-agent',
    session: { id: SESSION_ID, header: { id: SESSION_ID, cwd, ...overrides } },
  } as unknown as Agent
}

function toolExec(agent: Agent, name: string, args: Record<string, unknown>): ToolExecutionInput {
  return {
    callId: 'mcp-adapter-test' as ToolExecutionInput['callId'],
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  }
}

async function seededMainSession(harnessDir: string): Promise<string> {
  const initialized = await initializeStore({ harnessDir })
  initialized.close()
  const { token } = await initializeExecutionAuthority({ harnessDir })
  const created = await createExecutionWorkflow(
    {
      harnessDir,
      caller: { sessionId: SESSION_ID, role: 'coordinator', workflowId: WORKFLOW_ID, planId: null } satisfies ExecutionCaller,
    } satisfies ExecutionContext,
    {
      entry: { id: WORKFLOW_ID, type: 'iteration', status: 'running', started_at: STARTED_AT, dir: `workflows/${WORKFLOW_ID}` } as never,
      snapshot: {
        schema_version: 1,
        id: WORKFLOW_ID,
        type: 'iteration',
        status: 'running',
        started_at: STARTED_AT,
        updated_at: STARTED_AT,
        branch: { base: 'main' },
        plans: [{ id: PLAN_ID, plan_id: PLAN_ID, title: 'Native dsh MCP fixture', file: `.mstar/plans/${PLAN_ID}.md`, status: 'Todo' }],
      } as never,
      expected: token,
      operationId: 'create-native-fixture',
    },
  )
  const workflowToken = (created.data as unknown as { workflows: Array<{ workflowToken: string }> }).workflows[0]?.workflowToken
  if (workflowToken === undefined) throw new Error('created workflow has no token')
  return workflowToken
}

function productionExecutionHandler(harnessDir: string): CommandDefinition['handler'] {
  const registered: CommandDefinition[] = []
  const ctx = {
    inject: (_dependencies: string[], callback: (child: unknown) => void) => callback({
      commands: { register: (definition: CommandDefinition) => { registered.push(definition); return () => {} } },
    }),
  }
  registerExecutionSessionCommand(ctx as never, new HarnessResolver(harnessDir))
  const definition = registered[0]
  if (definition === undefined) throw new Error('mstar-execution command was not registered')
  return definition.handler
}

function commandInvocation(agent: Agent, input: unknown): CommandInvocation {
  return {
    commandId: 'mcp-adapter-test',
    agent,
    rawInput: JSON.stringify(input),
    attachments: [],
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
}

describe('dsh native MCP adapter', () => {
  it('registers the full canonical command set and admits a main-session mutation in process', async () => {
    booted = await bootApp()
    const gitInit = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: booted.root, encoding: 'utf8' })
    expect(gitInit.status).toBe(0)
    const initialCommit = spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'fixture'], { cwd: booted.root, encoding: 'utf8' })
    expect(initialCommit.status).toBe(0)
    const definitions = getCommandDefinitions()
    const names = new Set((booted.ctx.tools.schemas() as Array<{ name: string }>).map(({ name }) => name))
    for (const definition of definitions) {
      const canonicalName = mcpToolName(definition.id)
      const collisionName = `mstar_mcp_${definition.id.replace(/[.-]/g, '_')}`
      expect(names.has(canonicalName) || names.has(collisionName), definition.id).toBe(true)
    }
    const agent = agentIn(booted.root)

    const workflowToken = await seededMainSession(booted.harnessDir)
    const result = await booted.ctx.tools.execute(toolExec(agent, 'mstar_plan_bind', {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: booted.harnessDir,
      expect: workflowToken,
      operation: 'bind-from-native-main-session',
      sessionId: 'model-supplied-child-session',
    }))
    expect(result.isError, JSON.stringify(result.value)).toBe(false)
    expect((result.value as { status?: string }).status).toBe('ok')
  })

  it('keeps known-leaf refusal on the native execution-session command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-leaf-'))
    roots.push(root)
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const handler = productionExecutionHandler(harnessDir)
    const leaf = agentIn(root, { origin: 'subagent', delegationDepth: 1 })
    await expect(handler(commandInvocation(leaf, {
      operation: 'run', workflowId: WORKFLOW_ID, role: 'coordinator', planId: null, argv: ['mstar-harness', 'host', 'detect', '--signals', 'functions.*'],
    }))).rejects.toThrow('known leaf sessions cannot adopt, clear, or launch execution')
  })

  it('dispatches non-init mstar argv in process without falling back to a CLI subprocess', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-cutover-'))
    roots.push(root)
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const handler = productionExecutionHandler(harnessDir)
    const inheritedPath = process.env.PATH
    let result: CommandResult
    try {
      process.env.PATH = ''
      result = await handler(commandInvocation(agentIn(root), {
        operation: 'run', workflowId: WORKFLOW_ID, role: 'coordinator', planId: null,
        argv: ['mstar-harness', 'host', 'detect', '--signals', 'functions.*'],
      }))
    } finally {
      if (inheritedPath === undefined) delete process.env.PATH
      else process.env.PATH = inheritedPath
    }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('"command":"host.detect"')
    expect(result.text).toContain('"status":"ok"')
  })

  it('preserves unrelated authorized argv execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-argv-'))
    roots.push(root)
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const handler = productionExecutionHandler(harnessDir)
    const result = await handler(commandInvocation(agentIn(root), {
      operation: 'run', workflowId: WORKFLOW_ID, role: 'coordinator', planId: null,
      argv: [process.execPath, '-e', 'process.stdout.write(\"unrelated\")'],
    }))
    expect(result.kind).toBe('success')
    expect(result.text).toBe('unrelated')
  })
})
