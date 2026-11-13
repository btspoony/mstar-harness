import { ALL_ROLES, ROLE_GROUPS } from "./constants";
import type { ModelSelections } from "./types";

function pickByOrder(roleIds: readonly string[], selectedModels: string[]) {
  const assignments: Record<string, string> = {};
  for (let i = 0; i < roleIds.length; i += 1) {
    assignments[roleIds[i]] = selectedModels[i % selectedModels.length];
  }
  return assignments;
}

function pickRandom(roleIds: readonly string[], selectedModels: string[]) {
  const assignments: Record<string, string> = {};
  for (const roleId of roleIds) {
    assignments[roleId] = selectedModels[Math.floor(Math.random() * selectedModels.length)];
  }
  return assignments;
}

/** Excluded from `others` by group membership, not by what this call wrote: a
 *  caller supplying one group must not have the rest filled at random. */
const GROUPED_ROLES = new Set<string>([
  "project-manager",
  ...ROLE_GROUPS.strategic,
  ...ROLE_GROUPS.dev,
  ...ROLE_GROUPS.qc,
]);

export function buildModelAssignments(selections: ModelSelections) {
  const assignments: Record<string, string> = {};
  if (selections.pm.length > 0) assignments["project-manager"] = selections.pm[0];
  const groups = [
    [ROLE_GROUPS.strategic, selections.strategic],
    [ROLE_GROUPS.dev, selections.dev],
    [ROLE_GROUPS.qc, selections.qc],
  ] as const;
  for (const [roleIds, models] of groups) {
    if (models.length > 0) Object.assign(assignments, pickByOrder(roleIds, models));
  }
  if (selections.others.length === 0) return assignments;
  const others = ALL_ROLES.filter((role) => !GROUPED_ROLES.has(role));
  return { ...assignments, ...pickRandom(others, selections.others) };
}
