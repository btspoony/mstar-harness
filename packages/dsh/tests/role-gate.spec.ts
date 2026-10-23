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
 * Write a value through the Loader's live volatile config reference — the
 * exact effect a dsh plugin-settings save has on a `volatile` field. Fails
 * loud when the field is not volatile (no live reference was created).
 */
function writeLiveRoleGate(app: BootResult, mode: 'off' | 'warn' | 'hard'): void {
  const config = app.pluginFiber?.config as { roleGate?: Record<symbol, unknown> } | undefined
  const write = (config?.roleGate as Record<symbol, unknown> | undefined)?.[Symbol.for('cosmokit.volatile.write')]
  expect(typeof write, 'the plugin config must carry a live volatile roleGate reference').toBe('function')
  ;(write as (value: unknown) => void)(mode)
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

  it('(l) an omitted cwd inherits the HARNESS parent directory → repaired (not exempt)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    // `subagent` / `spawn_teammate` omit `cwd`: the child starts in the parent's directory.
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(FIELD_ROLE_PROMPT), parent: parentAgent(workspace) }))

    const sent = provider.starts[0]!.request as RecordedRequest
    expect(promptTextOf(sent).startsWith('## Assignment\n\nExecute as: fullstack-dev\n')).toBe(true)
    expect(sent.agentPreset).toBe(PRESET_ID)
  })

  it('(m) an omitted cwd with NO declaration is refused under hard (the default is not inert)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), parent: parentAgent(workspace) }))

    expect(error.message).toContain('Execute as')
    expect(error.message).toContain('roleGate')
    expect(error.message).toContain(workspace)
    expect(provider.starts).toHaveLength(0)
  })

  it('(n) a RELATIVE cwd inside the harness parent is not exempt', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const error = await startAndCatch(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), cwd: '.', parent: parentAgent(workspace) }))

    expect(error.message).toContain('Execute as')
    expect(provider.starts).toHaveLength(0)
  })

  it('(o) an omitted cwd inherits a NON-harness parent → passes under hard', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-role-gate-parent-'))
    scratchDirs.push(plain)
    const { app, provider } = await bootWithProvider()

    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(NO_DECLARATION_PROMPT), parent: parentAgent(plain) }))

    expect(provider.starts).toHaveLength(1)
  })

  it('(q) a repair over MULTIPLE text blocks resolves to the target role, and a second pass is a no-op', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const blocks = [
      { type: 'text', text: '## Assignment\n\n' },
      { type: 'text', text: 'Execute as: `fullstack-dev`\n' },
    ]
    await startActivationViaNativeChannel(app, specFor({ prompt: blocks, cwd: workspace }))

    const sent = provider.starts[0]!.request as RecordedRequest
    const text = promptTextOf(sent)
    expect(text).toContain('Execute as: fullstack-dev')
    expect(text).not.toContain('`fullstack-dev`')
    // The inner consumer parses the joined text: the canonical field bound the preset.
    expect(sent.agentPreset).toBe(PRESET_ID)
    // Rewriting the already-repaired text changes nothing (idempotent).
    expect(rewritePromptWithExecuteAs(text, EXECUTE_AS)).toBe(text)
  })

  it('(r) a lowercase `execute as` is normalized to the canonical label on the DELEGATED request', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '## Assignment',
      '',
      '**Delegation**: forbidden',
      'execute as: `fullstack-dev`',
      '',
      '## Task',
      '',
      'Do it.',
    ].join('\n')
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    const sent = provider.starts[0]!.request as RecordedRequest
    const text = promptTextOf(sent)
    expect(text).toContain('\nExecute as: fullstack-dev\n')
    expect(text).not.toContain('execute as:')
    // The case-sensitive downstream parser reads the repaired field.
    expect(sent.agentPreset).toBe(PRESET_ID)
  })

  it('(s) two same-value `Execute as` lines: every line is repaired (the parser binds the last)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '## Assignment',
      '',
      'Execute as: `fullstack-dev`',
      'Execute as: **fullstack-dev**',
      '',
      '## Task',
      '',
      'Do it.',
    ].join('\n')
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    const text = promptTextOf(provider.starts[0]!.request as RecordedRequest)
    expect(text.match(/^Execute as: fullstack-dev$/gm)).toHaveLength(2)
    // The wrapper's own consumer read the LAST line and selected the preset.
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

  it('(u) a four-backtick fenced declaration in the RAW header binds — the gate agrees (pass)', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    const prompt = [
      '## Assignment',
      '',
      '````markdown',
      'Execute as: fullstack-dev',
      '````',
      '',
      '## Task',
      '',
      'Implement.',
    ].join('\n')
    await startActivationViaNativeChannel(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    const sent = provider.starts[0]!.request as RecordedRequest
    // The header slice is line-based and fence-unaware: the binding seam parses
    // the quoted line, so a gate that refused here would diverge from what the
    // child actually gets. Pass — and the prompt stays byte-identical.
    expect(promptTextOf(sent)).toBe(prompt)
    expect(sent.agentPreset).toBe(PRESET_ID)
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
    expect(text.startsWith('## Assignment\n\nExecute as: fullstack-dev\n')).toBe(true)
    // The FINAL selection on the delegated request (not just the verdict kind).
    expect(sent.agentPreset).toBe(PRESET_ID)
  })

  it('(w) a repair the seam would NOT bind is never claimed — hard refuses, nothing starts', async () => {
    const { app, provider, workspace } = await bootWithProvider()
    // The masked scan finds the real declaration past the fenced `## Task`, so
    // the rewrite inserts the canonical line BEFORE the wrapped field that
    // still wins the raw header read — "repaired" would leave the child
    // unbound.
    const prompt = [
      '## Assignment',
      '',
      '```',
      'Execute as: `fullstack-dev`',
      '## Task',
      '```',
      'Execute as: fullstack-dev',
    ].join('\n')
    const error = await startAndCatch(app, specFor({ ...textPrompt(prompt), cwd: workspace }))

    // The real cause: a role IS declared, it just cannot be normalized.
    expect(error.message).toContain(`declares the role '${EXECUTE_AS}'`)
    expect(error.message).not.toContain('carries no role declaration')
    // The fix names the form that always binds, and the escape hatch stays.
    expect(error.message).toContain(`'Execute as: ${EXECUTE_AS}' as the ONLY role declaration`)
    expect(error.message).toContain('above any fenced block')
    expect(error.message).toContain('roleGate')
    expect(provider.starts).toHaveLength(0)
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
      evaluateRoleGate(gateInput('## Assignment\n\n```\nExecute as: `fullstack-dev`\nTake the `writing-specialist` seat.\n'))
        .kind,
    ).toBe('refuse')
    // After the real closer, the same token outside the fence is a candidate again.
    const decision = evaluateRoleGate(
      gateInput('## Assignment\n\n````\n`writing-specialist`\n```\n````\n\nTake the `writing-specialist` seat.\n'),
    )
    expect(decision.kind).toBe('repair')
    if (decision.kind === 'repair') expect(decision.roleId).toBe(WRITING)
  })

  it('(p16) a fully fenced `Execute as:` line is judged on the RAW header (pass — the seam binds it)', () => {
    const text = [
      '## Assignment',
      '',
      '```text',
      'Execute as: fullstack-dev',
      '```',
      '',
      '**Delegation**: forbidden',
      '',
      '## Task',
      '',
      'Do it.',
    ].join('\n')
    // The binding seam's header slice does not know fences, so it parses the
    // quoted line as the declaration and binds `fullstack-dev`; the gate says
    // the same thing instead of refusing a start that will bind.
    expect(evaluateRoleGate(gateInput(text))).toEqual({ kind: 'pass', reason: 'canonical' })
    // The rewrite still never edits fenced content: the canonical line is
    // inserted after the heading and the quoted block stays intact.
    const rewritten = rewritePromptWithExecuteAs(text, EXECUTE_AS)
    expect(rewritten.startsWith('## Assignment\n\nExecute as: fullstack-dev\n')).toBe(true)
    expect(rewritten).toContain('```text\nExecute as: fullstack-dev\n```')
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
    expect(evaluateRoleGate(gateInput('## Assignment\r\n\r\nExecute as: fullstack-dev\r\n'))).toEqual({
      kind: 'pass',
      reason: 'canonical',
    })
  })

  it('(p18) a repair the seam would NOT bind is never `repair` — the configured mode decides', () => {
    // The masked scan finds the declaration past the fenced `## Task`, so the
    // canonical line is inserted BEFORE the wrapped field that keeps winning
    // the raw header read: the rewrite cannot be proven, so the verdict is the
    // configured mode — never a "repaired" claim that leaves the child unbound.
    const text = [
      '## Assignment',
      '',
      '```',
      'Execute as: `fullstack-dev`',
      '## Task',
      '```',
      'Execute as: fullstack-dev',
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

  it('(p19) a fenced `## Task` whose inserted line DOES win the raw header still repairs', () => {
    // The insertion lands before the truncation point, so the binding seam's
    // own reader resolves the canonical value — the proof accepts the repair.
    const text = [
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
    const decision = evaluateRoleGate(gateInput(text))
    expect(decision.kind).toBe('repair')
    if (decision.kind !== 'repair') return
    expect(decision.roleId).toBe(EXECUTE_AS)
    expect((decision.request.prompt ?? []).map((block) => block.text ?? '').join('\n'))
      .toContain(`\nExecute as: ${EXECUTE_AS}\n`)
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

  it('repairs EVERY `Execute as` line — the engine parser binds the last one', () => {
    const rewritten = rewritePromptWithExecuteAs(
      '## Assignment\n\nExecute as: `fullstack-dev`\nExecute as: **fullstack-dev**\n',
      EXECUTE_AS,
    )
    expect(rewritten).toBe('## Assignment\n\nExecute as: fullstack-dev\nExecute as: fullstack-dev\n')
  })

  it('normalizes the label of a case-variant declaration to `Execute as`', () => {
    expect(rewritePromptWithExecuteAs('## Assignment\n\nexecute as: `fullstack-dev`\n', EXECUTE_AS)).toBe(
      '## Assignment\n\nExecute as: fullstack-dev\n',
    )
    expect(rewritePromptWithExecuteAs('## Assignment\n\n**EXECUTE AS**: fullstack-dev\n', EXECUTE_AS)).toBe(
      '## Assignment\n\nExecute as: fullstack-dev\n',
    )
  })

  it('preserves the rest of the prompt byte-for-byte', () => {
    const rest = '**Delegation**: forbidden\n\n## Task\n\n- keep `this`  \n- and this\n'
    const rewritten = rewritePromptWithExecuteAs(`## Assignment\n${rest}`, EXECUTE_AS)
    expect(rewritten.endsWith(rest)).toBe(true)
  })
})
