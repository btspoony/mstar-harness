export const SUPPORTED_TARGETS = ["opencode", "cursor", "codex", "zcode", "omp", "dsh"] as const;
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
  ) => Record<string, unknown>;
  validateConfig?: (config: Record<string, unknown>) => string[];
  /** Non-fatal notices printed after doctor validation passes (e.g. migration hints). */
  getDoctorWarnings?: (config: Record<string, unknown>) => string[];
  runInstallInit?: (
    scope: Scope,
    dryRun: boolean,
    initFlags?: InstallInitFlags,
  ) => { location: string; notes: string[] };
  runInstallDoctor?: (scope: Scope) => { location: string; errors: string[]; notes?: string[] };
  printPostSetupSummary?: (config: Record<string, unknown>) => void;
};
