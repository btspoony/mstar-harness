import type { OpencodeGeneration } from "@mstar-harness/commands";

export type { OpencodeGeneration };
export const SUPPORTED_TARGETS = ["opencode", "cursor", "codex", "zcode", "omp", "dsh", "kimi"] as const;
export type Target = (typeof SUPPORTED_TARGETS)[number];
export type Scope = "global" | "project";

export type InitOptions = {
  yes?: boolean;
  target?: Target;
  scope?: Scope;
  output?: string;
  dryRun?: boolean;
  /** Skip installing the dsh-llm-fallbacks plugin row (dsh target only). */
  noFallbacks?: boolean;
  /** Skip installing the matching-version @mstar-harness/cli globally after init. */
  noGlobalCli?: boolean;
  /** OpenCode config generation override (opencode target only). */
  opencodeGeneration?: OpencodeGeneration;
  pmModel?: string;
  strategicModels?: string;
  devModels?: string;
  qcModels?: string;
  otherModels?: string;
};

export type DoctorOptions = {
  target?: Target;
  scope?: Scope;
  output?: string;
};

export type PluginValidateOptions = {
  root?: string;
};

/**
 * Injectable subprocess seam for executable lookup and generation probes.
 * The runner receives a command and timeout hint; the default runner aborts
 * the child, and callers independently race its promise so a runner that
 * ignores the hint cannot block indefinitely.
 */
export type ProbeCommandRunner = (
  command: readonly string[],
  opts: { timeoutMs: number },
) => Promise<string>;

/** Optional generation-selection opts for the opencode config-mode adapter. */
export type MutateConfigForInitOptions = {
  /** Explicit `--opencode-generation` selection; always wins over probe and markers. */
  generation?: OpencodeGeneration;
  /** `--dry-run`: presence/generation probes never run — pure preview (D15). */
  dryRun?: boolean;
  /** Test seam overriding executable-PATH lookup; absent in production. */
  presenceRunner?: ProbeCommandRunner;
  /** Test seam overriding the OpenCode generation subprocess runner. */
  probeRunner?: ProbeCommandRunner;
};

export type ModelSelections = {
  pm: string[];
  strategic: string[];
  dev: string[];
  qc: string[];
  others: string[];
};

/** Flags forwarded to an install-mode adapter's runInstallInit. */
export type InstallInitFlags = {
  noFallbacks?: boolean;
};

export type AgentAdapter = {
  target: Target;
  mode: "config" | "install";
  getAvailableModels?: () => string[];
  resolveConfigPath?: (scope: Scope, outputPath?: string) => string;
  mutateConfigForInit?: (
    config: Record<string, unknown>,
    assignments: Record<string, string>,
    opts?: MutateConfigForInitOptions,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  validateConfig?: (config: Record<string, unknown>, opts?: MutateConfigForInitOptions) => string[];
  /** Non-fatal notices printed after doctor validation passes (e.g. migration hints). */
  getDoctorWarnings?: (config: Record<string, unknown>) => string[];
  runInstallInit?: (
    scope: Scope,
    dryRun: boolean,
    initFlags?: InstallInitFlags,
  ) => { location: string; notes: string[] } | Promise<{ location: string; notes: string[] }>;
  runInstallDoctor?: (scope: Scope) => { location: string; errors: string[]; notes?: string[] };
  printPostSetupSummary?: (config: Record<string, unknown>) => void;
};
