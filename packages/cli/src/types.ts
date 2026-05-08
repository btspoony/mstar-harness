export const SUPPORTED_TARGETS = ["opencode"] as const;
export type Target = (typeof SUPPORTED_TARGETS)[number];
export type Scope = "global" | "project";

export type InitOptions = {
  yes?: boolean;
  target?: Target;
  scope?: Scope;
  output?: string;
  dryRun?: boolean;
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

export type ModelSelections = {
  pm: string[];
  strategic: string[];
  dev: string[];
  qc: string[];
  others: string[];
};

export type AgentAdapter = {
  target: Target;
  getAvailableModels: () => string[];
  resolveConfigPath: (scope: Scope, outputPath?: string) => string;
  mutateConfigForInit: (
    config: Record<string, unknown>,
    assignments: Record<string, string>,
  ) => Record<string, unknown>;
  validateConfig: (config: Record<string, unknown>) => string[];
  printPostSetupSummary?: (config: Record<string, unknown>) => void;
};
