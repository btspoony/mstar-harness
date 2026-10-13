import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveActiveWorkflow, resolveReadWorkflow } from '../src/gates/workflow-selection.js'

describe('retired file-route selection refusals', () => {
  it('retains legacy-status and valid empty-registry selection branches', () => {
    const temp = mkdtempSync(join(tmpdir(), 'dsh-workflow-recovery-'))
    const root = join(temp, 'root')
    mkdirSync(root)
    try {
      writeFileSync(join(root, 'status.json'), JSON.stringify({ version: 1, plans: [] }))
      const legacy = resolveActiveWorkflow(root)
      expect(legacy.kind).toBe('error')
      if (legacy.kind === 'error') expect(legacy.code).toBe('status.migration-required')

      writeFileSync(join(root, 'status.json'), JSON.stringify({ version: 2, updated_at: '2026-01-01T00:00:00.000Z', workflows: [] }))
      const noSnapshots = resolveReadWorkflow(root)
      expect(noSnapshots.kind).toBe('error')
      if (noSnapshots.kind === 'error') expect(noSnapshots.code).toBe('workflow.selection.no-snapshot')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
