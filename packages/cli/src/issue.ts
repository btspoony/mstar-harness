/**
 * CLI `mstar issue` — thin surface over the C3 engine API (contract §5).
 *
 * Verbs: add|list|show|occurrence|triage|close|waive|duplicate|supersede|link|export.
 * Success `{ok:true,data,storeRevision}`; refusal `{ok:false,code,message,details}`.
 * Exit 0 success, 1 domain/runtime/IO, 2 usage. Help owns flags.
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import pc from "picocolors";
import {
  IssueError,
  SddScriptError,
  StoreError,
  appendOccurrence,
  captureIssue,
  closeIssue,
  getIssue,
  ISSUE_PAYLOAD_SCHEMAS,
  linkIssue,
  listIssues,
  resolveProcessHarnessDir,
  triageIssue,
  type CaptureInput,
  type ClosureEvidence,
  type IssueFilter,
  type IssueLink,
  type IssuePayloadName,
  type IssueReceipt,
  type IssueTriage,
  type MutationContext,
  type OccurrenceInput,
  type PayloadFieldSchema,
  type StoreContext,
  type TerminalDisposition,
} from "@mstar-harness/engine";

const ISSUE_VERBS: Record<string, true> = {
  add: true,
  list: true,
  show: true,
  occurrence: true,
  triage: true,
  close: true,
  waive: true,
  duplicate: true,
  supersede: true,
  link: true,
  export: true,
};

const COMMAND_POSITION = 2;

type IssueCliOptions = Record<string, string | boolean | number | undefined>;

const KINDS = {
  bug: true,
  risk: true,
  improvement: true,
  request: true,
  decision: true,
  "review-obligation": true,
} as const;

const SEVERITIES = { critical: true, high: true, medium: true, low: true, info: true } as const;

const DISPOSITIONS = {
  open: true,
  resolved: true,
  waived: true,
  duplicate: true,
  superseded: true,
} as const;

/**
 * Usage-failure object for commander-level errors on `mstar issue`
 * (unknown option, excess argument). Mirrors `planUsageFailurePayload`.
 */
export function issueUsageFailurePayload(argv: readonly string[], message: string): string | null {
  if (argv[COMMAND_POSITION] !== "issue") return null;
  const verb = argv.slice(COMMAND_POSITION + 1).find((token) => !token.startsWith("-"));
  return JSON.stringify({
    ok: false,
    code: "usage",
    message,
    details: { operation: verb !== undefined && ISSUE_VERBS[verb] === true ? verb : "issue" },
  });
}

function usage(message: string): never {
  throw new SddScriptError(message, 2);
}

function requireFlag(raw: string | undefined, flag: string, what: string): string {
  if (raw === undefined || raw.trim() === "") usage(`${flag} is required (${what})`);
  return raw.trim();
}

function parseExpect(raw: string | undefined): number {
  const value = requireFlag(raw, "--expect", "issue revision from show");
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    usage(`--expect must be a nonnegative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function readJsonFile(raw: string | undefined, flag: string): unknown {
  const path = requireFlag(raw, flag, "JSON payload file");
  if (!isAbsolute(path)) usage(`${flag} must be an absolute path`);
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

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    usage(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function validatePayload(typeName: IssuePayloadName, record: Record<string, unknown>): void {
  const failures: string[] = [];
  const visit = (
    schema: Record<string, PayloadFieldSchema>,
    value: Record<string, unknown>,
    prefix = "",
  ): void => {
    for (const [key, field] of Object.entries(schema)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const present = Object.hasOwn(value, key) && value[key] !== undefined;
      const fieldValue = value[key];
      if (!present) {
        if (field.required) {
          failures.push(
            field.type === "string" || field.type === "string | null"
              ? `${path} must be a nonblank string`
              : field.type === "string[]"
                ? `${path} must be an array of strings`
                : field.type === "object"
                  ? `${path} must be a JSON object`
                  : `${path} is required`,
          );
        }
        continue;
      }
      if (fieldValue === null && field.nullable) continue;
      if (field.type === "string" || field.type === "string | null") {
        if (typeof fieldValue !== "string" || (field.required && fieldValue.trim() === "")) {
          failures.push(`${path} must be a nonblank string`);
          continue;
        }
        if (field.values && !field.values.includes(fieldValue)) {
          failures.push(`invalid ${typeName === "IssueLink" && key === "kind" ? "provenance kind" : path} ${JSON.stringify(fieldValue)}`);
        }
      } else if (field.type === "string[]") {
        if (!Array.isArray(fieldValue) || fieldValue.some((item) => typeof item !== "string")) {
          failures.push(`${path} must be an array of strings`);
        }
      } else if (field.type === "object") {
        if (fieldValue === null || typeof fieldValue !== "object" || Array.isArray(fieldValue)) {
          failures.push(`${path} must be a JSON object`);
        } else if (field.properties) {
          visit(field.properties, fieldValue as Record<string, unknown>, path);
        }
      }
    }
  };
  visit(ISSUE_PAYLOAD_SCHEMAS[typeName] as Record<string, PayloadFieldSchema>, record);
  if (typeName === "IssueLink" && failures.length === 0) {
    const relationForm = typeof record.relation === "string" && typeof record.issueId === "string";
    const provenanceForm = typeof record.kind === "string" && typeof record.target === "string";
    if (!relationForm && !provenanceForm) failures.push("link payload needs relation+issueId or kind+target");
  }
  if (failures.length) usage(`${typeName} payload invalid: ${failures.join("; ")}`);
}

export function payloadFileHelp(typeName: IssuePayloadName): string {
  return `Absolute ${typeName} JSON path; fields: ${Object.keys(ISSUE_PAYLOAD_SCHEMAS[typeName]).join(", ")}. See mstar-harness schema ${typeName}`;
}

function readPayload(raw: string | undefined, typeName: IssuePayloadName): Record<string, unknown> {
  const record = asRecord(readJsonFile(raw, "--file"), typeName);
  validatePayload(typeName, record);
  return record;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") usage(`${key} must be a nonblank string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record) || record[key] === undefined) return undefined;
  if (typeof record[key] !== "string") usage(`${key} must be a string when present`);
  return record[key] as string;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    usage(`${key} must be an array of strings`);
  }
  return value as string[];
}

function parseKind(raw: string): CaptureInput["kind"] {
  if (!Object.hasOwn(KINDS, raw)) usage(`invalid kind ${JSON.stringify(raw)}`);
  return raw as CaptureInput["kind"];
}

function parseSeverity(raw: string): CaptureInput["severity"] {
  if (!Object.hasOwn(SEVERITIES, raw)) usage(`invalid severity ${JSON.stringify(raw)}`);
  return raw as CaptureInput["severity"];
}

function parseDisposition(raw: string): NonNullable<IssueFilter["disposition"]> {
  if (!Object.hasOwn(DISPOSITIONS, raw)) usage(`invalid disposition ${JSON.stringify(raw)}`);
  return raw as NonNullable<IssueFilter["disposition"]>;
}

function storeContext(options: IssueCliOptions): StoreContext {
  const override = typeof options.harness === "string" ? options.harness : undefined;
  const resolved = resolveProcessHarnessDir(process.cwd(), override);
  const harnessDir = resolved ?? (override !== undefined ? resolve(override) : process.cwd());
  return { harnessDir };
}

/**
 * Capture verbs carry the capturing seat and no plan scope (contract §4/§6:
 * unscoped confirmed findings stay capturable without a plan).
 */
function captureMutationOf(options: IssueCliOptions): MutationContext {
  return {
    operationId: requireFlag(
      typeof options.operationId === "string" ? options.operationId : undefined,
      "--operation-id",
      "idempotency key",
    ),
    actor: requireFlag(typeof options.actor === "string" ? options.actor : undefined, "--actor", "capturing seat"),
  };
}

/**
 * Privileged verbs are authorized by the session envelope, never by `--actor`
 * alone: the envelope is required and the actor label must match its seat.
 */
function authorizedMutationOf(options: IssueCliOptions, withExpect: boolean): MutationContext {
  const mutation = captureMutationOf(options);
  mutation.sessionFile = requireFlag(
    typeof options.session === "string" ? options.session : undefined,
    "--session",
    "authorizing session envelope path",
  );
  if (withExpect) mutation.expectedRevision = parseExpect(typeof options.expect === "string" ? options.expect : undefined);
  return mutation;
}

function issueIdOf(options: IssueCliOptions, positional?: string): string {
  if (positional !== undefined && positional.trim() !== "") return positional.trim();
  return requireFlag(typeof options.id === "string" ? options.id : undefined, "--id", "issue id");
}

function captureInputOf(record: Record<string, unknown>): CaptureInput {
  const input: CaptureInput = {
    projectId: requireString(record, "projectId"),
    title: requireString(record, "title"),
    kind: parseKind(requireString(record, "kind")),
    severity: parseSeverity(requireString(record, "severity")),
    impact: requireString(record, "impact"),
    acceptance: requireString(record, "acceptance"),
    sourceIdentity: requireString(record, "sourceIdentity"),
    rootCauseKey: requireString(record, "rootCauseKey"),
    acceptanceKey: requireString(record, "acceptanceKey"),
    occurrenceKey: requireString(record, "occurrenceKey"),
    sourceKind: requireString(record, "sourceKind"),
    location: requireString(record, "location"),
    observedBehavior: requireString(record, "observedBehavior"),
    evidence: stringArray(record, "evidence"),
    discoveredAt: requireString(record, "discoveredAt"),
  };
  const owner = optionalString(record, "owner");
  if (owner !== undefined) input.owner = owner;
  return input;
}

function occurrenceInputOf(record: Record<string, unknown>): OccurrenceInput {
  return {
    sourceIdentity: requireString(record, "sourceIdentity"),
    rootCauseKey: requireString(record, "rootCauseKey"),
    acceptanceKey: requireString(record, "acceptanceKey"),
    occurrenceKey: requireString(record, "occurrenceKey"),
    sourceKind: requireString(record, "sourceKind"),
    location: requireString(record, "location"),
    observedBehavior: requireString(record, "observedBehavior"),
    evidence: stringArray(record, "evidence"),
    discoveredAt: requireString(record, "discoveredAt"),
  };
}

function closureEvidenceOf(record: Record<string, unknown>): ClosureEvidence {
  const evidence: ClosureEvidence = {
    reason: requireString(record, "reason"),
    references: stringArray(record, "references"),
  };
  const scope = optionalString(record, "scope");
  if (scope !== undefined) evidence.scope = scope;
  const canonicalIssueId = optionalString(record, "canonicalIssueId");
  if (canonicalIssueId !== undefined) evidence.canonicalIssueId = canonicalIssueId;
  const alignmentRef = optionalString(record, "alignmentRef");
  if (alignmentRef !== undefined) evidence.alignmentRef = alignmentRef;
  return evidence;
}

function triageOf(record: Record<string, unknown>): IssueTriage {
  const patch: IssueTriage = { reason: requireString(record, "reason") };
  if ("kind" in record && record.kind !== undefined) {
    if (typeof record.kind !== "string") usage("kind must be a string when present");
    patch.kind = parseKind(record.kind);
  }
  if ("severity" in record && record.severity !== undefined) {
    if (typeof record.severity !== "string") usage("severity must be a string when present");
    patch.severity = parseSeverity(record.severity);
  }
  const impact = optionalString(record, "impact");
  if (impact !== undefined) patch.impact = impact;
  const acceptance = optionalString(record, "acceptance");
  if (acceptance !== undefined) patch.acceptance = acceptance;
  if ("owner" in record) {
    if (record.owner === null) patch.owner = null;
    else if (typeof record.owner === "string") patch.owner = record.owner;
    else usage("owner must be a string or null when present");
  }
  return patch;
}

function linkOf(record: Record<string, unknown>): IssueLink {
  if (typeof record.relation === "string") {
    const relation = record.relation;
    if (relation !== "related" && relation !== "blocks" && relation !== "duplicate-of" && relation !== "superseded-by") {
      usage(`invalid relation ${JSON.stringify(relation)}`);
    }
    return { relation, issueId: requireString(record, "issueId") };
  }
  if (typeof record.kind === "string") {
    const kind = record.kind;
    if (kind !== "plan" && kind !== "iteration" && kind !== "pr" && kind !== "report") {
      usage(`invalid provenance kind ${JSON.stringify(kind)}`);
    }
    return { kind, target: requireString(record, "target") };
  }
  usage("link payload needs relation+issueId or kind+target");
}

function parsePagingInt(raw: string, flag: string, min: number, max?: number): number {
  if (!/^\d+$/.test(raw)) usage(`${flag} must be a nonnegative integer \u2014 got ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) usage(`${flag} is out of range \u2014 got ${JSON.stringify(raw)}`);
  if (value < min || (max !== undefined && value > max)) {
    usage(
      max === undefined
        ? `${flag} must be >= ${min} \u2014 got ${JSON.stringify(raw)}`
        : `${flag} must be ${min}..${max} \u2014 got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function listFilterOf(options: IssueCliOptions): IssueFilter {
  const filter: IssueFilter = {};
  if (typeof options.project === "string") filter.projectId = options.project;
  if (typeof options.disposition === "string") filter.disposition = parseDisposition(options.disposition);
  if (typeof options.kind === "string") filter.kind = parseKind(options.kind);
  if (typeof options.severity === "string") filter.severity = parseSeverity(options.severity);
  if (typeof options.query === "string") filter.query = options.query;
  if (typeof options.limit === "string") filter.limit = parsePagingInt(options.limit, "--limit", 1, 200);
  if (typeof options.offset === "string") filter.offset = parsePagingInt(options.offset, "--offset", 0);
  return filter;
}

function printSuccess(data: unknown, storeRevision: number, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, data, storeRevision }));
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function failIssue(verb: string, error: unknown, json: boolean): void {
  if (error instanceof SddScriptError) {
    if (json) {
      console.log(JSON.stringify({ ok: false, code: "usage", message: error.message, details: { operation: verb } }));
    } else {
      console.error(pc.red(`issue ${verb}: ${error.message}`));
    }
    process.exitCode = error.exitCode;
    return;
  }
  if (error instanceof IssueError || error instanceof StoreError) {
    if (json) {
      console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, details: {} }));
    } else {
      console.error(pc.red(`issue ${verb}: ${error.message}`));
    }
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, code: "issue.internal-error", message, details: { operation: verb } }));
  else console.error(pc.red(`issue ${verb} failed: ${message}`));
  process.exitCode = 1;
}

async function runVerb(verb: string, options: IssueCliOptions, body: (json: boolean) => Promise<void>): Promise<void> {
  const json = options.json === true;
  try {
    await body(json);
  } catch (error) {
    failIssue(verb, error, json);
  }
}


function mutationFlags(command: Command): Command {
  return command
    .option("--operation-id <id>", "Idempotent operation id")
    .option("--actor <role>", "Audit actor; must match the seat the mutation authorizes (capture: project-manager)")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout");
}

/** Privileged verbs additionally require the envelope that authorizes them. */
function authorizedFlags(command: Command): Command {
  return mutationFlags(command).option(
    "--session <path>",
    "Absolute engine-issued session envelope of a live workflow (workflows/<id>/sessions/<role>-<session-id>.json); required",
  );
}

function expectFlag(command: Command): Command {
  return command.option("--expect <n>", "Expected issue revision");
}

export function registerIssueCommands(program: Command): void {
  const issue = program
    .command("issue")
    .description(
      "Issue store verbs (engine-backed): capture, read, occurrence, triage, terminal disposition, link, and export. " +
        "JSON envelope on stdout with --json; exit 0 success, 1 domain/runtime/IO refusal, 2 usage",
    )
    .exitOverride();

  mutationFlags(
    issue
      .command("add")
      .description("Capture a confirmed finding (unscoped; no plan required)")
      .option("--file <path>", payloadFileHelp("CaptureInput")),
  ).action(async (options: IssueCliOptions) =>
    runVerb("add", options, async (json) => {
      const input = captureInputOf(readPayload(typeof options.file === "string" ? options.file : undefined, "CaptureInput"));
      const receipt = await captureIssue(storeContext(options), input, captureMutationOf(options));
      printSuccess(receipt, receipt.storeRevision, json);
    }),
  );

  issue
    .command("list")
    .description("List issues")
    .option("--project <id>", "Filter by project id")
    .option("--disposition <disposition>", "Filter by disposition")
    .option("--kind <kind>", "Filter by kind")
    .option("--severity <severity>", "Filter by severity")
    .option("--query <text>", "Literal case-insensitive title/evidence text")
    .option("--limit <n>", "Page size (default 50, max 200)")
    .option("--offset <n>", "Nonnegative offset")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: IssueCliOptions) =>
      runVerb("list", options, async (json) => {
        const filter = listFilterOf(options);
        const page = await listIssues(storeContext(options), filter);
        printSuccess(page, page.storeRevision, json);
      }),
    );

  issue
    .command("show")
    .description("Show one issue")
    .argument("[id]", "Issue id")
    .option("--id <id>", "Issue id")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (id: string | undefined, options: IssueCliOptions) =>
      runVerb("show", options, async (json) => {
        const page = await listIssues(storeContext(options), { limit: 1 });
        const detail = await getIssue(storeContext(options), issueIdOf(options, id));
        printSuccess(detail, page.storeRevision, json);
      }),
    );

  mutationFlags(
    issue
      .command("occurrence")
      .description("Append an occurrence to an existing issue")
      .argument("[id]", "Issue id")
      .option("--id <id>", "Issue id")
      .option("--file <path>", payloadFileHelp("OccurrenceInput")),
  ).action(async (id: string | undefined, options: IssueCliOptions) =>
    runVerb("occurrence", options, async (json) => {
      const input = occurrenceInputOf(
        readPayload(typeof options.file === "string" ? options.file : undefined, "OccurrenceInput"),
      );
      const receipt = await appendOccurrence(storeContext(options), issueIdOf(options, id), input, captureMutationOf(options));
      printSuccess(receipt, receipt.storeRevision, json);
    }),
  );

  expectFlag(
    authorizedFlags(
      issue
        .command("triage")
        .description("Update triage fields without changing identity")
        .argument("[id]", "Issue id")
        .option("--id <id>", "Issue id")
        .option("--file <path>", payloadFileHelp("IssueTriage")),
    ),
  ).action(async (id: string | undefined, options: IssueCliOptions) =>
    runVerb("triage", options, async (json) => {
      const patch = triageOf(readPayload(typeof options.file === "string" ? options.file : undefined, "IssueTriage"));
      const receipt = await triageIssue(storeContext(options), issueIdOf(options, id), patch, authorizedMutationOf(options, true));
      printSuccess(receipt, receipt.storeRevision, json);
    }),
  );

  const closeVerb = (verb: "close" | "waive" | "duplicate" | "supersede", disposition: TerminalDisposition, description: string) => {
    expectFlag(
      authorizedFlags(
        issue
          .command(verb)
          .description(description)
          .argument("[id]", "Issue id")
          .option("--id <id>", "Issue id")
          .option("--file <path>", payloadFileHelp("ClosureEvidence")),
      ),
    ).action(async (id: string | undefined, options: IssueCliOptions) =>
      runVerb(verb, options, async (json) => {
        const evidence = closureEvidenceOf(
          readPayload(typeof options.file === "string" ? options.file : undefined, "ClosureEvidence"),
        );
        const receipt = await closeIssue(storeContext(options), issueIdOf(options, id), disposition, evidence, authorizedMutationOf(options, true));
        printSuccess(receipt, receipt.storeRevision, json);
      }),
    );
  };

  closeVerb(
    "close",
    "resolved",
    "Close as resolved (acceptance evidence in references plus the acceptance authority in alignmentRef)",
  );
  closeVerb("waive", "waived", "Close as waived");
  closeVerb("duplicate", "duplicate", "Close as duplicate of a canonical issue");
  closeVerb("supersede", "superseded", "Close as superseded by a replacement issue");

  expectFlag(
    authorizedFlags(
      issue
        .command("link")
        .argument("[id]", "Issue id")
        .description("Add a relation or typed provenance link")
        .option("--id <id>", "Issue id")
        .option("--file <path>", payloadFileHelp("IssueLink")),
    ),
  ).action(async (id: string | undefined, options: IssueCliOptions) =>
    runVerb("link", options, async (json) => {
      const link = linkOf(readPayload(typeof options.file === "string" ? options.file : undefined, "IssueLink"));
      const receipt = await linkIssue(storeContext(options), issueIdOf(options, id), link, authorizedMutationOf(options, true));
      printSuccess(receipt, receipt.storeRevision, json);
    }),
  );

  issue
    .command("export")
    .description("Human/transport dump of list or one issue (not a backup authority)")
    .argument("[id]", "Issue id")
    .option("--id <id>", "Issue id")
    .option("--project <id>", "Filter by project id")
    .option("--disposition <disposition>", "Filter by disposition")
    .option("--kind <kind>", "Filter by kind")
    .option("--severity <severity>", "Filter by severity")
    .option("--query <text>", "Literal case-insensitive title/evidence text")
    .option("--limit <n>", "Page size (default 50, max 200)")
    .option("--offset <n>", "Nonnegative offset")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (id: string | undefined, options: IssueCliOptions) =>
      runVerb("export", options, async (json) => {
        const page = await listIssues(storeContext(options), listFilterOf(options));
        const selected = id?.trim() || (typeof options.id === "string" ? options.id.trim() : "");
        if (selected !== "") {
          const detail = await getIssue(storeContext(options), selected);
          printSuccess(detail, page.storeRevision, json);
          return;
        }
        printSuccess(page, page.storeRevision, json);
      }),
    );

  for (const command of [issue, ...issue.commands]) command.exitOverride();
  program
    .command("schema")
    .description("Print the runtime field schema for a JSON payload type")
    .argument("<type>", "Payload type name")
    .action((typeName: string) => {
      if (!Object.hasOwn(ISSUE_PAYLOAD_SCHEMAS, typeName)) {
        usage(`unknown payload type ${JSON.stringify(typeName)}; available: ${Object.keys(ISSUE_PAYLOAD_SCHEMAS).join(", ")}`);
      }
      const fields = ISSUE_PAYLOAD_SCHEMAS[typeName as IssuePayloadName] as Record<string, PayloadFieldSchema>;
      console.log(
        JSON.stringify(
          { type: typeName, fields: Object.entries(fields).map(([name, field]) => ({ name, ...field })) },
          null,
          2,
        ),
      );
    });
}

