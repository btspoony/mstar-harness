/**
 * Boot-order convergence pin for the fallbacks role seeds — the REAL
 * `dsh-llm-fallbacks` devDependency, a SINGLE boot, the REAL profile row
 * order (mstar row first, fallbacks row second), and NO dispose/re-apply.
 *
 * Why this test exists: the mstar seeds declaration fires from the
 * `ctx.inject(['llm-fallbacks'])` child the moment the service appears —
 * the same tick as the provider's own `ctx.provide('llm-fallbacks', …)`.
 * The provider's seed write channel (`writeRoles`) starts as a thrower and
 * is only swapped by the provider's own `ctx.inject(['settings'], …)` child,
 * which settles one macrotask AFTER its apply. The declaration therefore
 * LOSES that settings-binding race and rejects with
 * `llm-fallbacks: seeds: settings service is unavailable — seed roles
 * cannot be written`, and nothing retries it on a plain boot (no decision
 * point runs) — the 13 mstar role ids never reach the effective taxonomy
 * nor the persisted `fallbacks` settings namespace. The existing suites
 * cannot see this: the seeds/advisory/coexistence suites inject fake
 * services (no upstream write channel), and the installed-deployment e2e
 * models the host config-stack re-composition (dispose + re-apply + a
 * `subagent/start` decision point) BEFORE asserting — exactly the path the
 * plain single boot never gets. This spec pins the plain boot.
 *
 * Harness fidelity (how the race is reproduced here): with the fake
 * settings row mounted BEFORE the fallbacks row, the provider's binding
 * child wins and the declare SUCCEEDS on attempt 1 — not the live failure.
 * This composition opts into the realistic settings arrival instead
 * (`settingsService: 'fake-deferred'`): the fake settings row mounts AFTER
 * the `dsh-llm-fallbacks` row, so the mstar declare fires on the
 * service-provide tick with `writeRoles` still the thrower, while the
 * provider's settings children settle one tick later — the same observable
 * ordering as the live deployment. The fake settings registry itself models
 * the real `dsh-settings-file` service's consumed contract
 * (`installSection` base-layer registration + live source closure +
 * synchronous/watch change notification; patch-merge `update`), so the
 * config loop the readback depends on CLOSES one tick after the declare
 * window: the provider's preset self-declare lands through the same seam
 * and the RED readback carries the 7 preset ids while the 13 mstar ids are
 * missing — the exact live failure shape (never the fake-api-absence shape:
 * a readback of `[]` plus an `installSection is not a function` provider
 * TypeError).
 *
 * Falsifiability: RED on the unfixed tree — the effective readback holds
 * only the 7 upstream preset ids, the settings namespace carries no mstar
 * row, and the boot log carries one `mstar/fallbacks-seeds` ERROR record
 * (the contained declaration failure). GREEN after the bounded-retry fix:
 * 20 ids (13 mirror-derived mstar + 7 presets), every mstar row seeded with
 * a non-empty persona, the 13 rows persisted, and a clean boot log.
 *
 * Boot-log capture: cordis's `LoggerService` registers a default buffer
 * exporter at construction — `ctx.logger.buffer` — but that buffer's level
 * cap is INFO (probe-verified at @deepseek-ai/cordis 4.0.2: ERROR and INFO
 * records land; WARN/DEBUG are filtered), so the spec registers an
 * additional test-owned exporter at DEBUG default level and asserts over
 * the UNION of both captures. The seeds failure surfaces as an ERROR
 * (buffer-visible); the advisory's degraded-abort record is a WARN and
 * would be invisible to the buffer alone.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { presetRoles } from 'dsh-llm-fallbacks'
import { bootApp, type BootResult, type FakeSettingsRegistry } from './harness.ts'
import { fallbacksService } from '../src/gates/fallbacks-probe.ts'
import type { FallbacksServiceView } from '../src/gates/fallbacks-structural.ts'
import { subagentRoleIds } from '../src/gates/agent-personas.ts'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'

/** The packaged mirror the boot's wiring resolves (synced by bundle-assets). */
const REAL_MIRROR = join(packageRoot, 'harness-agents')

/** Skip-guard reason (module scope): the mirror is a bundle-assets sync
 * product (gitignored). A skip is printed ALWAYS — never a silent green;
 * only a non-skip run is evidence here. */
const skipReason = existsSync(REAL_MIRROR)
  ? undefined
  : `harness-agents mirror not synced (run \`bun run bundle-assets\` in packages/dsh)`

/** One structured boot-log record (the cordis exporter `Message` subset the
 * assertions read — narrowed structurally, no cordis type coupling). */
interface BootLogRecord {
  type?: unknown
  name?: unknown
  args?: unknown[]
}

/** Structural view of the cordis logger service the spec consumes. */
interface LoggerServiceView {
  /** The default buffer exporter's records (level-capped at INFO). */
  buffer: BootLogRecord[]
  /** Register an exporter (disposed with the registering fiber). */
  exporter(exporter: { levels?: Record<string, number>; export(message: BootLogRecord): void }): unknown
}

/** The boot-log records captured so far: the default buffer PLUS the
 * test-owned full-level exporter registered right after boot (union —
 * the buffer cannot hold WARN-class records; see the header comment). */
let ownLogRecords: BootLogRecord[] = []

/** The union capture for one booted app. */
function bootLogRecords(booted: BootResult): BootLogRecord[] {
  const logger = booted.ctx.logger as unknown as LoggerServiceView | undefined
  if (logger === undefined) return ownLogRecords
  return [...(logger.buffer ?? []), ...ownLogRecords]
}

/** Best-effort flattened text of one log record (the message match surface). */
function recordText(record: BootLogRecord): string {
  return (record.args ?? []).map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')
}

/**
 * Bounded poll until the effective readback STABILIZES: the sorted
 * `id:seeded` signature is sampled every 25 ms and the poll ends when the
 * signature has repeated 3× consecutively (≈75 ms quiet) or the 2 s budget
 * elapses — the assertion then reads the final state. Any change resets the
 * quiet counter, so a late retry (e.g. a fix converging at ≈250 ms) keeps
 * the poll alive until truly quiet. Exported for reuse by the fix tasks.
 */
export async function waitForStableRoles(service: FallbacksServiceView, timeoutMs = 2_000): Promise<void> {
  const signature = (): string =>
    service
      .getEffectiveRoles()
      .roles.map((row) => `${row.id}:${row.seeded ? 1 : 0}`)
      .sort()
      .join(',')
  const start = Date.now()
  let previous = signature()
  let quiet = 0
  while (quiet < 3) {
    if (Date.now() - start > timeoutMs) return
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 25)
    await promise
    const current = signature()
    quiet = current === previous ? quiet + 1 : 0
    previous = current
  }
}

/** The narrowed `roles.list` the fallbacks seed manager persisted through
 * the settings seam (`fallbacks` namespace) — `undefined` until the first
 * successful seed write (the install-e2e readback pattern). */
function settingsRolesList(booted: BootResult): unknown[] | undefined {
  const settings = booted.ctx.get('settings') as FakeSettingsRegistry | undefined
  if (settings === undefined) return undefined
  const raw: unknown = settings.get('fallbacks')
  if (typeof raw !== 'object' || raw === null || !('roles' in raw)) return undefined
  const roles: unknown = (raw as { roles: unknown }).roles
  if (typeof roles !== 'object' || roles === null || !('list' in roles)) return undefined
  const list: unknown = (roles as { list: unknown }).list
  return Array.isArray(list) ? list : undefined
}

let booted: BootResult | undefined

// The skip reason (module scope): printed ALWAYS so a skipped run is
// explicit in the output, never a silent green.
if (skipReason !== undefined) {
  console.log(`fallbacks-seeds-boot-order: SKIPPED — ${skipReason}`)
}

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  ownLogRecords = []
})

describe('fallbacks seeds boot-order — single REAL-package boot converges the mstar role seeds', () => {
  test.skipIf(skipReason !== undefined)(
    'plain boot (mstar row first, real dsh-llm-fallbacks, deferred fake settings): 20-id taxonomy, persisted mstar rows, clean boot log',
    async () => {
      // 1. Expected id set — MIRROR-DERIVED mstar ids (never hardcoded) ∪
      //    the installed upstream preset ids (runtime anchor, not a local
      //    constant — upstream drift fails here, not in the field).
      const mstarIds = subagentRoleIds(REAL_MIRROR)
      expect(mstarIds, 'the mirror yields the 13 mstar subagent role ids').toHaveLength(13)
      const presetIds = presetRoles.map((role) => role.id)
      const expectedIds = new Set([...mstarIds, ...presetIds])
      expect(expectedIds.size, 'mstar and preset id sets are disjoint').toBe(mstarIds.length + presetIds.length)

      // 2. SINGLE boot — the real fallbacks devDependency, the real mstar
      //    src plugin, the fake settings seam mounted AFTER the fallbacks
      //    row ('fake-deferred' — the realistic settings arrival that
      //    reproduces the live declare-vs-binding race; see the header
      //    comment), the real profile row order (mstar first). No dispose,
      //    no re-apply, no decision-point emit: the plain boot a real
      //    deployment performs.
      const fallbacksModule = await import('dsh-llm-fallbacks')
      booted = await bootApp({ fallbacksModule, settingsService: 'fake-deferred' })
      // Full-level capture from settle-onward (registered post-boot: the
      // ctx does not exist earlier; the default buffer covers the boot
      // window and the union below is the assertion surface).
      ownLogRecords = []
      const logger = booted.ctx.logger as unknown as LoggerServiceView | undefined
      logger?.exporter({
        levels: { default: 3 },
        export: (message) => {
          ownLogRecords.push(message)
        },
      })

      // 3. The service is up (the fallbacks row applied).
      const service = fallbacksService(booted.ctx)
      expect(service, 'the real llm-fallbacks service is applied').toBeDefined()

      // 4. Give the boot every chance to converge (bounded ≤2 s), then read
      //    the final state — a healthy fix converges within its retry
      //    budget (≪2 s); the broken tree stabilizes missing the mstar ids.
      await waitForStableRoles(service!)
      const readback = service!.getEffectiveRoles()
      const effectiveIds = new Set(readback.roles.map((row) => row.id))

      // 5. RED assertion — the effective taxonomy carries ALL 20 ids after
      //    a plain boot. Failure output names the missing mstar ids.
      const missing = [...expectedIds].filter((id) => !effectiveIds.has(id)).sort()
      expect(missing, 'every expected role id is effective after a single plain boot (no dispose/re-apply)').toEqual([])

      // 6. Every mstar row is seeded with a non-empty persona.
      const byId = new Map(readback.roles.map((row) => [row.id, row]))
      for (const id of mstarIds) {
        const row = byId.get(id)
        expect(row, `effective role row for ${id}`).toBeDefined()
        expect(row!.seeded, `seeded source for ${id}`).toBe(true)
        expect(row!.persona?.trim(), `persona non-empty for ${id}`).not.toBe('')
      }

      // 7. The declaration PERSISTED: the fallbacks settings namespace
      //    carries every mstar row (the readback pattern the install-e2e
      //    pins — here without any host re-composition in between).
      const persisted = settingsRolesList(booted)
      expect(persisted, 'the fallbacks settings namespace carries the seed write').toBeDefined()
      const persistedIds = new Set(
        (persisted ?? [])
          .map((row) => (typeof row === 'object' && row !== null && 'id' in row ? (row as { id: unknown }).id : undefined))
          .filter((id): id is string => typeof id === 'string'),
      )
      for (const id of mstarIds) {
        expect(persistedIds.has(id), `persisted settings row for ${id}`).toBe(true)
      }

      // 8. Clean boot log: zero `mstar/fallbacks-seeds` ERROR records (the
      //    contained declaration failure of the unfixed tree) and zero
      //    `mstar/fallbacks-advisory` degraded-abort WARN records — over
      //    the buffer ∪ own-exporter union (see header comment).
      const records = bootLogRecords(booted)
      const seedsErrors = records.filter((record) => record.name === 'mstar/fallbacks-seeds' && record.type === 'error')
      const advisoryDegraded = records.filter(
        (record) => record.name === 'mstar/fallbacks-advisory' && recordText(record).includes('aborted (degraded'),
      )
      if (seedsErrors.length > 0 || advisoryDegraded.length > 0) {
        console.log('boot-order: boot-log violations:', JSON.stringify([...seedsErrors, ...advisoryDegraded].map((record) => ({ name: record.name, type: record.type, text: recordText(record) })), null, 2))
      }
      expect(seedsErrors, 'no mstar/fallbacks-seeds ERROR in the boot log').toEqual([])
      expect(advisoryDegraded, 'no mstar/fallbacks-advisory degraded-abort WARN in the boot log').toEqual([])
    },
  )

})
