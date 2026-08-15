/**
 * Task 3 — persona defaults from the bundled `harness-agents/` mirror (plan
 * `20260815-dsh-fallbacks-personas`): `personaFor` is the decoration's single
 * lookup — `Config.rolePersonas[role]` wins, then the mirror default (shell
 * file stem = role id; frontmatter `description` block scalar; the shell is
 * eligible when frontmatter `mode` is absent or `subagent`), with a
 * per-(mirrorRoot, mtime) cache so decision-point reads never go stale.
 * Extraction is limited to the constrained repo-owned frontmatter shape — no
 * general YAML parser, no new dependencies. The mirror-root resolution
 * (`resolvePackagedAgentsDir`) is pinned at both layout depths like its
 * harness-skills sibling.
 */
import { describe, expect, it, test, beforeEach, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { personaFor, type PersonaWarnSink } from '../src/gates/agent-personas.ts'
import { resolvePackagedAgentsDir } from '../src/gates/_shared.ts'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'

/** One fixture shell markdown: constrained repo-owned frontmatter + a stub body. */
function shell(frontmatter: string[]): string {
  return ['---', ...frontmatter, '---', '', '## Morning Star Role Binding', '', 'You are the role shell.'].join('\n')
}

const ROLE = 'fullstack-dev'
const CONFIG_PERSONA = 'You are a fullstack-dev executor for the Morning Star harness.'

let mirror: string
const warns: string[] = []
const warn: PersonaWarnSink = (message) => { warns.push(message) }

beforeEach(async () => {
  mirror = await mkdtemp(join(tmpdir(), 'agent-personas-'))
  warns.length = 0
})

afterEach(async () => {
  await rm(mirror, { recursive: true, force: true })
})

async function seedShell(roleId: string, frontmatter: string[]): Promise<void> {
  await writeFile(join(mirror, `${roleId}.md`), shell(frontmatter))
}

describe('personaFor — the decoration single lookup (config → mirror default → undefined)', () => {
  it('(a) config persona wins over the mirror default', async () => {
    await seedShell(ROLE, ['description: |-', '  Mirror default text.', 'mode: subagent'])
    const result = personaFor(ROLE, { rolePersonas: { [ROLE]: CONFIG_PERSONA }, agentsDir: mirror })
    expect(result).toEqual({ text: CONFIG_PERSONA, source: 'config' })
  })

  it('(b) mirror default from a shell description block scalar (multiline |-)', async () => {
    await seedShell(ROLE, [
      `name: ${ROLE}`,
      'description: |-',
      '  技术架构师 - 系统设计、技术决策。',
      '  Architect - system design and technical decisions.',
      'mode: subagent',
    ])
    const result = personaFor(ROLE, { agentsDir: mirror })
    expect(result).toEqual({
      text: '技术架构师 - 系统设计、技术决策。\nArchitect - system design and technical decisions.',
      source: 'default',
    })
  })

  it('(c) role absent from config and mirror → undefined', async () => {
    await seedShell(ROLE, ['description: some default', 'mode: subagent'])
    // No shell for the role, no config.
    expect(personaFor('qa-engineer', { agentsDir: mirror })).toBeUndefined()
    // Config carries a different role only.
    expect(personaFor('qa-engineer', { rolePersonas: { [ROLE]: CONFIG_PERSONA }, agentsDir: mirror })).toBeUndefined()
    // No mirror at all → the lookup is config-only.
    expect(personaFor(ROLE, { agentsDir: undefined })).toBeUndefined()
    expect(personaFor(ROLE, { rolePersonas: undefined })).toBeUndefined()
    // An empty-string configured persona is treated as absent (decoration parity).
    expect(personaFor('qa-engineer', { rolePersonas: { 'qa-engineer': '' }, agentsDir: mirror })).toBeUndefined()
  })

  it('(d) shell description containing the {{...}} hazard → default skipped + one warn, never throws', async () => {
    await seedShell(ROLE, ['description: |-', '  You are the {{role}} executor.', 'mode: subagent'])
    expect(personaFor(ROLE, { agentsDir: mirror }, warn)).toBeUndefined()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(ROLE)
    // Cache: a second lookup of the same shell (unchanged mtime) does not re-warn.
    expect(personaFor(ROLE, { agentsDir: mirror }, warn)).toBeUndefined()
    expect(warns).toHaveLength(1)
    // A lone `{{` with no later `}}` is literal prose (safe) — allowed, like Config.
    await seedShell('code-reviewer', ['description: Use single braces in prose: {like this}.', 'mode: subagent'])
    expect(personaFor('code-reviewer', { agentsDir: mirror }, warn))
      .toEqual({ text: 'Use single braces in prose: {like this}.', source: 'default' })
    expect(warns).toHaveLength(1)
  })

  it('(f) a shell with mode: primary is not offered as a subagent persona default', async () => {
    await seedShell('project-manager', ['description: |-', '  The PM orchestrates the team.', 'mode: primary'])
    expect(personaFor('project-manager', { agentsDir: mirror }, warn)).toBeUndefined()
    // Excluded silently — no hazard warn.
    expect(warns).toHaveLength(0)
  })

  it('(f2) mode absent → eligible; mode subagent → eligible', async () => {
    await seedShell('ops-engineer', ['description: |-', '  The ops engineer runs the fleet.'])
    expect(personaFor('ops-engineer', { agentsDir: mirror }))
      .toEqual({ text: 'The ops engineer runs the fleet.', source: 'default' })
    await seedShell('writing-specialist', ['description: Writing prose.', 'mode: subagent'])
    expect(personaFor('writing-specialist', { agentsDir: mirror }))
      .toEqual({ text: 'Writing prose.', source: 'default' })
  })

  it('plain-scalar description and quoted mode parse (constrained repo-owned YAML)', async () => {
    await seedShell('architect', ['description: One-line persona.', 'mode: "subagent"'])
    expect(personaFor('architect', { agentsDir: mirror }))
      .toEqual({ text: 'One-line persona.', source: 'default' })
  })

  it('(cache) re-extracts after the shell changes — per-(mirrorRoot, mtime), no staleness', async () => {
    await seedShell(ROLE, ['description: |-', '  Version A.', 'mode: subagent'])
    expect(personaFor(ROLE, { agentsDir: mirror })).toEqual({ text: 'Version A.', source: 'default' })
    // An in-place edit bumps the file mtime; the next decision-point read re-extracts.
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 5)
    await promise
    await seedShell(ROLE, ['description: |-', '  Version B.', 'mode: subagent'])
    expect(personaFor(ROLE, { agentsDir: mirror })).toEqual({ text: 'Version B.', source: 'default' })
  })
})

// Real-checkout sanity (architect fact): the ONLY `mode: primary` shell is
// project-manager; the 13 subagent shells resolve a default. Skips when the
// mirror is absent (bundle-assets not run).
describe('real mirror contract (when synced)', () => {
  const realMirror = join(packageRoot, 'harness-agents')

  test.skipIf(!existsSync(realMirror))('project-manager (mode: primary) is excluded; subagent shells resolve', () => {
    expect(personaFor('project-manager', { agentsDir: realMirror }, warn)).toBeUndefined()
    expect(warns).toHaveLength(0)
    const architect = personaFor('architect', { agentsDir: realMirror })
    expect(architect?.source).toBe('default')
    expect(architect?.text.length).toBeGreaterThan(0)
    expect(personaFor('fullstack-dev', { agentsDir: realMirror })?.source).toBe('default')
  })
})

describe('resolvePackagedAgentsDir — dual-depth direct resolution', () => {
  // The exact file URL strings the pure helper receives as `import.meta.url`
  // when called from a module at that depth: the REAL `src/gates/_shared.ts`
  // URL (source-layout depth) and a simulated `dist/index.js` URL (the
  // shipped form — `package.json` `main: ./dist/index.js`, dist-layout
  // depth). The dist file itself need not exist — it only anchors the probe.
  const SOURCE_DEPTH_URL = new URL('../src/gates/_shared.ts', import.meta.url).href
  const DIST_DEPTH_URL = new URL('../dist/index.js', import.meta.url).href
  const CANONICAL_MIRROR = join(packageRoot, 'harness-agents')

  it('source layout (src/gates/_shared.ts) resolves to the canonical mirror — never src/harness-agents', () => {
    const dir = resolvePackagedAgentsDir(SOURCE_DEPTH_URL)
    // First candidate at source depth is `src/harness-agents` — a NON-canonical
    // path (`bundle-assets` only ever generates the mirror at
    // `packages/dsh/harness-agents`); the probe must skip it and land on
    // `../../harness-agents`.
    expect(dir).not.toBe(join(packageRoot, 'src', 'harness-agents'))
    if (existsSync(CANONICAL_MIRROR)) {
      expect(dir).toBe(CANONICAL_MIRROR)
    } else {
      expect(dir).toBeUndefined()
    }
  })

  it('dist layout (dist/index.js) resolves to the same canonical mirror', () => {
    const dir = resolvePackagedAgentsDir(DIST_DEPTH_URL)
    if (existsSync(CANONICAL_MIRROR)) {
      expect(dir).toBe(CANONICAL_MIRROR)
    } else {
      expect(dir).toBeUndefined()
    }
  })

  it('both depths agree — a single canonical mirror from either layout', () => {
    expect(resolvePackagedAgentsDir(SOURCE_DEPTH_URL)).toBe(resolvePackagedAgentsDir(DIST_DEPTH_URL))
  })
})
