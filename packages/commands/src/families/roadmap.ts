import { refusalEnvelope } from "../envelope.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  RoadmapError,
  importRoadmapAuthority,
  parseRoadmapContent,
  queryDashboard,
  readRoadmapAuthority,
  replaceRoadmapAuthority,
  resolveProcessHarnessDir,
  reviewRoadmapImport,
  withStoreRead,
  type RoadmapDTO,
  type RoadmapExpected,
  type RoadmapImportReview,
  type StoreContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../definitions.js";

const inputSchema = z.object({
  project: z.string().optional(), file: z.string().optional(), review: z.string().optional(), apply: z.boolean().optional(), operation: z.string().optional(),
  expectProject: z.number().int().nonnegative().optional(), expectRoadmap: z.union([z.number().int().positive(), z.literal("absent")]).optional(),
  format: z.enum(["markdown", "json"]).optional(), harness: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;
const verbs = ["import", "replace", "show", "export"] as const;
const descriptions: Record<(typeof verbs)[number], string> = {
  import: "Preview a roadmap import read-only or apply current source content using the saved review's observed revisions.",
  replace: "Replace the complete roadmap using observed project and roadmap revisions.",
  show: "Show the project/catalog revisions, roadmap record and parsed content.",
  export: "Export composed milestone roadmap as JSON v2 or grouped Markdown; reporting only, not backup/restore. The grouped Markdown frontmatter mirrors the stored roadmap content (title/status from the stored document; catalog defaults apply when no content exists) — it is regenerated on each export. import/replace/show modify Markdown content only.",
};
const cliFlags: Record<keyof Input, string> = {
  project: "--project <id>", file: "--file <absolute-md>", review: "--review <absolute-json>", apply: "--apply", operation: "--operation <id>",
  expectProject: "--expect-project <n>", expectRoadmap: "--expect-roadmap <n|absent>", format: "--format <markdown|json>", harness: "--harness <root>",
};
/**
 * A refusal names every irreducible fact this call cannot derive, in one
 * result (A27): the verb's own minimum requirement set, never the first
 * missing field alone. Each entry is the CLI flag plus what must be supplied.
 */
class UsageError extends Error {
  readonly paths: string[];
  constructor(message: string, paths: readonly string[]) {
    super(message);
    this.paths = [...paths];
  }
}
const REPLACE_REQUIREMENTS: Readonly<Record<string, { flag: string; need: string }>> = {
  project: { flag: "--project", need: "the catalog project the roadmap belongs to" },
  file: { flag: "--file", need: "the absolute Markdown candidate to publish" },
  expectProject: { flag: "--expect-project", need: "the project revision this candidate was read against" },
  expectRoadmap: { flag: "--expect-roadmap", need: "the roadmap revision this candidate was read against (or absent)" },
  operation: { flag: "--operation", need: "the operation id this write is journalled under" },
};
const REVIEW_REQUIREMENTS: Readonly<Record<string, { flag: string; need: string }>> = {
  review: { flag: "--review", need: "the saved reviewed source (absolute JSON)" },
  operation: { flag: "--operation", need: "the operation id this write is journalled under" },
};
function requireAll(input: Input, requirements: Readonly<Record<string, { flag: string; need: string }>>): void {
  const missing = Object.entries(requirements).filter(([key]) => {
    const value = input[key as keyof Input];
    // A revision claim is present when it is a number (`--expect-roadmap
    // absent` arrives as its literal string); every other aggregated field is
    // a non-blank string.
    if (typeof value === "number") return false;
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length === 0) return;
  throw new UsageError(
    missing.map(([, entry]) => `${entry.flag} is required: ${entry.need}`).join("; "),
    missing.map(([key]) => key),
  );
}
function usage(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new UsageError(`${flag} is required`, [flag]);
  return value.trim();
}
function absolute(value: string, flag: string): string {
  if (!path.isAbsolute(value)) throw new UsageError(`${flag} must be an absolute path`, [flag]);
  return value;
}
function storeContext(input: Input, invocation: InvocationContext): StoreContext {
  const resolved = resolveProcessHarnessDir(invocation.cwd, input.harness);
  return { harnessDir: resolved ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function reviewInput(value: unknown): RoadmapImportReview {
  const candidate = typeof value === "object" && value !== null && "data" in value ? (value as { data?: unknown }).data : value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new UsageError("review must contain a RoadmapImportReview object", ["review"]);
  const review = candidate as Partial<RoadmapImportReview>;
  if (
    review.version !== 1 || typeof review.projectId !== "string" || !Number.isSafeInteger(review.expectedProjectRevision) ||
    (review.expectedRoadmapRevision !== "absent" && (!Number.isSafeInteger(review.expectedRoadmapRevision) || (review.expectedRoadmapRevision as number) < 1)) ||
    typeof review.sourcePath !== "string" || !path.isAbsolute(review.sourcePath) || typeof review.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(review.sourceHash)
  ) throw new UsageError("review has invalid RoadmapImportReview fields", ["review"]);
  return review as RoadmapImportReview;
}
function readReviewFile(value: string): unknown {
  const file = absolute(value, "--review");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new UsageError(`--review could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`, ["review"]);
  }
}
function success(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
export function failure(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    return refusalEnvelope({
      command: id,
      status: "usage",
      code: "usage",
      exitCode: 2,
      message,
      details: { operation: id, paths: error.paths },
    });
  }
  let code = `${id}.internal-error`;
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") code = error.code;
  return refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message, details: { operation: id } , recovery: id === "roadmap.import"
        ? "Align the source document with the saved review and its observed project and roadmap revisions before retrying the import."
        : id === "roadmap.replace"
          ? "Read the current project and roadmap revisions, then retry with the complete intended roadmap content."
          : id === "roadmap.show"
            ? "Select the registered project id and correct the reported store-read cause before showing its roadmap again."
            : "Choose a writable export destination and retry the roadmap export."});
}
function escapeMarkdown(value: string): string {
  return value.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
}
function exportMarkdown(roadmap: RoadmapDTO, storeRevision: number): string {
  const lines = [
    "---",
    `project_id: ${JSON.stringify(roadmap.projectId)}`,
    `title: ${JSON.stringify(roadmap.content?.frontmatter?.title ?? roadmap.catalog.title)}`,
    `status: ${JSON.stringify(roadmap.content?.frontmatter?.status ?? "active")}`,
    `created_at: ${JSON.stringify(roadmap.content?.frontmatter?.created_at ?? roadmap.catalog.registeredAt.slice(0, 10))}`,
    "---",
    "",
    "# Roadmap",
    "",
    `Store revision: ${storeRevision}`,
    "",
    "## Direction",
    "",
    roadmap.content?.direction?.replace(/^\n+|\n+$/g, "") || "No stored Direction.",
    "",
  ];
  for (const milestone of roadmap.milestones.milestones) {
    lines.push(`## ${escapeMarkdown(milestone.name)}`, "", `Target: ${escapeMarkdown(milestone.target ?? "no target")} · Status: ${milestone.status} · Issues: ${milestone.totalIssues} total, ${milestone.openIssues} open, ${milestone.resolvedIssues} resolved, ${milestone.otherRetiredIssues} other retired`, "");
    const issues = roadmap.milestones.issues.filter(issue => issue.milestoneId === milestone.milestoneId);
    if (!issues.length) lines.push("No linked issues.", "");
    for (const issue of issues) lines.push(`- **${escapeMarkdown(issue.id)} — ${escapeMarkdown(issue.title)}** (${issue.disposition}): ${escapeMarkdown(issue.acceptance) || "No acceptance prose."}`);
    lines.push("");
  }
  lines.push("## Unassigned", "", `Unassigned issues: ${roadmap.milestones.unassignedIssues}`);
  return lines.join("\n");
}
async function execute(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  try {
    const context = storeContext(input, invocation);
    const verb = id.slice("roadmap.".length);
    if (verb === "show") {
      const read = await readRoadmapAuthority(context, usage(input.project, "--project"));
      // The parsed projections are DERIVED from the stored body, never a
      // second authority: the roadmap record above stays the source the
      // content came from (the parse is a read of it, A02).
      const content = read.roadmap === null ? null : parseRoadmapContent(read.roadmap.contentMarkdown);
      return success(id, { projectId: read.projectId, projectRevision: read.projectRevision, roadmap: read.roadmap, content });
    }
    if (verb === "import") {
      if (input.apply) {
        if (input.project !== undefined || input.file !== undefined || input.review === undefined) {
          throw new UsageError(
            "apply mode reads the reviewed source only: --review and --operation are the irreducible inputs, and --project/--file are rejected",
            ["review"],
          );
        }
        requireAll(input, REVIEW_REQUIREMENTS);
        return success(id, await importRoadmapAuthority(context, reviewInput(readReviewFile(input.review!)), { operationId: input.operation! }));
      }
      if (input.review !== undefined || input.operation !== undefined) throw new UsageError("preview mode accepts only --project and --file; use --review --apply --operation to commit", ["review", "operation"]);
      requireAll(input, { project: { flag: "--project", need: "the catalog project to preview against" }, file: { flag: "--file", need: "the absolute Markdown source to review" } });
      return success(id, await reviewRoadmapImport(context, input.project!, absolute(input.file!, "--file")));
    }
    if (verb === "replace") {
      // A whole-document replacement states the comparison basis it actually
      // read: both revisions are irreducible caller claims, because deriving
      // them inside the write transaction would make the guard vacuous and a
      // stale read would silently overwrite whatever moved since (A11). The
      // target, the candidate bytes, both claims and the operation id are
      // aggregated in one refusal (A27).
      requireAll(input, REPLACE_REQUIREMENTS);
      const bytes = readFileSync(absolute(input.file!, "--file"));
      let contentMarkdown: string;
      try {
        contentMarkdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
      } catch (error) {
        if (error instanceof TypeError) throw new RoadmapError("roadmap.invalid-content", "Replacement file is not valid UTF-8.");
        throw error;
      }
      return success(id, await replaceRoadmapAuthority(context, {
        projectId: input.project!,
        expectedProjectRevision: input.expectProject!,
        expectedRoadmapRevision: input.expectRoadmap as RoadmapExpected,
        contentMarkdown,
      }, { operationId: input.operation! }));
    }
    if (verb === "export") {
      // Derived, not stated: the composed export is a read of one store
      // snapshot, and `markdown` is its documented default rendering (A27).
      const format = input.format ?? "markdown";
      const projectId = usage(input.project, "--project");
      const envelope = await withStoreRead(context, queryDashboard("roadmap", { projectId }));
      const roadmap = envelope.data;
      if (roadmap === null) throw new RoadmapError("roadmap.project-not-found", `Catalog project ${projectId} does not exist.`);
      const data = format === "markdown"
        ? exportMarkdown(roadmap, envelope.storeRevision)
        : {
          version: 2, projectId: roadmap.projectId, storeRevision: envelope.storeRevision, catalogRevision: envelope.catalogRevision,
          projection: envelope.projection, contentMarkdown: roadmap.content?.contentMarkdown ?? null, direction: roadmap.content?.direction ?? null,
          milestones: roadmap.milestones,
        };
      return success(id, data);
    }
    throw new Error(`unsupported roadmap command ${id}`);
  } catch (error) {
    return failure(id, error);
  }
}

const optionsByVerb: Record<(typeof verbs)[number], (keyof Input)[]> = {
  import: ["project", "file", "review", "apply", "operation", "harness"],
  replace: ["project", "file", "expectProject", "expectRoadmap", "operation", "harness"],
  show: ["project", "harness"],
  export: ["project", "format", "harness"],
};
/**
 * Parser-level required options: the facts whose absence makes the verb's
 * identity itself unknown (the target project and the candidate/reviewed
 * bytes). `--expect-project`/`--expect-roadmap` are equally irreducible on
 * `replace`, but they are aggregated by the handler instead so one refusal
 * names every missing claim at once (A27); `--operation` is declared here too
 * where the engine journals the write. `--format` on `export` derives its
 * documented default (`markdown`) rather than being a hard requirement.
 */
const requiredOptions: Record<(typeof verbs)[number], (keyof Input)[]> = {
  import: [], replace: ["project", "file", "operation"], show: ["project"], export: ["project"],
};
export function getRoadmapCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => {
    const id = `roadmap.${verb}`;
    const effects = verb === "import" ? ["read", "write"] as const : verb === "show" || verb === "export" ? ["read"] as const : ["write"] as const;
    const input = inputSchema.pick(Object.fromEntries(optionsByVerb[verb].map((key) => [key, true])) as { [K in (typeof optionsByVerb)[typeof verb][number]]: true });
    return {
      id, cli: {
        path: ["roadmap", verb], aliases: [], arguments: [],
        options: optionsByVerb[verb].map((key) => ({ key, flags: cliFlags[key], required: requiredOptions[verb].includes(key) })),
      },
      input, output: commandEnvelopeSchema, effects, description: descriptions[verb],
      execute: (value: Input, context: InvocationContext) => execute(id, value, context),
    };
  });
}
