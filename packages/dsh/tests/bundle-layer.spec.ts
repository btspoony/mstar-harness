/**
 * Task 4 — profile bundle layer : the
 * `@mstar-harness/dsh` package doubles as a dsh profile bundle per the
 * dsh-bundle contract (manifest `dsh.bundle.patch` + a `cordis.patch.yml`
 * patch list; `- insert:` op; id-targeted patches replace a row's WHOLE
 * `config` — no deep merge; layer over dsh-base).
 *
 * The tests read the shipped manifest and patch file (the exact files the
 * dsh profile loader composes at boot — `loadProfile` resolves
 * `join(packageDir, dsh.bundle.patch)`), assert the row's neutral defaults
 * (Enforcement OFF by construction: absent → the iteration compass decides,
 * warn-only when nothing hardens — never a global always-on hard gate), and
 * round-trip whole-config replacement with a minimal mirror of the include
 * patch algorithm (`insert` append + id-targeted `config` replacement).
 */
import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import * as plugin from '../src/index.ts'

/** Package root of `@mstar-harness/dsh` (the bundle package). */
const PKG_DIR = join(import.meta.dir, '..')

/** Row shape of a cordis entry list (the dsh-bundle patch row contract). */
interface EntryRow {
  id?: string
  name?: string
  config?: unknown
  disabled?: boolean | null
}

/** One patch op: `- insert:` lists or an id-targeted override. */
interface PatchOp {
  id?: string
  insert?: EntryRow[]
  config?: unknown
}

/**
 * Minimal mirror of the include patch semantics the dsh profile loader
 * applies, for the two ops the dsh-bundle contract uses: `insert` appends
 * rows; an id-targeted `config` patch replaces the target row's WHOLE config
 * (no deep merge).
 * @param entries - the composed entry list (e.g. the dsh-base layer).
 * @param patches - patch ops in application order (later wins).
 * @returns the composed entry list.
 */
function applyPatch(entries: EntryRow[], patches: PatchOp[]): EntryRow[] {
  const out = entries.map((row) => ({ ...row }))
  for (const patch of patches) {
    if (patch.insert !== undefined) {
      out.push(...patch.insert.map((row) => ({ ...row })))
      continue
    }
    const target = out.find((row) => row.id === patch.id)
    if (target === undefined) continue // the Loader warns; the row stays absent
    if (patch.config !== undefined) target.config = structuredClone(patch.config)
  }
  return out
}

/** The bundle's patch file path exactly as `loadProfile` resolves it. */
const patchPath = (pkg: { dsh?: { bundle?: { patch?: string } } }): string =>
  join(PKG_DIR, pkg.dsh?.bundle?.patch ?? '')

/** Parse the shipped `bundle/cordis.patch.yml` as a patch-op list. */
function loadBundlePatch(): PatchOp[] {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
  expect(pkg.dsh?.bundle?.patch).toBe('./bundle/cordis.patch.yml')
  const parsed = load(readFileSync(patchPath(pkg), 'utf8'))
  expect(Array.isArray(parsed)).toBe(true)
  return parsed as PatchOp[]
}

/** The `mstar` plugin row and the `mstar-mcp` MCP client row the bundle inserts. */
function bundleRows(): EntryRow[] {
  const patches = loadBundlePatch()
  expect(patches).toHaveLength(1)
  const rows = patches[0]?.insert
  expect(rows).toHaveLength(2)
  return rows!
}

function mstarRow(): EntryRow {
  const row = bundleRows().find((entry) => entry.id === 'mstar')
  expect(row).toBeDefined()
  return row!
}

function mstarMcpRow(): EntryRow {
  const row = bundleRows().find((entry) => entry.id === 'mstar-mcp')
  expect(row).toBeDefined()
  return row!
}

describe('profile bundle layer (Task 4)', () => {
  it('declares dsh.bundle.patch in the manifest and ships the patch file', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
    expect(pkg.dsh?.bundle?.patch).toBe('./bundle/cordis.patch.yml')
    expect(existsSync(patchPath(pkg))).toBe(true)
    // The manifest travels in the published package (bundle dir whitelisted).
    expect(pkg.files).toContain('bundle')
  })

  it('parses as a dsh-bundle patch: one `- insert:` op mounting the mstar plugin row and the mstar-mcp client row', () => {
    const row = mstarRow()
    expect(row.id).toBe('mstar')
    expect(row.name).toBe('@mstar-harness/dsh')
    const mcp = mstarMcpRow()
    expect(mcp.name).toBe('@deepseek-ai/dsh-mcp-client')
    const config = mcp.config as Record<string, unknown>
    expect(config.serverName).toBe('mstar')
    expect(config.transport).toBe('stdio')
    expect(config.command).toBe('npx')
    expect(config.args).toEqual(['-y', '@mstar-harness/cli', 'mcp'])
  })

  it('ships exactly one MCP row: only the shared mstar-mcp row names the client package', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
    // The shared `mstar-mcp` row is the whole MCP channel. A second ROW naming
    // the client — a scoped/per-agent mount — would mean two channels.
    const mcpRows = bundleRows().filter((entry) => JSON.stringify(entry).includes('@deepseek-ai/dsh-mcp-client'))
    expect(mcpRows.map((entry) => entry.id)).toEqual(['mstar-mcp'])
    // The plugin never declares the client as its own dependency: it mounts no
    // MCP instance, the Loader mounts the row.
    expect(pkg.dependencies?.['@deepseek-ai/dsh-mcp-client']).toBeUndefined()
    expect(pkg.devDependencies?.['@deepseek-ai/dsh-mcp-client']).toBeUndefined()
    expect(pkg.peerDependencies?.['@deepseek-ai/dsh-mcp-client']).toBeUndefined()
  })

  it('defaults Enforcement OFF and ships no deployment-owned config keys', () => {
    const config = mstarRow().config as Record<string, unknown>
    expect(config).toBeDefined()
    // Default-off by construction: absent → the iteration compass decides,
    // warn-only when no compass hardens (never a global always-on hard gate).
    expect(config.enforcement).toBeUndefined()
    // Deployment-owned / dev-time fields stay unset for the user's layer.
    expect(config.harnessDir).toBeUndefined()
    expect(config.dispatchTools).toBeUndefined()
    expect(config.dispatchBinding).toBeUndefined()
    expect(config.skillRoots).toBeUndefined()
    // bundledSkillDir stays unset too: the plugin resolves its OWN packaged
    // `harness-skills/` mirror package-relative (bundle-assets sync), so the
    // patch ships no cwd-anchored default.
    expect(config.bundledSkillDir).toBeUndefined()
  })

  it('accepts the shipped row config through the plugin Config schema', () => {
    const config = mstarRow().config
    expect(() => plugin.Config(config as never)).not.toThrow()
  })

  it('round-trips whole-config replacement over a dsh-base layer (no deep merge)', () => {
    // dsh-base-like composed tree WITHOUT the mstar row (the layer this
    // bundle patches over).
    const base: EntryRow[] = [
      { id: 'llm', name: '@deepseek-ai/dsh-llm' },
      { id: 'skill', name: '@deepseek-ai/dsh-skill' },
    ]
    // 1. The bundle layer inserts the mstar row with its neutral config
    //    (empty — the plugin's packaged defaults apply).
    const afterBundle = applyPatch(base, loadBundlePatch())
    const row = afterBundle.find((entry) => entry.id === 'mstar')
    expect(row?.name).toBe('@mstar-harness/dsh')
    expect(row?.config).toEqual({})
    // 2. A user-level id-targeted patch replaces the WHOLE config: the
    //    shipped keys are gone — replacement, not merge.
    const afterUser = applyPatch(afterBundle, [{ id: 'mstar', config: { enforcement: 'soft' } }])
    const finalRow = afterUser.find((entry) => entry.id === 'mstar')
    expect(finalRow?.config).toEqual({ enforcement: 'soft' })
    expect((finalRow?.config as Record<string, unknown>).bundledSkillDir).toBeUndefined()
  })
})

/* ------------------------------------------------------------------------ *
 * The shipped `mstar-mcp` row, LAUNCHED
 *
 * Reading the row proves it is declared; it does not prove what the host gets
 * from it. The row mounts ONE generic stdio connection for the whole profile,
 * and that connection is where a caller meets the control-root rule. So the
 * test runs the row's OWN server argv against this checkout's CLI entry (the
 * row's `npx` launcher would fetch the published package over the network; the
 * argv, not the launcher, is the shipped contract) and asserts what the default
 * connection does: a root-free call answers, a root CONSUMER refuses.
 * ------------------------------------------------------------------------ */

/** Repo root (`packages/dsh/tests` -> up three levels). */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
/** The CLI entry the row's package (`@mstar-harness/cli`) provides in this checkout. */
const CLI_ENTRY = join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts')
/** Ambient root/identity variables the connection must not inherit. */
const STRIPPED_ENV = [
  'MSTAR_HARNESS_DIR',
  'MSTAR_CONTROL_ROOT',
  'SDD_DIR',
  'MSTAR_HOST_SESSION_ID',
  'MSTAR_EXECUTION_IDENTITY',
  'MSTAR_WRITE_GATE',
]

/** The MCP server argv the shipped row launches, read from the row itself. */
function rowServerArgv(): string[] {
  const config = mstarMcpRow().config as { command?: unknown; args?: unknown }
  expect(typeof config.command).toBe('string')
  const args = config.args as string[]
  const packageIndex = args.indexOf('@mstar-harness/cli')
  expect(packageIndex).toBeGreaterThanOrEqual(0)
  return args.slice(packageIndex + 1)
}

type JsonRpcResponse = {
  id?: number
  result?: { content?: Array<{ text?: string }>; structuredContent?: unknown; isError?: boolean }
  error?: unknown
}

/** One newline-delimited JSON-RPC child over its stdio, answered by request id. */
function startRowServer(argv: readonly string[], cwd: string) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || STRIPPED_ENV.includes(key)) continue
    env[key] = value
  }
  const child = spawn(process.execPath, ['run', CLI_ENTRY, ...argv], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiters = new Map<number, (response: JsonRpcResponse) => void>()
  let buffer = ''
  let stderr = ''
  let nextId = 0
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      const response = JSON.parse(line) as JsonRpcResponse
      const waiter = response.id === undefined ? undefined : waiters.get(response.id)
      if (waiter !== undefined) {
        waiters.delete(response.id!)
        waiter(response)
      }
    }
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  return {
    request(method: string, params: unknown): Promise<JsonRpcResponse> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        waiters.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        setTimeout(() => reject(new Error(`mcp ${method} timed out\n${stderr}`)), 60_000).unref?.()
      })
    },
    notify(method: string, params: unknown): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    stderr: (): string => stderr,
    stop(): void {
      child.stdin.end()
      child.kill()
    },
  }
}

describe('the shipped mstar-mcp row, launched', () => {
  it('answers a root-free call and refuses a root consumer when no root is declared', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mstar-dsh-row-'))
    const server = startRowServer(rowServerArgv(), cwd)
    try {
      const handshake = await server.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dsh-row-test', version: '0.0.0' },
      })
      expect((handshake.result as unknown as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('mstar-harness')
      server.notify('notifications/initialized', {})

      // The row mounts the folded family surface, not some other server.
      const listed = await server.request('tools/list', {})
      const names = ((listed.result as unknown as { tools?: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name)
      expect(names).toContain('mstar_status')
      expect(names).toContain('mstar_schema')

      // A root-free call answers on the very connection that refuses below: the
      // refusal is about the missing root, not a dead child.
      const discovery = await server.request('tools/call', { name: 'mstar_schema', arguments: { action: 'schema', family: 'plan' } })
      expect(discovery.result?.isError).toBe(false)

      // `status.validate` reads the control root and publishes no root
      // selector, so the shipped argv's undeclared root is what refuses it.
      const refused = await server.request('tools/call', { name: 'mstar_status', arguments: { action: 'validate' } })
      expect(refused.result?.isError).toBe(true)
      const text = (refused.result?.content ?? []).map((block) => block.text ?? '').join('\n')
      expect(text).toContain('mcp.control-root-unresolved')
      expect(text).toContain('--harness')
    } finally {
      server.stop()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 120_000)
})
