/**
 * Task 2 — harness-agents mirror : the
 * `bundle-assets` sync gains a third mirror, repo-root `agents/` →
 * package `harness-agents/` (the role-persona default source Task 3
 * consumes). Importing the script must stay side-effect free — the sync only
 * runs under `import.meta.main` (direct `bun run bundle-assets`), never on
 * import. These tests pin the resolved source/dest paths and the `copyTree`
 * contract on a tiny fixture (no full-tree copy in tests), and sanity-check
 * the real repo-root `agents/` shell set when running in the monorepo
 * (skips gracefully when the checkout lacks the mirror source).
 */
import { describe, expect, it, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  copyTree,
  destHarnessAgents,
  packageRoot,
  repoRoot,
  sourceAgents,
} from '../scripts/bundle-harness-assets.ts'


/** A tiny throwaway source/dest pair; never touches the real mirrors. */
async function fixturePair(): Promise<{ src: string; dest: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'harness-agents-mirror-'))
  const src = join(root, 'agents')
  const dest = join(root, 'harness-agents')
  await mkdir(src, { recursive: true })
  return { src, dest, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('bundle-harness-assets — resolved mirror paths', () => {
  it('points the agents mirror at repo-root agents/ -> package harness-agents/', () => {
    expect(sourceAgents).toBe(join(repoRoot, 'agents'))
    expect(destHarnessAgents).toBe(join(packageRoot, 'harness-agents'))
  })

  it('anchors packageRoot one level under the repo root (stable under any cwd)', () => {
    expect(packageRoot).toBe(join(repoRoot, 'packages', 'dsh'))
  })
})

describe('copyTree — mirror contract on a tiny fixture', () => {
  it('copies the tree byte-identical, nested files included', async () => {
    const { src, dest, cleanup } = await fixturePair()
    try {
      await writeFile(join(src, 'architect.md'), '---\ndescription: shell one\n---\nbody\n')
      await mkdir(join(src, 'nested'))
      await writeFile(join(src, 'nested', 'code-reviewer.md'), 'nested shell body')

      copyTree('agents', src, dest)

      expect(readFileSync(join(dest, 'architect.md'), 'utf8')).toBe('---\ndescription: shell one\n---\nbody\n')
      expect(readFileSync(join(dest, 'nested', 'code-reviewer.md'), 'utf8')).toBe('nested shell body')
    } finally {
      await cleanup()
    }
  })

  it('replaces a stale dest tree instead of merging into it', async () => {
    const { src, dest, cleanup } = await fixturePair()
    try {
      await writeFile(join(src, 'architect.md'), 'v2')
      await mkdir(join(dest, 'stale'), { recursive: true })
      await writeFile(join(dest, 'stale', 'old.md'), 'leftover')

      copyTree('agents', src, dest)

      expect(existsSync(join(dest, 'stale'))).toBe(false)
      expect(readFileSync(join(dest, 'architect.md'), 'utf8')).toBe('v2')
    } finally {
      await cleanup()
    }
  })
})

// Real-checkout sanity: 13 shared subagent shells in the monorepo; skips when
// agents/ is absent.
test.skipIf(!existsSync(sourceAgents))('repo-root agents/ excludes the OpenCode-only project-manager seat (monorepo checkout)', () => {
  expect(existsSync(join(sourceAgents, 'project-manager.md'))).toBe(false)
})
