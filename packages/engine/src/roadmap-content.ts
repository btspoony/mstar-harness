import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parseCompassFrontmatterText } from "./iteration.js";
import { type GateResult, type Severity, type ValidationResult } from "./core.js";

export type RoadmapFrontmatter = {
  project_id: string;
  title: string;
  status: "active" | "paused" | "completed";
  created_at: string;
  milestones?: string[] | null;
  residuals_ref?: string | null;
  [key: string]: unknown;
};

export type RoadmapContent = {
  contentMarkdown: string;
  frontmatter: RoadmapFrontmatter;
  direction: string | null;
  goals: Array<{
    ordinal: number;
    parentOrdinal: number | null;
    checked: boolean;
    title: string;
    body: string;
  }>;
  milestones: string[];
  sections: Array<{ level: number; heading: string; body: string }>;
};
export const ROADMAP_STATUSES = ["active", "paused", "completed"] as const;
export type RoadmapValidation = GateResult & { warnings: ValidationResult[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type MdNode = {
  type: string;
  position?: { start: { offset: number }; end: { offset: number } };
  children?: MdNode[];
  depth?: number;
  value?: string;
  checked?: boolean | null;
};

function violation(severity: Severity, code: string, message: string): ValidationResult {
  return { ok: false, severity, code, message };
}

function validateNonEmptyString(
  violations: ValidationResult[],
  value: unknown,
  field: string,
  missingCode: string,
  invalidCode: string,
): void {
  if (value === undefined) {
    violations.push(violation("high", missingCode, `missing required field: ${field}`));
  } else if (typeof value !== "string" || value.trim() === "") {
    violations.push(violation("medium", invalidCode, `${field} must be a non-empty string`));
  }
}

function frontmatterEnd(content: string): number {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return 0;
  let offset = lines[0].length;
  const newlineWidth = content.startsWith("\r\n", offset) ? 2 : content[offset] === "\n" ? 1 : 0;
  offset += newlineWidth;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nextNewline = content.indexOf("\n", offset);
    const end = nextNewline === -1 ? content.length : nextNewline;
    const lineEnd = content[end - 1] === "\r" ? end - 1 : end;
    if (content.slice(offset, lineEnd) === "---") {
      return nextNewline === -1 ? content.length : nextNewline + 1;
    }
    offset = nextNewline === -1 ? content.length : nextNewline + 1;
  }
  return 0;
}

function plainText(node: MdNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  if (node.type === "break") return " ";
  return (node.children ?? []).map(plainText).join("");
}

function isPositioned(node: MdNode): node is MdNode & { position: NonNullable<MdNode["position"]> } {
  return node.position !== undefined;
}

/** Validate one in-memory roadmap document using the same rules as the file entry. */
export function validateRoadmapContent(content: string, sourceLabel: string): RoadmapValidation {
  const violations: ValidationResult[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = parseCompassFrontmatterText(content, sourceLabel);
  } catch (err) {
    const message = err instanceof Error ? err.message : `invalid roadmap frontmatter in ${sourceLabel}`;
    return { ok: false, violations: [violation("high", "project.roadmap.invalid-frontmatter", message)], warnings: [] };
  }

  validateNonEmptyString(violations, doc.project_id, "project_id", "project.roadmap.missing-project-id", "project.roadmap.invalid-project-id");
  validateNonEmptyString(violations, doc.title, "title", "project.roadmap.missing-title", "project.roadmap.invalid-title");
  if (doc.status === undefined) {
    violations.push(violation("high", "project.roadmap.missing-status", "missing required field: status"));
  } else if (typeof doc.status !== "string" || !(ROADMAP_STATUSES as readonly string[]).includes(doc.status)) {
    violations.push(violation("medium", "project.roadmap.invalid-status", `status must be one of ${ROADMAP_STATUSES.join(" | ")} \u2014 got ${JSON.stringify(doc.status)}`));
  }
  if (doc.created_at === undefined) {
    violations.push(violation("high", "project.roadmap.missing-created-at", "missing required field: created_at"));
  } else if (typeof doc.created_at !== "string" || !DATE_RE.test(doc.created_at)) {
    violations.push(violation("medium", "project.roadmap.invalid-created-at", "created_at must be YYYY-MM-DD"));
  }
  if (doc.milestones !== undefined && doc.milestones !== null) {
    if (!Array.isArray(doc.milestones)) {
      violations.push(violation("medium", "project.roadmap.invalid-milestones", "milestones must be a list of milestone names"));
    } else if (doc.milestones.some((item) => typeof item !== "string" || item.trim() === "")) {
      violations.push(violation("medium", "project.roadmap.invalid-milestones", "milestones items must be non-empty strings"));
    }
  }
  if (doc.residuals_ref !== undefined && doc.residuals_ref !== null && (typeof doc.residuals_ref !== "string" || doc.residuals_ref.trim() === "")) {
    violations.push(violation("medium", "project.roadmap.invalid-residuals-ref", "residuals_ref must be a non-empty string"));
  }

  const warnings: ValidationResult[] = [];
  const end = frontmatterEnd(content);
  const body = content.slice(end);
  if (!/^##\s+Direction\s*$/m.test(body)) {
    warnings.push(violation("low", "project.roadmap.body.missing-direction", "roadmap body has no `## Direction` section (documented body convention) \u2014 state the project direction there"));
  }
  if (!/^\s*[-*]\s+\[[xX ]\]/m.test(body)) {
    warnings.push(violation("low", "project.roadmap.body.no-goal-items", "roadmap body has no goal-item task list (documented body convention) \u2014 list goals as `- [ ]` / `- [x]` markdown task items"));
  }
  return { ok: violations.length === 0, violations, warnings };
}

/** Parse a validated Markdown roadmap without rewriting its content. */
export function parseRoadmapContent(contentMarkdown: string): RoadmapContent {
  const validation = validateRoadmapContent(contentMarkdown, "roadmap content");
  if (!validation.ok) {
    throw new Error(`invalid roadmap content: ${validation.violations.map((item) => item.code).join(", ")}`);
  }
  const rawFrontmatter = parseCompassFrontmatterText(contentMarkdown, "roadmap content");
  const frontmatter = rawFrontmatter as RoadmapFrontmatter;
  const bodyOffset = frontmatterEnd(contentMarkdown);
  const bodySource = contentMarkdown.slice(bodyOffset);
  const tree = fromMarkdown(bodySource, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MdNode;
  const sections: RoadmapContent["sections"] = [];
  const headings: Array<MdNode & { depth: number; position: NonNullable<MdNode["position"]> }> = [];
  const blocks = tree.children ?? [];
  for (const node of blocks) {
    if (node.type === "heading" && node.depth !== undefined && isPositioned(node)) headings.push(node as MdNode & { depth: number; position: NonNullable<MdNode["position"]> });
  }
  const firstHeadingOffset = headings[0]?.position.start.offset ?? bodySource.length;
  if (firstHeadingOffset > 0) sections.push({ level: 0, heading: "", body: bodySource.slice(0, firstHeadingOffset) });
  for (let index = 0; index < headings.length; index += 1) {
    const headingNode = headings[index]!;
    const nextHeading = headings.slice(index + 1).find((candidate) => candidate.depth <= headingNode.depth);
    const endOffset = nextHeading?.position.start.offset ?? bodySource.length;
    const heading = (headingNode.children ?? []).map(plainText).join("");
    sections.push({ level: headingNode.depth, heading, body: bodySource.slice(headingNode.position.end.offset, endOffset) });
  }

  const goals: RoadmapContent["goals"] = [];
  const visit = (node: MdNode, parentOrdinal: number | null): void => {
    if (node.type === "listItem" && node.checked !== undefined && node.checked !== null && isPositioned(node)) {
      const ordinal = goals.length;
      const firstParagraph = (node.children ?? []).find((child) => child.type === "paragraph");
      goals.push({
        ordinal,
        parentOrdinal,
        checked: node.checked,
        title: firstParagraph ? plainText(firstParagraph).trim() : "",
        body: bodySource.slice(node.position.start.offset, node.position.end.offset),
      });
      for (const child of node.children ?? []) visit(child, ordinal);
      return;
    }
    for (const child of node.children ?? []) visit(child, parentOrdinal);
  };
  visit(tree, null);
  return {
    contentMarkdown,
    frontmatter,
    direction: sections.find((section) => section.level === 2 && section.heading.trim() === "Direction")?.body ?? null,
    goals,
    milestones: Array.isArray(frontmatter.milestones) ? frontmatter.milestones : [],
    sections,
  };
}
