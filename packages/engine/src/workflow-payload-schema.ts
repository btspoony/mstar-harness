/**
 * The `workflow.snapshot` persist payload contract, in its own acyclic leaf
 * module. `coordination.ts` reads it at MODULE EVALUATION TIME for the
 * `PERSIST_PAYLOAD_CONTRACTS` value export, and `workflow.ts` reaches
 * `coordination.ts` through `path.ts -> catalog.ts` — a top-level read in
 * coordination.ts of a binding that lives in workflow.ts dies on the
 * import-order TDZ. Moving the literal here (it is a plain `as const` object
 * with no imports) lets both importers evaluate in any order.
 *
 * Validation remains `validateWorkflowSnapshot` in workflow.ts; this object is
 * the published field contract only (the `mstar-harness schema` surface).
 */
export const WORKFLOW_SNAPSHOT_PAYLOAD_SCHEMA = {
  version: { required: true, type: "number", description: "Root artifact version." },
  schema_version: { required: true, type: "number", description: "Snapshot schema version; currently 1." },
  id: { required: true, type: "string", description: "Workflow id, equal to the persist key." },
  type: { required: true, type: "string", description: "Workflow lifecycle type: plan or iteration." },
  status: { required: true, type: "string", description: "Current lifecycle status." },
  started_at: { required: true, type: "string", description: "Workflow start timestamp." },
  updated_at: { required: true, type: "string", description: "Last snapshot update timestamp." },
  plans: { required: false, type: "array", description: "Plan rows, validated by the workflow engine." },
} as const;
