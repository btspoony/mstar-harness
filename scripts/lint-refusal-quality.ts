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

const RECOVERY = /\b(?:recover|retry|run|use|provide|supply|repair|resolve|reopen|restore|resume|invoke)\b/i;

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
    let start = normalized.indexOf(verb);
    while (start >= 0) {
      const before = normalized[start - 1];
      const end = start + verb.length;
      if ((before === undefined || !/[A-Za-z0-9]/.test(before)) && (normalized[end] === undefined || /\s|--/.test(normalized[end]!))) {
        const rest = normalized.slice(end);
        const stop = rest.search(/[.;,]|\bor\b/i);
        const command = stop < 0 ? rest : rest.slice(0, stop);
        const mentioned = [...command.matchAll(/(?:^|\s)(--?[A-Za-z][A-Za-z0-9-]*)/g)].map((match) => match[1]!);
        const flags = grammar.flagsByVerb.get(verb) ?? new Set<string>();
        if (mentioned.every((flag) => flags.has(flag))) return true;
      }
      start = normalized.indexOf(verb, start + 1);
    }
  }
  return false;
}
/** Bounded structured-channel scan: typed CoordinationError codes, recoveryRefusal messages,
 * and refusalEnvelope objects are agent-facing. Internal `violation(...)` results, arbitrary
 * helper calls, and raw Error invariants are excluded. Recovery presence is enforced only on
 * refusalEnvelope, which exposes that field; explicit recovery actions are grammar-checked.
 */
export function scanSource(source: string, file: string, grammar: CliGrammar): RefusalFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, ts.Expression>();
  const visitDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(sf);
  const findings: RefusalFinding[] = [];
  const codeValue = (node: ts.Expression | undefined): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => span.literal.text).join("");
    if (ts.isIdentifier(node)) {
      const value = declarations.get(node.text);
      if (value && (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value))) return value.text;
      if (value && ts.isTemplateExpression(value)) return codeValue(value);
    }
    return undefined;
  };
  const isCauseCode = (node: ts.Expression | undefined): boolean => {
    if (!node) return false;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.trim().length > 0;
    if (ts.isIdentifier(node)) return node.text !== "undefined";
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "code" || node.name.text === "refusal";
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)) return isCauseCode(node.expression);
    if (ts.isConditionalExpression(node)) return isCauseCode(node.whenTrue) && isCauseCode(node.whenFalse);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      return isCauseCode(node.left) && isCauseCode(node.right);
    }
    if (ts.isTemplateExpression(node)) return node.head.text.length > 0 || node.templateSpans.length > 0;
    return false;
  };
  const properties = (node: ts.ObjectLiteralExpression): Map<string, ts.Expression> => {
    const result = new Map<string, ts.Expression>();
    const collect = (property: ts.ObjectLiteralElementLike): void => {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) result.set(property.name.text, property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) result.set(property.name.text, property.name);
      else if (ts.isSpreadAssignment(property)) {
        const collectExpression = (expression: ts.Expression): void => {
          if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) collectExpression(expression.expression);
          else if (ts.isObjectLiteralExpression(expression)) expression.properties.forEach(collect);
          else if (ts.isConditionalExpression(expression)) { collectExpression(expression.whenTrue); collectExpression(expression.whenFalse); }
        };
        collectExpression(property.expression);
      }
    };
    node.properties.forEach(collect);
    return result;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(sf).split(".").at(-1) === "CoordinationError") {
      if (!isCauseCode(node.arguments?.[0])) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({ file, line: line + 1, column: character + 1, classification: "missing-cause-code", reason: "Rule #341 class 2 (named cause): supply a stable code to CoordinationError.", snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 240) });
      }
      const message = codeValue(node.arguments?.[1]);
      if (message && RECOVERY.test(message) && !recoveryIsReachable(message, grammar)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({ file, line: line + 1, column: character + 1, classification: "unreachable-recovery", reason: "Rule #341 class 4 / #365 (discoverability): name only verbs and flags present in the canonical CLI grammar.", snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 240) });
      }
      return visitChildren(node);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf).split(".").at(-1);
      const message = codeValue(node.arguments[1]);
      if (callee === "recoveryRefusal" && message && RECOVERY.test(message) && !recoveryIsReachable(message, grammar)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({ file, line: line + 1, column: character + 1, classification: "unreachable-recovery", reason: "Rule #341 class 4 / #365 (discoverability): name only verbs and flags present in the canonical CLI grammar.", snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 240) });
      }
      if (callee === "refusalEnvelope") {
        const input = node.arguments[0];
        if (!input || !ts.isObjectLiteralExpression(input)) return visitChildren(node);
        const fields = properties(input);
        const status = codeValue(fields.get("status"));
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const add = (classification: RefusalClassification, reason: string) =>
          findings.push({ file, line: line + 1, column: character + 1, classification, reason, snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 240) });
        if (!fields.has("code")) add("missing-cause-code", "Rule #341 class 2 (named cause): provide the refusal envelope's named `code` field.");
        const recoveryNode = fields.get("recovery");
        if (status !== "usage" && !recoveryNode) add("missing-recovery", "Rule #341 class 3 (recovery): provide the refusal envelope's supported `recovery` field.");
        const recovery = codeValue(recoveryNode);
        if (recovery && RECOVERY.test(recovery) && !recoveryIsReachable(recovery, grammar)) add("unreachable-recovery", "Rule #341 class 4 / #365 (discoverability): name only verbs and flags present in the canonical CLI grammar.");
        return visitChildren(node);
      }
    }
    visitChildren(node);
  };
  function visitChildren(node: ts.Node): void { ts.forEachChild(node, visit); }
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
