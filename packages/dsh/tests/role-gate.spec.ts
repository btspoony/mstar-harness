/**
 * Dispatch-role gate — normalize an explicit role declaration into the
 * canonical Assignment header at the ONE subagent start seam
 * (`SubagentRuntime.startActivation`, wrapped by `role-persona.ts`).
 *
 * The suite pins the contract from both ends:
 * - the pure decision function (`evaluateRoleGate`) + rewrite helper: repair
 *   candidates, tier precedence, ambiguity, free-prose exclusion, and the
 *   refusal/advisory text;
 * - the real wiring through a booted composition: the REWRITTEN prompt is what
 *   the recording fake service receives (so the inner preset merge and the
 *   runtime both see the role), `hard` refuses before delegating, `warn`
 *   advises ONCE per apply, `off` is silent, a non-harness `cwd` is exempt,
 *   a canonical prompt is never rewritten, a request carrying `agentPreset` is
 *   untouched, and an unknown provider fails its own way (`NO_PROVIDER`)
 *   instead of producing a role-gate error.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAssignmentFields } from '@mstar-harness/engine'
import {
  FakeSubagentProvider,
  FakeSubagentService,
  bootApp,
  startActivationViaNativeChannel,
  type BootResult,
} from './harness.ts'
import {
  evaluateRoleGate,
  rewritePromptWithExecuteAs,
  setRolePersonaLogger,
  type RoleGateInput,
  type RolePersonaLogLevel,
  type SubagentActivationSpecView,
} from '../src/gates/role-persona.ts'

/** The role the test Assignments declare (also a configured preset key). */
const EXECUTE_AS = 'fullstack-dev'

/** A second declared role (the token tier / ambiguity fixtures). */
const WRITING = 'writing-specialist'

/** A preset id the mounted roster declares and the mapping selects. */
const PRESET_ID = 'mstar-execute'

/** The provider every integration start targets. */
const PROVIDER = 'fake-spawn'

let booted: BootResult | undefined

/** Temp dirs created outside the boot (the non-harness fixture). */
const scratchDirs: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** The request shape `FakeSubagentProvider.starts` records. */
type RecordedRequest = {
  agentPreset?: string
  cwd?: string
  parent?: unknown
  prompt?: Array<{ type: string; text?: string }>
}

/** The prompt payload of one start request. */
function textPrompt(text: string): RecordedRequest {
  return { prompt: [{ type: 'text', text }] }
}

/** A fake spawning agent carrying a session cwd (the omitted-cwd inheritance source). */
function parentAgent(cwd: string): { session: { header: { cwd: string } } } {
  return { session: { header: { cwd } } }
}

/**
 * A `workingDirectory` service answering the session's CURRENT directory —
 * the host's own `get(session)` projection (initialised from `header.cwd`,
 * then following `working-directory/change`). `current` models a parent that
 * `cd`-ed after the session was created.
 */
class FakeWorkingDirectory extends Service {
  current: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  get(session: unknown): string | undefined {
    return this.current ?? (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
  }
}

/**
 * Write a value through the Loader's live volatile config reference — the
 * exact effect a dsh plugin-settings save has on a `volatile` field. Fails
 * loud when the field is not volatile (no live reference was created).
 */
function writeLiveRoleGate(app: BootResult, mode: 'off' | 'warn' | 'hard'): void {
  const config = app.pluginFiber?.effectiveConfig as { roleGate?: Record<symbol, unknown> } | undefined
  const write = (config?.roleGate as Record<symbol, unknown> | undefined)?.[Symbol.for('cosmokit.volatile.write')]
  expect(typeof write, 'the plugin config must carry a live volatile roleGate reference').toBe('function')
  ;(write as (value: unknown) => void)(mode)
}

/**
 * The delegation tool call the `tools/pre-execute` listener gates.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
function subagentCall(prompt: string, agent?: unknown, callId = 'call-1'): ToolExecution {
  return {
    callId: callId as ToolExecution['callId'],
    name: 'subagent',
    arguments: { description: 'probe', prompt },
    ...(agent === undefined ? {} : { agent: agent as ToolExecution['agent'] }),
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/**
 * The registry's bare default decision (the waterfall's terminal `next()`).
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
const allowNext = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

/**
 * A successful dispatch outcome (the around-dispatch waterfall's terminal value).
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
const okResult = { isError: false as const, value: null, content: [] }

/**
 * Run one tool call's body inside the `tools/execute` scope the plugin
 * registers — the seam that lets a start consume THAT call's carrier handoff.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
async function runInCall(app: BootResult, exec: ToolExecution, body: () => Promise<unknown>): Promise<void> {
  await app.ctx.waterfall('tools/execute', exec, async () => {
    await body()
    return okResult
  })
}

/** One activation spec for the fake provider (the non-consumed fields are additive). */
function specFor(request: RecordedRequest, provider: string = PROVIDER): SubagentActivationSpecView {
  // Boundary cast: the view types only the consumed fields; the signal is the
  // runtime's own (the wrapper forwards the spec spread). The spec extends the
  // request since dsh 0.2.2-rc.3, so the request fields sit on the spec.
  return { provider, ...request, signal: new AbortController().signal } as unknown as SubagentActivationSpecView
}

/** The text projection of one recorded request prompt. */
function promptTextOf(request: RecordedRequest): string {
  return (request.prompt ?? []).map((block) => block.text ?? '').join('\n')
}

/** Capture role-persona logs through the module sink (the channel's own logger). */
function captureLogs(): { captured: Array<[RolePersonaLogLevel, string]>; restore: () => void } {
  const captured: Array<[RolePersonaLogLevel, string]> = []
  const prior = setRolePersonaLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => { setRolePersonaLogger(prior) } }
}

/**
 * Boot the fake subagents runtime + the fake preset roster with one
 * preset-capable provider. Both fixture roles are configured preset keys, so
 * the declared role-id set is deterministic (the packaged mirror is a
 * generated, gitignored asset — never a test input).
 */
async function bootWithProvider(
  options: Partial<Parameters<typeof bootApp>[0]> = {},
): Promise<{ app: BootResult; provider: FakeSubagentProvider; workspace: string }> {
  const app = booted = await bootApp({
    subagents: 'fake',
    agentPresetsService: [PRESET_ID],
    rolePresets: { [EXECUTE_AS]: PRESET_ID, [WRITING]: PRESET_ID },
    ...options,
  })
  const provider = new FakeSubagentProvider(PROVIDER, { agentPresetCapability: true })
  ;(app.ctx.subagents as unknown as FakeSubagentService).registerProvider(provider)
  // `app.root` carries the boot's `.mstarc` declaration → a harness project.
  return { app, provider, workspace: app.root }
}

/** Await a start, returning the thrown error instead of failing the test. */
async function startAndCatch(app: BootResult, spec: SubagentActivationSpecView): Promise<Error> {
  const error = await startActivationViaNativeChannel(app, spec).then(() => undefined, (thrown: unknown) => thrown)
  expect(error, 'the start was expected to fail').toBeInstanceOf(Error)
  return error as Error
}

const FIELD_ROLE_PROMPT = [
  '## Assignment',
  '',
  'Role: `fullstack-dev`',
  '',
  '## Task',
  '',
  'Implement the assigned work.',
].join('\n')

/**
 * A fully valid front-matter Assignment missing ONLY the role declaration.
 * see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
 */
const NO_DECLARATION_PROMPT = [
  '---',
  'delegation: forbidden',
  'task_category: logic',
  '---',
  '',
  '## Task',
  '',
  'Implement the assigned work.',
].join('\n')

/**
 * The canonical declaration: `execute_as` in the front matter block.
 * see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
 */
const CANONICAL_PROMPT = [
  '---',
  'execute_as: fullstack-dev',
  'delegation: forbidden',
  '---',
  '',
  '## Task',
  '',
  'Implement the assigned work.',
].join('\n')

/**
 * The D16 regression — the ONE legacy body-label fixture of this spec.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
const LEGACY_BODY_LABEL_PROMPT = [
  '## Assignment',
  '',
  '**Execute as**: fullstack-dev',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  '## Task',
  '',
  'Implement the assigned work.',
].join('\n')

describe('dispatch-role gate — repair + refusal through the start seam', () => {
  it('(a) repairs an explicit `Role:` field into the canonical header (start NOT failed)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const request = { ...textPrompt(FIELD_ROLE_PROMPT), cwd: workspace }
    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor(request))

      expect(provider.starts).toHaveLength(1)
      const sent = provider.starts[0]!.request as RecordedRequest
      const text = promptTextOf(sent)
      // The canonical front matter block is prepended.
      // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
      expect(text.startsWith('---\nexecute_as: fullstack-dev\n---\n')).toBe(true)
      // The rest of the prompt is preserved byte-for-byte.
      expect(text).toContain('Role: `fullstack-dev`\n\n## Task\n\nImplement the assigned work.')
      // The rewritten request reached the INNER consumer: the preset channel
      // parsed the repaired header and selected the role's preset.
      expect(sent.agentPreset).toBe(PRESET_ID)
      // One debug log naming the repaired role and the evidence kind.
      const repairs = captured.filter(([, message]) => message.includes('role gate repaired'))
      expect(repairs).toHaveLength(1)
      expect(repairs[0]![0]).toBe('debug')
      expect(repairs[0]![1]).toContain(EXECUTE_AS)
      expect(repairs[0]![1]).toContain('role field line')
    } finally {
      restore()
    }
  })

  it('(b) repairs a bold declared role id token in prose', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '## Assignment',
      '',
      'You are the **writing-specialist** for this task.',
      '',
      '## Task',
      '',
      'Write the document.',
    ].join('\n')
    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

      const text = promptTextOf(provider.starts[0]!.request as RecordedRequest)
      expect(text).toContain('execute_as: writing-specialist')
      expect(text).toContain('You are the **writing-specialist** for this task.')
      // Evidence kind is the lower-confidence token tier.
      expect(captured.some(([, message]) => message.includes('role gate repaired') && message.includes('role-id token'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('(c) repairs a backticked declared role id token', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = ['## Assignment', '', 'Take the `writing-specialist` seat.', '', '## Task', '', 'Write.'].join('\n')
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    expect(promptTextOf(provider.starts[0]!.request as RecordedRequest)).toContain('execute_as: writing-specialist')
  })

  it('(d) ambiguous (two distinct candidates) is NOT repaired → hard refuses', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '## Assignment',
      '',
      'Role: `fullstack-dev`',
      'Act as: `writing-specialist`',
      '',
      '## Task',
      '',
      'Do it.',
    ].join('\n')
    const error = await startAndCatch(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    expect(error.message).toContain('execute_as')
    expect(error.message).toContain('roleGate')
    expect(provider.starts).toHaveLength(0)
  })

  it('(e) hard + no declaration + harness cwd → throws with the fix and the escape hatch', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }))

    expect(error.message).toContain('execute_as')
    expect(error.message).toContain('roleGate')
    expect(error.message).toContain(workspace)
    expect(provider.starts).toHaveLength(0)
  })

  it('(f) warn → passes, ONE warning per apply, no throw', async () => {
    const { app, provider, workspace } = await bootWithProvider({ roleGate: 'warn' })
    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }))
      await startActivationViaNativeChannel(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }))

      expect(provider.starts).toHaveLength(2)
      const warnings = captured.filter(([level]) => level === 'warn')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]![1]).toContain('execute_as')
      expect(warnings[0]![1]).toContain('roleGate')
    } finally {
      restore()
    }
  })

  it('(g) off → passes silently, no log, no throw', async () => {
    const { app, provider, workspace } = await bootWithProvider({ roleGate: 'off' })
    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }))

      expect(provider.starts).toHaveLength(1)
      expect(captured).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('(h) non-harness cwd → passes under hard', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-plain-'))
    scratchDirs.push(plain)
    const { app, provider } = await bootWithProvider()

    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: plain }))

    expect(provider.starts).toHaveLength(1)
  })

  it('(i) an already-canonical prompt is not rewritten (byte-identical prompt)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const request = { ...textPrompt(CANONICAL_PROMPT), cwd: workspace }
    await startActivationViaNativeChannel(app, specFor(request))

    const sent = provider.starts[0]!.request as RecordedRequest
    // Identity, not equality: the gate returned the request untouched.
    expect(sent.prompt).toBe(request.prompt)
    expect(sent.agentPreset).toBe(PRESET_ID)
  })

  it('(j) a request carrying `agentPreset` is untouched', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const request: RecordedRequest = { ...textPrompt(FIELD_ROLE_PROMPT), cwd: workspace, agentPreset: 'caller-preset' }
    await startActivationViaNativeChannel(app, specFor(request))

    const sent = provider.starts[0]!.request as RecordedRequest
    expect(sent.agentPreset).toBe('caller-preset')
    expect(sent.prompt).toBe(request.prompt)
  })

  it('(j2) an explicit `agentPreset` does not bypass the terminal D16 refusal (recognized retired Assignment)', async () => {
    // The preset exemption is caller intent for the ROLE preset — it never
    // hands a recognized retired body-label Assignment to a provider: the
    // terminal D16 check sits AHEAD of the preset exemption, so the same
    // request without a preset ((p20)) and with one are refused identically.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const { app, provider, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(LEGACY_BODY_LABEL_PROMPT), cwd: workspace, agentPreset: 'caller-preset' }))

    expect(error.message).toContain('legacy-format')
    expect(error.message).toContain('execute_as')
    expect(error.message).toContain('terminal')
    expect(provider.starts).toHaveLength(0)
  })

  it('(k) an unknown provider does not produce a role-gate error (the service fails its own way)', async () => {
    const { app, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }, 'ghost-provider'))

    expect(error.message).toContain('NO_PROVIDER')
    expect(error.message).not.toContain('roleGate')
  })

  it('(l) an omitted cwd inherits the HARNESS parent directory → repaired (not exempt)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    // `subagent` / `subagent_fork` omit `cwd`: the child starts in the parent's directory.
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(FIELD_ROLE_PROMPT), parent: parentAgent(workspace) }))

    const sent = provider.starts[0]!.request as RecordedRequest
    expect(promptTextOf(sent).startsWith('---\nexecute_as: fullstack-dev\n---\n')).toBe(true)
    expect(sent.agentPreset).toBe(PRESET_ID)
  })

  it('(m) an omitted cwd with NO declaration is refused under hard (the default is not inert)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), parent: parentAgent(workspace) }))

    expect(error.message).toContain('execute_as')
    expect(error.message).toContain('roleGate')
    expect(error.message).toContain(workspace)
    expect(provider.starts).toHaveLength(0)
  })

  it('(n) a RELATIVE cwd inside the harness parent is not exempt', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: '.', parent: parentAgent(workspace) }))

    expect(error.message).toContain('execute_as')
    expect(provider.starts).toHaveLength(0)
  })

  it('(o) an omitted cwd inherits a NON-harness parent → passes under hard', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-parent-'))
    scratchDirs.push(plain)
    const { app, provider } = await bootWithProvider()

    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), parent: parentAgent(plain) }))

    expect(provider.starts).toHaveLength(1)
  })

  it('(o1) an omitted cwd inherits the parent workingDirectory projection, not header.cwd (repair)', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-projection-'))
    scratchDirs.push(plain)
    const { app, provider, workspace } = await bootWithProvider()
    // The parent STARTED in `plain` (header.cwd) and then `cd`-ed into the
    // harness project: the runtime resolves the child against the projection.
    const workingDirectory = new FakeWorkingDirectory(app.ctx)
    workingDirectory.current = workspace

    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(FIELD_ROLE_PROMPT), parent: parentAgent(plain) }))

    expect(provider.starts).toHaveLength(1)
    expect(promptTextOf(provider.starts[0]!.request as RecordedRequest).startsWith('---\nexecute_as: fullstack-dev\n---\n')).toBe(true)
  })

  it('(o2) an omitted cwd with NO declaration is refused against the projection (names the child directory)', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-projection-'))
    scratchDirs.push(plain)
    const { app, provider, workspace } = await bootWithProvider()
    const workingDirectory = new FakeWorkingDirectory(app.ctx)
    workingDirectory.current = workspace

    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), parent: parentAgent(plain) }))

    expect(error.message).toContain(workspace)
    expect(error.message).not.toContain(plain)
    expect(provider.starts).toHaveLength(0)
  })

  it('(o3) a parent that cd-ed OUT of the harness project is exempt (header.cwd is not the source)', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-projection-'))
    scratchDirs.push(plain)
    const { app, provider, workspace } = await bootWithProvider()
    const workingDirectory = new FakeWorkingDirectory(app.ctx)
    workingDirectory.current = plain

    await startActivationViaNativeChannel(
      app,
      specFor({ ...textPrompt(NO_DECLARATION_PROMPT), parent: parentAgent(workspace) }),
    )

    expect(provider.starts).toHaveLength(1)
  })

  it('(o4) a RELATIVE cwd resolves against the projection, not header.cwd', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-projection-'))
    scratchDirs.push(plain)
    const { app, provider, workspace } = await bootWithProvider()
    const workingDirectory = new FakeWorkingDirectory(app.ctx)
    workingDirectory.current = workspace

    // `.` is a relative segment (the host's `resolve(parentBase, cwd)`), and
    // resolving it against the plain header would exempt the start.
    const error = await startAndCatch(
      app,
      specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: '.', parent: parentAgent(plain) }),
    )

    expect(error.message).toContain(workspace)
    expect(provider.starts).toHaveLength(0)
  })

  it('(o5) a WHITESPACE-only cwd is a relative segment, not "omitted" (judged where it resolves)', async () => {
    const { app, provider } = await bootWithProvider()
    // why: `resolve(parent, '   ')` lexically resolves INTO the parent, which is
    // where the start is judged: with a NON-harness parent the resolved
    // location governs nothing, so the start proceeds — reading the value as
    // "omitted" would instead have judged it against the harness workspace.
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-ws-cwd-'))
    scratchDirs.push(plain)
    await startActivationViaNativeChannel(
      app,
      specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: '   ', parent: parentAgent(plain) }),
    )

    expect(provider.starts).toHaveLength(1)
  })

  it('(q) a repair over MULTIPLE text blocks resolves to the target role, and a second pass is a no-op', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const blocks = [
      { type: 'text', text: '---\nexecute_as: `fullstack-dev`\n' },
      { type: 'text', text: '---\n' },
    ]
    await startActivationViaNativeChannel(app, specFor({ prompt: blocks, cwd: workspace }))

    const sent = provider.starts[0]!.request as RecordedRequest
    const text = promptTextOf(sent)
    expect(text).toContain('execute_as: fullstack-dev')
    expect(text).not.toContain('`fullstack-dev`')
    // The inner consumer parses the joined text: the canonical field bound the preset.
    expect(sent.agentPreset).toBe(PRESET_ID)
    // Rewriting the already-repaired text changes nothing (idempotent).
    expect(rewritePromptWithExecuteAs(text, EXECUTE_AS)).toBe(text)
  })

  it('(r) a case-variant front matter key is normalized to `execute_as` on the DELEGATED request', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '---',
      'delegation: forbidden',
      'Execute_As: `fullstack-dev`',
      '---',
      '',
      '## Task',
      '',
      'Do it.',
    ].join('\n')
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    const sent = provider.starts[0]!.request as RecordedRequest
    const text = promptTextOf(sent)
    expect(text).toContain('\nexecute_as: fullstack-dev\n')
    expect(text).not.toContain('Execute_As')
    // The downstream parser reads the repaired key.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    expect(sent.agentPreset).toBe(PRESET_ID)
  })

  it('(s) duplicate front matter role keys collapse to ONE canonical line (the strict parser refuses duplicates)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '---',
      'role: `fullstack-dev`',
      'act_as: **fullstack-dev**',
      '---',
      '',
      '## Task',
      '',
      'Do it.',
    ].join('\n')
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    const text = promptTextOf(provider.starts[0]!.request as RecordedRequest)
    expect(text.match(/^execute_as: fullstack-dev$/gm)).toHaveLength(1)
    expect(text).not.toContain('act_as')
    // The collapsed key parses, so the inner consumer selected the preset.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    expect((provider.starts[0]!.request as RecordedRequest).agentPreset).toBe(PRESET_ID)
  })

  it('(t) a live roleGate save is observed by the NEXT start (plugin settings form path)', async () => {
    const { app, provider, workspace } = await bootWithProvider({ roleGate: 'off' })
    // `off`: a start with no declaration passes silently.
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }))
    expect(provider.starts).toHaveLength(1)
    // The dsh plugin settings form saves through the live volatile field — no
    // remount, no re-apply.
    writeLiveRoleGate(app, 'hard')
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }))

    expect(error.message).toContain('roleGate')
    expect(provider.starts).toHaveLength(1)
  })

  it('(u) a fenced `execute_as` quote is never a candidate — hard refuses the missing declaration', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '## Assignment',
      '',
      '````markdown',
      'execute_as: fullstack-dev',
      '````',
      '',
      '## Task',
      '',
      'Implement.',
    ].join('\n')
    const error = await startAndCatch(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    // A quoted example is evidence, not a declaration: the fence masks it in
    // both the candidate scan and the rewrite, so the verdict is the missing-
    // declaration refusal.
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    expect(error.message).toContain('carries no role declaration')
    expect(error.message).toContain('execute_as')
    expect(error.message).toContain('roleGate')
    expect(provider.starts).toHaveLength(0)
  })

  it('(v) a fenced `## Task` truncates the raw header → repaired BEFORE the truncation point (the seam binds)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '## Assignment',
      '',
      '```',
      '## Task',
      '```',
      '',
      'Execute as: fullstack-dev',
      '',
      '## Task',
      '',
      'Implement.',
    ].join('\n')
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    const sent = provider.starts[0]!.request as RecordedRequest
    const text = promptTextOf(sent)
    // The canonical line lands before the fenced `## Task` — inside the raw
    // header the binding seam parses, not merely somewhere in the prompt.
    expect(text.startsWith('---\nexecute_as: fullstack-dev\n---\n')).toBe(true)
    // The FINAL selection on the delegated request (not just the verdict kind).
    expect(sent.agentPreset).toBe(PRESET_ID)
  })

  it('(w) a repair the seam would NOT bind is never claimed — hard refuses, nothing starts', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    // The front matter declares the role but the block is not valid YAML:
    // replacing the role key cannot make the strict parser read it, so the
    // proof fails and "repaired" is never claimed.
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    const prompt = [
      '---',
      'role: `fullstack-dev`',
      'broken: {',
      '---',
      '',
      '## Task',
      '',
      'Implement.',
    ].join('\n')
    const error = await startAndCatch(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    // The real cause: a role IS declared, it just cannot be normalized.
    expect(error.message).toContain(`declares the role '${EXECUTE_AS}'`)
    expect(error.message).not.toContain('carries no role declaration')
    // The fix names the form that always binds, and the escape hatch stays.
    expect(error.message).toContain(`'execute_as: ${EXECUTE_AS}' as the ONLY role declaration`)
    expect(error.message).toContain('above any fenced block')
    expect(error.message).toContain('roleGate')
    expect(provider.starts).toHaveLength(0)
  })

  it('(x) an `Assignment file:` pointer binds the gate and the preset exactly as the inline form (compass D14)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    // Inline control: the canonical document selects the role's preset.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(CANONICAL_PROMPT), cwd: workspace }))
    expect(provider.starts).toHaveLength(1)
    const inline = provider.starts[0]!.request as RecordedRequest
    expect(inline.agentPreset).toBe(PRESET_ID)
    expect(promptTextOf(inline)).toBe(CANONICAL_PROMPT)

    // The SAME document passed as a pointer under the accepted harness home:
    // the gate resolves it before role evaluation, and the preset merge reads
    // the document — never the pointer line.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const assignmentsDir = join(app.harnessDir, 'assignments')
    mkdirSync(assignmentsDir, { recursive: true })
    const file = join(assignmentsDir, 'pointer-assignment.md')
    writeFileSync(file, CANONICAL_PROMPT)
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(`Assignment file: ${file}`), cwd: workspace }))

    expect(provider.starts).toHaveLength(2)
    const sent = provider.starts[1]!.request as RecordedRequest
    expect(sent.agentPreset).toBe(PRESET_ID)
    // The child receives the RESOLVED document (the re-carried inline form),
    // so the pointer and inline starts deliver the same prompt content.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    expect(promptTextOf(sent)).toBe(CANONICAL_PROMPT)
  })

  it('(y) a pointer OUTSIDE every accepted assignment home propagates the resolver refusal (no containment bypass)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const outside = join(app.root, 'outside-assignment.md')
    writeFileSync(outside, CANONICAL_PROMPT)
    const error = await startAndCatch(app, specFor({ ...textPrompt(`Assignment file: ${outside}`), cwd: workspace }))

    expect(error.message).toContain('dispatch.assignment.path')
    expect(error.message).toContain('roleGate')
    expect(provider.starts).toHaveLength(0)
  })

  it('(z) a MISSING declaration inside the pointer document is refused exactly as the inline form (hard)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const assignmentsDir = join(app.harnessDir, 'assignments')
    mkdirSync(assignmentsDir, { recursive: true })
    const file = join(assignmentsDir, 'no-declaration.md')
    writeFileSync(file, NO_DECLARATION_PROMPT)
    const error = await startAndCatch(app, specFor({ ...textPrompt(`Assignment file: ${file}`), cwd: workspace }))

    expect(error.message).toContain('execute_as')
    expect(error.message).toContain('roleGate')
    expect(provider.starts).toHaveLength(0)
  })

  it('(aa) a refused pointer is terminal — no roleGate mode or role exemption softens it', async () => {
    // `off` is the documented rollback for ordinary gate verdicts; a source
    // refusal has no verified document, so the start is still refused.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    const { app, provider, workspace } = await bootWithProvider({ roleGate: 'off' })
    const outside = join(app.root, 'outside-assignment.md')
    writeFileSync(outside, CANONICAL_PROMPT)

    const error = await startAndCatch(app, specFor({ ...textPrompt(`Assignment file: ${outside}`), cwd: workspace }))
    expect(error.message).toContain('dispatch.assignment.path')
    expect(error.message).toContain('terminal')
    expect(provider.starts).toHaveLength(0)

    // A non-harness start directory exempts the ordinary gate, never the
    // terminal refusal.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-plain-'))
    scratchDirs.push(plain)
    const exempt = await startAndCatch(app, specFor({ ...textPrompt(`Assignment file: ${outside}`), parent: parentAgent(plain) }))
    expect(exempt.message).toContain('dispatch.assignment.path')
    expect(provider.starts).toHaveLength(0)
  })

  it('(ab) a start that traversed pre-execution runs the document the gate decided on, not a second read', async () => {
    const { app, provider, workspace } = await bootWithProvider({ dispatchBinding: 'project-manager' })
    const assignmentsDir = join(app.harnessDir, 'assignments')
    mkdirSync(assignmentsDir, { recursive: true })
    const file = join(assignmentsDir, 'one-read.md')
    writeFileSync(file, CANONICAL_PROMPT)
    const pointer = `Assignment file: ${file}`
    const caller = parentAgent(workspace)
    const exec = subagentCall(pointer, caller, 'call-one-read')

    const decision = await app.ctx.waterfall('tools/pre-execute', exec, allowNext)
    expect(decision.kind).toBe('allow')

    // Controlled boundary, no timer: the file is rewritten AFTER the gate's
    // decision and BEFORE the start seam runs. A second read would start the
    // child on the rewritten document.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    writeFileSync(file, CANONICAL_PROMPT.replace(EXECUTE_AS, WRITING))
    await runInCall(app, exec, () => startActivationViaNativeChannel(app, specFor({ ...textPrompt(pointer), cwd: workspace, parent: caller })))

    expect(provider.starts).toHaveLength(1)
    const sent = provider.starts[0]!.request as RecordedRequest
    expect(promptTextOf(sent)).toBe(CANONICAL_PROMPT)
    expect(sent.agentPreset).toBe(PRESET_ID)
  })

  it('(ac) overlapping admitted calls from one parent each consume their OWN resolved document', async () => {
    const { app, provider, workspace } = await bootWithProvider({ dispatchBinding: 'project-manager' })
    const assignmentsDir = join(app.harnessDir, 'assignments')
    mkdirSync(assignmentsDir, { recursive: true })
    const file = join(assignmentsDir, 'overlap.md')
    writeFileSync(file, CANONICAL_PROMPT)
    const pointer = `Assignment file: ${file}`
    const caller = parentAgent(workspace)
    const rewritten = CANONICAL_PROMPT.replace(EXECUTE_AS, WRITING)

    // Two calls on the SAME pointer text and parent: the second admission
    // resolves the rewritten document. A handoff keyed by parent + text would
    // let the second overwrite the first's snapshot.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const first = subagentCall(pointer, caller, 'call-overlap-a')
    const second = subagentCall(pointer, caller, 'call-overlap-b')
    expect((await app.ctx.waterfall('tools/pre-execute', first, allowNext)).kind).toBe('allow')
    writeFileSync(file, rewritten)
    expect((await app.ctx.waterfall('tools/pre-execute', second, allowNext)).kind).toBe('allow')

    await runInCall(app, first, () => startActivationViaNativeChannel(app, specFor({ ...textPrompt(pointer), cwd: workspace, parent: caller })))
    await runInCall(app, second, () => startActivationViaNativeChannel(app, specFor({ ...textPrompt(pointer), cwd: workspace, parent: caller })))

    expect(provider.starts).toHaveLength(2)
    const startedFirst = provider.starts[0]!.request as RecordedRequest
    const startedSecond = provider.starts[1]!.request as RecordedRequest
    expect(promptTextOf(startedFirst)).toBe(CANONICAL_PROMPT)
    expect(startedFirst.agentPreset).toBe(PRESET_ID)
    expect(promptTextOf(startedSecond)).toBe(rewritten)
  })

  it('(ad) an admitted call that starts nothing leaves no snapshot for a later start', async () => {
    const { app, provider, workspace } = await bootWithProvider({ dispatchBinding: 'project-manager' })
    const assignmentsDir = join(app.harnessDir, 'assignments')
    mkdirSync(assignmentsDir, { recursive: true })
    const file = join(assignmentsDir, 'orphan.md')
    writeFileSync(file, CANONICAL_PROMPT)
    const pointer = `Assignment file: ${file}`
    const caller = parentAgent(workspace)
    const rewritten = CANONICAL_PROMPT.replace(EXECUTE_AS, WRITING)

    const exec = subagentCall(pointer, caller, 'call-orphan')
    expect((await app.ctx.waterfall('tools/pre-execute', exec, allowNext)).kind).toBe('allow')
    // The call runs without an activation (a downstream denial or a carrier
    // that starts no child): its handoff must die with the call.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    await runInCall(app, exec, async () => {})
    writeFileSync(file, rewritten)

    // A later direct start resolves the source ITSELF — never the dropped
    // snapshot of an earlier call.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(pointer), cwd: workspace, parent: caller }))

    expect(provider.starts).toHaveLength(1)
    const sent = provider.starts[0]!.request as RecordedRequest
    expect(promptTextOf(sent)).toBe(rewritten)
  })

  it('(ae) a preflight denial leaves no snapshot for a later call that reuses the caller id', async () => {
    const { app, provider, workspace } = await bootWithProvider({ dispatchBinding: 'project-manager' })
    const assignmentsDir = join(app.harnessDir, 'assignments')
    mkdirSync(assignmentsDir, { recursive: true })
    const file = join(assignmentsDir, 'denied.md')
    writeFileSync(file, CANONICAL_PROMPT)
    const pointer = `Assignment file: ${file}`
    const caller = parentAgent(workspace)

    // A downstream listener denies AFTER this gate admitted the call: the
    // preflight publishes its carrier, then the call never reaches
    // `tools/execute` (no body, no settle).
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    let denyNext = true
    app.ctx.on('tools/pre-execute', (_exec, next) => {
      if (!denyNext) return next()
      denyNext = false
      return Promise.resolve<PreToolDecision>({ kind: 'deny', reason: 'downstream denial' })
    })
    const denied = subagentCall(pointer, caller, 'call-reused')
    expect((await app.ctx.waterfall('tools/pre-execute', denied, allowNext)).kind).toBe('deny')

    // The file is rewritten; the later invocation is a DIFFERENT execution that
    // happens to spell the same caller id and carries its own inline document.
    // The denied call's document must not surface as this call's carrier.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    writeFileSync(file, CANONICAL_PROMPT.replace(EXECUTE_AS, WRITING))
    const inline = CANONICAL_PROMPT.replace(EXECUTE_AS, WRITING)
    const later = subagentCall(inline, caller, 'call-reused')
    expect((await app.ctx.waterfall('tools/pre-execute', later, allowNext)).kind).toBe('allow')
    await runInCall(app, later, () => startActivationViaNativeChannel(app, specFor({ ...textPrompt(inline), cwd: workspace, parent: caller })))

    expect(provider.starts).toHaveLength(1)
    const sent = provider.starts[0]!.request as RecordedRequest
    expect(promptTextOf(sent)).toBe(inline)
  })
})

/** Pure decision inputs: a harness project that declares both fixture roles. */
function gateInput(text: string, overrides: Partial<RoleGateInput> = {}): RoleGateInput {
  return {
    request: { prompt: [{ type: 'text', text }] },
    mode: 'hard',
    cwd: '/workspace/repo',
    harnessProject: true,
    providerKnown: true,
    declaredRoleIds: new Set([EXECUTE_AS, WRITING]),
    ...overrides,
  }
}

describe('dispatch-role gate — pure decision table (evaluateRoleGate)', () => {
  it('(p1) normalizes a role field value: leading `@`, quotes, backticks, bold label', () => {
    for (const line of [
      'Role: @fullstack-dev',
      'Act as: "fullstack-dev"',
      'Role: `fullstack-dev`',
      '**Role**: fullstack-dev',
      '- **Role**: fullstack-dev',
      // A wrapped legacy `Execute as` label value is not usable as-is — it is
      // repaired into front matter, not treated as canonical.
      // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
      'Execute as: `fullstack-dev`',
      'Execute as: "fullstack-dev"',
    ]) {
      const decision = evaluateRoleGate(gateInput(`## Assignment\n\n${line}\n`))
      expect(decision.kind, line).toBe('repair')
      if (decision.kind !== 'repair') continue
      expect(decision.roleId).toBe(EXECUTE_AS)
      expect(decision.evidence).toBe('field')
      // The repaired request — not only its metadata — carries a header the
      // binding seam's own reader resolves to the target role.
      const repaired = (decision.request.prompt ?? []).map((block) => block.text ?? '').join('\n')
      expect(parseAssignmentFields(repaired).executeAs, line).toBe(EXECUTE_AS)
    }
  })

  it('(p2) a present-but-unusable role value names that value (never a missing declaration)', () => {
    for (const [text, raw] of [
      ['## Assignment\n\nRole: inherit\n', 'inherit'],
      ['## Assignment\n\nRole: FullStack-Dev\n', 'FullStack-Dev'],
      ['## Assignment\n\nRole: fullstack dev\n', 'fullstack dev'],
      ['## Assignment\n\nRole: \n', ''],
      ['---\nexecute_as:\n---\n', ''],
      ['---\nexecute_as: FullStack-Dev\n---\n', 'FullStack-Dev'],
    ] as const) {
      const decision = evaluateRoleGate(gateInput(text))
      expect(decision.kind, text).toBe('refuse')
      if (decision.kind !== 'refuse') continue
      // The field IS there: the cause must be its value, with the requirement.
      expect(decision.message, text).not.toContain('carries no role declaration')
      expect(decision.message, text).toContain('lowercase role id')
      expect(decision.message, text).toContain(raw === '' ? 'an empty value' : raw)
      expect(decision.message, text).toContain('roleGate')
    }
    // warn advises with the same cause; off stays the rollback.
    const warn = evaluateRoleGate(gateInput('---\nexecute_as: FullStack-Dev\n---\n', { mode: 'warn' }))
    expect(warn.kind).toBe('warn')
    if (warn.kind === 'warn') {
      expect(warn.message).toContain('FullStack-Dev')
      expect(warn.message).not.toContain('carries no role declaration')
    }
    expect(evaluateRoleGate(gateInput('---\nexecute_as:\n---\n', { mode: 'off' }))).toEqual({ kind: 'pass', reason: 'off' })
  })

  it('(p3) a bold/backticked DECLARED id is the lower-confidence token tier', () => {
    const decision = evaluateRoleGate(gateInput('Take the **writing-specialist** seat.'))
    expect(decision.kind).toBe('repair')
    if (decision.kind !== 'repair') return
    expect(decision.roleId).toBe(WRITING)
    expect(decision.evidence).toBe('token')
  })

  it('(p4) two distinct candidates at the SAME tier → ambiguous, never repaired', () => {
    expect(evaluateRoleGate(gateInput('## Assignment\n\nRole: fullstack-dev\nRole: writing-specialist\n')).kind).toBe('refuse')
  })

  it('(p5) the token tier is header-scoped: a BODY mention never competes with a header field', () => {
    const text = '## Assignment\n\nRole: fullstack-dev\n\n## Task\n\nUse `writing-specialist` for the write-up.\n'
    const decision = evaluateRoleGate(gateInput(text))
    // The body sentence quotes a role id but is not a declaration; the header
    // field is the only candidate, so the prompt is repaired to it.
    expect(decision.kind).toBe('repair')
    if (decision.kind !== 'repair') return
    expect(decision.roleId).toBe(EXECUTE_AS)
    expect(decision.evidence).toBe('field')
    // A bare body mention with no header declaration falls to the refusal.
    const bodyOnly = '## Assignment\n\n**Delegation**: forbidden\n\n## Task\n\nUse `writing-specialist` for the write-up.\n'
    expect(evaluateRoleGate(gateInput(bodyOnly)).kind).toBe('refuse')
  })

  it('(p5b) one candidate at each tier with DIFFERENT values → ambiguous, never repaired', () => {
    const text = '## Assignment\n\nRole: fullstack-dev\n\n**writing-specialist**\n\n## Task\n\nDo it.\n'
    expect(evaluateRoleGate(gateInput(text)).kind).toBe('refuse')
  })

  it('(p6) the SAME value at both tiers is not ambiguous', () => {
    const text = '## Assignment\n\nRole: fullstack-dev\n\nUse `fullstack-dev` for the work.\n'
    const decision = evaluateRoleGate(gateInput(text))
    expect(decision.kind).toBe('repair')
    if (decision.kind === 'repair') expect(decision.evidence).toBe('field')
  })

  it('(p7) free prose is never mined — even when it names a declared role', () => {
    for (const text of [
      'You are an architect doing the design review.',
      'You are a fresh-context L2 reviewer.',
      'You are the fullstack-dev for this task.',
    ]) {
      expect(evaluateRoleGate(gateInput(text, { declaredRoleIds: new Set([EXECUTE_AS, 'architect']) })).kind, text).toBe('refuse')
    }
  })

  it('(p8) exempt paths are silent passes: agentPreset, canonical header, non-harness cwd, unknown provider', () => {
    expect(evaluateRoleGate(gateInput('Implement.', { request: { prompt: [], agentPreset: 'caller-preset' } })))
      .toEqual({ kind: 'pass', reason: 'agent-preset' })
    expect(evaluateRoleGate(gateInput(CANONICAL_PROMPT))).toEqual({ kind: 'pass', reason: 'canonical' })
    expect(evaluateRoleGate(gateInput('---\nexecute_as: inherit\n---\n')))
      .toEqual({ kind: 'pass', reason: 'canonical' })
    expect(evaluateRoleGate(gateInput('Implement.', { harnessProject: false }))).toEqual({ kind: 'pass', reason: 'non-harness' })
    expect(evaluateRoleGate(gateInput('Implement.', { providerKnown: false }))).toEqual({ kind: 'pass', reason: 'provider-unknown' })
    expect(evaluateRoleGate(gateInput('Implement.', { mode: 'off' }))).toEqual({ kind: 'pass', reason: 'off' })
  })

  it('(p9) warn mode returns the advisory message (the wrapper latches it once per apply)', () => {
    const decision = evaluateRoleGate(gateInput('Implement.', { mode: 'warn' }))
    expect(decision.kind).toBe('warn')
    if (decision.kind !== 'warn') return
    expect(decision.message).toContain('execute_as')
    expect(decision.message).toContain('roleGate')
  })

  it('(p10) an ambiguous declaration names the ids and demands exactly one (not "missing")', () => {
    const ambiguous = evaluateRoleGate(gateInput('## Assignment\n\nRole: fullstack-dev\nAct as: writing-specialist\n'))
    expect(ambiguous.kind).toBe('refuse')
    if (ambiguous.kind !== 'refuse') return
    expect(ambiguous.message).toContain('exactly one')
    expect(ambiguous.message).toContain(EXECUTE_AS)
    expect(ambiguous.message).toContain(WRITING)
    expect(ambiguous.message).not.toContain('carries no role declaration')
    expect(ambiguous.message).toContain('roleGate')
  })

  it('(p11) zero candidates keeps the missing-declaration wording', () => {
    const missing = evaluateRoleGate(gateInput('Implement.'))
    expect(missing.kind).toBe('refuse')
    if (missing.kind !== 'refuse') return
    expect(missing.message).toContain('carries no role declaration')
    expect(missing.message).not.toContain('exactly one')
  })


  it('(p20) the retired body-label Assignment grammar is refused with the legacy-format cause (D16) in every mode', () => {
    // Terminal, exactly like the shared `dispatch.assignment.legacy-format`
    // violation: the retired document declares no front matter, so a mode that
    // only softens ordinary role-declaration verdicts cannot admit the start.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    for (const mode of ['hard', 'warn', 'off'] as const) {
      const decision = evaluateRoleGate(gateInput(LEGACY_BODY_LABEL_PROMPT, { mode }))
      expect(decision.kind, mode).toBe('refuse')
      if (decision.kind !== 'refuse') continue
      expect(decision.message).toContain('legacy-format')
      expect(decision.message).toContain('execute_as')
      expect(decision.message).toContain('terminal')
      // An explicit `agentPreset` bypasses nothing: the terminal D16 check
      // sits ahead of the preset exemption, so every mode refuses the same
      // retired document with a caller-supplied preset selection too.
      // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
      const presetDecision = evaluateRoleGate(gateInput(LEGACY_BODY_LABEL_PROMPT, {
        mode,
        request: { ...gateInput(LEGACY_BODY_LABEL_PROMPT).request, agentPreset: 'caller-preset' },
      }))
      expect(presetDecision.kind, `${mode} + agentPreset`).toBe('refuse')
      if (presetDecision.kind !== 'refuse') continue
      expect(presetDecision.message).toBe(decision.message)
    }
  })
  it('(p12) the warn advisory does not tell a warn-mode operator to set warn', () => {
    const warn = evaluateRoleGate(gateInput('Implement.', { mode: 'warn' }))
    expect(warn.kind).toBe('warn')
    if (warn.kind !== 'warn') return
    expect(warn.message).not.toContain('Escape hatch')
    expect(warn.message).not.toContain("set 'roleGate: warn'")
    expect(warn.message).toContain("set 'roleGate: off'")
    const hard = evaluateRoleGate(gateInput('Implement.'))
    if (hard.kind === 'refuse') expect(hard.message).toContain('Escape hatch')
  })

  it('(p13) fenced code blocks never become repair candidates', () => {
    // A quoted example is not a declaration.
    expect(evaluateRoleGate(gateInput('## Assignment\n\nSee:\n\n```text\nTake the `writing-specialist` seat.\n```\n')).kind)
      .toBe('refuse')
    // The same token outside a fence is a declared-id candidate.
    expect(evaluateRoleGate(gateInput('Take the `writing-specialist` seat.')).kind).toBe('repair')
    // A fenced example of ANOTHER role does not make a real field ambiguous.
    const decision = evaluateRoleGate(gateInput('## Assignment\n\nRole: fullstack-dev\n\n~~~\nUse `writing-specialist`.\n~~~\n'))
    expect(decision.kind).toBe('repair')
    if (decision.kind === 'repair') expect(decision.roleId).toBe(EXECUTE_AS)
  })

  it('(p14) a four-backtick fence keeps its body: no candidate, not repaired', () => {
    const text = [
      '## Assignment',
      '',
      '````markdown',
      'Execute as: `fullstack-dev`',
      'Take the `writing-specialist` seat.',
      '````',
      '',
      '## Task',
      '',
      'Implement.',
    ].join('\n')
    // The fenced field line is wrapped (never canonical), so it can only act
    // as a repair CANDIDATE — and the fence masks it, in both tiers.
    expect(evaluateRoleGate(gateInput(text)).kind).toBe('refuse')
  })

  it('(p15) a fence closes only on its own character and a run at least as long', () => {
    // A tilde line does not close a backtick fence: the token AFTER the fake
    // closer is still fenced (a wrongly accepted tilde would expose it).
    expect(evaluateRoleGate(gateInput('## Assignment\n\n```\n~~~\n`writing-specialist`\n```\n')).kind).toBe('refuse')
    // A same-character, long-enough closer line carrying trailing text is
    // content, not a closer (only the opening fence carries an info string).
    expect(evaluateRoleGate(gateInput('## Assignment\n\n```\n``` not-a-closer\n`writing-specialist`\n```\n')).kind)
      .toBe('refuse')
    // Three backticks do not close a four-backtick opener.
    expect(
      evaluateRoleGate(gateInput('## Assignment\n\n````\n`writing-specialist`\n```\n`writing-specialist`\n````\n')).kind,
    ).toBe('refuse')
    // An unterminated fence keeps its body: its declaration is never a candidate.
    expect(
      evaluateRoleGate(gateInput('## Assignment\n\n```\nrole: `fullstack-dev`\nTake the `writing-specialist` seat.\n'))
        .kind,
    ).toBe('refuse')
    // After the real closer, the same token outside the fence is a candidate again.
    const decision = evaluateRoleGate(
      gateInput('## Assignment\n\n````\n`writing-specialist`\n```\n````\n\nTake the `writing-specialist` seat.\n'),
    )
    expect(decision.kind).toBe('repair')
    if (decision.kind === 'repair') expect(decision.roleId).toBe(WRITING)
  })

  it('(p16) a fully fenced `execute_as` line is never a declaration: hard refuses, warn advises, off passes', () => {
    const text = [
      '---',
      '```text',
      'execute_as: fullstack-dev',
      '```',
      '---',
      '',
      '## Task',
      '',
      'Do it.',
    ].join('\n')
    // The front matter contract is fence-aware at the scan level: a quoted
    // example masks out of the candidate scan, so the verdict is the missing-
    // declaration refusal — never a silent pass that arms a pasted template.
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    const hard = evaluateRoleGate(gateInput(text))
    expect(hard.kind).toBe('refuse')
    if (hard.kind === 'refuse') {
      expect(hard.message).toContain('carries no role declaration')
      expect(hard.message).toContain('execute_as')
      expect(hard.message).toContain('roleGate')
    }
    // `warn` / `off` stay the documented rollbacks.
    const warn = evaluateRoleGate(gateInput(text, { mode: 'warn' }))
    expect(warn.kind).toBe('warn')
    expect(evaluateRoleGate(gateInput(text, { mode: 'off' }))).toEqual({ kind: 'pass', reason: 'off' })
    // The rewrite still never edits fenced content: a fresh front matter
    // block is prepended and the quoted key lines inside it stay intact.
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    const rewritten = rewritePromptWithExecuteAs(text, EXECUTE_AS)
    expect(rewritten.startsWith('---\nexecute_as: fullstack-dev\n')).toBe(true)
    expect(rewritten).toContain('```text\nexecute_as: fullstack-dev\n```')
  })

  it('(p17) a CRLF prompt masks its fences (a fenced declaration is refused, not repaired)', () => {
    const prompt = [
      '## Assignment',
      '',
      '````markdown',
      'Execute as: `fullstack-dev`',
      '````',
      '',
      '## Task',
      '',
      'Implement.',
    ].join('\r\n')
    // `.`/`$` never match past the trailing `\r`: without stripping it for
    // fence recognition every line failed the fence pattern, masking was a
    // no-op and this quoted field line came back as a repair candidate.
    expect(evaluateRoleGate(gateInput(prompt)).kind).toBe('refuse')
    // The rest of the gate is CRLF-agnostic: a real declaration still passes.
    expect(evaluateRoleGate(gateInput('---\r\nexecute_as: fullstack-dev\r\n---\r\n'))).toEqual({
      kind: 'pass',
      reason: 'canonical',
    })
  })

  it('(p18) a repair that cannot parse is never `repair` — the configured mode decides', () => {
    // The front matter declares the role but the block is not valid YAML:
    // replacing the role key cannot make the strict parser read it, so the
    // proof fails and "repaired" is never claimed — the verdict is the
    // configured mode, never a "repaired" claim that leaves the child unbound.
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    const text = [
      '---',
      'role: `fullstack-dev`',
      'broken: {',
      '---',
      '',
      '## Task',
      '',
      'Implement.',
    ].join('\n')
    const hard = evaluateRoleGate(gateInput(text))
    expect(hard.kind).toBe('refuse')
    if (hard.kind === 'refuse') {
      expect(hard.message).toContain(`declares the role '${EXECUTE_AS}'`)
      expect(hard.message).not.toContain('carries no role declaration')
      expect(hard.message).toContain('above any fenced block')
      expect(hard.message).toContain('roleGate')
    }
    const warn = evaluateRoleGate(gateInput(text, { mode: 'warn' }))
    expect(warn.kind).toBe('warn')
    if (warn.kind === 'warn') expect(warn.message).toContain(`declares the role '${EXECUTE_AS}'`)
    expect(evaluateRoleGate(gateInput(text, { mode: 'off' }))).toEqual({ kind: 'pass', reason: 'off' })
  })

  it('(p19) a valid front matter whose role key is repaired in place proves the rewrite', () => {
    const text = [
      '---',
      'delegation: forbidden',
      'role: `fullstack-dev`',
      '---',
      '',
      '## Task',
      '',
      'Implement.',
    ].join('\n')
    const decision = evaluateRoleGate(gateInput(text))
    expect(decision.kind).toBe('repair')
    if (decision.kind !== 'repair') return
    expect(decision.roleId).toBe(EXECUTE_AS)
    const rewritten = (decision.request.prompt ?? []).map((block) => block.text ?? '').join('\n')
    expect(rewritten).toContain(`\nexecute_as: ${EXECUTE_AS}\n`)
    expect(rewritten).toContain('delegation: forbidden')
  })

})

describe('dispatch-role gate — canonical front matter rewrite', () => {
  it('prepends a front matter block when the prompt opens otherwise', () => {
    expect(rewritePromptWithExecuteAs('Implement the work.', EXECUTE_AS)).toBe(
      '---\nexecute_as: fullstack-dev\n---\n\nImplement the work.',
    )
    expect(rewritePromptWithExecuteAs('## Assignment\n\nSome prose.\n', EXECUTE_AS)).toBe(
      '---\nexecute_as: fullstack-dev\n---\n\n## Assignment\n\nSome prose.\n',
    )
  })

  it('replaces an unusable existing `execute_as` scalar in place (no duplicate key)', () => {
    const rewritten = rewritePromptWithExecuteAs('---\nexecute_as: `fullstack-dev`\ndelegation: forbidden\n---\n', EXECUTE_AS)
    expect(rewritten).toBe('---\nexecute_as: fullstack-dev\ndelegation: forbidden\n---\n')
    expect(rewritten.match(/execute_as/g)).toHaveLength(1)
  })

  it('collapses duplicate role-family keys to ONE canonical line (the strict parser refuses duplicates)', () => {
    const rewritten = rewritePromptWithExecuteAs(
      '---\nrole: `fullstack-dev`\nact_as: **fullstack-dev**\n---\n',
      EXECUTE_AS,
    )
    expect(rewritten).toBe('---\nexecute_as: fullstack-dev\n---\n')
  })

  it('normalizes the key of a case-variant declaration to `execute_as`', () => {
    expect(rewritePromptWithExecuteAs('---\nExecute_As: `fullstack-dev`\n---\n', EXECUTE_AS)).toBe(
      '---\nexecute_as: fullstack-dev\n---\n',
    )
    expect(rewritePromptWithExecuteAs('---\nROLE: fullstack-dev\n---\n', EXECUTE_AS)).toBe(
      '---\nexecute_as: fullstack-dev\n---\n',
    )
  })

  it('splices `execute_as` as the first line of an existing front matter block without a role key', () => {
    expect(rewritePromptWithExecuteAs('---\ndelegation: forbidden\n---\n\n## Task\n', EXECUTE_AS)).toBe(
      '---\nexecute_as: fullstack-dev\ndelegation: forbidden\n---\n\n## Task\n',
    )
  })

  it('preserves the rest of the prompt byte-for-byte', () => {
    const rest = '## Assignment\n\nSome prose.\n\n## Task\n\n- keep `this`  \n- and this\n'
    const rewritten = rewritePromptWithExecuteAs(rest, EXECUTE_AS)
    expect(rewritten.endsWith(rest)).toBe(true)
  })

  it('a CRLF document with preceding fields and duplicate role keys repairs without touching unrelated bytes', () => {
    // `\r\n` line endings through the WHOLE document, with unrelated fields
    // before AND after the role keys: before the span-aware offset fix the
    // rewrite drifted one byte per preceding CRLF line, landing the splice
    // inside `task_category` and leaving `\r` fragments around the drop.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    const unrelatedBefore = ['---', 'delegation: forbidden', 'task_category: logic'].join('\r\n')
    const unrelatedAfter = ['---', '', '## Task', '', 'Do it.', '- keep this  ', ''].join('\r\n')
    const document = [unrelatedBefore, 'role: `fullstack-dev`', 'act_as: fullstack-dev', unrelatedAfter].join('\r\n')

    const rewritten = rewritePromptWithExecuteAs(document, EXECUTE_AS)

    // The repaired document parses to the role (the proof the gate claims).
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    expect(parseAssignmentFields(rewritten).executeAs).toBe(EXECUTE_AS)
    // The unrelated preceding fields are byte-identical: the canonical line
    // follows them with the document's own CRLF ending.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    expect(rewritten.startsWith(`${unrelatedBefore}\r\nexecute_as: fullstack-dev`)).toBe(true)
    // The duplicate was dropped WITH its real ending — no orphan `\r`.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    expect(rewritten).not.toContain('act_as')
    expect(rewritten).not.toMatch(/\r[^\n]/)
    // Everything after the role family is byte-identical (the closing fence,
    // the body, trailing whitespace).
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    expect(rewritten.endsWith(`\r\n${unrelatedAfter}`)).toBe(true)
  })

  it('a CRLF single role key replaces in place, keeping the line ending intact', () => {
    const rewritten = rewritePromptWithExecuteAs('---\r\nexecute_as: `fullstack-dev`\r\ndelegation: forbidden\r\n---\r\n', EXECUTE_AS)
    expect(rewritten).toBe('---\r\nexecute_as: fullstack-dev\r\ndelegation: forbidden\r\n---\r\n')
  })
})
