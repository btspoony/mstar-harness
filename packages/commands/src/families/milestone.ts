import { engineErrorFacts } from "./family-refusal.js";
import { refusalEnvelope } from "../envelope.js";
import { addMilestone, assignIssueMilestone, queryMilestones, resolveProcessHarnessDir, updateMilestone, withStoreRead, type MilestonePatch, type MutationContext, type StoreContext } from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const schema = z.object({ project: z.string().optional(), id: z.string().optional(), name: z.string().optional(), ordinal: z.number().int().nonnegative().optional(), target: z.string().optional(), clearTarget: z.boolean().optional(), status: z.enum(["planned", "active", "delivered", "dropped"]).optional(), issue: z.string().optional(), reason: z.string().optional(), expectIssue: z.number().int().nonnegative().optional(), expectStore: z.number().int().nonnegative().optional(), operation: z.string().optional(), session: z.string().optional(), actor: z.string().optional(), harness: z.string().optional(), clear: z.boolean().optional() });
type Input = z.infer<typeof schema>;
const verbs = ["add", "update", "assign", "list", "status"] as const;
const flags: Record<keyof Input, string> = { project:"--project <id>",id:"--id <id>",name:"--name <name>",ordinal:"--ordinal <n>",target:"--target <YYYY-MM-DD>",clearTarget:"--clear-target",status:"--status <status>",issue:"--issue <id>",reason:"--reason <text>",expectIssue:"--expect-issue <n>",expectStore:"--expect-store <n>",operation:"--operation <id>",session:"--session <path>",actor:"--actor <role>",harness:"--harness <root>",clear:"--clear" };
const options: Record<(typeof verbs)[number], (keyof Input)[]> = { add:["project","name","ordinal","target","expectStore","operation","harness"], update:["project","id","name","ordinal","target","clearTarget","status","expectStore","operation","harness"], assign:["project","issue","id","clear","reason","expectIssue","expectStore","operation","session","actor","harness"], list:["project","harness"], status:["project","id","harness"] };
const required: Record<(typeof verbs)[number], (keyof Input)[]> = { add:["project","name","ordinal","expectStore","operation"], update:["project","id","expectStore","operation"], assign:["project","issue","reason","expectIssue","expectStore","operation","session","actor"], list:["project"], status:["project","id"] };
class UsageError extends Error {}
function requireValue(value: string | undefined, flag: string): string { if (value === undefined || !value.trim()) throw new UsageError(`${flag} is required`); return value.trim(); }
function context(input: Input, invocation: InvocationContext): StoreContext { const root = resolveProcessHarnessDir(invocation.cwd, input.harness); return { harnessDir: root ?? input.harness ?? invocation.controlRoot ?? invocation.cwd }; }
function envelope(id: string, data: unknown): CommandEnvelope { return { version:1, command:id, status:"ok", code:`${id}.ok`, exitCode:0, data }; }
export function failure(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const { code, details, recovery } = engineErrorFacts(error);
  const facts = { details: { operation: id, ...details }, ...(recovery === undefined ? {} : { recovery }) };
  if (error instanceof UsageError) return refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message, ...facts });
  return refusalEnvelope({ command: id, status: "refused", code: code ?? `${id}.internal-error`, exitCode: 1, message, ...facts });
}
async function run(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
 try {
  const verb = id.slice("milestone.".length) as typeof verbs[number]; const projectId = requireValue(input.project,"--project"); const store = context(input,invocation);
  if (verb === "list" || verb === "status") return envelope(id,await withStoreRead(store,queryMilestones(projectId,verb === "status" ? requireValue(input.id,"--id") : undefined)));
  if (input.expectStore === undefined) throw new UsageError("--expect-store is required");
  const operationId = requireValue(input.operation,"--operation");
  if (verb === "add") { if (input.name === undefined || input.ordinal === undefined) throw new UsageError("--name and --ordinal are required"); return envelope(id,await addMilestone(store,{projectId,name:input.name,ordinal:input.ordinal,target:input.target ?? null},{operationId,expectedStoreRevision:input.expectStore})); }
  if (verb === "update") {
   if (input.target !== undefined && input.clearTarget) throw new UsageError("--target and --clear-target are exclusive");
   const patch: MilestonePatch = { ...(input.name === undefined ? {} : {name:input.name}), ...(input.ordinal === undefined ? {} : {ordinal:input.ordinal}), ...(input.status === undefined ? {} : {status:input.status}), ...(input.target === undefined && !input.clearTarget ? {} : {target:input.clearTarget ? null : input.target!}) };
   if (!Object.keys(patch).length) throw new UsageError("update requires at least one patch field");
   return envelope(id,await updateMilestone(store,projectId,requireValue(input.id,"--id"),patch,{operationId,expectedStoreRevision:input.expectStore}));
  }
  if ((input.id !== undefined) === (input.clear === true)) throw new UsageError("exactly one of --id or --clear is required");
  if (input.expectIssue === undefined) throw new UsageError("--expect-issue is required");
  const mutation: MutationContext & {expectedStoreRevision:number} = {operationId,actor:requireValue(input.actor,"--actor"),sessionFile:requireValue(input.session,"--session"),expectedRevision:input.expectIssue,expectedStoreRevision:input.expectStore};
  return envelope(id,await assignIssueMilestone(store,requireValue(input.issue,"--issue"),{projectId,milestoneId:input.clear ? null : requireValue(input.id,"--id"),reason:requireValue(input.reason,"--reason")},mutation));
 } catch(error) { return failure(id, error); }
}
export function getMilestoneCommandDefinitions(): readonly CommandDefinition[] {
  const descriptions: Record<(typeof verbs)[number], string> = {
    add: "Add a milestone record to the project store; its name, target and ordinal are authoritative.",
    update: "Update stored milestone fields using the observed store revision; roadmap document text is unchanged.",
    assign: "Assign or unassign an issue from a stored milestone with expected issue revision and a reason.",
    list: "List the project's stored milestones and linked-issue rollups.",
    status: "Show one milestone and linked issue rollup.",
  };
  return verbs.map((verb) => {
    const id = `milestone.${verb}`;
    const opts = options[verb];
    const requirements = (["cli", "mcp"] as const).flatMap((route) => [
      ...required[verb].map((name) => ({
        name,
        ownership: "caller" as const,
        route,
        required: true,
        ...(name === "expectStore" || name === "expectIssue" ? { tokenKind: "revision" as const } : {}),
      })),
      ...(verb === "update" ? [
        { name: "name", ownership: "caller" as const, route, required: false, constraint: "at least one of name, ordinal, status, target, or clearTarget=true is required" },
        { name: "ordinal", ownership: "caller" as const, route, required: false, constraint: "at least one patch field is required; target and clearTarget are optional" },
        { name: "status", ownership: "caller" as const, route, required: false, constraint: "at least one patch field is required; target and clearTarget are optional" },
        { name: "target", ownership: "caller" as const, route, required: false, constraint: "optional patch; mutually exclusive with clearTarget" },
        { name: "clearTarget", ownership: "caller" as const, route, required: false, constraint: "only true clears target; false does not select a patch or alternative" },
      ] : []),
      ...(verb === "assign" ? [
        { name: "id", ownership: "caller" as const, route, required: false, constraint: "exactly one of id or clear=true is required" },
        { name: "clear", ownership: "caller" as const, route, required: false, constraint: "only true selects unassignment; false does not select this alternative" },
      ] : []),
    ]);
    return {
      id,
      cli: {
        path: ["milestone", verb], aliases: [], arguments: [],
        options: opts.map((key) => ({
          key, flags: flags[key], required: required[verb].includes(key),
          ...(verb === "update" && key === "clearTarget" ? { help: "Only true clears target; false does not select an alternative." } : {}),
          ...(verb === "update" && key === "target" ? { help: "Optional target patch; mutually exclusive with --clear-target." } : {}),
        })),
      },
      input: schema.pick(Object.fromEntries(opts.map((key) => [key, true])) as never),
      output: commandEnvelopeSchema,
      effects: verb === "list" || verb === "status" ? ["read"] : ["write"],
      description: descriptions[verb],
      requirements,
      execute: (input: Input, invocation: InvocationContext) => run(id, input, invocation),
    };
  });
}
