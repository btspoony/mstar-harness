export const ALL_ROLES = [
  "project-manager",
  "architect",
  "product-manager",
  "prompt-engineer",
  "fullstack-dev",
  "fullstack-dev-2",
  "frontend-dev",
  "qc-specialist",
  "qc-specialist-2",
  "qc-specialist-3",
  "qa-engineer",
  "ops-engineer",
  "writing-specialist",
] as const;

export const ROLE_GROUPS = {
  strategic: ["architect", "product-manager", "prompt-engineer"],
  dev: ["fullstack-dev", "fullstack-dev-2", "frontend-dev"],
  qc: ["qc-specialist", "qc-specialist-2", "qc-specialist-3"],
} as const;
