import { ALL_ROLES, ROLE_GROUPS } from "./constants";
import type { ModelSelections } from "./types";

export function parseSelection(
  rawValues: string[] | undefined,
  models: string[],
  maxCount: number,
  singleOnly = false,
) {
  const picked = (rawValues || []).map((item) => item.trim()).filter(Boolean);
  if (!picked.length) return { ok: false as const, reason: "empty" as const };
  if (singleOnly && picked.length !== 1) return { ok: false as const, reason: "single_required" as const };
  if (picked.length > maxCount) return { ok: false as const, reason: "too_many" as const };
  const invalid = picked.filter((id) => !models.includes(id));
  if (invalid.length) return { ok: false as const, reason: "invalid" as const, invalid };
  return { ok: true as const, value: picked };
}

export function requireValidatedSelection(
  label: string,
  rawValues: string[] | undefined,
  models: string[],
  maxCount: number,
  singleOnly = false,
) {
  const parsed = parseSelection(rawValues, models, maxCount, singleOnly);
  if (parsed.ok) return parsed.value;
  if (parsed.reason === "empty") throw new Error(`Missing option for ${label}.`);
  if (parsed.reason === "single_required") throw new Error(`${label} requires exactly one model.`);
  if (parsed.reason === "too_many") throw new Error(`${label} allows at most ${maxCount} model(s).`);
  throw new Error(`${label} contains invalid model(s): ${parsed.invalid.join(", ")}`);
}

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
