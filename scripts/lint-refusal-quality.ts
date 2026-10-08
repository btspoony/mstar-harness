#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { getCommandDefinitions } from "../packages/commands/src/definitions";
import { getCommandSchemas } from "../packages/commands/src/families/schema";

export type RefusalClassification = "missing-cause-code" | "missing-recovery" | "unreachable-recovery" | "capability-unreachable" | "allowlisted";
export interface RefusalFinding { file: string; line: number; column: number; classification: RefusalClassification; reason: string; snippet: string; }
export interface CliGrammar { verbs: Set<string>; flagsByVerb: Map<string, Set<string>>; }
export interface AllowlistEntry { signature: string; justification: string; trackingIssue: string; }

const REFUSAL_CALL = /^(?:fail[A-Za-z0-9_]*|refus[A-Za-z0-9_]*|violation|invalid[A-Za-z0-9_]*|reject[A-Za-z0-9_]*|tokenRefusal|recoveryRefusal|planOperationRefusal|coordinationRefusal|storeRefusal)$/;
const CAUSE_CODE = /\b(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z][A-Za-z0-9-]*(?:\.[a-z][A-Za-z0-9-]*)+)\b/;
const RECOVERY = /\b(?:recover|retry|run|use|provide|supply|repair|resolve|reopen|restore|resume|retrying|invoke)\b[^.!?\n]*/i;

export function normalizeSnippet(snippet: string): string { return snippet.trim().replace(/\s+/g, " "); }
export function signatureFor(classification: string, file: string, snippet: string): string {
  return `${classification}:${file}:${createHash("sha256").update(normalizeSnippet(snippet)).digest("hex").slice(0, 12)}`;
}
export function extractCliGrammar(): CliGrammar {
  const definitions = getCommandDefinitions();
  const schemas = getCommandSchemas(definitions);
  const verbs = new Set<string>();
  const flagsByVerb = new Map<string, Set<string>>();
  for (const definition of definitions) {
    const verb = definition.cli.path.join(" ");
    verbs.add(verb);
    const flags = flagsByVerb.get(verb) ?? new Set<string>();
    for (const option of definition.cli.options) for (const flag of option.flags.split(/[ ,|]+/).filter(Boolean)) flags.add(flag);
    for (const argument of definition.cli.arguments) flags.add(argument.key);
    flagsByVerb.set(verb, flags);
  }
  // Schema descriptors are the authoritative companion surface for schema-provided options.
  for (const schema of schemas) {
    const verb = schema.cli.path.join(" ");
    verbs.add(verb);
    const flags = flagsByVerb.get(verb) ?? new Set<string>();
    for (const option of schema.cli.options) for (const flag of option.flags.split(/[ ,|]+/).filter(Boolean)) flags.add(flag);
    flagsByVerb.set(verb, flags);
  }
  return { verbs, flagsByVerb };
}
function walkFiles(path: string): string[] {
  return readdirSync(path).flatMap((name) => { const child = resolve(path, name); return statSync(child).isDirectory() ? walkFiles(child) : child.endsWith(".ts") && !child.endsWith(".test.ts") ? [child] : []; });
}
function recoveryIsReachable(recovery: string, grammar: CliGrammar): boolean {
  const normalized = recovery.replace(/\bmstar\s+/g, "");
  for (const verb of grammar.verbs) {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?:^|\\b)${escaped}(?=\\s|$|--)`).test(normalized)) continue;
    const flags = grammar.flagsByVerb.get(verb) ?? new Set<string>();
    const mentioned = normalized.match(/--?[A-Za-z][A-Za-z0-9-]*/g) ?? [];
    return mentioned.every((flag) => flags.has(flag));
  }
  return false;
}
export function scanSource(source: string, file: string, grammar: CliGrammar): RefusalFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: RefusalFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf).split(".").at(-1) ?? "";
      if (REFUSAL_CALL.test(callee)) {
        const strings: string[] = [];
        const identifiers: string[] = [];
        const gather = (arg: ts.Node): void => {
          if (ts.isStringLiteralLike(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) strings.push(arg.text);
          else if (ts.isIdentifier(arg)) identifiers.push(arg.text);
          else ts.forEachChild(arg, gather);
        };
        node.arguments.forEach(gather);
        const message = strings.join(" ");
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const snippet = node.getText(sf).replace(/\s+/g, " ").slice(0, 240);
        const add = (classification: RefusalClassification, reason: string) => findings.push({ file, line: line + 1, column: character + 1, classification, reason, snippet });
        if (!CAUSE_CODE.test(message) && !identifiers.some((identifier) => /^[A-Z][A-Z0-9_]+$/.test(identifier))) add("missing-cause-code", "Rule #341 class 2 (named cause): add a stable cause code to the refusal message.");
        const match = RECOVERY.exec(message);
        if (!match) add("missing-recovery", "Rule #341 class 3 (recovery): name the supported recovery or repair action in the refusal.");
        else if (!recoveryIsReachable(match[0], grammar)) add("unreachable-recovery", "Rule #341 class 4 / #365 (discoverability): replace the recovery with a verb and flags present in the canonical CLI grammar.");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
function loadAllowlist(path: string): AllowlistEntry[] {
  if (!statSafe(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path}: allowlist must be a JSON array`);
  return parsed as AllowlistEntry[];
}
function statSafe(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
export function applyAllowlist(findings: RefusalFinding[], entries: AllowlistEntry[], repoRoot: string): { findings: RefusalFinding[]; stale: string[]; used: AllowlistEntry[] } {
  const bySignature = new Map(entries.map((entry) => [entry.signature, entry]));
  const output: RefusalFinding[] = [];
  const matched = new Set<string>();
  for (const finding of findings) {
    const repoFile = (isAbsolute(finding.file) ? relative(repoRoot, finding.file) : finding.file).split("\\").join("/");
    const signature = signatureFor(finding.classification, repoFile, finding.snippet);
    const entry = bySignature.get(signature);
    if (!entry) { output.push(finding); continue; }
    matched.add(signature);
    output.push({ ...finding, classification: "allowlisted", reason: `${finding.classification}: ${finding.reason} Allowlisted: ${entry.justification} (${entry.trackingIssue}).` });
  }
  return { findings: output, stale: entries.filter((entry) => !matched.has(entry.signature)).map((entry) => entry.signature), used: entries.filter((entry) => matched.has(entry.signature)) };
}
function run(): number {
  const root = resolve(import.meta.dir, "..");
  const input = process.argv.slice(2);
  if (input.some((arg) => arg !== "--json")) { console.error("Usage: bun scripts/lint-refusal-quality.ts [--json]"); return 2; }
  try {
    const grammar = extractCliGrammar();
    const all: RefusalFinding[] = [];
    for (const dir of ["packages/engine/src", "packages/commands/src"]) for (const file of walkFiles(resolve(root, dir))) {
      const rel = relative(root, file).split("\\").join("/");
      all.push(...scanSource(readFileSync(file, "utf8"), rel, grammar));
    }
    const result = applyAllowlist(all, loadAllowlist(resolve(root, "scripts/lint-refusal-quality.allowlist.json")), root);
    if (input.includes("--json")) console.log(JSON.stringify({ findings: result.findings, staleAllowlist: result.stale, allowlist: result.used }, null, 2));
    else {
      for (const finding of result.findings) console.log(`${finding.file}:${finding.line}:${finding.column} ${finding.classification} ${finding.reason}\n  ${finding.snippet}`);
      if (result.used.length) console.log(`Allowlist (${result.used.length}):\n${JSON.stringify(result.used, null, 2)}`);
      if (result.stale.length) console.error(`Stale allowlist entries: ${result.stale.join(", ")}`);
      console.log(`Refusal-quality: ${result.findings.length - result.used.length} violations; ${result.used.length} allowlisted`);
    }
    return result.findings.length !== result.used.length || result.stale.length ? 1 : 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
}
if (import.meta.main) process.exit(run());
