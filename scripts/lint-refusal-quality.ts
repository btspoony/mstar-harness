#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { getCommandDefinitions } from "../packages/commands/src/definitions";
import { getCommandSchemas } from "../packages/commands/src/families/schema";

export type RefusalClassification = "missing-cause-code" | "missing-recovery" | "unreachable-recovery" | "capability-unreachable" | "allowlisted";
export interface RefusalFinding { file: string; line: number; column: number; classification: RefusalClassification; reason: string; snippet: string; }
export interface AllowlistEntry { signature: string; justification: string; trackingIssue: string; expectedCount?: number; }


export function normalizeSnippet(snippet: string): string { return snippet.trim().replace(/\s+/g, " "); }
export function signatureFor(classification: string, file: string, snippet: string): string {
  return `${classification}:${file}:${createHash("sha256").update(normalizeSnippet(snippet)).digest("hex").slice(0, 12)}`;
}
export function extractCliGrammar(): CliGrammar {
  const definitions = getCommandDefinitions();
  const schemas = getCommandSchemas(definitions);
  const verbs = new Set<string>();
  const flagsByVerb = new Map<string, Set<string>>();
  const positionalsByVerb = new Map<string, readonly { key: string; required: boolean; variadic: boolean }[]>();
  for (const definition of definitions) {
    const verb = definition.cli.path.join(" ");
    verbs.add(verb);
    const flags = flagsByVerb.get(verb) ?? new Set<string>();
    for (const option of definition.cli.options) for (const flag of option.flags.split(/[ ,|]+/).filter(Boolean)) flags.add(flag);
    flagsByVerb.set(verb, flags);
    positionalsByVerb.set(verb, definition.cli.arguments.map(({ key, required, variadic }) => ({ key, required, variadic })));
  }
  // Schema descriptors are the authoritative companion surface for options and positionals.
  for (const schema of schemas) {
    const verb = schema.cli.path.join(" ");
    verbs.add(verb);
    const flags = flagsByVerb.get(verb) ?? new Set<string>();
    for (const option of schema.cli.options) for (const flag of option.flags.split(/[ ,|]+/).filter(Boolean)) flags.add(flag);
    flagsByVerb.set(verb, flags);
    positionalsByVerb.set(verb, schema.cli.arguments.map(({ key, required, variadic }) => ({ key, required, variadic })));
  }
  for (const flags of flagsByVerb.values()) flags.add("--help");
  return { verbs, flagsByVerb, positionalsByVerb };
}

export function objectAlternatives(object: ts.ObjectLiteralExpression): Map<string, ts.Expression>[] {
  let alternatives = [new Map<string, ts.Expression>()];
  const spreadAlternatives = (expression: ts.Expression): Map<string, ts.Expression>[] => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) return spreadAlternatives(expression.expression);
    if (ts.isObjectLiteralExpression(expression)) return objectAlternatives(expression);
    if (ts.isConditionalExpression(expression)) return [...spreadAlternatives(expression.whenTrue), ...spreadAlternatives(expression.whenFalse)];
    return [new Map<string, ts.Expression>()];
  };
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      for (const fields of alternatives) fields.set(property.name.text, property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      for (const fields of alternatives) fields.set(property.name.text, property.name);
    } else if (ts.isSpreadAssignment(property)) {
      const choices = spreadAlternatives(property.expression);
      alternatives = alternatives.flatMap((base) => choices.map((choice) => new Map([...base, ...choice])));
    }
  }
  return alternatives;
}
function walkFiles(path: string): string[] {
  return readdirSync(path).flatMap((name) => { const child = resolve(path, name); return statSync(child).isDirectory() ? walkFiles(child) : child.endsWith(".ts") && !child.endsWith(".test.ts") ? [child] : []; });
}
export function recoveryIsReachable(recovery: string, grammar: CliGrammar): boolean {
  const stopClause = (text: string): string => {
    const boundary = text.search(/[.;,!?\uFF0C]|\b(?:or|and|then|with|instead|otherwise|before|after|via)\b/i);
    return boundary < 0 ? text : text.slice(0, boundary);
  };
  const commandIsReachable = (text: string): boolean => {
    const clause = stopClause(text.trim().replace(/^mstar\s+/i, "")).trim();
    const tokens = clause.split(/\s+/).filter(Boolean);
    const pathTokens: string[] = [];
    for (const token of tokens) {
      if (token.startsWith("-") || /^(?:to|for|with|and|or|then|instead|otherwise|after|before|via)$/i.test(token)) break;
      pathTokens.push(token.replace(/[,.)]+$/, ""));
    }
    for (let end = pathTokens.length; end > 0; end -= 1) {
      const verb = pathTokens.slice(0, end).join(" ");
      if (!grammar.verbs.has(verb)) continue;
      const args = pathTokens.slice(end);
      const positionals = grammar.positionalsByVerb?.get(verb) ?? [];
      const maxArgs = positionals.at(-1)?.variadic ? Number.POSITIVE_INFINITY : positionals.length;
      const requiredCount = positionals.filter(({ required }) => required).length;
      if (args.length < requiredCount || args.length > maxArgs) continue;
      const flags = grammar.flagsByVerb.get(verb) ?? new Set<string>();
      const mentioned = [...clause.matchAll(/(?:^|\s)(--?[A-Za-z][A-Za-z0-9-]*)/g)].map((match) => match[1]!);
      if (mentioned.every((flag) => flags.has(flag))) return true;
    }
    return false;
  };
  const candidates: string[] = [];
  const references = [...recovery.matchAll(/\bmstar\s+([A-Za-z][A-Za-z0-9.-]*)/gi)];
  for (const [index, match] of references.entries()) {
    const start = (match.index ?? 0) + match[0].length;
    const next = references[index + 1];
    candidates.push(`${match[1]} ${recovery.slice(start, next?.index ?? recovery.length)}`);
  }
  const firstWords = new Set([...grammar.verbs].map((verb) => verb.split(" ")[0]!));
  for (const action of recovery.matchAll(/\b(?:run|use|supply|provide|resume|restore|recover|retry|invoke)\s+/gi)) {
    const start = (action.index ?? 0) + action[0].length;
    let phrase = recovery.slice(start);
    const explicit = /^mstar\s+/i.test(phrase);
    phrase = phrase.replace(/^mstar\s+/i, "");
    const first = phrase.match(/^[A-Za-z][A-Za-z0-9.-]*/)?.[0]?.toLowerCase();
    const hasFlag = /(?:^|\s)--?[A-Za-z]/.test(phrase);
    if (explicit || firstWords.has(first ?? "") || action[0].trim().toLowerCase() === "run" || hasFlag) candidates.push(phrase);
  }
  return candidates.length > 0 && candidates.every(commandIsReachable);
}
/**
 * Bounded structured-channel scan: validation violation() results, arbitrary helper calls,
 * and raw programmer-error throws are intentionally excluded. Cause and recovery-presence
 * checks apply only to the recognized refusal channels.
 */
export function scanSource(source: string, file: string): RefusalFinding[] {
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
    if (ts.isIdentifier(node)) {
      const resolved = declarations.get(node.text);
      if (resolved && (ts.isStringLiteralLike(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved))) return resolved.text.trim().length > 0;
      return node.text !== "undefined";
    }
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "code" || node.name.text === "refusal";
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)) return isCauseCode(node.expression);
    if (ts.isConditionalExpression(node)) return isCauseCode(node.whenTrue) && isCauseCode(node.whenFalse);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      return isCauseCode(node.left) && isCauseCode(node.right);
    }
    if (ts.isTemplateExpression(node)) return node.head.text.trim().length > 0 || node.templateSpans.length > 0;
    return false;
  };
  let grammar: CliGrammar | undefined;
  const getGrammar = () => grammar ??= extractCliGrammar();
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(sf).split(".").at(-1) === "CoordinationError") {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const add = (classification: RefusalClassification, reason: string) =>
        findings.push({ file, line: line + 1, column: character + 1, classification, reason, snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 240) });
      if (!isCauseCode(node.arguments?.[0])) {
        add("missing-cause-code", "Rule #341 class 2 (named cause): supply a stable code to CoordinationError.");
      }
      const message = codeValue(node.arguments?.[1]);
      if (message && /\bmstar\s+[a-z][a-z0-9.-]*/i.test(message) && !recoveryIsReachable(message, getGrammar())) {
        add("unreachable-recovery", "Rule #341 class 4 (discoverability): CoordinationError message references a CLI command absent from the help grammar.");
      }
      return visitChildren(node);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf).split(".").at(-1);
      if (callee === "refusalEnvelope") {
        const input = node.arguments[0];
        if (!input || !ts.isObjectLiteralExpression(input)) return visitChildren(node);
        const variants = objectAlternatives(input);
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const add = (classification: RefusalClassification, reason: string) =>
          findings.push({ file, line: line + 1, column: character + 1, classification, reason, snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 240) });
        if (variants.some((fields) => !isCauseCode(fields.get("code")))) {
          add("missing-cause-code", "Rule #341 class 2 (named cause): provide a nonempty named `code` field on every refusal branch.");
        }
        const recoveryMissing = variants.some((fields) => {
          const recovery = fields.get("recovery");
          const status = codeValue(fields.get("status"));
          const text = codeValue(recovery);
          return status !== "usage" && (!recovery || (text !== undefined && text.trim() === ""));
        });
        if (recoveryMissing) add("missing-recovery", "Rule #341 class 3 (recovery): provide a nonempty supported `recovery` field on every refusal branch.");
        return visitChildren(node);
      }
    }
    visitChildren(node);
  };
  function visitChildren(node: ts.Node): void { ts.forEachChild(node, visit); }
  visit(sf);
  return findings;
}
const ALLOWLIST_CLASSES: Readonly<Record<string, true>> = {
  "missing-cause-code": true,
  "missing-recovery": true,
  "unreachable-recovery": true,
  "capability-unreachable": true,
};
export function validateAllowlistEntries(value: unknown): AllowlistEntry[] {
  if (!Array.isArray(value)) throw new Error("Allowlist must be a JSON array");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`Allowlist entry ${index + 1} must be an object`);
    const entry = raw as Record<string, unknown>;
    for (const field of ["justification", "trackingIssue"] as const) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") throw new Error(`Allowlist entry ${index + 1} requires nonempty ${field}`);
    }
    if (typeof entry.signature !== "string") throw new Error(`Allowlist entry ${index + 1} requires a signature`);
    const parts = entry.signature.split(":");
    if (parts.length !== 3 || !ALLOWLIST_CLASSES[parts[0]!]) throw new Error(`Allowlist entry ${index + 1} has an invalid signature classification`);
    const [, file, digest] = parts;
    if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => part === "" || part === "." || part === "..") || !/^[a-f0-9]{12}$/.test(digest!)) {
      throw new Error(`Allowlist entry ${index + 1} signature must be <classification>:<repo-relative file>:<12-hex>`);
    }
    if (seen.has(entry.signature)) throw new Error(`Allowlist contains duplicate signature ${entry.signature}`);
    seen.add(entry.signature);
    const expectedCount = entry.expectedCount ?? 1;
    if (!Number.isSafeInteger(expectedCount) || (expectedCount as number) < 1) throw new Error(`Allowlist entry ${index + 1} expectedCount must be a positive integer`);
    return { signature: entry.signature, justification: (entry.justification as string).trim(), trackingIssue: (entry.trackingIssue as string).trim(), expectedCount: expectedCount as number };
  });
}
export function parseAllowlist(content: string): AllowlistEntry[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (error) { throw new Error(`Invalid allowlist JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return validateAllowlistEntries(parsed);
}
function loadAllowlist(path: string): AllowlistEntry[] {
  if (!statSafe(path)) return [];
  return parseAllowlist(readFileSync(path, "utf8"));
}
function statSafe(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
export function applyAllowlist(findings: RefusalFinding[], entries: AllowlistEntry[], repoRoot: string): { findings: RefusalFinding[]; stale: string[]; used: AllowlistEntry[] } {
  const validated = validateAllowlistEntries(entries);
  const bySignature = new Map(validated.map((entry) => [entry.signature, entry]));
  const output: RefusalFinding[] = [];
  const matched = new Set<string>();
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const repoFile = (isAbsolute(finding.file) ? relative(repoRoot, finding.file) : finding.file).split("\\").join("/");
    const signature = signatureFor(finding.classification, repoFile, finding.snippet);
    const entry = bySignature.get(signature);
    const count = counts.get(signature) ?? 0;
    counts.set(signature, count + 1);
    if (!entry || count >= (entry.expectedCount ?? 1)) { output.push(finding); continue; }
    matched.add(signature);
    output.push({ ...finding, classification: "allowlisted", reason: `${finding.classification}: ${finding.reason} Allowlisted: ${entry.justification} (${entry.trackingIssue}).` });
  }
  return { findings: output, stale: validated.filter((entry) => !matched.has(entry.signature)).map((entry) => entry.signature), used: validated.filter((entry) => matched.has(entry.signature)) };
}
export function countViolations(findings: RefusalFinding[]): number {
  return findings.filter((finding) => finding.classification !== "allowlisted").length;
}
export function exitCodeFor(findings: RefusalFinding[], stale: string[]): 0 | 1 {
  return countViolations(findings) === 0 && stale.length === 0 ? 0 : 1;
}
function run(): number {
  const root = resolve(import.meta.dir, "..");
  const input = process.argv.slice(2);
  if (input.some((arg) => arg !== "--json")) { console.error("Usage: bun scripts/lint-refusal-quality.ts [--json]"); return 2; }
  try {
    const all: RefusalFinding[] = [];
    for (const dir of ["packages/engine/src", "packages/commands/src"]) for (const file of walkFiles(resolve(root, dir))) {
      const rel = relative(root, file).split("\\").join("/");
      all.push(...scanSource(readFileSync(file, "utf8"), rel));
    }
    const result = applyAllowlist(all, loadAllowlist(resolve(root, "scripts/lint-refusal-quality.allowlist.json")), root);
    if (input.includes("--json")) console.log(JSON.stringify({ findings: result.findings, staleAllowlist: result.stale, allowlist: result.used }, null, 2));
    else {
      for (const finding of result.findings) console.log(`${finding.file}:${finding.line}:${finding.column} ${finding.classification} ${finding.reason}\n  ${finding.snippet}`);
      if (result.used.length) console.log(`Allowlist (${result.used.length}):\n${JSON.stringify(result.used, null, 2)}`);
      if (result.stale.length) console.error(`Stale allowlist entries: ${result.stale.join(", ")}`);
      console.log(`Refusal-quality: ${countViolations(result.findings)} violations; ${result.used.length} allowlisted`);
    }
    return exitCodeFor(result.findings, result.stale);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
}
if (import.meta.main) process.exit(run());
