import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  RoadmapError,
  SddScriptError,
  StoreError,
  importRoadmapAuthority,
  readRoadmapAuthority,
  replaceRoadmapAuthority,
  resolveProcessHarnessDir,
  reviewRoadmapImport,
  type RoadmapExpected,
  type RoadmapImportReview,
  type StoreContext,
} from "@mstar-harness/engine";

type RoadmapOptions = Record<string, string | boolean | undefined>;
const COMMAND_POSITION = 2;
const VERBS: Record<string, true> = { show: true, import: true, replace: true, export: true };
class RoadmapAbsentError extends Error {
  readonly code = "roadmap.absent";
}

export function roadmapUsageFailurePayload(argv: readonly string[], message: string): string | null {
  if (argv[COMMAND_POSITION] !== "roadmap") return null;
  const verb = argv.slice(COMMAND_POSITION + 1).find((token) => !token.startsWith("-"));
  return JSON.stringify({ ok: false, code: "usage", message, details: { operation: verb !== undefined && VERBS[verb] ? verb : "roadmap" } });
}

function usage(message: string): never {
  throw new SddScriptError(message, 2);
}

function required(options: RoadmapOptions, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") usage(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  return value.trim();
}

function absolute(value: string, flag: string): string {
  if (!isAbsolute(value)) usage(`${flag} must be an absolute path`);
  return value;
}

function positiveRevision(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) usage(`${flag} must be a positive integer or absent`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) usage(`${flag} must be a positive integer`);
  return parsed;
}

function expectedRoadmapRevision(value: string): RoadmapExpected {
  return value === "absent" ? "absent" : positiveRevision(value, "--expect-roadmap");
}

function context(options: RoadmapOptions): StoreContext {
  const override = typeof options.harness === "string" ? options.harness : undefined;
  const harnessDir = resolveProcessHarnessDir(process.cwd(), override) ?? (override === undefined ? process.cwd() : resolve(override));
  return { harnessDir };
}

function jsonMode(options: RoadmapOptions): boolean {
  return options.json === true;
}

function success(data: unknown, json: boolean): void {
  console.log(json ? JSON.stringify({ ok: true, data }) : JSON.stringify(data, null, 2));
}

function failure(verb: string, error: unknown, json: boolean): void {
  if (error instanceof SddScriptError) {
    if (json) console.log(JSON.stringify({ ok: false, code: "usage", message: error.message, details: { operation: verb } }));
    else console.error(pc.red(`roadmap ${verb}: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  if (error instanceof RoadmapAbsentError) {
    if (json) console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, details: {} }));
    else console.error(pc.red(`roadmap ${verb}: ${error.message}`));
    process.exitCode = 1;
    return;
  }
  if (error instanceof RoadmapError || error instanceof StoreError) {
    if (json) console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, details: {} }));
    else console.error(pc.red(`roadmap ${verb}: ${error.message}`));
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, code: "roadmap.internal-error", message, details: { operation: verb } }));
  else console.error(pc.red(`roadmap ${verb} failed: ${message}`));
  process.exitCode = 1;
}

async function run(verb: string, options: RoadmapOptions, action: (json: boolean) => Promise<void>): Promise<void> {
  const json = jsonMode(options);
  try {
    await action(json);
  } catch (error) {
    failure(verb, error, json);
  }
}

function readReview(value: string): RoadmapImportReview {
  const reviewPath = absolute(value, "--review");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reviewPath, "utf8")) as unknown;
  } catch (error) {
    usage(`--review could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) usage("--review must contain a RoadmapImportReview object");
  const review = parsed as Partial<RoadmapImportReview>;
  if (
    review.version !== 1 || typeof review.projectId !== "string" || !Number.isSafeInteger(review.expectedProjectRevision) ||
    (review.expectedRoadmapRevision !== "absent" && (!Number.isSafeInteger(review.expectedRoadmapRevision) || (review.expectedRoadmapRevision as number) < 1)) ||
    typeof review.sourcePath !== "string" || !isAbsolute(review.sourcePath) || typeof review.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(review.sourceHash)
  ) usage("--review has invalid RoadmapImportReview fields; required: version:1, projectId:string, expectedProjectRevision:integer, expectedRoadmapRevision:number|'absent', sourcePath:absolute string, sourceHash:sha256 hex");
  return review as RoadmapImportReview;
}

export function registerRoadmapCommands(program: Command): void {
  const roadmap = program.command("roadmap")
    .description("Roadmap content authority: show, reviewed import, revision-guarded replace, and transport export")
    .exitOverride()
    .addHelpText("after", [
      "",
      "Payload contracts:",
      "  show.data = { projectId:string, projectRevision:integer, roadmap:RoadmapRecord|null }",
      "  RoadmapRecord = { projectId:string, revision:positive integer, contentHash:sha256 hex, updatedAt:string, contentMarkdown:string }",
      "  preview.data = { version:1, projectId:string, expectedProjectRevision:integer, expectedRoadmapRevision:positive integer|'absent', sourcePath:absolute string, sourceHash:sha256 hex }",
      "  write.data = { projectId:string, revision:positive integer, contentHash:sha256 hex, storeRevision:integer }",
      "  JSON export.data = { version:1, projectId:string, revision:positive integer, contentHash:sha256 hex, contentMarkdown:string }",
      "  Invalid roadmap content reports all validator field codes; absent authority, unknown project, schema/store refusal, source drift and revision conflict are distinct.",
    ].join("\n"));

  roadmap.command("show")
    .description("Show project/catalog revisions, authority record (or roadmap:null), hash and full Markdown content")
    .requiredOption("--project <id>", "Explicit catalog project id")
    .option("--harness <root>", "Canonical harness root override")
    .option("--json", "Machine-readable {ok:true,data} envelope")
    .action((options: RoadmapOptions) => run("show", options, async (json) => {
      const read = await readRoadmapAuthority(context(options), required(options, "project"));
      success({ projectId: read.projectId, projectRevision: read.projectRevision, roadmap: read.roadmap }, json);
    }));

  roadmap.command("import")
    .description("Preview import read-only with --file; apply only a saved reviewed RoadmapImportReview JSON using --review, --apply and --operation")
    .option("--project <id>", "Catalog project id for preview")
    .option("--file <absolute-md>", "Absolute Markdown source file for read-only preview")
    .option("--review <absolute-json>", "Absolute RoadmapImportReview JSON file for apply")
    .option("--apply", "Apply the reviewed import; requires --review and --operation")
    .option("--operation <id>", "Idempotent operation id required for apply")
    .option("--harness <root>", "Canonical harness root override")
    .option("--json", "Machine-readable {ok:true,data} envelope")
    .action((options: RoadmapOptions) => run("import", options, async (json) => {
      const applying = options.apply === true;
      if (applying) {
        if (options.project !== undefined || options.file !== undefined || options.review === undefined) usage("apply mode requires --review and rejects --project/--file");
        const receipt = await importRoadmapAuthority(context(options), readReview(required(options, "review")), { operationId: required(options, "operation") });
        success(receipt, json);
      } else {
        if (options.review !== undefined || options.operation !== undefined) usage("preview mode accepts only --project and --file; use --review --apply --operation to commit");
        const review = await reviewRoadmapImport(context(options), required(options, "project"), absolute(required(options, "file"), "--file"));
        success(review, json);
      }
    }));

  roadmap.command("replace")
    .description("Replace the complete Markdown record using observed catalog and roadmap revisions (or absent)")
    .requiredOption("--project <id>", "Explicit catalog project id")
    .requiredOption("--file <absolute-md>", "Absolute Markdown content candidate; never modified")
    .requiredOption("--expect-project <n>", "Observed catalog project revision")
    .requiredOption("--expect-roadmap <n|absent>", "Observed roadmap revision, or absent for creation")
    .requiredOption("--operation <id>", "Idempotent operation id")
    .option("--harness <root>", "Canonical harness root override")
    .option("--json", "Machine-readable {ok:true,data} envelope")
    .action((options: RoadmapOptions) => run("replace", options, async (json) => {
      let contentMarkdown: string;
      try {
        contentMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute(required(options, "file"), "--file")));
      } catch (error) {
        if (error instanceof TypeError) throw new RoadmapError("roadmap.invalid-content", "Replacement file is not valid UTF-8.");
        throw error;
      }
      const receipt = await replaceRoadmapAuthority(context(options), {
        projectId: required(options, "project"),
        expectedProjectRevision: positiveRevision(required(options, "expectProject"), "--expect-project"),
        expectedRoadmapRevision: expectedRoadmapRevision(required(options, "expectRoadmap")),
        contentMarkdown,
      }, { operationId: required(options, "operation") });
      success(receipt, json);
    }));

  roadmap.command("export")
    .description("Export the stored document as raw Markdown or version-1 JSON transport; refuses absent authority")
    .requiredOption("--project <id>", "Explicit catalog project id")
    .requiredOption("--format <markdown|json>", "Transport format")
    .option("--harness <root>", "Canonical harness root override")
    .option("--json", "Machine-readable envelope (JSON transport only)")
    .action((options: RoadmapOptions) => run("export", options, async (json) => {
      const format = required(options, "format");
      if (format !== "markdown" && format !== "json") usage("--format must be markdown | json");
      if (format === "markdown" && json) usage("--json is not accepted with raw Markdown export");
      const read = await readRoadmapAuthority(context(options), required(options, "project"));
      if (read.roadmap === null) throw new RoadmapAbsentError("roadmap.absent: project has no stored roadmap content");
      if (format === "markdown") process.stdout.write(read.roadmap.contentMarkdown);
      else success({ version: 1, projectId: read.projectId, revision: read.roadmap.revision, contentHash: read.roadmap.contentHash, contentMarkdown: read.roadmap.contentMarkdown }, json);
    }));

  for (const command of [roadmap, ...roadmap.commands]) command.exitOverride();
}
