/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-skill` — the
 * agent skill provider registry (`ctx.skills`) consumed by `@mstar-harness/dsh`
 * and the `@deepseek-ai/dsh-skill-local` peer stub.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface — `SkillSummary` /
 * `SkillCandidate` / `SkillDefinition` shapes, the `SkillProvider` interface,
 * the `ctx.skills` service — and implements just enough behavior for
 * real-composition tests: provider registration with fiber-scoped disposal,
 * first-wins catalog merging (rank, then registration order), and on-demand
 * definition loading. Pinned to dsh-private commit 9451be2 (2026-08-07
 * snapshot). Keep in sync when the dsh-private baseline moves.
 */

import { Context, Service } from 'cordis'

/** Origin bucket for a skill contribution. The value is prompt-visible metadata, not precedence by itself. */
export type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})

/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
export type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** Invocation controls shared by skill discovery consumers. */
export interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean
}

/** Invocation-neutral skill metadata returned by `ctx.skills.list()`. */
export interface SkillSummary {
  /** Kebab-case identifier used to address the skill. */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved model and user invocation controls. */
  readonly invocation: SkillInvocationPolicy
  /** Discovery source that produced this winning skill. */
  readonly source: SkillSource
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase
}

/** Provider catalog entry used by the registry to merge and later load skills. */
export interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Absolute file path when the provider has one. */
  readonly path?: string
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Absolute file path when the skill came from disk. */
  readonly path?: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Caller context used for cwd-sensitive and abortable provider work. */
export interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}

/** Provider candidates plus whether the current discovery is authoritative. */
export interface SkillProviderObservation {
  /** Candidates available from the current provider discovery. */
  readonly candidates: readonly SkillCandidate[]
  /** Whether discovery completed and these candidates may be cached. */
  readonly complete: boolean
}

/** One catalog observation plus whether discovery completed within a stable catalog revision. */
export interface SkillCatalogSnapshot {
  /** Sorted invocation-neutral summaries collected in this observation. */
  readonly skills: SkillSummary[]
  /** Whether every registered provider completed without a concurrent catalog revision. */
  readonly complete: boolean
}

/** Provider interface for one source of skills, such as local directories or a remote registry. */
export interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  /**
   * List available skill candidates for the current lookup context. Providers
   * register synchronously during `apply()`; remote initialization,
   * authentication, and discovery are awaited inside this method.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns provider candidates as a complete-array shorthand, or an explicit
   *   observation when usable candidates came from incomplete discovery.
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

/** Registration-scoped lifecycle and invalidation capability borrowed by one provider. */
export interface SkillProviderControl {
  /** Aborts if registration fails or when the exact provider registration is disposed. */
  readonly signal: AbortSignal
  /** Invalidate completed catalogs and notify consumers only while the exact registration remains active. */
  readonly invalidate: () => void
}

/** Skill registry configuration. */
export interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
}

declare module 'cordis' {
  interface Context {
    skills: SkillService
  }

  interface Events {
    /**
     * A skill provider, runtime contribution, or provider-backed catalog may
     * have changed. This is an unfiltered invalidation notification; consumers
     * refetch the catalog for their own lookup options. Listener failures are
     * contained and cannot veto the registry mutation.
     * @mode emit
     */
    'skills/change'(): void
  }
}

/** One merged catalog entry: the winning candidate plus its owning provider. */
interface MergedEntry {
  readonly candidate: SkillCandidate
  readonly provider: SkillProvider
}

/**
 * Registry of skill providers (dev-time minimal functional stand-in). It
 * merges provider catalogs with stable first-wins duplicate handling (lower
 * rank wins; ties fall back to provider registration order), exposes sorted
 * invocation-neutral summaries, and loads full skill bodies on demand.
 *
 * `simplify:` dev-time stub — no catalog caching, revision tracking, or
 * cancellation racing; swap the real `@deepseek-ai/dsh-skill` package at P3
 * e2e for the production semantics.
 */
export class SkillService extends Service {
  private readonly providers: Array<{ provider: SkillProvider; order: number }> = []
  private nextProviderOrder = 0

  constructor(ctx: Context, _config: Config = {}) {
    super(ctx, 'skills')
  }

  /**
   * Register a borrowed same-process provider synchronously during plugin
   * apply. Duplicate names throw; fiber disposal unregisters the provider.
   * @param create - synchronous factory receiving this registration's lifecycle control.
   * @returns the exact Cordis effect disposer that unregisters this provider.
   */
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void {
    const lifecycle = new AbortController()
    const control: SkillProviderControl = {
      signal: lifecycle.signal,
      // simplify: dev-time stub — no catalog caches to invalidate.
      invalidate: () => {},
    }
    const provider = create(control)
    if (this.providers.some((entry) => entry.provider.name === provider.name)) {
      lifecycle.abort(new Error(`a skill provider named "${provider.name}" is already registered`))
      throw new Error(`a skill provider named "${provider.name}" is already registered`)
    }
    const entry = { provider, order: this.nextProviderOrder }
    this.nextProviderOrder += 1
    const providers = this.providers
    const notify = (): void => { this.ctx.emit('skills/change') }
    return this.ctx.effect(() => {
      providers.push(entry)
      notify()
      return () => {
        providers.splice(providers.indexOf(entry), 1)
        lifecycle.abort(new Error(`skill provider "${provider.name}" disposed`))
        notify()
      }
    }, 'skills.registerProvider()')
  }

  /**
   * List invocation-neutral skill summaries for a workspace.
   * @param options - lookup options; `cwd` selects project roots and `signal` cancels discovery.
   * @returns all sorted winning summaries.
   */
  async list(options: SkillLookupOptions = {}): Promise<SkillSummary[]> {
    return (await this.snapshot(options)).skills
  }

  /**
   * Observe the current invocation-neutral catalog and whether discovery
   * completed within a stable revision.
   * @param options - lookup options; `cwd` selects project roots and `signal` cancels discovery.
   * @returns sorted summaries plus discovery-completeness state.
   */
  async snapshot(options: SkillLookupOptions = {}): Promise<SkillCatalogSnapshot> {
    const merged = await this.merge(options)
    return { skills: merged.map((entry) => toSummary(entry.candidate)), complete: true }
  }

  /**
   * Load the winning candidate, passing its opaque discovery locator back to
   * the provider.
   * @param name - kebab-case skill name.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill, including body content, or `undefined`.
   */
  async get(name: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    const winner = (await this.merge(options)).find((entry) => entry.candidate.name === name)
    if (winner === undefined) return undefined
    return winner.provider.get(winner.candidate, options)
  }

  /** Collect candidates from all providers, first-wins by rank then registration order. */
  private async merge(options: SkillLookupOptions): Promise<MergedEntry[]> {
    const collected: MergedEntry[] = []
    for (const { provider } of this.providers) {
      const output = await provider.list(options)
      // `Array.isArray` does not narrow readonly-array unions — discriminate on the observation shape.
      const candidates: readonly SkillCandidate[] = 'candidates' in output ? output.candidates : output
      for (const candidate of candidates) collected.push({ candidate, provider })
    }
    // Lower ranks win duplicate names before provider registration order; the
    // stable sort keeps registration order within a rank.
    collected.sort((a, b) => a.candidate.rank - b.candidate.rank)
    const winners = new Map<string, MergedEntry>()
    for (const entry of collected) {
      if (!winners.has(entry.candidate.name)) winners.set(entry.candidate.name, entry)
    }
    return [...winners.values()].sort((a, b) => a.candidate.name.localeCompare(b.candidate.name))
  }
}

/** Strip provider-owned fields to the invocation-neutral summary shape. */
function toSummary(skill: SkillSummary): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
    invocation: skill.invocation,
    source: skill.source,
    provider: skill.provider,
    ...skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {},
  }
}

export default SkillService
