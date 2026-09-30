import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SddScriptError,
  abortCatalogExecution,
  catalogExportToInputs,
  derivePlanRegistration,
  discoverCatalog,
  exportCatalog,
  getCatalog,
  importCatalog,
  linkCatalogEntities,
  listCatalog,
  listPendingCatalogRegistrations,
  planCatalogImport,
  reconcileCatalogExecution,
  registerCatalogEntity,
  resolvePlanDir,
  resolveProcessHarnessDir,
  updateCatalogEntity,
  verifyCatalogImport,
  type CatalogDocumentKind,
  type CatalogEntityKind,
  type CatalogEntityPatch,
  type CatalogExport,
  type CatalogFilter,
  type CatalogImportInput,
  type CatalogImportPlan,
  type CatalogKey,
  type CatalogLifecycle,
  type CatalogLinkInput,
  type CatalogRelation,
  type CatalogRootKind,
  type StoreContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../definitions.js";

const inputSchema = z.object({
  kind: z.string().optional(), id: z.string().optional(), title: z.string().optional(), description: z.string().optional(),
  rootKind: z.string().optional(), path: z.string().optional(), file: z.string().optional(), documentKind: z.string().optional(), lifecycle: z.string().optional(),
  sourceHash: z.string().optional(), expect: z.number().int().nonnegative().optional(), fromKind: z.string().optional(),
  fromId: z.string().optional(), relation: z.string().optional(), toKind: z.string().optional(), toId: z.string().optional(),
  ordinal: z.number().int().nonnegative().nullable().optional(), project: z.string().optional(), iteration: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(), offset: z.number().int().nonnegative().optional(), out: z.string().optional(),
  plan: z.string().optional(), inputs: z.string().optional(), dryRun: z.boolean().optional(), operationId: z.string().optional(),
  actor: z.string().optional(), harness: z.string().optional(), abort: z.boolean().optional(), list: z.boolean().optional(),
});
type Input = z.infer<typeof inputSchema>;
const verbs = ["discover", "import", "register", "update", "link", "list", "show", "export", "reconcile"] as const;
const entityKinds: readonly CatalogEntityKind[] = ["project", "iteration", "plan", "document"];
const rootKinds: readonly CatalogRootKind[] = ["repository", "harness", "plans", "iterations", "specs", "knowledge", "projects"];
const documentKinds: readonly CatalogDocumentKind[] = ["spec", "knowledge", "guide", "compass", "plan", "roadmap", "review", "other"];
const lifecycles: readonly CatalogLifecycle[] = ["active", "archived", "superseded"];
const relations: readonly CatalogRelation[] = ["belongs-to", "documents", "spec-ref", "knowledge-ref", "derived-from", "supersedes"];
const descriptions: Record<(typeof verbs)[number], string> = {
  discover: "Read-only inventory proposals with source hashes, unknowns and index sections proposed for retirement.",
  import: "Apply a reviewed catalog plan; conflicts and reviewed-source drift refuse the whole import before writes.",
  register: "Register a catalog row or attach to the row owning its canonical location.",
  update: "Change catalog-only metadata with an expected-revision guard.",
  link: "Record a relation between registered catalog rows.",
  list: "List catalog rows with incident relations.",
  show: "Show one catalog row and its incident relations.",
  export: "Export the versioned catalog transport payload.",
  reconcile: "Recover a pending catalog execution registration; --list is read-only and --abort abandons only unwritten work.",
};
const cliFlags: Record<keyof Input, string> = {
  kind: "--kind <kind>", id: "--id <id>", title: "--title <title>", description: "--description <text>", rootKind: "--root-kind <rootKind>",
  path: "--path <relativePath>", file: "--file <absolute-md>", documentKind: "--document-kind <kind>", lifecycle: "--lifecycle <lifecycle>", sourceHash: "--source-hash <sha256>",
  expect: "--expect <n>", fromKind: "--from-kind <kind>", fromId: "--from-id <id>", relation: "--relation <relation>", toKind: "--to-kind <kind>",
  toId: "--to-id <id>", ordinal: "--ordinal <n>", project: "--project <id>", iteration: "--iteration <id>", limit: "--limit <n>", offset: "--offset <n>",
  out: "--out <file>", plan: "--plan <file>", inputs: "--inputs <file>", dryRun: "--dry-run", operationId: "--operation-id <id>", actor: "--actor <role>",
  harness: "--harness <path>", abort: "--abort", list: "--list",
};
function envelope(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function failure(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const paths = error !== null && typeof error === "object" && "paths" in error && Array.isArray(error.paths)
    ? error.paths as string[]
    : [];
  const details: Record<string, unknown> = { operation: id, ...(paths.length === 0 ? {} : { paths }) };
  if (error instanceof SddScriptError) return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message, details };
  let code = `${id}.internal-error`;
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") code = error.code;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message, details };
}
function storeContext(input: Input, invocation: InvocationContext): StoreContext {
  const root = resolveProcessHarnessDir(invocation.cwd, input.harness);
  return { harnessDir: root ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function requireValue(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${field} is required`, 2);
  return value.trim();
}
/**
 * A usage refusal names EVERY irreducible field this verb cannot derive, in one
 * result (A27) — never the first missing field alone, and never a field the
 * domain can derive from a selected document. The message carries the real CLI
 * flag a caller types; the `paths` detail keeps the machine-readable field key
 * beside it.
 */
function requireAll(input: Input, fields: readonly (keyof Input)[]): void {
  const missing = fields.filter((field) => {
    const value = input[field];
    // A numeric guard (`--expect`) is present when it is a number; every other
    // aggregated field is a non-blank string.
    if (typeof value === "number") return false;
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length === 0) return;
  const flags = missing.map((field) => cliFlags[field].split(" ")[0]!);
  const error = new SddScriptError(
    `${flags.join(", ")} ${missing.length === 1 ? "is" : "are"} required; ` +
      "no derivable fact fills these from the selected document",
    2,
  ) as SddScriptError & { paths: string[] };
  error.paths = missing.map((field) => String(field));
  throw error;
}
function oneOf<T extends string>(value: string | undefined, values: readonly T[], field: string): T {
  const selected = requireValue(value, field);
  if (!values.includes(selected as T)) throw new SddScriptError(`${field} must be one of ${values.join(" | ")}`, 2);
  return selected as T;
}
/**
 * The catalog registration a named plan document proves (R1/A02). Identity,
 * title and the catalog LOCATION are read from the document through the ONE
 * derivation the registration journal also uses (`derivePlanRegistration`), so
 * reading a plan never enrolls it and a registered row can never disagree with
 * the document it points at. A supplied `id`/`title` is a CONSTRAINT on that
 * document, never a replacement for it — the engine refuses a contradiction.
 *
 * `path` on this verb is the catalog LOCATION of the plan
 * (`DerivedPlanRegistration.catalogRelativePath`, plans-root-relative); `file`
 * is the canonical plan pointer. Either names the same document.
 */
function planRegistration(input: Input, context: StoreContext): {
  kind: CatalogEntityKind; id: string; title: string; rootKind: CatalogRootKind; relativePath: string; resolvedFrom: readonly { path: string; source: string }[];
} {
  const located = input.path === undefined ? undefined : requireValue(input.path, "path");
  const planDir = resolvePlanDir(context.harnessDir);
  const file = input.file !== undefined
    ? requireValue(input.file, "file")
    : located === undefined
      ? undefined
      : path.join(planDir, located);
  if (file === undefined) throw new SddScriptError("one of --file or --path is required to derive a plan registration", 2);
  if (!path.isAbsolute(file)) throw new SddScriptError("file must be an absolute path", 2);
  const derived = derivePlanRegistration({
    harnessDir: context.harnessDir,
    plan: { ...(input.id === undefined ? {} : { id: input.id }), ...(input.title === undefined ? {} : { title: input.title }), file },
  });
  // The same document stated twice must agree: a supplied location that is not
  // the derived one is a caller error, never a silent relocation.
  if (located !== undefined && located !== derived.catalogRelativePath) {
    throw new SddScriptError(
      `path ${JSON.stringify(located)} is not the derived catalog location ${JSON.stringify(derived.catalogRelativePath)} of plan ${JSON.stringify(derived.plan.id)}`,
      2,
    );
  }
  return { kind: "plan", id: derived.plan.id, title: derived.plan.title, rootKind: "plans", relativePath: derived.catalogRelativePath, resolvedFrom: derived.resolvedFrom };
}
async function reviewedPlan(input: Input, context: StoreContext): Promise<CatalogImportPlan> {
  if (input.plan !== undefined && input.inputs !== undefined) throw new SddScriptError("plan and inputs are mutually exclusive", 2);
  const planFile = input.plan;
  const inputsFile = input.inputs;
  if (planFile === undefined && inputsFile === undefined) throw new SddScriptError("one of plan or inputs is required", 2);
  const file = planFile ?? inputsFile!;
  if (!path.isAbsolute(file)) throw new SddScriptError("plan and inputs paths must be absolute", 2);
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new SddScriptError(`reviewed catalog file could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (planFile !== undefined) return payload as CatalogImportPlan;
  const inputs = Array.isArray(payload) ? payload as CatalogImportInput[] : catalogExportToInputs(payload as CatalogExport);
  return await planCatalogImport(context, inputs);
}
function importSummary(plan: CatalogImportPlan): Record<string, unknown> {
  return {
    version: plan.version, entities: plan.entities.length, links: plan.links.length, conflicts: plan.conflicts.length,
    unknowns: plan.unknowns.length, retirementSections: plan.retirementSections.length, sourceDigests: plan.sourceDigests.length,
  };
}
async function execute(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  try {
    const context = storeContext(input, invocation);
    const verb = id.slice("catalog.".length);
    if (verb === "discover") {
      const plan = await discoverCatalog(context);
      if (input.out !== undefined) {
        if (!path.isAbsolute(input.out)) throw new SddScriptError("out must be an absolute path", 2);
        writeFileSync(input.out, `${JSON.stringify(plan, null, 2)}\n`);
        return envelope(id, { ...importSummary(plan), out: input.out });
      }
      return envelope(id, plan);
    }
    if (verb === "import") {
      requireAll(input, ["operationId", "actor"]);
      const plan = await reviewedPlan(input, context);
      if (input.dryRun) {
        const verification = await verifyCatalogImport(context, plan);
        return envelope(id, { importable: verification.ok, ...importSummary(plan), drift: verification.drift, conflicts: verification.conflicts });
      }
      return envelope(id, await importCatalog(context, plan, {
        operationId: input.operationId!, actor: input.actor!,
      }));
    }
    if (verb === "register") {
      // A `plan` row is the ONE case whose identity, title and location a
      // document proves: derive them rather than demanding the caller restate
      // what the harness already reads (R1/A02). Every other kind registers
      // facts only its caller owns, and an absent kind cannot select the plan
      // route at all — so the irreducible set is aggregated per route (A27).
      if (input.kind?.trim() === "plan") {
        const derived = planRegistration(input, context);
        requireAll(input, ["operationId", "actor"]);
        return envelope(id, await registerCatalogEntity(context, {
          kind: derived.kind, id: derived.id, title: derived.title, description: input.description ?? null,
          rootKind: derived.rootKind, relativePath: derived.relativePath,
          ...(input.lifecycle === undefined ? {} : { lifecycle: oneOf(input.lifecycle, lifecycles, "lifecycle") }),
          ...(input.sourceHash === undefined ? {} : { sourceHash: input.sourceHash }),
        }, { operationId: input.operationId!, actor: input.actor! }));
      }
      requireAll(
        input,
        input.kind === undefined
          ? ["kind", "operationId", "actor"]
          : ["kind", "id", "title", "rootKind", "path", "operationId", "actor"],
      );
      const documentKind = input.documentKind === undefined ? undefined : oneOf(input.documentKind, documentKinds, "documentKind");
      const lifecycle = input.lifecycle === undefined ? undefined : oneOf(input.lifecycle, lifecycles, "lifecycle");
      return envelope(id, await registerCatalogEntity(context, {
        kind: oneOf(input.kind, entityKinds, "kind"), id: requireValue(input.id, "id"), title: requireValue(input.title, "title"),
        description: input.description ?? null, rootKind: oneOf(input.rootKind, rootKinds, "rootKind"), relativePath: requireValue(input.path, "path"),
        ...(documentKind === undefined ? {} : { documentKind }), ...(lifecycle === undefined ? {} : { lifecycle }),
        ...(input.sourceHash === undefined ? {} : { sourceHash: input.sourceHash }),
      }, { operationId: input.operationId!, actor: input.actor! }));
    }
    if (verb === "update") {
      requireAll(input, ["kind", "id", "operationId", "actor"]);
      const patch: CatalogEntityPatch = {};
      if (input.title !== undefined) patch.title = requireValue(input.title, "title");
      if (input.description !== undefined) patch.description = input.description;
      if (input.rootKind !== undefined) patch.rootKind = oneOf(input.rootKind, rootKinds, "rootKind");
      if (input.path !== undefined) patch.relativePath = requireValue(input.path, "path");
      if (input.documentKind !== undefined) patch.documentKind = oneOf(input.documentKind, documentKinds, "documentKind");
      if (input.lifecycle !== undefined) patch.lifecycle = oneOf(input.lifecycle, lifecycles, "lifecycle");
      if (input.sourceHash !== undefined) patch.sourceHash = requireValue(input.sourceHash, "sourceHash");
      if (Object.keys(patch).length === 0) throw new SddScriptError("at least one catalog field must be updated", 2);
      requireAll(input, ["expect"]);
      return envelope(id, await updateCatalogEntity(context, {
        kind: oneOf(input.kind, entityKinds, "kind"), id: requireValue(input.id, "id"),
      }, patch, input.expect!, { operationId: input.operationId!, actor: input.actor! }));
    }
    if (verb === "link") {
      requireAll(input, ["fromKind", "fromId", "relation", "toKind", "toId", "operationId", "actor"]);
      return envelope(id, await linkCatalogEntities(context, {
        from: { kind: oneOf(input.fromKind, entityKinds, "fromKind"), id: requireValue(input.fromId, "fromId") },
        relation: oneOf(input.relation, relations, "relation"),
        to: { kind: oneOf(input.toKind, entityKinds, "toKind"), id: requireValue(input.toId, "toId") }, ordinal: input.ordinal ?? null,
      } as CatalogLinkInput, { operationId: input.operationId!, actor: input.actor! }));
    }
    if (verb === "list") {
      const filter: CatalogFilter = {};
      if (input.kind !== undefined) filter.kind = oneOf(input.kind, entityKinds, "kind");
      if (input.documentKind !== undefined) filter.documentKind = oneOf(input.documentKind, documentKinds, "documentKind");
      if (input.lifecycle !== undefined) filter.lifecycle = oneOf(input.lifecycle, lifecycles, "lifecycle");
      if (input.project !== undefined) filter.projectId = input.project;
      if (input.iteration !== undefined) filter.iterationId = input.iteration;
      if (input.limit !== undefined) filter.limit = input.limit;
      if (input.offset !== undefined) filter.offset = input.offset;
      return envelope(id, await listCatalog(context, filter));
    }
    if (verb === "show") return envelope(id, await getCatalog(context, {
      kind: oneOf(input.kind, entityKinds, "kind"), id: requireValue(input.id, "id"),
    } satisfies CatalogKey));
    if (verb === "export") {
      const payload = await exportCatalog(context);
      if (input.out !== undefined) {
        if (!path.isAbsolute(input.out)) throw new SddScriptError("out must be an absolute path", 2);
        writeFileSync(input.out, `${JSON.stringify(payload, null, 2)}\n`);
        return envelope(id, { version: payload.version, storeRevision: payload.storeRevision, entities: payload.entities.length, links: payload.links.length, out: input.out });
      }
      return envelope(id, payload);
    }
    if (verb === "reconcile") {
      if (input.list) {
        if (input.operationId !== undefined || input.abort) throw new SddScriptError("list mode rejects operationId and abort", 2);
        return envelope(id, { pending: await listPendingCatalogRegistrations(context) });
      }
      requireAll(input, ["operationId"]);
      return envelope(id, input.abort ? await abortCatalogExecution(context, input.operationId!, "abandoned from the command surface") : await reconcileCatalogExecution(context, input.operationId!));
    }
    throw new Error(`unsupported catalog command ${id}`);
  } catch (error) {
    return failure(id, error);
  }
}

const optionsByVerb: Record<(typeof verbs)[number], (keyof Input)[]> = {
  discover: ["out", "harness"],
  import: ["plan", "inputs", "dryRun", "operationId", "actor", "harness"],
  register: ["kind", "id", "title", "description", "rootKind", "path", "file", "documentKind", "lifecycle", "sourceHash", "operationId", "actor", "harness"],
  update: ["expect", "title", "description", "rootKind", "path", "documentKind", "lifecycle", "sourceHash", "operationId", "actor", "harness"],
  link: ["fromKind", "fromId", "relation", "toKind", "toId", "ordinal", "operationId", "actor", "harness"],
  list: ["kind", "documentKind", "lifecycle", "project", "iteration", "limit", "offset", "harness"],
  show: ["harness"],
  export: ["out", "harness"],
  reconcile: ["operationId", "abort", "list", "harness"],
};
const argumentsByVerb: Record<(typeof verbs)[number], (keyof Input)[]> = {
  discover: [], import: [], register: [], update: ["kind", "id"], link: [], list: [], show: ["kind", "id"], export: [], reconcile: [],
};
/**
 * Write verbs declare no parser-level required option: a sparse intent reaches
 * engine resolution and the handler aggregates every irreducible field in one
 * classified refusal (A03/A27). `catalog.show`/`update` keep their positional
 * identity arguments, which are genuinely irreducible for those verbs.
 */
const requiredOptions: Record<(typeof verbs)[number], (keyof Input)[]> = {
  discover: [], import: [], register: [], update: [], link: [],
  list: [], show: [], export: [], reconcile: [],
};
export function getCatalogCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => {
    const id = `catalog.${verb}`;
    const effects = verb === "discover" || verb === "reconcile" ? ["read", "write"] as const
      : ["list", "show", "export"].includes(verb) ? ["read"] as const : ["write"] as const;
    const inputKeys = [...argumentsByVerb[verb], ...optionsByVerb[verb]];
    const input = inputSchema.pick(Object.fromEntries(inputKeys.map((key) => [key, true])) as { [K in (typeof inputKeys)[number]]: true });
    return {
      id,
      cli: {
        path: ["catalog", verb], aliases: [],
        arguments: argumentsByVerb[verb].map((key) => ({ key, required: true, variadic: false })),
        options: optionsByVerb[verb].map((key) => ({ key, flags: cliFlags[key], required: requiredOptions[verb].includes(key) })),
      },
      input, output: commandEnvelopeSchema, effects, description: descriptions[verb],
      execute: (value: Input, context: InvocationContext) => execute(id, value, context),
    };
  });
}
