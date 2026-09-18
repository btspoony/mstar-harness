/**
 * CLI `mstar catalog` -- thin surface over the catalog authority (P1 domain
 * verbs) and its import/discovery/export transport (P2, contract §2/§4).
 *
 * Verbs: list|show|register|update|link|discover|import|export.
 * Success `{ok:true,data}`; refusal `{ok:false,code,message}`; exit 0 success,
 * 1 domain/runtime/IO refusal, 2 usage. Help owns flags.
 *
 * The module owns argument shape only: identity, paths, relations and the
 * reviewed import decisions are engine-validated. `catalog reconcile` (the
 * recoverable registration journal, contract §3) is registered by the
 * registration-journal task, not here.
 */
import { Command } from "commander";
import { isAbsolute, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import pc from "picocolors";
import {
  CatalogError,
  CatalogImportError,
  SddScriptError,
  StoreError,
  catalogExportToInputs,
  discoverCatalog,
  exportCatalog,
  getCatalog,
  importCatalog,
  linkCatalogEntities,
  listCatalog,
  planCatalogImport,
  registerCatalogEntity,
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

const CATALOG_VERBS: Record<string, true> = {
  list: true,
  show: true,
  register: true,
  update: true,
  link: true,
  discover: true,
  import: true,
  export: true,
};

const COMMAND_POSITION = 2;

type CatalogCliOptions = Record<string, string | boolean | undefined>;

const ENTITY_KINDS: Record<string, true> = { project: true, iteration: true, plan: true, document: true };
const ROOT_KINDS: Record<string, true> = {
  repository: true,
  harness: true,
  plans: true,
  iterations: true,
  specs: true,
  knowledge: true,
  projects: true,
};
const DOCUMENT_KINDS: Record<string, true> = {
  spec: true,
  knowledge: true,
  guide: true,
  compass: true,
  plan: true,
  roadmap: true,
  review: true,
  other: true,
};
const LIFECYCLES: Record<string, true> = { active: true, archived: true, superseded: true };
const RELATIONS: Record<string, true> = {
  "belongs-to": true,
  documents: true,
  "spec-ref": true,
  "knowledge-ref": true,
  "derived-from": true,
  supersedes: true,
};

/**
 * Usage-failure object for commander-level errors on `mstar catalog`
 * (unknown option, excess argument). Mirrors `planUsageFailurePayload`.
 */
export function catalogUsageFailurePayload(argv: readonly string[], message: string): string | null {
  if (argv[COMMAND_POSITION] !== "catalog") return null;
  const verb = argv.slice(COMMAND_POSITION + 1).find((token) => !token.startsWith("-"));
  return JSON.stringify({
    ok: false,
    code: "usage",
    message,
    details: { operation: verb !== undefined && CATALOG_VERBS[verb] === true ? verb : "catalog" },
  });
}

function usage(message: string): never {
  throw new SddScriptError(message, 2);
}

function requireFlag(raw: string | undefined, flag: string, what: string): string {
  if (raw === undefined || raw.trim() === "") usage(`${flag} is required (${what})`);
  return raw.trim();
}

function optionalFlag(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

function requireAbsolute(raw: string, flag: string): string {
  const path = requireFlag(raw, flag, "absolute path");
  if (!isAbsolute(path)) usage(`${flag} must be an absolute path`);
  return path;
}

function parsePagingInt(raw: string | undefined, flag: string, min: number, max?: number): number {
  const value = requireFlag(raw, flag, "page value");
  if (!/^\d+$/.test(value)) usage(`${flag} must be a nonnegative integer -- got ${JSON.stringify(value)}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    usage(max === undefined ? `${flag} must be >= ${min}` : `${flag} must be ${min}..${max}`);
  }
  return parsed;
}

function oneOf<T extends string>(raw: string | undefined, allowed: Record<string, true>, flag: string): T {
  const value = requireFlag(raw, flag, "enum value");
  if (!Object.hasOwn(allowed, value)) usage(`${flag} must be one of ${Object.keys(allowed).join(" | ")} -- got ${JSON.stringify(value)}`);
  return value as T;
}

function optionalOneOf<T extends string>(raw: string | undefined, allowed: Record<string, true>, flag: string): T | undefined {
  return raw === undefined ? undefined : oneOf<T>(raw, allowed, flag);
}

function readJsonFile(raw: string, flag: string): unknown {
  const path = requireAbsolute(raw, flag);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    usage(`${flag} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    usage(`${flag} is not valid JSON`);
  }
}

function writeJsonFile(raw: string, flag: string, value: unknown): string {
  const path = requireAbsolute(raw, flag);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function storeContext(options: CatalogCliOptions): StoreContext {
  const override = typeof options.harness === "string" ? options.harness : undefined;
  const resolved = resolveProcessHarnessDir(process.cwd(), override);
  const harnessDir = resolved ?? (override !== undefined ? resolve(override) : process.cwd());
  return { harnessDir };
}

function entityKeyOf(options: CatalogCliOptions, positional?: string, kindFlag = "kind", idFlag = "id"): CatalogKey {
  const id = positional !== undefined && positional.trim() !== "" ? positional.trim() : requireFlag(asText(options[idFlag]), `--${idFlag}`, "catalog id");
  return { kind: oneOf<CatalogEntityKind>(asText(options[kindFlag]), ENTITY_KINDS, `--${kindFlag}`), id };
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function linkOf(options: CatalogCliOptions): CatalogLinkInput {
  const ordinalRaw = optionalFlag(asText(options.ordinal));
  const ordinal = ordinalRaw === undefined ? null : parsePagingInt(ordinalRaw, "--ordinal", 0);
  return {
    from: { kind: oneOf<CatalogEntityKind>(asText(options.fromKind), ENTITY_KINDS, "--from-kind"), id: requireFlag(asText(options.fromId), "--from-id", "from id") },
    relation: oneOf<CatalogRelation>(asText(options.relation), RELATIONS, "--relation"),
    to: { kind: oneOf<CatalogEntityKind>(asText(options.toKind), ENTITY_KINDS, "--to-kind"), id: requireFlag(asText(options.toId), "--to-id", "to id") },
    ordinal,
  };
}

function printSuccess(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, data }));
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function failCatalog(verb: string, error: unknown, json: boolean): void {
  if (error instanceof SddScriptError) {
    if (json) console.log(JSON.stringify({ ok: false, code: "usage", message: error.message, details: { operation: verb } }));
    else console.error(pc.red(`catalog ${verb}: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  if (error instanceof CatalogError || error instanceof CatalogImportError || error instanceof StoreError) {
    if (json) console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, details: {} }));
    else console.error(pc.red(`catalog ${verb}: ${error.message}`));
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, code: "catalog.internal-error", message, details: { operation: verb } }));
  else console.error(pc.red(`catalog ${verb} failed: ${message}`));
  process.exitCode = 1;
}

async function runVerb(verb: string, options: CatalogCliOptions, body: (json: boolean) => Promise<void>): Promise<void> {
  const json = options.json === true;
  try {
    await body(json);
  } catch (error) {
    failCatalog(verb, error, json);
  }
}

/** Mutation flags shared by the domain writes (§2: operation id + actor). */
function mutationFlags(command: Command): Command {
  return command
    .option("--actor <role>", "Audit actor recorded on the catalog operation")
    .option("--operation-id <id>", "Idempotent operation id (reuse it to replay a retry)")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout");
}

function filterFlags(command: Command): Command {
  return command
    .option("--kind <kind>", "Filter: project | iteration | plan | document")
    .option("--document-kind <kind>", "Filter: spec | knowledge | guide | compass | plan | roadmap | review | other")
    .option("--lifecycle <lifecycle>", "Filter: active | archived | superseded")
    .option("--project <id>", "Filter by `belongs-to` project membership")
    .option("--iteration <id>", "Filter by `belongs-to` iteration membership")
    .option("--limit <n>", "Page size (default 50, max 200)")
    .option("--offset <n>", "Nonnegative offset")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout");
}

function listFilterOf(options: CatalogCliOptions): CatalogFilter {
  const filter: CatalogFilter = {};
  const kind = optionalOneOf<CatalogEntityKind>(asText(options.kind), ENTITY_KINDS, "--kind");
  if (kind !== undefined) filter.kind = kind;
  const documentKind = optionalOneOf<CatalogDocumentKind>(asText(options.documentKind), DOCUMENT_KINDS, "--document-kind");
  if (documentKind !== undefined) filter.documentKind = documentKind;
  const lifecycle = optionalOneOf<CatalogLifecycle>(asText(options.lifecycle), LIFECYCLES, "--lifecycle");
  if (lifecycle !== undefined) filter.lifecycle = lifecycle;
  const projectId = optionalFlag(asText(options.project));
  if (projectId !== undefined) filter.projectId = projectId;
  const iterationId = optionalFlag(asText(options.iteration));
  if (iterationId !== undefined) filter.iterationId = iterationId;
  if (asText(options.limit) !== undefined) filter.limit = parsePagingInt(asText(options.limit), "--limit", 1, 200);
  if (asText(options.offset) !== undefined) filter.offset = parsePagingInt(asText(options.offset), "--offset", 0);
  return filter;
}

function patchOf(options: CatalogCliOptions): CatalogEntityPatch {
  const patch: CatalogEntityPatch = {};
  if (asText(options.title) !== undefined) patch.title = requireFlag(asText(options.title), "--title", "catalog title");
  if (asText(options.description) !== undefined) patch.description = asText(options.description);
  const rootKind = optionalOneOf<CatalogRootKind>(asText(options.rootKind), ROOT_KINDS, "--root-kind");
  if (rootKind !== undefined) patch.rootKind = rootKind;
  if (asText(options.path) !== undefined) patch.relativePath = requireFlag(asText(options.path), "--path", "root-relative catalog path");
  if (asText(options.documentKind) !== undefined) {
    patch.documentKind = oneOf<CatalogDocumentKind>(asText(options.documentKind), DOCUMENT_KINDS, "--document-kind");
  }
  const lifecycle = optionalOneOf<CatalogLifecycle>(asText(options.lifecycle), LIFECYCLES, "--lifecycle");
  if (lifecycle !== undefined) patch.lifecycle = lifecycle;
  if (asText(options.sourceHash) !== undefined) patch.sourceHash = requireFlag(asText(options.sourceHash), "--source-hash", "body content hash");
  if (Object.keys(patch).length === 0) usage("no catalog field was given; pass at least one of --title/--description/--root-kind/--path/--document-kind/--lifecycle/--source-hash");
  return patch;
}

/** A reviewed import plan read from `--plan`, or built from `--inputs`. */
async function reviewedPlanOf(context: StoreContext, options: CatalogCliOptions): Promise<CatalogImportPlan> {
  const planFile = asText(options.plan);
  const inputsFile = asText(options.inputs);
  if (planFile !== undefined && inputsFile !== undefined) usage("--plan and --inputs are mutually exclusive");
  if (planFile === undefined && inputsFile === undefined) usage("one of --plan <file.json> or --inputs <file.json> is required");
  const payload = readJsonFile(planFile ?? inputsFile!, planFile !== undefined ? "--plan" : "--inputs");
  if (planFile !== undefined) return payload as CatalogImportPlan;
  const inputs = Array.isArray(payload) ? (payload as CatalogImportInput[]) : catalogExportToInputs(payload as CatalogExport);
  return planCatalogImport(context, inputs);
}

function importSummary(plan: CatalogImportPlan): Record<string, unknown> {
  return {
    version: plan.version,
    entities: plan.entities.length,
    links: plan.links.length,
    conflicts: plan.conflicts.length,
    unknowns: plan.unknowns.length,
    retirementSections: plan.retirementSections.length,
    sourceDigests: plan.sourceDigests.length,
  };
}

export function registerCatalogCommands(program: Command): void {
  const catalog = program
    .command("catalog")
    .description(
      "Catalog authority verbs (engine-backed): list, show, register, update, link, discover, import, export. " +
        "`discover` is a read-only proposal over the configured roots; `import` applies a reviewed plan " +
        "(conflicts and source drift refuse the whole import); `export` is versioned transport, never a file " +
        "authority. JSON envelope on stdout with --json; exit 0 success, 1 domain/runtime/IO refusal, 2 usage",
    )
    .exitOverride();

  filterFlags(
    catalog
      .command("list")
      .description("List catalog rows with their incident relations (deterministic kind/title/id order)"),
  ).action(async (options: CatalogCliOptions) =>
    runVerb("list", options, async (json) => {
      const page = await listCatalog(storeContext(options), listFilterOf(options));
      printSuccess(page, json);
    }),
  );

  catalog
    .command("show")
    .description("Show one catalog row with every relation incident to it")
    .argument("<kind>", "project | iteration | plan | document")
    .argument("<id>", "Catalog id")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (kind: string, id: string, options: CatalogCliOptions) =>
      runVerb("show", options, async (json) => {
        const detail = await getCatalog(storeContext(options), entityKeyOf({ ...options, kind }, id));
        printSuccess(detail, json);
      }),
    );

  mutationFlags(
    catalog
      .command("register")
      .description(
        "Register a catalog row, or attach to the row that already owns the canonical location " +
          "(a different id at a registered location attaches rather than minting a duplicate)",
      )
      .requiredOption("--kind <kind>", "project | iteration | plan | document")
      .requiredOption("--id <id>", "Catalog id")
      .requiredOption("--title <title>", "Catalog title")
      .requiredOption("--root-kind <rootKind>", "repository | harness | plans | iterations | specs | knowledge | projects")
      .requiredOption("--path <relativePath>", "Path relative to the resolved root kind")
      .option("--description <text>", "Catalog description")
      .option("--document-kind <kind>", "Required for a document row: spec | knowledge | guide | compass | plan | roadmap | review | other")
      .option("--lifecycle <lifecycle>", "Catalog lifecycle (default active)")
      .option("--source-hash <sha256>", "Content hash of the tracked body at review time"),
  ).action(async (options: CatalogCliOptions) =>
    runVerb("register", options, async (json) => {
      const documentKind = optionalOneOf<CatalogDocumentKind>(asText(options.documentKind), DOCUMENT_KINDS, "--document-kind");
      const lifecycle = optionalOneOf<CatalogLifecycle>(asText(options.lifecycle), LIFECYCLES, "--lifecycle");
      const receipt = await registerCatalogEntity(
        storeContext(options),
        {
          kind: oneOf<CatalogEntityKind>(asText(options.kind), ENTITY_KINDS, "--kind"),
          id: requireFlag(asText(options.id), "--id", "catalog id"),
          title: requireFlag(asText(options.title), "--title", "catalog title"),
          description: optionalFlag(asText(options.description)) ?? null,
          rootKind: oneOf<CatalogRootKind>(asText(options.rootKind), ROOT_KINDS, "--root-kind"),
          relativePath: requireFlag(asText(options.path), "--path", "root-relative catalog path"),
          ...(documentKind === undefined ? {} : { documentKind }),
          ...(lifecycle === undefined ? {} : { lifecycle }),
          ...(asText(options.sourceHash) === undefined ? {} : { sourceHash: requireFlag(asText(options.sourceHash), "--source-hash", "body content hash") }),
        },
        { operationId: requireFlag(asText(options.operationId), "--operation-id", "idempotency key"), actor: requireFlag(asText(options.actor), "--actor", "audit actor") },
      );
      printSuccess(receipt, json);
    }),
  );

  mutationFlags(
    catalog
      .command("update")
      .description("Change catalog-only metadata/lifecycle; identity is never patched and `--expect` guards the revision")
      .argument("<kind>", "project | iteration | plan | document")
      .argument("<id>", "Catalog id")
      .requiredOption("--expect <n>", "Revision from `mstar catalog show`")
      .option("--title <title>", "New catalog title")
      .option("--description <text>", "New catalog description")
      .option("--root-kind <rootKind>", "Move to another resolved root kind")
      .option("--path <relativePath>", "New path relative to the root kind")
      .option("--document-kind <kind>", "New document kind (document rows only)")
      .option("--lifecycle <lifecycle>", "active | archived | superseded")
      .option("--source-hash <sha256>", "New tracked-body content hash"),
  ).action(async (kind: string, id: string, options: CatalogCliOptions) =>
    runVerb("update", options, async (json) => {
      const receipt = await updateCatalogEntity(
        storeContext(options),
        entityKeyOf({ ...options, kind }, id),
        patchOf(options),
        parsePagingInt(asText(options.expect), "--expect", 1),
        { operationId: requireFlag(asText(options.operationId), "--operation-id", "idempotency key"), actor: requireFlag(asText(options.actor), "--actor", "audit actor") },
      );
      printSuccess(receipt, json);
    }),
  );

  mutationFlags(
    catalog
      .command("link")
      .description("Record a relation between two registered catalog rows (both endpoints must exist)"),
  )
    .requiredOption("--from-kind <kind>", "Relation source entity kind")
    .requiredOption("--from-id <id>", "Relation source id")
    .requiredOption("--relation <relation>", "belongs-to | documents | spec-ref | knowledge-ref | derived-from | supersedes")
    .requiredOption("--to-kind <kind>", "Relation target entity kind")
    .requiredOption("--to-id <id>", "Relation target id")
    .option("--ordinal <n>", "Nonnegative ordinal inside one relation family")
    .action(async (options: CatalogCliOptions) =>
      runVerb("link", options, async (json) => {
        const receipt = await linkCatalogEntities(storeContext(options), linkOf(options), {
          operationId: requireFlag(asText(options.operationId), "--operation-id", "idempotency key"),
          actor: requireFlag(asText(options.actor), "--actor", "audit actor"),
        });
        printSuccess(receipt, json);
      }),
    );

  catalog
    .command("discover")
    .description(
      "Read-only dry-run inventory (contract §4): legacy index rows plus the tracked bodies of the configured " +
        "roots, as proposals with their reviewed source hashes, undisclosed metadata and index sections proposed " +
        "for retirement. Writes nothing",
    )
    .option("--out <file>", "Absolute path to write the proposed plan JSON to (review artifact)")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: CatalogCliOptions) =>
      runVerb("discover", options, async (json) => {
        const plan = await discoverCatalog(storeContext(options));
        const out = asText(options.out);
        if (out !== undefined) {
          const written = writeJsonFile(out, "--out", plan);
          printSuccess({ ...importSummary(plan), out: written }, json);
          return;
        }
        printSuccess(plan, json);
      }),
    );

  mutationFlags(
    catalog
      .command("import")
      .description(
        "Apply a reviewed plan through the shared catalog mutations. --plan takes a CatalogImportPlan JSON " +
          "(from `catalog discover` or a host-built plan); --inputs takes a reviewed input array or a " +
          "`catalog export` payload. Conflicts and reviewed-source drift refuse the whole import before the " +
          "first write; no workflow session is created and no index is retired. --dry-run re-checks the plan " +
          "against the store and sources and writes nothing (exit 1 when it would be refused)",
      )
      .option("--plan <file>", "Reviewed CatalogImportPlan JSON (absolute path)")
      .option("--inputs <file>", "Reviewed CatalogImportInput[] JSON, or a CatalogExport payload (absolute path)")
      .option("--dry-run", "Report whether the plan would be accepted, without writing"),
  ).action(async (options: CatalogCliOptions) =>
    runVerb("import", options, async (json) => {
      const context = storeContext(options);
      const plan = await reviewedPlanOf(context, options);
      if (options.dryRun === true) {
        const verification = await verifyCatalogImport(context, plan);
        const data = { importable: verification.ok, ...importSummary(plan), drift: verification.drift, conflicts: verification.conflicts };
        printSuccess(data, json);
        if (!verification.ok) {
          if (!json) console.error(pc.red(`catalog import: the reviewed plan would be refused (${verification.drift.length} drifted source(s), ${verification.conflicts.length} conflict(s))`));
          process.exitCode = 1;
        }
        return;
      }
      const receipt = await importCatalog(context, plan, {
        operationId: requireFlag(asText(options.operationId), "--operation-id", "idempotency key"),
        actor: requireFlag(asText(options.actor), "--actor", "audit actor"),
      });
      printSuccess(receipt, json);
    }),
  );

  catalog
    .command("export")
    .description(
      "Versioned transport dump of the whole catalog (ids, relations, revisions and provenance). " +
        "Not a continuously maintained file authority: import it with `catalog import --inputs`",
    )
    .option("--out <file>", "Absolute path to write the export payload to")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: CatalogCliOptions) =>
      runVerb("export", options, async (json) => {
        const payload = await exportCatalog(storeContext(options));
        const out = asText(options.out);
        if (out !== undefined) {
          const written = writeJsonFile(out, "--out", payload);
          printSuccess({ version: payload.version, storeRevision: payload.storeRevision, entities: payload.entities.length, links: payload.links.length, out: written }, json);
          return;
        }
        printSuccess(payload, json);
      }),
    );

  for (const command of [catalog, ...catalog.commands]) command.exitOverride();
}
