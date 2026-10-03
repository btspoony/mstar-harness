#!/usr/bin/env bun
/**
 * lint-hash-gates.ts — bounded TypeScript-AST architecture lint for issue #362
 * (plan 20261003-engine-hash-gates, acceptance A1).
 *
 * Rule: a content-hash (`sha256`/`sha1`/`digest`/`checksum`) or
 * canonical-serialized (`stableJson`, `serializeExecutionValue`,
 * `JSON.stringify`) equality MUST NOT drive a refusal, a conditional gate or a
 * test assertion. The one permitted comparison is the same-operation-id
 * `request_hash` replay conflict.
 *
 * Detection is deliberately bounded — no type checker and no dataflow solver:
 *   1. collect every comparison whose operand is hash/canonical bearing
 *      (identifier or property names, digest-producer calls, `Buffer.compare`,
 *      `.equals(` on a digest, and simple local aliases whose initializer is
 *      hash bearing);
 *   2. classify it by its controlling context: a refusing `if`/`while`/
 *      ternary branch, a bun/node assertion call, or a local variable / local
 *      helper (same file, at most two lexical call hops) that such a context
 *      consumes;
 *   3. allow `request_hash` equality only when the enclosing function names an
 *      operation id or is a known replay helper. The allowlist is per site and
 *      is printed in full — never per file, never per helper name.
 *
 * Limitations (documented in the task report; the reviewed manual inventory is
 * complementary evidence and is not replaced by this command):
 *   - a digest carried through object spread, a DB column, a container or a
 *     cross-file helper is not tracked;
 *   - assertion helpers and matchers outside the listed set are only seen
 *     through the local call closure (two hops);
 *   - a comparison used for an explicitly reviewed record-only purpose is
 *     reported as advisory, never silently excused.
 *
 * CLI:
 *   bun scripts/lint-hash-gates.ts                    scan engine src + test
 *   bun scripts/lint-hash-gates.ts --dir <path> ...  scan other roots
 *   bun scripts/lint-hash-gates.ts --repo <path>     path display root
 *   bun scripts/lint-hash-gates.ts --json            machine-readable report
 *   bun scripts/lint-hash-gates.ts --advisory        print advisory rows too
 * Exit codes: 0 clean, 1 violations found, 2 usage or read error.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

export type HashGateClassification =
  | "hash-gate"
  | "canonical-gate"
  | "byte-gate"
  | "hash-assertion"
  | "canonical-assertion"
  | "byte-assertion"
  | "helper-hash-gate"
  | "replay-allowed"
  | "record-only";

export interface HashGateFinding {
  file: string;
  line: number;
  column: number;
  classification: HashGateClassification;
  reason: string;
  snippet: string;
}

const VIOLATION_CLASSES: Readonly<Record<string, true>> = {
  "hash-gate": true,
  "canonical-gate": true,
  "byte-gate": true,
  "hash-assertion": true,
  "canonical-assertion": true,
  "byte-assertion": true,
  "helper-hash-gate": true,
};

/** Same-operation-id request-hash replay helpers: the single sanctioned
 * comparison site family. Membership still requires the operation-id anchor
 * check below, so a same-named helper cannot excuse an unrelated comparison. */
const REPLAY_HELPERS: Readonly<Record<string, true>> = {
  replayOperation: true,
  replayOrConflict: true,
  readOperationReplay: true,
  lookupOperation: true,
  recordOperation: true,
};

/** Callee names that raise or record a refusal. A branch containing one is a
 * gate for the purposes of this lint. */
const REFUSAL_CALL =
  /^(?:fail[A-Za-z0-9_]*|refus[A-Za-z0-9_]*|violation|invalid[A-Za-z0-9_]*|reject[A-Za-z0-9_]*|tokenRefusal|recoveryRefusal|planOperationRefusal|coordinationRefusal|storeRefusal)$/;

const ASSERTION_CALL = /^(?:expect|assert|assertEquals?|strictEqual|notStrictEqual|deepStrictEqual|deepEqual|notDeepEqual)\b/;

const DEFAULT_DIRS = ["packages/engine/src", "packages/engine/test"];

/** Names of value kinds this lint tracks. */
type ValueKind = "hash" | "canonical";

interface AliasDecl {
  name: string;
  owner: ts.Node | undefined;
}

interface Comparison {
  node: ts.Node;
  operands: ts.Expression[];
  rawBytes: boolean;
  assertion: boolean;
}

interface RefusalContexts {
  /** Conditions and branch bodies that decide a refusal. */
  nodes: ts.Node[];
  /** Full assertion call expressions (`expect(...)`, `assert(...)`). */
  assertions: ts.Node[];
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function strip(node: ts.Expression): ts.Expression {
  let n: ts.Node = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n as ts.Expression;
}

function valueName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function calleePath(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const base = calleePath(expr.expression);
    return base === "" ? expr.name.text : `${base}.${expr.name.text}`;
  }
  return "";
}

function lastSegment(path: string): string {
  const cut = path.lastIndexOf(".");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** A hash/digest/checksum field name. Plural collections (`sourceDigests`,
 * `hashes`, `checksums`) are record sets, not digest values, and are ignored. */
function hashNameStem(name: string): boolean {
  if (name === "hash" || name === "digest" || name === "checksum" || name === "sha1" || name === "sha256") return true;
  if (/(?:Hash|Digest|Checksum|Sha256|Sha1)$/.test(name)) return true;
  return /(?:^|_)(?:sha1|sha256|hash|digest|checksum)(?:_|$)/.test(name);
}

function hashFieldName(name: string): boolean {
  if (!hashNameStem(name)) return false;
  if (name.endsWith("s") && !hashNameStem(name.slice(0, -1))) return false;
  return true;
}

/** A call that produces a hash, digest, checksum or request fingerprint. */
function producerName(name: string): boolean {
  if (name === "sha1" || name === "sha256" || name === "createHash" || name === "sha256Bytes") return true;
  if (/^sha256Of[A-Za-z0-9_]*$/.test(name)) return true;
  return hashFieldName(name);
}

function canonicalCallName(path: string): boolean {
  const last = lastSegment(path);
  return path === "JSON.stringify" || last === "stableJson" || last === "serializeExecutionValue";
}

function ownerOf(node: ts.Node): ts.Node | undefined {
  return ts.findAncestor(node, (n) => ts.isFunctionLike(n));
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  const fn = ownerOf(node);
  if (fn === undefined) return undefined;
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return fn.name.text;
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  const grand = parent.parent;
  if (grand !== undefined && ts.isVariableDeclaration(grand) && ts.isIdentifier(grand.name)) return grand.name.text;
  return undefined;
}

function containsNode(outer: ts.Node, inner: ts.Node): boolean {
  return outer.getStart() <= inner.getStart() && inner.getEnd() <= outer.getEnd();
}

/** `true` when the subtree raises or records a refusal. */
function containsRefusal(node: ts.Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (found) return;
    if (ts.isThrowStatement(n)) {
      found = true;
      return;
    }
    if (ts.isNewExpression(n)) {
      const name = lastSegment(calleePath(n.expression));
      if (/(?:Error|Refusal|Conflict|Problem)$/.test(name)) found = true;
      return;
    }
    if (ts.isCallExpression(n)) {
      const name = lastSegment(calleePath(n.expression));
      if (REFUSAL_CALL.test(name) || /(?:Error|Refusal|Conflict|Problem)$/.test(name)) found = true;
    }
  });
  return found;
}

/** Collect the refusal-controlling conditions/branches and assertion calls. */
function collectRefusalContexts(sf: ts.SourceFile): RefusalContexts {
  const nodes: ts.Node[] = [];
  const assertions: ts.Node[] = [];
  walk(sf, (n) => {
    if (ts.isIfStatement(n)) {
      for (const branch of [n.thenStatement, n.elseStatement]) {
        if (branch !== undefined && containsRefusal(branch)) {
          nodes.push(n.expression, branch);
        }
      }
      return;
    }
    if (ts.isWhileStatement(n) || ts.isDoStatement(n)) {
      if (containsRefusal(n.statement)) nodes.push(n.expression, n.statement);
      return;
    }
    if (ts.isConditionalExpression(n)) {
      for (const branch of [n.whenTrue, n.whenFalse]) {
        if (containsRefusal(branch)) nodes.push(n.condition, branch);
      }
      return;
    }
    if (ts.isCallExpression(n)) {
      const path = calleePath(n.expression);
      if (ASSERTION_CALL.test(path)) assertions.push(n);
    }
  });
  return { nodes, assertions };
}

function scanComparisons(sf: ts.SourceFile): Comparison[] {
  const out: Comparison[] = [];
  walk(sf, (n) => {
    if (ts.isBinaryExpression(n)) {
      const kind = n.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.EqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsToken ||
        kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        out.push({ node: n, operands: [n.left, n.right], rawBytes: false, assertion: false });
      }
      return;
    }
    if (!ts.isCallExpression(n)) return;
    const path = calleePath(n.expression);
    if (path === "Buffer.compare" && n.arguments.length === 2) {
      out.push({ node: n, operands: [n.arguments[0]!, n.arguments[1]!], rawBytes: true, assertion: false });
      return;
    }
    if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "equals" && n.arguments.length === 1) {
      out.push({ node: n, operands: [n.expression.expression, n.arguments[0]!], rawBytes: true, assertion: false });
      return;
    }
    // `expect(<value>).toBe(<other>)` and its strict siblings: the equality is
    // the matcher call, not a binary expression.
    if (!ts.isPropertyAccessExpression(n.expression)) return;
    const matcher = n.expression.name.text;
    if (!/^to(?:Be|Equal|StrictEqual)$/.test(matcher) || n.arguments.length !== 1) return;
    const receiver = n.expression.expression;
    if (
      ts.isCallExpression(receiver) &&
      lastSegment(calleePath(receiver.expression)) === "expect" &&
      receiver.arguments.length === 1
    ) {
      out.push({
        node: n,
        operands: [receiver.arguments[0]!, n.arguments[0]!],
        rawBytes: false,
        assertion: true,
      });
    }
  });
  return out;
}

/** A digest producer, a raw file/descriptor read, or a Buffer equality call
 * nested in an expression — the evidence half of a byte-identity assertion. */
function hasProducerEvidence(expr: ts.Expression): boolean {
  let found = false;
  walk(expr, (n) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const path = calleePath(n.expression);
      const name = lastSegment(path);
      if (producerName(name) || name === "readFileSync" || name === "readDescriptorBytes" || name === "readFileDescriptor") {
        found = true;
        return;
      }
      if (path === "Buffer.compare") {
        found = true;
        return;
      }
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "equals") found = true;
      return;
    }
    if (ts.isNewExpression(n) && lastSegment(calleePath(n.expression)) === "Buffer") found = true;
  });
  return found;
}

function literalOperand(node: ts.Expression): boolean {
  const n = strip(node);
  return (
    n.kind === ts.SyntaxKind.NullKeyword ||
    ts.isTypeOfExpression(n) ||
    ts.isStringLiteral(n) ||
    ts.isNumericLiteral(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isArrayLiteralExpression(n) ||
    ts.isObjectLiteralExpression(n) ||
    (ts.isIdentifier(n) && n.text === "undefined")
  );
}

function valueKind(expr: ts.Expression, aliases: AliasDecl[]): ValueKind | null {
  const n = strip(expr);
  if (ts.isTypeOfExpression(n)) return null;
  if (ts.isCallExpression(n)) {
    const path = calleePath(n.expression);
    if (canonicalCallName(path)) return "canonical";
    if (producerName(lastSegment(path))) return "hash";
    return null;
  }
  // `\`sha256:${sha256OfFile(path)}\`` — a digest interpolated into a string
  // literal is the same byte identity as the digest itself.
  if (ts.isTemplateExpression(n)) {
    let hashed = false;
    walk(n, (child) => {
      if (hashed || !ts.isCallExpression(child)) return;
      if (producerName(lastSegment(calleePath(child.expression)))) hashed = true;
    });
    return hashed ? "hash" : null;
  }
  const name = valueName(n);
  if (name === null) return null;
  if (hashFieldName(name)) return "hash";
  if (ts.isIdentifier(n)) {
    const owner = ownerOf(n);
    if (aliases.some((a) => a.name === name && a.owner === owner)) return "hash";
  }
  return null;
}

/** Simple local alias propagation: `const h = sha256Bytes(x)` marks `h`. */
function collectAliases(sf: ts.SourceFile): AliasDecl[] {
  const raw: Array<AliasDecl & { init: ts.Expression }> = [];
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      raw.push({ name: n.name.text, owner: ownerOf(n), init: n.initializer });
    }
  });
  const aliases: AliasDecl[] = [];
  for (let round = 0; round < 4; round++) {
    let grew = false;
    for (const decl of raw) {
      if (aliases.some((a) => a.name === decl.name && a.owner === decl.owner)) continue;
      if (valueKind(decl.init, aliases) !== null) {
        aliases.push({ name: decl.name, owner: decl.owner });
        grew = true;
      }
    }
    if (!grew) break;
  }
  return aliases;
}

/** Local functions by name, for the bounded call closure. */
function collectLocalFunctions(sf: ts.SourceFile): Record<string, ts.Node> {
  const out: Record<string, ts.Node> = {};
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) out[n.name.text] = n;
  });
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      const init = strip(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out[n.name.text] = init;
    }
  });
  return out;
}

function calledNames(node: ts.Node): string[] {
  const names: string[] = [];
  walk(node, (n) => {
    if (ts.isCallExpression(n)) {
      const last = lastSegment(calleePath(n.expression));
      if (last !== "") names.push(last);
    }
  });
  return names;
}

/** Local call closure from refusal/assertion contexts, at most 2 hops. */
function reachableHelpers(sf: ts.SourceFile, contexts: RefusalContexts, local: Record<string, ts.Node>): Record<string, true> {
  const seeds: string[] = [];
  for (const node of [...contexts.nodes, ...contexts.assertions]) {
    for (const name of calledNames(node)) if (local[name] !== undefined && !seeds.includes(name)) seeds.push(name);
  }
  const reachable: Record<string, true> = {};
  for (const name of seeds) reachable[name] = true;
  let frontier = [...seeds];
  for (let hop = 0; hop < 2; hop++) {
    const next: string[] = [];
    for (const name of frontier) {
      const fn = local[name];
      if (fn === undefined) continue;
      for (const called of calledNames(fn)) {
        if (local[called] !== undefined && reachable[called] !== true) {
          reachable[called] = true;
          next.push(called);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return reachable;
}

/** The variable a comparison's result is stored in, if any. */
function initializerTarget(node: ts.Node): { name: string; decl: ts.Node } | null {
  let current: ts.Node = node;
  while (
    current.parent !== undefined &&
    (ts.isBinaryExpression(current.parent) || ts.isParenthesizedExpression(current.parent))
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return { name: parent.name.text, decl: parent };
  }
  return null;
}

/** `true` when `name` is read (not declared) inside one of `scopes`. */
function nameReadIn(name: string, scopes: ts.Node[], decl: ts.Node): boolean {
  for (const scope of scopes) {
    let found = false;
    walk(scope, (n) => {
      if (found) return;
      if (ts.isIdentifier(n) && n.text === name && n !== decl && !containsNode(decl, n)) found = true;
    });
    if (found) return true;
  }
  return false;
}

/** A binary comparison nested inside an `expect(...)` / `assert(...)` call. */
function insideAssertionCall(node: ts.Node, sf: ts.SourceFile): boolean {
  return (
    ts.findAncestor(node.parent, (n) => {
      if (!ts.isCallExpression(n) || !containsNode(n, node)) return false;
      return ASSERTION_CALL.test(calleePath(n.expression)) || ASSERTION_CALL.test(n.expression.getText(sf));
    }) !== undefined
  );
}

/** The replay allowlist: a `request_hash` comparison whose enclosing function
 * names an operation id (or is a known replay helper). Per site, not per file,
 * and never a content digest: a checksum or content hash on either side of the
 * comparison disqualifies the site. */
function isReplayAllowed(node: ts.Node, sf: ts.SourceFile): boolean {
  const text = node.getText(sf);
  if (!/request_hash|requestHash/.test(text)) return false;
  if (/typeof/.test(text)) return false;
  const withoutRequestHash = text.replace(/request_hash|requestHash/g, "");
  if (/(?:sha1|sha256|digest|checksum|contentHash|sourceHash|manifestHash|document_hash|input_hash)/i.test(withoutRequestHash)) {
    return false;
  }
  const fn = ownerOf(node);
  if (fn === undefined) return false;
  const name = enclosingFunctionName(node);
  if (name !== undefined && REPLAY_HELPERS[name] === true) return true;
  return /operation[_]?id/i.test(fn.getText(sf));
}

function classifyReason(classification: HashGateClassification, kind: ValueKind, fn: string | undefined, extra: string): string {
  const where = fn === undefined ? "at top level" : `in ${fn}`;
  const detail = extra === "" ? "" : `${extra} `;
  switch (classification) {
    case "hash-gate":
      return `content-hash equality ${detail}controls a refusal ${where}`;
    case "canonical-gate":
      return `canonical-serialized equality ${detail}controls a refusal ${where}`;
    case "byte-gate":
      return `raw byte identity ${detail}controls a refusal ${where}`;
    case "hash-assertion":
      return `content-hash equality is asserted by a test ${where}`;
    case "canonical-assertion":
      return `canonical-serialized equality is asserted by a test ${where}`;
    case "byte-assertion":
      return `raw byte identity is asserted by a test ${where}`;
    case "helper-hash-gate":
      return `${kind === "canonical" ? "canonical-serialized" : "content-hash"} equality ${detail}is computed by helper ${fn ?? "?"} that a refusal or assertion consumes`;
    case "replay-allowed":
      return `same-operation-id request_hash replay comparison ${where}`;
    default:
      return `${kind === "canonical" ? "canonical-serialized" : "content-hash"} equality ${detail}is recorded or compared outside a refusal, gate or assertion ${where}`;
  }
}

/** One of the three equality flavors, for the gate/assertion classification. */
function equalityClass(kind: ValueKind, rawBytes: boolean, mode: "gate" | "assertion"): HashGateClassification {
  if (rawBytes) return mode === "gate" ? "byte-gate" : "byte-assertion";
  if (kind === "canonical") return mode === "gate" ? "canonical-gate" : "canonical-assertion";
  return mode === "gate" ? "hash-gate" : "hash-assertion";
}

/** Scan one source file's text. Pure: no filesystem access. */
export function scanSource(rel: string, text: string): HashGateFinding[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const aliases = collectAliases(sf);
  const contexts = collectRefusalContexts(sf);
  const local = collectLocalFunctions(sf);
  const reachable = reachableHelpers(sf, contexts, local);
  const findings: HashGateFinding[] = [];

  const add = (node: ts.Node, classification: HashGateClassification, kind: ValueKind, extra: string): void => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const raw = node.getText(sf).replace(/\s+/g, " ");
    findings.push({
      file: rel,
      line: pos.line + 1,
      column: pos.character + 1,
      classification,
      reason: classifyReason(classification, kind, enclosingFunctionName(node), extra),
      snippet: raw.length > 140 ? `${raw.slice(0, 137)}...` : raw,
    });
  };

  for (const candidate of scanComparisons(sf)) {
    const kinds = candidate.operands.map((operand) => valueKind(operand, aliases));
    const kind: ValueKind = candidate.rawBytes ? "hash" : kinds.find((k) => k !== null) ?? "hash";
    const hashBearing = candidate.rawBytes || kinds.some((k) => k !== null);
    if (!hashBearing) continue;
    if (candidate.assertion && !hasProducerEvidence(candidate.operands[0]!) && !hasProducerEvidence(candidate.operands[1]!)) continue;

    const node = candidate.node;
    if (isReplayAllowed(node, sf)) {
      add(node, "replay-allowed", kind, "same-operation-id replay");
      continue;
    }
    if (candidate.assertion) {
      add(node, equalityClass(kind, candidate.rawBytes, "assertion"), kind, "");
      continue;
    }
    if (!candidate.rawBytes && candidate.operands.some((operand) => literalOperand(operand))) {
      add(node, "record-only", kind, "presence/shape");
      continue;
    }

    const direct = contexts.nodes.some((context) => containsNode(context, node));
    if (direct) {
      add(node, equalityClass(kind, candidate.rawBytes, "gate"), kind, "");
      continue;
    }
    if (insideAssertionCall(node, sf)) {
      add(node, equalityClass(kind, candidate.rawBytes, "assertion"), kind, "");
      continue;
    }
    const target = initializerTarget(node);
    if (target !== null && nameReadIn(target.name, [...contexts.nodes, ...contexts.assertions], target.decl)) {
      add(node, equalityClass(kind, candidate.rawBytes, "gate"), kind, `via local ${target.name}`);
      continue;
    }
    const fnName = enclosingFunctionName(node);
    if (fnName !== undefined && reachable[fnName] === true) {
      add(node, "helper-hash-gate", kind, "");
      continue;
    }
    add(node, "record-only", kind, "");
  }
  return findings.sort((a, b) => (a.line - b.line) || (a.column - b.column));
}

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
}

interface Options {
  repo: string;
  dirs: string[];
  json: boolean;
  advisory: boolean;
}

function parseArgs(argv: string[]): Options | { error: string } {
  const opts: Options = { repo: process.cwd(), dirs: [], json: false, advisory: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dir") {
      const value = argv[++i];
      if (value === undefined) return { error: "--dir requires a path" };
      opts.dirs.push(value);
    } else if (arg === "--repo") {
      const value = argv[++i];
      if (value === undefined) return { error: "--repo requires a path" };
      opts.repo = value;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--advisory") {
      opts.advisory = true;
    } else if (arg === "--help" || arg === "-h") {
      return { error: "help" };
    } else {
      return { error: `unknown argument ${JSON.stringify(arg)}` };
    }
  }
  if (opts.dirs.length === 0) opts.dirs = [...DEFAULT_DIRS];
  return opts;
}

const HELP = `lint:hash-gates — bounded TypeScript-AST hash-gate lint (#362)

Usage: bun scripts/lint-hash-gates.ts [--repo <path>] [--dir <path>]... [--json] [--advisory]

  --repo      path used to display file locations and to resolve default roots
              (default: process.cwd())
  --dir       scan root, repeatable (default: packages/engine/src packages/engine/test)
              pass a disposable fixture directory to exercise the rule
  --json      print the full report as JSON
  --advisory  print advisory rows (record-only / canonical non-gate) in text mode

Exit codes: 0 clean, 1 violations found, 2 usage or read error.`;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log(HELP);
      return 0;
    }
    console.error(`lint:hash-gates: ${parsed.error}`);
    console.error(HELP);
    return 2;
  }
  const repo = resolve(parsed.repo);
  const all: HashGateFinding[] = [];
  const scanned: string[] = [];
  for (const dir of parsed.dirs) {
    const root = resolve(repo, dir);
    let st;
    try {
      st = statSync(root);
    } catch {
      console.error(`lint:hash-gates: scan root does not exist: ${root}`);
      return 2;
    }
    if (!st.isDirectory()) {
      console.error(`lint:hash-gates: scan root is not a directory: ${root}`);
      return 2;
    }
    const files: string[] = [];
    collectTsFiles(root, files);
    for (const file of files) {
      const rel = file.startsWith(repo + "/") ? file.slice(repo.length + 1) : file;
      scanned.push(rel);
      all.push(...scanSource(rel, readFileSync(file, "utf8")));
    }
  }

  const isViolation = (finding: HashGateFinding): boolean => Object.hasOwn(VIOLATION_CLASSES, finding.classification);
  const violations = all.filter(isViolation);
  const allowlist = all.filter((f) => f.classification === "replay-allowed");
  const advisory = all.filter((f) => !isViolation(f) && f.classification !== "replay-allowed");

  if (parsed.json) {
    console.log(
      JSON.stringify(
        { repo, dirs: parsed.dirs, scanned: scanned.length, violations, allowlist, advisory },
        null,
        2,
      ),
    );
    return violations.length > 0 ? 1 : 0;
  }

  const show = (rows: HashGateFinding[]): void => {
    for (const f of rows) {
      console.error(`  ${f.file}:${f.line}:${f.column} [${f.classification}] ${f.reason}`);
      console.error(`      ${f.snippet}`);
    }
  };

  if (violations.length > 0) {
    console.error(`lint:hash-gates: ${violations.length} violation(s) in ${scanned.length} file(s) scanned:`);
    show(violations);
  }
  console.error(`lint:hash-gates: replay allowlist — ${allowlist.length} same-operation-id request_hash site(s):`);
  show(allowlist);
  if (parsed.advisory) {
    console.error(`lint:hash-gates: advisory — ${advisory.length} record-only/non-gate site(s):`);
    show(advisory);
  } else {
    console.error(`lint:hash-gates: advisory — ${advisory.length} site(s) (pass --advisory to list):`);
  }
  if (violations.length > 0) {
    console.error(
      "lint:hash-gates: FAIL — delete the hash/canonical equality or move it to the same-operation-id request_hash replay rule",
    );
    return 1;
  }
  console.error(`lint:hash-gates: OK — no hash or canonical-serialized equality drives a refusal or assertion (${scanned.length} file(s) scanned)`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
