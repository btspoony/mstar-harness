#!/usr/bin/env bun
/**
 * Grammar bound: canonical registry + schema descriptors, not captured --help
 * text. If rendering diverges, extend the shared grammar helper, not a capture.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { applyAllowlist, countViolations, exitCodeFor, parseAllowlist, extractCliGrammar, recoveryIsReachable, type RefusalFinding } from "./lint-refusal-quality";
import type { CliGrammar } from "./lint-refusal-quality";

export type HelpReachabilityFinding = RefusalFinding;

function literalText(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
}

function makeFinding(source: ts.SourceFile, file: string, node: ts.Node, reason: string, snippet: string): HelpReachabilityFinding {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file, line: point.line + 1, column: point.character + 1, classification: "capability-unreachable", reason: `Rule #341 class 4: ${reason}. Fix hint: reference only verbs and flags present in the CLI registry/schema grammar (#365).`, snippet: snippet.trim().replace(/\s+/g, " ") };
}

export function scanRecoveryText(sourceText: string, file: string, grammar: CliGrammar): HelpReachabilityFinding[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const value = (node: ts.Expression | undefined): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => span.literal.text).join("");
    if (ts.isIdentifier(node)) return value(declarations.get(node.text));
    return undefined;
  };
  const findings: HelpReachabilityFinding[] = [];
  const inspect = (node: ts.Node, text: string): void => {
    if (/\b(?:recover|retry|run|use|provide|supply|repair|resolve|reopen|restore|resume|invoke)\b|\bmstar\s+[a-z][a-z0-9.-]*/i.test(text) && !recoveryIsReachable(text, grammar)) {
      findings.push(makeFinding(source, file, node, "recovery text references a verb or flag missing from the help grammar", node.getText(source)));
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source).split(".").at(-1) === "CoordinationError") {
      const text = value(node.arguments?.[1]);
      if (text) inspect(node, text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source).split(".").at(-1);
      if (callee === "recoveryRefusal") {
        const text = value(node.arguments[1]);
        if (text) inspect(node, text);
      } else if (callee === "refusalEnvelope" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const recovery = node.arguments[0].properties.find((item) => ts.isPropertyAssignment(item) && propertyName(item.name) === "recovery");
        if (recovery && ts.isPropertyAssignment(recovery)) {
          const text = value(recovery.initializer);
          if (text) inspect(node, text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function scanDeclaredCapabilities(sourceText: string, file: string, grammar: CliGrammar): HelpReachabilityFinding[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: HelpReachabilityFinding[] = [];
  const commandPath = (cli: ts.ObjectLiteralExpression): string | null => {
    const path = cli.properties.find((item) => ts.isPropertyAssignment(item) && propertyName(item.name) === "path");
    if (!path || !ts.isPropertyAssignment(path) || !ts.isArrayLiteralExpression(path.initializer)) return null;
    const parts = path.initializer.elements.map((part) => literalText(part as ts.Expression));
    return parts.every((part): part is string => part !== null) ? parts.join(" ") : null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "cli" && ts.isObjectLiteralExpression(node.initializer)) {
      const cli = node.initializer;
      const verb = commandPath(cli);
      if (verb && !grammar.verbs.has(verb)) findings.push(makeFinding(source, file, cli, `declared command verb “${verb}” is absent from the help grammar`, cli.getText(source)));
      const options = cli.properties.find((item) => ts.isPropertyAssignment(item) && propertyName(item.name) === "options");
      if (verb && options && ts.isPropertyAssignment(options) && ts.isArrayLiteralExpression(options.initializer)) {
        for (const option of options.initializer.elements) {
          if (!ts.isObjectLiteralExpression(option)) continue;
          const flagsProperty = option.properties.find((item) => ts.isPropertyAssignment(item) && propertyName(item.name) === "flags");
          if (!flagsProperty || !ts.isPropertyAssignment(flagsProperty)) continue;
          const flagsText = literalText(flagsProperty.initializer as ts.Expression);
          if (flagsText === null) continue;
          for (const flag of flagsText.split(/[ ,|]+/).filter(Boolean)) if (!(grammar.flagsByVerb.get(verb)?.has(flag) ?? false)) findings.push(makeFinding(source, file, flagsProperty.initializer, `declared flag “${flag}” for “${verb}” is absent from the help grammar`, flagsText));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function walkFiles(path: string): string[] {
  return readdirSync(path).flatMap((name) => { const child = resolve(path, name); return statSync(child).isDirectory() ? walkFiles(child) : child.endsWith(".ts") && !child.endsWith(".test.ts") ? [child] : []; });
}

function run(): number {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--json")) { console.error("Usage: bun scripts/lint-help-reachability.ts [--json]"); return 2; }
  try {
    const grammar = extractCliGrammar();
    const findings: HelpReachabilityFinding[] = [];
    for (const dir of ["packages/engine/src", "packages/commands/src"]) for (const path of walkFiles(resolve(root, dir))) {
      const rel = relative(root, path).split("\\").join("/");
      const source = readFileSync(path, "utf8");
      findings.push(...scanRecoveryText(source, rel, grammar), ...scanDeclaredCapabilities(source, rel, grammar));
    }
    let allowlist;
    try { allowlist = parseAllowlist(readFileSync(resolve(root, "scripts/lint-help-reachability.allowlist.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") allowlist = []; else throw error; }
    const applied = applyAllowlist(findings, allowlist, root);
    if (args.includes("--json")) console.log(JSON.stringify({ findings: applied.findings, staleAllowlist: applied.stale, allowlist: applied.used }, null, 2));
    else {
      for (const row of applied.findings) console.log(`${row.file}:${row.line}:${row.column} ${row.classification} ${row.reason}\n  ${row.snippet}`);
      if (applied.used.length) console.log(`Allowlist (${applied.used.length}):\n${JSON.stringify(applied.used, null, 2)}`);
      if (applied.stale.length) console.error(`Stale allowlist entries: ${applied.stale.join(", ")}`);
      console.log(`Help-reachability: ${countViolations(applied.findings)} violations; ${applied.used.length} allowlisted`);
    }
    return exitCodeFor(applied.findings, applied.stale);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
}

if (import.meta.main) process.exit(run());
