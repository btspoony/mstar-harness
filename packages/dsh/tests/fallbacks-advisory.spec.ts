/**
 * Task 4 — warn-only adoption advisory (plan `20260815-dsh-fallbacks-personas`):
 * when fallbacks is mounted, ONE advisory pass per apply structurally reads the
 * deployment's fallbacks row config from the loader entry (`entry.options.config`
 * — architect-verified field: `EntryOptions.config` "Config passed to the
 * plugin", the same value the plugin's `apply()` receives) and warns (bounded:
 * ≤1 warn per category, logger `mstar/fallbacks-advisory`) on taxonomy gaps:
 *
 * - (b) mstar role ids missing from the deployment's `roles.list` — the
 *   mstar role-id set is derived from the `harness-agents/` mirror
 *   (Task 3 surface, never hardcoded);
 * - (c) declared role entities with an empty persona;
 * - (d) legacy keys in role entities (`detectLegacyKeys` semantics — the
 *   service's own detector when applied).
 *
 * Unreadable row config (absent field / non-object) → skip + one debug log;
 * unmounted → the advisory is not invoked (returns false, no logs). The
 * advisory NEVER writes the fallbacks config (fixtures assert the row-config
 * object is unmutated) and never throws.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import * as fallbacks from 'dsh-llm-fallbacks'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootApp, FakeLoaderRegistry, startInfo, type BootResult } from './harness.ts'
import { FALLBACKS_ENTRY_NAME, type LoaderEntryView } from '../src/gates/fallbacks-probe.ts'
import { packagedAgentsDir } from '../src/gates/_shared.ts'
import {
  ADVISORY_LOGGER,
  runFallbacksAdvisory,
  setAdvisoryLogger,
  type AdvisoryLogLevel,
} from '../src/gates/fallbacks-advisory.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The mirror-derived mstar role-id set the fixture shells declare. */
const MIRROR_ROLES = ['architect', 'fullstack-dev', 'scout']

/** One fixture shell markdown: constrained repo-owned frontmatter + a stub body. */
function shell(frontmatter: string[]): string {
  return ['---', ...frontmatter, '---', '', '## Morning Star Role Binding', '', 'You are the role shell.'].join('\n')
}

/** Seed a throwaway fixture mirror with the three subagent-mode shells. */
async function fixtureMirror(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-advisory-mirror-'))
  const shells: Array<[string, string[]]> = [
    ['architect', ['name: architect', 'description: |-', '  Architect the plan.', 'mode: subagent']],
    ['fullstack-dev', ['name: fullstack-dev', 'description: |-', '  Implement the task.', 'mode: subagent']],
    ['scout', ['name: scout', 'description: |-', '  Explore the repository.', 'mode: subagent']],
  ]
  for (const [role, frontmatter] of shells) await writeFile(join(dir, `${role}.md`), shell(frontmatter))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** One declared fallbacks role entity (`roles.list` entry). */
function role(id: string, persona: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, persona, ...extra }
}

/** A structurally well-formed fallbacks row config around the given roles.list. */
function rowConfig(list: unknown[]): Record<string, unknown> {
  return {
    enabled: true,
    triggerCodes: ['429'],
    rootChain: ['gpt-4o'],
    roles: { list, rules: [] },
    cooldownMs: 60000,
  }
}

/** A live, enabled fallbacks loader entry carrying the given row config (undefined = unconfigured row). */
function liveEntry(rowConfig?: unknown): LoaderEntryView {
  return { options: { name: FALLBACKS_ENTRY_NAME, config: rowConfig }, disabled: false, fiber: {} }
}

/** A context whose loader answers entries() with the given list (probe test pattern). */
function ctxWithLoader(entries: LoaderEntryView[]): Context {
  const ctx = new Context()
  const loader = new FakeLoaderRegistry(ctx)
  loader.entriesList = entries
  return ctx
}

/** Capture advisory logs through the module sink (decoration test pattern). */
function captureLogs(): { captured: Array<[AdvisoryLogLevel, string]>; restore: () => void } {
  const captured: Array<[AdvisoryLogLevel, string]> = []
  const prior = setAdvisoryLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setAdvisoryLogger(prior) }
}

describe('fallbacks adoption advisory — mounted, warn-only, bounded', () => {
  it('(a) roles.list covers all mirror role ids with non-empty personas → pass, no logs, config unmutated', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = rowConfig(MIRROR_ROLES.map((id) => role(id, `Persona for ${id}`)))
      const snapshot = structuredClone(cfg)
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        // Clean taxonomy → no warn, no debug.
        expect(captured).toEqual([])
        // The advisory is read-only over the deployment's config layer.
        expect(cfg).toEqual(snapshot)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(b) mstar role ids missing from roles.list → ONE warn listing them', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = rowConfig([role('architect', 'Architect persona'), role('fullstack-dev', 'Dev persona')])
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('scout')
        expect(captured.filter(([level]) => level === 'debug')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(c) declared role with an empty persona → ONE warn naming the id', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = rowConfig(MIRROR_ROLES.map((id) => role(id, id === 'scout' ? '' : `Persona for ${id}`)))
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('scout')
        expect(warns[0]![1]).toContain('empty persona')
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(c2) a null/non-object entry in roles.list → skipped + one debug each; the pass continues for the other entries (S-003)', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = rowConfig([role('architect', 'Architect persona'), null, 'not-an-entity', role('fullstack-dev', 'Dev persona')])
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        // The malformed entries are skipped; the well-formed entries still
        // drive the taxonomy checks — scout is still missing → ONE warn.
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('scout')
        // Each skipped malformed entry → one debug (null + string = 2).
        const debugs = captured.filter(([level]) => level === 'debug')
        expect(debugs).toHaveLength(2)
        expect(debugs.every(([, message]) => message.includes('roles.list entry'))).toBe(true)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(d) legacy keys in role entities → ONE warn citing detectLegacyKeys semantics', async () => {
    const mirror = await fixtureMirror()
    try {
      booted = await bootApp()
      // The real registry plugin applied as a row (probe spec pattern): the
      // advisory uses the service's own detectLegacyKeys when applied.
      const fallbacksPlugin = fallbacks as unknown as Parameters<Context['plugin']>[0]
      await booted.ctx.plugin(fallbacksPlugin)
      // The legacy entity keeps a persona so (c) stays silent — this case
      // isolates the legacy-keys warn.
      const cfg = rowConfig([
        role('architect', 'Architect persona', { label: 'Architect', description: 'Legacy field' }),
        role('fullstack-dev', 'Dev persona'),
        role('scout', 'Scout persona'),
      ])
      ;(booted.ctx.get('loader') as FakeLoaderRegistry).entriesList = [liveEntry(cfg)]
      const snapshot = structuredClone(cfg)
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(booted.ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('detectLegacyKeys')
        expect(warns[0]![1]).toContain('roles.list[].label')
        expect(warns[0]![1]).toContain('roles.list[].description')
        expect(cfg).toEqual(snapshot)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(e) row config absent (unconfigured row) → skip + ONE debug, no warn', async () => {
    const mirror = await fixtureMirror()
    try {
      const ctx = ctxWithLoader([liveEntry()])
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        expect(captured.filter(([level]) => level === 'debug')).toHaveLength(1)
        expect(captured[0]![0]).toBe('debug')
        expect(captured[0]![1]).toContain('unreadable')
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(e2) non-object row config → skip + ONE debug, no warn', async () => {
    const mirror = await fixtureMirror()
    try {
      const ctx = ctxWithLoader([liveEntry('not-an-object')])
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        expect(captured.filter(([level]) => level === 'debug')).toHaveLength(1)
        expect(captured[0]![1]).toContain('unreadable')
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(e3) unreadable roles block → skip taxonomy + ONE debug, no warn', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = { enabled: true, triggerCodes: ['429'], rootChain: ['gpt-4o'], roles: 'not-an-object' }
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        expect(captured.filter(([level]) => level === 'debug')).toHaveLength(1)
        expect(captured[0]![1]).toContain('roles')
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(f) unmounted fallbacks (no loader service) → advisory not invoked: false, no logs', async () => {
    const mirror = await fixtureMirror()
    try {
      const ctx = new Context()
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(false)
        expect(captured).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(f2) disabled fallbacks entry → advisory not invoked: false, no logs', async () => {
    const mirror = await fixtureMirror()
    try {
      const ctx = ctxWithLoader([{ options: { name: FALLBACKS_ENTRY_NAME, config: rowConfig([]) }, disabled: true, fiber: {} }])
      const { captured, restore } = captureLogs()
      try {
        expect(runFallbacksAdvisory(ctx, mirror.dir)).toBe(false)
        expect(captured).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('wiring — apply binds the advisory and runs ONE pass at the first subagent/start decision point', async () => {
    const mirror = packagedAgentsDir()
    if (mirror === undefined) return // bundle-assets not run — the live mirror is a precondition
    booted = await bootApp()
    // The loader mounts entries concurrently — at apply the row list is
    // empty, so the apply-time attempt sees unmounted and the latch stays
    // open; the first decision point (subagent/start) runs the pass.
    ;(booted.ctx.get('loader') as FakeLoaderRegistry).entriesList = [liveEntry(rowConfig([]))]
    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo('agent-1'))
      const warns = captured.filter(([level]) => level === 'warn')
      expect(warns.length).toBeGreaterThan(0)
      expect(warns.some(([, message]) => message.includes('roles.list is missing'))).toBe(true)
      // Bounded: a second decision point emits nothing new (one pass per apply).
      const before = captured.length
      booted.ctx.events.emit('subagent/start', startInfo('agent-2'))
      expect(captured.slice(before)).toEqual([])
    } finally {
      restore()
    }
  })
})
