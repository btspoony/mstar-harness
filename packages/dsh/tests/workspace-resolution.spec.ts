/**
 * Workspace-root `{HARNESS_DIR}` resolution (the "never probe from the
 * process cwd" contract): the plugin resolves the harness dir from the
 * WORKSPACE root of the session whose agent drives each event — the session
 * cwd (`agent.session.header.cwd`) — never from `process.cwd()`.
 *
 * Covered:
 *  1. HarnessResolver unit semantics — explicit config wins outright; a
 *     missing workspace resolves to null (no process-cwd probe); the probe
 *     starts from the given workspace root; results are memoized per root.
 *  1b. Workspace-root boundary (roadmap §7c) — the probe stops AT the session
 *     workspace (`workspaceRoot = cwd`): a harness dir anywhere above it is
 *     never returned (the `~/.mstar` global-collision fixture), even inside a
 *     git repo where the engine's default boundary would have walked up; a
 *     workspace-local harness still resolves; explicit `config.harnessDir`
 *     stays authoritative outside the boundary.
 *  2. Pre-step catalog — no-config boot: an agent carrying a session cwd
 *     watermarks the WORKSPACE's harness dir; an agent-less event shows
 *     `harness dir: none` even though the process cwd walk-up would reach
 *     a global `~/.mstar` on this machine (regression proof: the old code
 *     probed from `process.cwd()`).
 *  3. Status gate — no-config boot: an fs intent whose actor carries the
 *     session agent gates the WORKSPACE's status.json; an agent-less actor
 *     is inert (no harness dir).
 *  4. Digest/staleness — within one turn an unchanged workspace does not
 *     re-inject the catalog row (digest-gated re-emission); a NEW
 *     workspace resolves fresh on its own first use (independent cache +
 *     digest key).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { HarnessResolver } from '../src/index.ts'
import { bootApp, seedHarness, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- helpers ---------------------------------- */

/** A fresh workspace root directory. */
async function makeWorkspace(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/**
 * Minimal valid git work tree (no `git init` subprocess) — mirrors the
 * engine/cli `gitInit` fixture: the engine's default boundary runs
 * `git rev-parse --show-cdup`, which only needs a valid `.git` layout
 * (HEAD + config + objects/ + refs/) — no commits.
 */
async function gitInit(root: string): Promise<void> {
  await mkdir(join(root, '.git', 'objects'), { recursive: true })
  await mkdir(join(root, '.git', 'refs'), { recursive: true })
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
}

/** A pre-step payload whose agent carries a session cwd (the workspace). */
const stepPayload = (messages: UserMessage[], cwd?: string) => ({
  agent: cwd === undefined ? {} : { session: { header: { cwd } } },
  messages,
  turn: 1,
  step: 1,
  signal: new AbortController().signal,
} as never)

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** The last message of an enter decision (the appended rows when present). */
const lastMessage = (decision: { kind: 'enter'; messages: UserMessage[] }): UserMessage | undefined =>
  decision.messages.at(-1)

/** FsTarget for a local-backend path. */
const target = (path: string): FsTarget => ({ targetKey: path as FsTarget['targetKey'], displayPath: path })

/** Collect status-gate advisory emits on the app context. */
function captureStatusAdvisories(ctx: BootResult['ctx']): Array<{ result: { violations: Array<{ code: string }> } }> {
  const seen: Array<{ result: { violations: Array<{ code: string }> } }> = []
  ctx.on('mstar/status-gate', (payload) => { seen.push(payload) })
  return seen
}

/* ===========================================================================
 * 1. HarnessResolver — explicit wins, workspace-root probing, no cwd probe
 * ========================================================================== */

describe('HarnessResolver — explicit config wins; the probe starts from the workspace root, never the process cwd', () => {
  it('returns the explicit config outright (even for a nonexistent root — authoritative)', async () => {
    const ws = await makeWorkspace('dsh-ws-explicit-')
    const explicit = join(ws, '.harness')
    const resolver = new HarnessResolver(explicit)
    // Any workspace (or none) resolves to the explicit root.
    expect(resolver.forWorkspace(undefined)).toBe(explicit)
    expect(resolver.forWorkspace(join(ws, 'other'))).toBe(explicit)
    expect(resolver.forAgent({ session: { header: { cwd: ws } } })).toBe(explicit)
    expect(resolver.forAgent({})).toBe(explicit)
  })

  it('resolves null when no explicit config AND no workspace (never a process-cwd probe)', () => {
    const resolver = new HarnessResolver(undefined)
    expect(resolver.forWorkspace(undefined)).toBeNull()
    expect(resolver.forAgent({})).toBeNull()
    expect(resolver.forAgent({ session: {} })).toBeNull()
    expect(resolver.forAgent({ session: { header: {} } })).toBeNull()
  })

  it('probes from the WORKSPACE root (`.agents` found under the workspace, not the cwd)', async () => {
    const ws = await makeWorkspace('dsh-ws-probe-')
    await mkdir(join(ws, '.agents'), { recursive: true })
    const resolver = new HarnessResolver(undefined)
    expect(resolver.forAgent({ session: { header: { cwd: ws } } })).toBe(join(ws, '.agents'))
    // The workspace is derived from the agent's session cwd.
    expect(resolver.forWorkspace(ws)).toBe(join(ws, '.agents'))
  })

  it('memoizes per workspace root', async () => {
    const ws = await makeWorkspace('dsh-ws-memo-')
    await mkdir(join(ws, '.agents'), { recursive: true })
    const resolver = new HarnessResolver(undefined)
    const first = resolver.forWorkspace(ws)
    expect(first).toBe(join(ws, '.agents'))
    expect(resolver.forWorkspace(ws)).toBe(first) // same value; cache path hit
    // A different workspace probes independently.
    const other = await makeWorkspace('dsh-ws-memo-other-')
    expect(resolver.forWorkspace(other)).toBeNull()
  })
})

/* ===========================================================================
 * 1b. Workspace-root boundary (roadmap §7c) — the probe stops AT the session
 * workspace; a harness dir anywhere above it is never returned, even when
 * the engine's default git boundary would have found it. The dsh boundary
 * is the probe start itself (`workspaceRoot = cwd`), NOT the git top-level.
 * ========================================================================== */

describe('HarnessResolver — workspace-root boundary: probe stops at the session workspace (roadmap §7c)', () => {
  it('a `.mstar` above the session workspace but INSIDE the git top-level is never returned — the dsh boundary is the probe start, not git', async () => {
    const home = await makeWorkspace('dsh-ws-boundary-')
    const repo = join(home, 'proj')
    await gitInit(repo) // the engine DEFAULT boundary would be this repo root
    await mkdir(join(repo, '.mstar'), { recursive: true }) // harness ABOVE the session workspace
    const ws = join(repo, 'packages', 'app') // the session workspace (deep)
    await mkdir(ws, { recursive: true })
    const resolver = new HarnessResolver(undefined)
    // dsh boundary = the probe start (session cwd): no walk-up beyond it,
    // so the repo-root `.mstar` must NOT resolve for a deeper workspace.
    expect(resolver.forWorkspace(ws)).toBeNull()
    expect(resolver.forAgent({ session: { header: { cwd: ws } } })).toBeNull()
  })

  it('a `~/.mstar`-style fixture in the parent chain above the workspace is never returned (the global-collision regression)', async () => {
    const home = await makeWorkspace('dsh-ws-collision-')
    await mkdir(join(home, '.mstar'), { recursive: true }) // the "global" ~/.mstar fixture
    const repo = join(home, 'proj')
    await gitInit(repo)
    const ws = join(repo, 'nested', 'deep') // the session workspace, deep under the fixture home
    await mkdir(ws, { recursive: true })
    const resolver = new HarnessResolver(undefined)
    expect(resolver.forWorkspace(ws)).toBeNull()
    expect(resolver.forAgent({ session: { header: { cwd: ws } } })).toBeNull()
  })

  it('a workspace-LOCAL harness still resolves — the boundary keeps the probe at the start itself, and the start is probed', async () => {
    const home = await makeWorkspace('dsh-ws-local-')
    await mkdir(join(home, '.mstar'), { recursive: true }) // parent-chain fixture (must NOT win)
    const ws = join(home, 'proj')
    await gitInit(ws) // the engine default boundary = the workspace itself here
    await mkdir(join(ws, '.agents'), { recursive: true }) // workspace-local harness
    const resolver = new HarnessResolver(undefined)
    expect(resolver.forWorkspace(ws)).toBe(join(ws, '.agents'))
  })

  it('a RELATIVE session cwd still resolves a workspace-local harness (regression: a relative cwd pushed the boundary BELOW the probe start → null)', async () => {
    // Real-world geometry: the dsh process cwd sits ABOVE the session
    // workspace, so the session carries a relative cwd like `packages/app`
    // (no leading `..`). Under the buggy code `resolve(start, workspaceRoot)`
    // anchored the relative boundary to the START, landing BELOW the probe
    // start and nulling out even a workspace-local harness. Reproduce it by
    // chdir'ing to a synthetic process cwd for this test only (restored
    // after — this file's other tests use absolute paths).
    const base = await makeWorkspace('dsh-ws-relbase-')
    const ws = join(base, 'packages', 'app')
    await mkdir(join(ws, '.agents'), { recursive: true })
    const rel = relative(base, ws) // e.g. `packages/app` — the relative session cwd
    const prev = process.cwd()
    process.chdir(base)
    try {
      // After chdir the process cwd is the realpath'd form (`/private/var/…`
      // on macOS), so compare against the resolver's own canonical form.
      const abs = resolve(rel)
      const resolver = new HarnessResolver(undefined)
      expect(resolver.forWorkspace(rel)).toBe(join(abs, '.agents'))
      expect(resolver.forAgent({ session: { header: { cwd: rel } } })).toBe(join(abs, '.agents'))
    } finally {
      process.chdir(prev)
    }
  })

  it('explicit config.harnessDir stays authoritative even OUTSIDE the workspace boundary', async () => {
    const home = await makeWorkspace('dsh-ws-explicit-outside-')
    await mkdir(join(home, '.mstar'), { recursive: true }) // above the workspace (outside the boundary)
    const ws = join(home, 'proj', 'src')
    await mkdir(ws, { recursive: true })
    const resolver = new HarnessResolver(join(home, '.mstar'))
    expect(resolver.forWorkspace(ws)).toBe(join(home, '.mstar'))
    expect(resolver.forAgent({ session: { header: { cwd: ws } } })).toBe(join(home, '.mstar'))
  })
})

/* ===========================================================================
 * 2. Pre-step catalog — watermark resolves per session workspace (no config)
 * ========================================================================== */

describe('agent/pre-step — the watermark harness dir resolves from the session workspace, never the process cwd', () => {
  it('agent with a session cwd → watermark shows the WORKSPACE-resolved harness dir', async () => {
    const ws = await makeWorkspace('dsh-ws-prestep-')
    await mkdir(join(ws, '.agents'), { recursive: true })
    booted = await bootApp({ harnessDir: null })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([], ws), defaultEnter([]))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({ kind: 'mstar-engine-status', harnessDir: join(ws, '.agents') })
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain(`harness dir: ${join(ws, '.agents')}`)
  })

  it('agent-less event → `harness dir: none` (regression: the old boot probe from process.cwd() reached the global ~/.mstar on this machine)', async () => {
    booted = await bootApp({ harnessDir: null })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({ kind: 'mstar-engine-status', harnessDir: null })
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain('harness dir: none')
  })
})

/* ===========================================================================
 * 3. Status gate — gates the WORKSPACE's status.json (no config)
 * ========================================================================== */

describe('fs/write-intent — the status gate follows the session workspace (no config)', () => {
  it('actor carrying the session agent → invalid workspace status.json is flagged', async () => {
    const ws = await makeWorkspace('dsh-ws-gate-')
    await seedHarness(join(ws, '.agents'), { 'status.json': '{ "version": 1, "plans": "not-an-array" }' })
    booted = await bootApp({ harnessDir: null })
    const advisories = captureStatusAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall(
      'fs/write-intent',
      target(join(ws, '.agents', 'status.json')),
      { agent: { session: { header: { cwd: ws } } } },
      () => undefined,
    )

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('status.invalid-plans')
  })

  it('agent-less actor → inert (no workspace, no harness dir — nothing to gate)', async () => {
    const ws = await makeWorkspace('dsh-ws-gate-inert-')
    await seedHarness(join(ws, '.agents'), { 'status.json': '{ "version": 1, "plans": "not-an-array" }' })
    booted = await bootApp({ harnessDir: null })
    const advisories = captureStatusAdvisories(booted.ctx)

    await booted.ctx.waterfall(
      'fs/write-intent',
      target(join(ws, '.agents', 'status.json')),
      {},
      () => undefined,
    )

    expect(advisories).toHaveLength(0)
  })
})

/* ===========================================================================
 * 4. Staleness — catalog sources are stable per workspace after first use
 * ========================================================================== */

describe('agent/pre-step — per-workspace source staleness (no config)', () => {
  it('within one turn an unchanged workspace does not re-inject; a NEW workspace resolves fresh', async () => {
    const ws = await makeWorkspace('dsh-ws-stale-')
    await mkdir(join(ws, '.agents'), { recursive: true })
    booted = await bootApp({ harnessDir: null })

    // First pre-step of ws: no compass yet → soft (cache built on first use).
    const first = await booted.ctx.waterfall('agent/pre-step', stepPayload([], ws), defaultEnter([]))
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') return
    expect(lastMessage(first)?.source).toMatchObject({ enforcement: { hard: false, source: 'none' } })

    // Same turn + unchanged → the digest gate suppresses the identical row
    // (the within-TTL staleness is moot: the row is simply not re-injected
    // until it changes or a new turn starts).
    const second = await booted.ctx.waterfall('agent/pre-step', stepPayload([], ws), defaultEnter([]))
    expect(second.kind).toBe('enter')
    if (second.kind !== 'enter') return
    expect(second.messages).toHaveLength(0)

    // A NEW workspace with the hard compass seeded BEFORE its first use
    // resolves fresh (per-workspace first-use build + independent digest).
    const ws2 = await makeWorkspace('dsh-ws-stale-2-')
    await seedHarness(join(ws2, '.agents'), {
      'iterations/ws-stale-2/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })
    const third = await booted.ctx.waterfall('agent/pre-step', stepPayload([], ws2), defaultEnter([]))
    expect(third.kind).toBe('enter')
    if (third.kind !== 'enter') return
    expect(lastMessage(third)?.source).toMatchObject({ enforcement: { hard: true, source: 'compass' } })
  })
})
