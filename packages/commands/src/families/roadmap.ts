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
  import: "Preview a roadmap import read-only or apply a saved reviewed source using engine drift checks.",
  replace: "Replace the complete roadmap using observed project and roadmap revisions.",
  show: "Show the project/catalog revisions, roadmap record and parsed content.",
  export: "Export composed milestone roadmap as JSON v2 or grouped Markdown; reporting only, not backup/restore. The grouped Markdown frontmatter mirrors the stored roadmap content (title/status from the stored document; catalog defaults apply when no content exists) — it is regenerated on each export. import/replace/show modify Markdown content only.",
};
const cliFlags: Record<keyof Input, string> = {
  project: "--project <id>", file: "--file <absolute-md>", review: "--review <absolute-json>", apply: "--apply", operation: "--operation <id>",
  expectProject: "--expect-project <n>", expectRoadmap: "--expect-roadmap <n|absent>", format: "--format <markdown|json>", harness: "--harness <root>",
};
class UsageError extends Error {}
function usage(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new UsageError(`${flag} is required`);
  return value.trim();
}
function absolute(value: string, flag: string): string {
  if (!path.isAbsolute(value)) throw new UsageError(`${flag} must be an absolute path`);
  return value;
}
function storeContext(input: Input, invocation: InvocationContext): StoreContext {
  const resolved = resolveProcessHarnessDir(invocation.cwd, input.harness);
  return { harnessDir: resolved ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function reviewInput(value: unknown): RoadmapImportReview {
  const candidate = typeof value === "object" && value !== null && "data" in value ? (value as { data?: unknown }).data : value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new UsageError("review must contain a RoadmapImportReview object");
  const review = candidate as Partial<RoadmapImportReview>;
  if (
    review.version !== 1 || typeof review.projectId !== "string" || !Number.isSafeInteger(review.expectedProjectRevision) ||
    (review.expectedRoadmapRevision !== "absent" && (!Number.isSafeInteger(review.expectedRoadmapRevision) || (review.expectedRoadmapRevision as number) < 1)) ||
    typeof review.sourcePath !== "string" || !path.isAbsolute(review.sourcePath) || typeof review.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(review.sourceHash)
  ) throw new UsageError("review has invalid RoadmapImportReview fields");
  return review as RoadmapImportReview;
}
function readReviewFile(value: string): unknown {
  const file = absolute(value, "--review");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new UsageError(`--review could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function success(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function failure(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message, details: { operation: id } };
  let code = `${id}.internal-error`;
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") code = error.code;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message, details: { operation: id } };
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
    roadmap.content?.direction?.trim() ? roadmap.content.direction.trim() : "No stored Direction.",
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
      const content = read.roadmap === null ? null : parseRoadmapContent(read.roadmap.contentMarkdown);
      return success(id, { projectId: read.projectId, projectRevision: read.projectRevision, roadmap: read.roadmap, content });
    }
    if (verb === "import") {
      if (input.apply) {
        if (input.project !== undefined || input.file !== undefined || input.review === undefined) throw new UsageError("apply mode requires --review and rejects --project/--file");
        return success(id, await importRoadmapAuthority(context, reviewInput(readReviewFile(input.review)), { operationId: usage(input.operation, "--operation") }));
      }
      if (input.review !== undefined || input.operation !== undefined) throw new UsageError("preview mode accepts only --project and --file; use --review --apply --operation to commit");
      return success(id, await reviewRoadmapImport(context, usage(input.project, "--project"), absolute(usage(input.file, "--file"), "--file")));
    }
    if (verb === "replace") {
      const bytes = readFileSync(absolute(usage(input.file, "--file"), "--file"));
      let contentMarkdown: string;
      try {
        contentMarkdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
      } catch (error) {
        if (error instanceof TypeError) throw new RoadmapError("roadmap.invalid-content", "Replacement file is not valid UTF-8.");
        throw error;
      }
      if (input.expectProject === undefined) throw new UsageError("--expect-project is required");
      if (input.expectRoadmap === undefined) throw new UsageError("--expect-roadmap is required");
      const expectedRoadmapRevision: RoadmapExpected = input.expectRoadmap;
      return success(id, await replaceRoadmapAuthority(context, {
        projectId: usage(input.project, "--project"), expectedProjectRevision: input.expectProject, expectedRoadmapRevision, contentMarkdown,
      }, { operationId: usage(input.operation, "--operation") }));
    }
    if (verb === "export") {
      if (input.format === undefined) throw new UsageError("--format is required");
      const envelope = await withStoreRead(context, queryDashboard("roadmap", { projectId: usage(input.project, "--project") }));
      const roadmap = envelope.data;
      if (roadmap === null) throw new RoadmapError("roadmap.project-not-found", `Catalog project ${usage(input.project, "--project")} does not exist.`);
      const data = input.format === "markdown"
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
const requiredOptions: Record<(typeof verbs)[number], (keyof Input)[]> = {
  import: [], replace: ["project", "file", "expectProject", "expectRoadmap", "operation"], show: ["project"], export: ["project", "format"],
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
