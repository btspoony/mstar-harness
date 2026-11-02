/**
 * Command → owning-skill mapping, published by the CLI at its failure points
 * (refusal envelope `details.skill`, CLI `--help` `Skill:` line). The mapping
 * is a name only — the skill owns the semantics, never the envelope.
 */

/** Family defaults: one owning skill for the whole `<family>.*` group. */
const FAMILY_OWNING_SKILL: Readonly<Record<string, string>> = {
  persist: "mstar-artifacts",
  workflow: "mstar-artifacts",
  issue: "mstar-project-governance",
  milestone: "mstar-project-governance",
  project: "mstar-project-governance",
  catalog: "mstar-conventions",
  roadmap: "mstar-project-governance",
  store: "mstar-conventions",
  sdd: "mstar-sdd",
  audit: "mstar-audit",
  dispatch: "mstar-dispatch-gates",
  review: "mstar-review-qc",
  qc: "mstar-review-qc",
  "pr-review": "mstar-audit",
  skill: "mstar-skill-authoring",
  roles: "mstar-roles",
  compound: "mstar-compound",
  "design-md": "mstar-design-md",
  harness: "mstar-conventions",
  path: "mstar-conventions",
  host: "mstar-host",
  schema: "mstar-use-cli",
  report: "mstar-use-cli",
  lint: "mstar-skill-authoring",
};

/** Command overrides where one command visibly belongs to one skill inside a multi-owner family. */
const COMMAND_OWNING_SKILL: Readonly<Record<string, string>> = {
  "plan.show": "mstar-artifacts",
  "plan.bind": "mstar-iteration",
  "plan.prepare": "mstar-artifacts",
  "plan.progress": "mstar-sdd",
  "plan.issue-add": "mstar-project-governance",
  "plan.issue-close": "mstar-project-governance",
  "plan.complete": "mstar-artifacts",
  "iteration.gate": "mstar-iteration",
  "iteration.push-cadence": "mstar-iteration",
  "iteration.register": "mstar-artifacts",
  "status.validate": "mstar-artifacts",
  "status.tech-debt": "mstar-project-governance",
  "status.findings-cleanup": "mstar-artifacts",
  "status.workflow-close": "mstar-iteration",
  "worktree.check": "mstar-branch-worktree",
  "session.run": "mstar-iteration",
  "session.recover": "mstar-iteration",
  "worktree.qc-alignment": "mstar-branch-worktree",
  "worktree.cleanup": "mstar-iteration",
  "store.execution.restore-preview": "mstar-artifacts",
  "store.execution.restore": "mstar-artifacts",
  "store.execution.export": "mstar-artifacts",
  // checks-and-lints names mstar-project-governance (capture/source mapping)
  // as the staged issue/catalog migration's callout home, ahead of the
  // store family's mstar-conventions default.
  "store.migrate": "mstar-project-governance",
};

/** Exact id override, then family default, then nothing — no invented owner. */
export function owningSkillFor(commandId: string): string | undefined {
  return COMMAND_OWNING_SKILL[commandId] ?? FAMILY_OWNING_SKILL[commandId.split(".")[0] ?? ""];
}
