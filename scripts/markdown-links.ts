import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import GithubSlugger from "github-slugger";
import { fromHtml } from "hast-util-from-html";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { toString } from "mdast-util-to-string";
import { isMap, parseDocument } from "yaml";
import type { Root as HastRoot, RootContent } from "hast";
import type { Heading, Link, LinkReference } from "mdast";

export type MarkdownLinkDiagnostic = {
  source: string;
  line: number;
  rawTarget: string;
  kind: "missing-target" | "missing-anchor" | "escapes-root" | "invalid-encoding" | "unreadable" | "unsupported-fragment";
};

export type MarkdownLinkResult = {
  filesScanned: number;
  linksChecked: number;
  anchorsChecked: number;
  skipped: Record<string, number>;
  diagnostics: MarkdownLinkDiagnostic[];
};

type OutgoingLink = { destination: string; raw: string; line: number; template?: boolean };
type ParsedDocument = { anchors: Set<string>; links: OutgoingLink[] };
type SyntaxNode = {
  type: string;
  children?: SyntaxNode[];
  position?: { start: { line: number; offset: number }; end: { offset: number } };
  value?: unknown;
  url?: string;
  identifier?: string;
  label?: string;
};

const EXCLUDED_PREFIXES = [
  "packages/omp/skills/", "packages/omp/commands/", "packages/omp/agents/", "packages/omp/assets/",
  "packages/omp/harness-skills/", "packages/omp/harness-commands/", "packages/omp/harness-agents/",
  "packages/dsh/harness-skills/", "packages/dsh/harness-commands/", "packages/dsh/harness-agents/",
  "packages/opencode/harness-skills/", "packages/opencode/harness-commands/", "packages/opencode/harness-agents/",
];

function excluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    path === "CHANGELOG.md" || path === "CHANGELOG_CN.md" || /^packages\/[^/]+\/CHANGELOG\.md$/i.test(path);
}

function markdownPaths(tracked: ReadonlySet<string>): string[] {
  return [...tracked].filter((path) => /\.md$/i.test(path) && !excluded(path)).sort();
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function nodeRaw(source: string, start: number, end: number, fallback: string): { raw: string; template: boolean } {
  const text = source.slice(start, end);
  const inline = /\]\(\s*(?:<([^>]*)>|([^\s)]+))/.exec(text);
  if (!inline) return { raw: fallback, template: false };
  const angle = inline[1];
  if (angle !== undefined) {
    return { raw: angle || "<>", template: angle === "" || /^[A-Za-z][A-Za-z0-9_-]*$/.test(angle) };
  }
  const raw = inline[2] ?? fallback;
  return { raw, template: /\{[A-Za-z0-9_]+\}|\{\}/.test(raw) };
}
function rawHtmlAttribute(source: string, start: number, end: number, name: string, fallback: string): string {
  const element = source.slice(start, end);
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(element);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? fallback;
}

function frontmatter(source: string): string {
  const firstEnd = source.indexOf("\n");
  if (firstEnd < 0 || !/^---\s*\r?$/.test(source.slice(0, firstEnd))) return source;
  const rest = source.slice(firstEnd + 1);
  const close = /^(?:---|\.\.\.)\s*\r?$/m.exec(rest);
  if (!close) return source;
  const document = parseDocument(rest.slice(0, close.index), { strict: true });
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) return source;
  const after = firstEnd + 1 + close.index + close[0].length;
  const newline = source.indexOf("\n", after);
  const end = newline < 0 ? source.length : newline + 1;
  return `${"\n".repeat(source.slice(0, end).split("\n").length - 1)}${source.slice(end)}`;
}

function visibleText(node: Heading): string {
  return toString(node);
}

function parseMarkdown(source: string): ParsedDocument {
  const prepared = frontmatter(source);
  const tree = fromMarkdown(prepared, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const syntaxTree = tree as unknown as SyntaxNode;
  const definitions = new Map<string, SyntaxNode>();
  walk(syntaxTree, (node) => {
    if (node.type === "definition" && node.identifier && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });

  const headings: Array<{ line: number; order: number; text?: string; explicit?: string }> = [];
  const links: OutgoingLink[] = [];
  walk(syntaxTree, (node) => {
    if (node.type === "heading") {
      headings.push({ line: node.position?.start.line ?? 1, order: node.position?.start.offset ?? 0, text: visibleText(node as unknown as Heading) });
    } else if (node.type === "link" || node.type === "image") {
      const link = node as unknown as Link;
      const span = nodeRaw(prepared, link.position?.start.offset ?? 0, link.position?.end.offset ?? 0, link.url);
      links.push({ destination: link.url, raw: span.raw, template: span.template, line: link.position?.start.line ?? 1 });
    } else if (node.type === "linkReference" || node.type === "imageReference") {
      const ref = node as unknown as LinkReference;
      const definition = definitions.get(ref.identifier);
      const line = ref.position?.start.line ?? 1;
      if (!definition) {
        links.push({ destination: `\u0000undefined-reference:${ref.identifier}`, raw: ref.label ?? ref.identifier, line });
      } else {
        const url = definition.url ?? "";
        const definitionPosition = definition.position;
        const raw = definitionPosition
          ? prepared.slice(definitionPosition.start.offset, definitionPosition.end.offset).split(/:\s*/).slice(1).join(": ").trim().replace(/^<|>$/g, "")
          : url;
        links.push({ destination: url, raw: raw || url, template: /\{[A-Za-z0-9_]+\}|\{\}/.test(url), line });
      }
    }
  });

  const htmlNodes: Array<{ value: string; line: number; offset: number }> = [];
  walk(syntaxTree, (node) => {
    if (node.type === "html" && typeof node.value === "string") {
      htmlNodes.push({ value: node.value, line: node.position?.start.line ?? 1, offset: node.position?.start.offset ?? 0 });
    }
  });
  const explicitIds: Array<{ id: string; line: number; order: number }> = [];
  for (const html of htmlNodes) {
    let parsed: HastRoot;
    try {
      parsed = fromHtml(html.value, { fragment: true });
    } catch {
      continue;
    }
    const collect = (node: RootContent): string => {
      if (node.type === "text") return node.value;
      if (node.type !== "element") return "";
      const tag = node.tagName.toLowerCase();
      if (["code", "pre", "script", "style"].includes(tag)) return "";
      const posLine = (node.position?.start.line ?? 1) + html.line - 1;
      const order = html.offset + (node.position?.start.offset ?? 0);
      const id = node.properties.id;
      const name = tag === "a" ? node.properties.name : undefined;
      if (typeof id === "string") explicitIds.push({ id, line: posLine, order });
      if (typeof name === "string") explicitIds.push({ id: name, line: posLine, order });
      for (const attr of ["href", "src"] as const) {
        const target = node.properties[attr];
        if (typeof target === "string") {
          const start = node.position?.start.offset ?? 0;
          const end = node.position?.end.offset ?? start;
          const raw = rawHtmlAttribute(html.value, start, end, attr, target);
          links.push({ destination: target, raw, template: /\{[A-Za-z0-9_]+\}|\{\}/.test(target), line: posLine });
        }
      }
      const content = node.children.map(collect).join("");
      if (/^h[1-6]$/.test(tag)) headings.push({ line: posLine, order, text: content, explicit: typeof id === "string" ? id : undefined });
      return content;
    };
    for (const child of parsed.children) collect(child);
  }
  const allHeadings = [...headings].sort((a, b) => a.order - b.order);
  const anchors = new Set<string>();
  const slugger = new GithubSlugger();
  for (const heading of allHeadings) {
    const id = heading.explicit ?? slugger.slug(heading.text ?? "");
    anchors.add(id);
  }
  for (const item of explicitIds) anchors.add(item.id);
  return { anchors, links };
}


function decode(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function directoryReadme(root: string, dir: string, tracked: ReadonlySet<string>): string | undefined {
  const directory = relative(root, dir) || ".";
  const candidates = [...tracked].filter((path) => {
    const base = dirname(path);
    return base === directory && /^readme\.md$/i.test(path.slice(path.lastIndexOf("/") + 1));
  }).sort();
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function checkMarkdownLinks(repoRoot: string, tracked: ReadonlySet<string>): MarkdownLinkResult {
  const root = realpathSync(repoRoot);
  const result: MarkdownLinkResult = { filesScanned: 0, linksChecked: 0, anchorsChecked: 0, skipped: {}, diagnostics: [] };
  const cache = new Map<string, ParsedDocument>();
  const parsed = (path: string): ParsedDocument | undefined => {
    const cached = cache.get(path);
    if (cached) return cached;
    try {
      const document = parseMarkdown(readFileSync(join(root, path), "utf8"));
      cache.set(path, document);
      return document;
    } catch {
      return undefined;
    }
  };
  const diagnostic = (source: string, line: number, rawTarget: string, kind: MarkdownLinkDiagnostic["kind"]) => {
    result.diagnostics.push({ source, line, rawTarget, kind });
  };

  const sources = markdownPaths(tracked);
  for (const source of sources) {
    result.filesScanned++;
    try {
      if (!inside(root, realpathSync(join(root, source)))) {
        diagnostic(source, 1, source, "escapes-root");
        continue;
      }
    } catch {
      diagnostic(source, 1, source, "unreadable");
      continue;
    }
    const document = parsed(source);

    if (!document) {
      diagnostic(source, 1, source, "unreadable");
      continue;
    }
    for (const link of document.links) {
      const raw = link.raw;
      const target = link.destination;
      if (target.startsWith("\u0000undefined-reference:")) {
        diagnostic(source, link.line, raw, "missing-target");
        continue;
      }
      if (link.template || /\{[A-Za-z0-9_]+\}|\{\}/.test(target)) {
        result.skipped.template = (result.skipped.template ?? 0) + 1;
        continue;
      }
      if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(target) || target.startsWith("//")) {
        result.skipped.external = (result.skipped.external ?? 0) + 1;
        continue;
      }
      const hash = target.indexOf("#");
      const query = target.indexOf("?");
      const pathEnd = [hash, query].filter((n) => n >= 0).reduce((a, b) => Math.min(a, b), target.length);
      const encodedPath = target.slice(0, pathEnd);
      const encodedFragment = hash < 0 ? "" : target.slice(hash + 1, query >= 0 && query > hash ? query : undefined);
      const decodedPath = decode(encodedPath);
      const fragment = decode(encodedFragment);
      if (decodedPath === undefined || fragment === undefined) {
        diagnostic(source, link.line, raw, "invalid-encoding");
        continue;
      }
      const sourcePath = join(root, source);
      const joined = decodedPath.startsWith("/") ? resolve(root, `.${decodedPath}`) : decodedPath ? resolve(dirname(sourcePath), decodedPath) : sourcePath;
      if (!inside(root, joined)) {
        diagnostic(source, link.line, raw, "escapes-root");
        continue;
      }
      let targetPath = relative(root, joined).split(sep).join("/");
      let realPath: string | undefined;
      let isDirectory = false;
      try {
        realPath = realpathSync(joined);
        if (!inside(root, realPath)) {
          diagnostic(source, link.line, raw, "escapes-root");
          continue;
        }
        isDirectory = statSync(realPath).isDirectory();
      } catch {
        diagnostic(source, link.line, raw, "missing-target");
        continue;
      }
      if (isDirectory || decodedPath.endsWith("/")) {
        const canonical = directoryReadme(root, joined, tracked);
        if (fragment && !canonical) {
          diagnostic(source, link.line, raw, "missing-target");
          continue;
        }
        if (!fragment) {
          if (![...tracked].some((path) => path.startsWith(`${targetPath.replace(/\/$/, "")}/`))) diagnostic(source, link.line, raw, "missing-target");
          else result.linksChecked++;
          continue;
        }
        targetPath = canonical!;
      } else {
        if (!targetPath) targetPath = source;
        const realTargetPath = relative(root, realPath).split(sep).join("/");
        if (!tracked.has(targetPath) || !tracked.has(realTargetPath)) {
          diagnostic(source, link.line, raw, "missing-target");
          continue;
        }
      }
      if (!fragment) {
        result.linksChecked++;
        continue;
      }
      result.anchorsChecked++;
      const parsedTarget = parsed(targetPath);
      if (!parsedTarget) {
        diagnostic(source, link.line, raw, "unreadable");
        continue;
      }
      const markdown = /\.md$/i.test(targetPath);
      const html = /\.html?$/i.test(targetPath);
      const svg = /\.svg$/i.test(targetPath);
      if (!markdown && !html && !svg) {
        diagnostic(source, link.line, raw, "unsupported-fragment");
      } else if (!parsedTarget.anchors.has(fragment)) {
        diagnostic(source, link.line, raw, "missing-anchor");
      } else result.linksChecked++;
    }
  }
  return result;
}

export function readTrackedMarkdown(repoRoot: string): { tracked: Set<string>; failures: MarkdownLinkDiagnostic[] } {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] }) as Buffer;
    const tracked = new Set(output.toString("utf8").split("\0").filter(Boolean).filter((path) => /\.md$/i.test(path) && !excluded(path)));
    return { tracked, failures: [] };
  } catch {
    return { tracked: new Set(), failures: [{ source: "", line: 0, rawTarget: "git ls-files -z", kind: "unreadable" }] };
  }
}
