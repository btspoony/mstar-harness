#!/usr/bin/env bun
/**
 * Grammar bound: canonical registry + schema descriptors, not captured --help
 * text. If rendering diverges, extend the shared grammar helper, not a capture.
 *
 * One same-file wrapper level is followed only when a top-level helper has exactly one direct return of refusalEnvelope or CoordinationError.
 * Its call-site arguments are substituted and checked; wrapper chains are not followed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { applyAllowlist, countViolations, exitCodeFor, parseAllowlist, extractCliGrammar, findRefusalWrappers, objectAlternatives, recoveryFailure, type AllowlistEntry, type CliGrammar, type RefusalFinding, type RefusalWrapperDescriptor } from "./lint-refusal-quality";

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
  interface Scope { parent?: Scope; kind: "source" | "function" | "block"; declarations: Map<string, ts.VariableDeclaration>; }
  const scopeByNode = new WeakMap<ts.Node, Scope>();
  const sourceScope: Scope = { kind: "source", declarations: new Map() };
  const buildScopes = (node: ts.Node, inherited: Scope): void => {
    const kind = ts.isFunctionLike(node) ? "function" : ts.isBlock(node) ? "block" : undefined;
    const scope: Scope = kind ? { parent: inherited, kind, declarations: new Map() } : inherited;
    scopeByNode.set(node, scope);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let target = scope;
      if (!(node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) {
        while (target.parent && target.kind === "block") target = target.parent;
      }
      target.declarations.set(node.name.text, node);
    }
    ts.forEachChild(node, (child) => buildScopes(child, scope));
  };
  buildScopes(source, sourceScope);
  const resolveDeclaration = (scope: Scope | undefined, name: string): ts.VariableDeclaration | undefined => {
    for (let current = scope; current; current = current.parent) {
      const declaration = current.declarations.get(name);
      if (declaration) return declaration;
    }
    return undefined;
  };
  const resolveLocalDeclaration = (scope: Scope | undefined, name: string): ts.VariableDeclaration | undefined => {
    for (let current = scope; current && current.kind !== "source"; current = current.parent) {
      const declaration = current.declarations.get(name);
      if (declaration) return declaration;
    }
    return undefined;
  };
  const wrappers = findRefusalWrappers(source);
  const callBindings = (wrapper: RefusalWrapperDescriptor, call: ts.CallExpression): Map<string, ts.Expression> => {
    const bindings = new Map<string, ts.Expression>();
    wrapper.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        const actual = call.arguments[index] ?? parameter.initializer;
        if (actual) bindings.set(parameter.name.text, actual);
      }
    });
    return bindings;
  };
  const value = (
    node: ts.Expression | undefined,
    scope?: Scope,
    seenDeclarations = new Set<ts.VariableDeclaration>(),
    bindings = new Map<string, ts.Expression>(),
    seenBindings = new Set<string>(),
  ): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => span.literal.text).join("");
    if (ts.isIdentifier(node)) {
      const currentScope = scope ?? scopeByNode.get(node);
      const local = resolveLocalDeclaration(currentScope, node.text);
      if (local?.initializer && !seenDeclarations.has(local)) {
        return value(local.initializer, scopeByNode.get(local), new Set(seenDeclarations).add(local), bindings, seenBindings);
      }
      if (bindings.has(node.text) && !seenBindings.has(node.text)) {
        const actual = bindings.get(node.text)!;
        return value(actual, scopeByNode.get(actual), seenDeclarations, bindings, new Set(seenBindings).add(node.text));
      }
      const declaration = resolveDeclaration(currentScope, node.text);
      if (declaration?.initializer && !seenDeclarations.has(declaration)) {
        return value(declaration.initializer, scopeByNode.get(declaration), new Set(seenDeclarations).add(declaration), bindings, seenBindings);
      }
    }
    return undefined;
  };
  const resolveBound = (node: ts.Expression, bindings: Map<string, ts.Expression>, seen = new Set<string>()): ts.Expression => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return resolveBound(node.expression, bindings, seen);
    }
    if (ts.isIdentifier(node)) {
      const scope = scopeByNode.get(node);
      const local = resolveLocalDeclaration(scope, node.text);
      if (local?.initializer) return resolveBound(local.initializer, bindings, seen);
      if (bindings.has(node.text) && !seen.has(node.text)) {
        return resolveBound(bindings.get(node.text)!, bindings, new Set(seen).add(node.text));
      }
      const declaration = resolveDeclaration(scope, node.text);
      if (declaration?.initializer) return resolveBound(declaration.initializer, bindings, seen);
    }
    return node;
  };
  const concatenatedCommandText = (
    node: ts.Expression | undefined,
    scope?: Scope,
    bindings = new Map<string, ts.Expression>(),
  ): string | undefined => {
    if (!node) return undefined;
    const parts: ts.Expression[] = [];
    const flatten = (part: ts.Expression): void => {
      if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        flatten(part.left);
        flatten(part.right);
      } else {
        parts.push(part);
      }
    };
    flatten(node);
    if (parts.length < 2) return undefined;
    const text = parts.map((part) => value(part, scope, new Set(), bindings) ?? "").join("");
    return /\bmstar\s+[a-z][a-z0-9.-]*/i.test(text) ? text : undefined;
  };
  const hasUnresolvedTemplate = (
    node: ts.Expression | undefined,
    scope?: Scope,
    seenDeclarations = new Set<ts.VariableDeclaration>(),
    bindings = new Map<string, ts.Expression>(),
    seenBindings = new Set<string>(),
  ): boolean => {
    if (!node) return false;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return hasUnresolvedTemplate(node.expression, scope, seenDeclarations, bindings, seenBindings);
    }
    if (ts.isTemplateExpression(node)) return node.templateSpans.length > 0;
    if (ts.isConditionalExpression(node)) {
      return hasUnresolvedTemplate(node.whenTrue, scope, seenDeclarations, bindings, seenBindings)
        || hasUnresolvedTemplate(node.whenFalse, scope, seenDeclarations, bindings, seenBindings);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = value(node.left, scope, seenDeclarations, bindings, seenBindings);
        const right = value(node.right, scope, seenDeclarations, bindings, seenBindings);
        if ((left !== undefined && right === undefined) || (right !== undefined && left === undefined)) return true;
      }
      return hasUnresolvedTemplate(node.left, scope, seenDeclarations, bindings, seenBindings)
        || hasUnresolvedTemplate(node.right, scope, seenDeclarations, bindings, seenBindings);
    }
    if (ts.isIdentifier(node)) {
      const currentScope = scope ?? scopeByNode.get(node);
      const local = resolveLocalDeclaration(currentScope, node.text);
      if (local?.initializer && !seenDeclarations.has(local)) {
        return hasUnresolvedTemplate(local.initializer, scopeByNode.get(local), new Set(seenDeclarations).add(local), bindings, seenBindings);
      }
      if (bindings.has(node.text) && !seenBindings.has(node.text)) {
        const actual = bindings.get(node.text)!;
        return hasUnresolvedTemplate(actual, scopeByNode.get(actual), seenDeclarations, bindings, new Set(seenBindings).add(node.text));
      }
      const declaration = resolveDeclaration(currentScope, node.text);
      if (declaration?.initializer && !seenDeclarations.has(declaration)) {
        return hasUnresolvedTemplate(declaration.initializer, scopeByNode.get(declaration), new Set(seenDeclarations).add(declaration), bindings, seenBindings);
      }
    }
    return false;
  };
  const findings: HelpReachabilityFinding[] = [];
  const unresolvedTemplateReason = "unresolved runtime substitution — advertised command is not statically provable";
  const reportFailure = (node: ts.Node, reason: string): void => {
    findings.push(makeFinding(source, file, node, reason, node.getText(source)));
  };
  const inspect = (node: ts.Node, text: string): void => {
    const failure = recoveryFailure(text, grammar);
    if (failure !== undefined) reportFailure(node, failure);
  };
  const inspectEnvelope = (node: ts.Node, input: ts.Expression | undefined, bindings = new Map<string, ts.Expression>()): void => {
    if (!input) return;
    const alternatives = objectAlternatives(resolveBound(input, bindings));
    const failures = alternatives.flatMap(({ fields }) => {
      const recovery = fields.get("recovery");
      if (!recovery) return [];
      if (hasUnresolvedTemplate(recovery, scopeByNode.get(recovery), new Set(), bindings)) return [unresolvedTemplateReason];
      const text = value(recovery, scopeByNode.get(recovery), new Set(), bindings);
      if (text === undefined) return [];
      const failure = recoveryFailure(text, grammar);
      return failure === undefined ? [] : [failure];
    });
    if (failures.length > 0) reportFailure(node, failures[0]!);
  };
  const inspectCoordinationError = (node: ts.Node, message: ts.Expression | undefined, bindings = new Map<string, ts.Expression>()): void => {
    const bound = message && resolveBound(message, bindings);
    const unresolvedTemplate = !!bound && hasUnresolvedTemplate(bound, scopeByNode.get(bound), new Set(), bindings);
    const text = value(bound, bound && scopeByNode.get(bound), new Set(), bindings)
      ?? concatenatedCommandText(bound, bound && scopeByNode.get(bound), bindings);
    if (unresolvedTemplate && text && /\bmstar\s+[a-z][a-z0-9.-]*/i.test(text)) {
      reportFailure(node, unresolvedTemplateReason);
      return;
    }
    if (text && !/\bmstar\s+[a-z][a-z0-9.-]*/i.test(text)) inspect(node, text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source).split(".").at(-1) === "CoordinationError") {
      inspectCoordinationError(node, node.arguments?.[1]);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source).split(".").at(-1);
      const wrapper = callee ? wrappers.get(callee) : undefined;
      if (wrapper) {
        const bindings = callBindings(wrapper, node);
        if (ts.isCallExpression(wrapper.inner)) inspectEnvelope(node, wrapper.inner.arguments[0], bindings);
        else inspectCoordinationError(node, wrapper.inner.arguments?.[1], bindings);
      } else if (callee === "recoveryRefusal") {
        const recovery = node.arguments[1];
        if (hasUnresolvedTemplate(recovery)) reportFailure(node, unresolvedTemplateReason);
        else {
          const text = value(recovery);
          if (text !== undefined) inspect(node, text);
        }
      } else if (callee === "refusalEnvelope") {
        inspectEnvelope(node, node.arguments[0]);
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
          for (const flag of flagsText.match(/--?[A-Za-z][A-Za-z0-9-]*/g) ?? []) if (!(grammar.flagsByVerb.get(verb)?.has(flag) ?? false)) findings.push(makeFinding(source, file, flagsProperty.initializer, `declared flag “${flag}” for “${verb}” is absent from the help grammar`, flagsText));
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
    let allowlist: AllowlistEntry[];
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
