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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  prompt?: Array<{ type: string; text?: string }>
}

/** The prompt payload of one start request. */
function textPrompt(text: string): RecordedRequest {
  return { prompt: [{ type: 'text', text }] }
}

/** One activation spec for the fake provider (the non-consumed fields are additive). */
function specFor(request: RecordedRequest, provider: string = PROVIDER): SubagentActivationSpecView {
  // Boundary cast: the view types only the consumed fields; the signal is the
  // runtime's own (the wrapper forwards the spec spread).
  return { provider, request, signal: new AbortController().signal } as unknown as SubagentActivationSpecView
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
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Role: `fullstack-dev`',
  '',
  '## Task',
  '',
  'Implement the assigned work.',
].join('\n')

const NO_DECLARATION_PROMPT = [
  '## Assignment',
  '',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  '## Task',
  '',
  'Implement the assigned work.',
].join('\n')

const CANONICAL_PROMPT = [
  '## Assignment',
  '',
  'Execute as: fullstack-dev',
  '**Delegation**: forbidden',
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
      // The canonical declaration is the FIRST field line of the Assignment.
      expect(text.startsWith('## Assignment\n\nExecute as: fullstack-dev\n')).toBe(true)
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
      expect(text).toContain('Execute as: writing-specialist')
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

    expect(promptTextOf(provider.starts[0]!.request as RecordedRequest)).toContain('Execute as: writing-specialist')
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

    expect(error.message).toContain('Execute as')
    expect(error.message).toContain('roleGate')
    expect(provider.starts).toHaveLength(0)
  })

  it('(e) hard + no declaration + harness cwd → throws with the fix and the escape hatch', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }))

    expect(error.message).toContain('Execute as')
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
      expect(warnings[0]![1]).toContain('Execute as')
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

  it('(k) an unknown provider does not produce a role-gate error (the service fails its own way)', async () => {
    const { app, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: workspace }, 'ghost-provider'))

    expect(error.message).toContain('NO_PROVIDER')
    expect(error.message).not.toContain('roleGate')
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
      // A wrapped `Execute as` value is not usable as-is (the parsers keep it
      // raw) — it is repaired in place, not treated as canonical.
      'Execute as: `fullstack-dev`',
      'Execute as: "fullstack-dev"',
    ]) {
      const decision = evaluateRoleGate(gateInput(`## Assignment\n\n${line}\n`))
      expect(decision.kind, line).toBe('repair')
      if (decision.kind !== 'repair') continue
      expect(decision.roleId).toBe(EXECUTE_AS)
      expect(decision.evidence).toBe('field')
    }
  })

  it('(p2) `inherit` and non-role-id values are not candidates', () => {
    for (const line of ['Role: inherit', 'Role: FullStack-Dev', 'Role: fullstack dev', 'Role: ']) {
      expect(evaluateRoleGate(gateInput(`## Assignment\n\n${line}\n`)).kind, line).toBe('refuse')
    }
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

  it('(p5) one candidate at each tier with DIFFERENT values → ambiguous, never repaired', () => {
    const text = '## Assignment\n\nRole: fullstack-dev\n\nUse `writing-specialist` for the write-up.\n'
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
    expect(evaluateRoleGate(gateInput('## Assignment\n\n- **Execute as**: fullstack-dev\n')))
      .toEqual({ kind: 'pass', reason: 'canonical' })
    expect(evaluateRoleGate(gateInput('Implement.', { harnessProject: false }))).toEqual({ kind: 'pass', reason: 'non-harness' })
    expect(evaluateRoleGate(gateInput('Implement.', { providerKnown: false }))).toEqual({ kind: 'pass', reason: 'provider-unknown' })
    expect(evaluateRoleGate(gateInput('Implement.', { mode: 'off' }))).toEqual({ kind: 'pass', reason: 'off' })
  })

  it('(p9) warn mode returns the advisory message (the wrapper latches it once per apply)', () => {
    const decision = evaluateRoleGate(gateInput('Implement.', { mode: 'warn' }))
    expect(decision.kind).toBe('warn')
    if (decision.kind !== 'warn') return
    expect(decision.message).toContain('Execute as')
    expect(decision.message).toContain('roleGate')
  })
})

describe('dispatch-role gate — canonical header rewrite', () => {
  it('inserts the declaration as the first field line of an opening Assignment section', () => {
    expect(rewritePromptWithExecuteAs('## Assignment\n\n**Delegation**: forbidden\n', EXECUTE_AS)).toBe(
      '## Assignment\n\nExecute as: fullstack-dev\n**Delegation**: forbidden\n',
    )
  })

  it('prepends the canonical header block when the prompt opens otherwise', () => {
    expect(rewritePromptWithExecuteAs('Implement the work.', EXECUTE_AS)).toBe(
      '## Assignment\n\nExecute as: fullstack-dev\n\nImplement the work.',
    )
  })

  it('replaces an unusable existing `Execute as` value in place (no duplicate field)', () => {
    const rewritten = rewritePromptWithExecuteAs('## Assignment\n\nExecute as: `fullstack-dev`\n**Delegation**: forbidden\n', EXECUTE_AS)
    expect(rewritten).toBe('## Assignment\n\nExecute as: fullstack-dev\n**Delegation**: forbidden\n')
    expect(rewritten.match(/Execute as/g)).toHaveLength(1)
  })

  it('preserves the rest of the prompt byte-for-byte', () => {
    const rest = '**Delegation**: forbidden\n\n## Task\n\n- keep `this`  \n- and this\n'
    const rewritten = rewritePromptWithExecuteAs(`## Assignment\n${rest}`, EXECUTE_AS)
    expect(rewritten.endsWith(rest)).toBe(true)
  })
})
