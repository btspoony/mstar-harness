/** Shared pure collection of lifecycle branch ownership facts. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** One observed lifecycle owner claim. */
export type ActiveLifecycleBranch = { branch: string; workflowId: string | null; planId: string | null };

/** The stable identity of a lifecycle plan row, preferring its canonical id. */
export function activeLifecyclePlanId(row: unknown): string | null {
  if (!isPlainObject(row)) return null;
  return typeof row.id === "string" ? row.id : typeof row.plan_id === "string" ? row.plan_id : null;
}

/** Collect ownership, including retained L2 tracks; base/target are not ownership. */
export function collectActiveLifecycleBranches(snapshots: readonly Record<string, unknown>[]): ActiveLifecycleBranch[] {
  const owned = new Map<string, ActiveLifecycleBranch>();
  const add = (branch: string, workflowId: string | null, planId: string | null) => {
    const key = `${branch}\0${workflowId ?? ""}\0${planId ?? ""}`;
    if (!owned.has(key)) owned.set(key, { branch, workflowId, planId });
  };
  for (const doc of snapshots) {
    const workflowId = typeof doc.id === "string" ? doc.id : null;
    const branch = doc.branch;
    if (isPlainObject(branch) && typeof branch.integration === "string" && branch.integration.trim() !== "") add(branch.integration, workflowId, null);
    if (!Array.isArray(doc.plans)) continue;
    for (const row of doc.plans) {
      if (!isPlainObject(row)) continue;
      const planId = activeLifecyclePlanId(row);
      const meta = row.metadata;
      if (isPlainObject(meta) && Array.isArray(meta.track_branches)) {
        for (const track of meta.track_branches) if (typeof track === "string" && track.trim() !== "") add(track, workflowId, planId);
      }
      if (isPlainObject(meta) && typeof meta.working_branch === "string" && meta.working_branch.trim() !== "") add(meta.working_branch, workflowId, planId);
    }
  }
  return [...owned.values()];
}

