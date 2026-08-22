/**
 * Engine git `execFileSync` env-pin regression detector (plan
 * 20260822-cli-engine-leftover Task 3, originally audit-2026-08-21/005).
 *
 * Detector contract (plan "Task 3 · Interfaces" + STOP conditions):
 * - Stable detector = source-text scan of the three engine files that shell
 *   out to git (`path.ts` `defaultWorkspaceRoot`, `sdd.ts` `gitOut` /
 *   `reviewPackage` / `assertBaseSha`, `worktree.ts` `probeBranch`).
 * - Every git `execFileSync` call's options literal must be env-permissive:
 *   `env` unset (inherit), `env: process.env`, or a non-empty subset.
 *   Regression = `env: {}` or an env object that pins `PATH` to an empty
 *   string.
 * - Production source is never rewritten (test-only; do not export
 *   `defaultWorkspaceRoot` — it stays private at `path.ts:119`).
 *
 * Why source-text and not a runtime monkey-patch of `node:child_process`:
 * the stale 005 sample monkey-patched the test file's own import binding
 * (which does not reach the engine modules — ES module bindings are not
 * mutable that way), and a bun `mock.module("node:child_process")` probe
 * (bun 1.2.17) showed the registry leaks to every other test file in the
 * same bun process — the engine suite runs all files in one process, so a
 * mock cannot be isolated. That hits the plan's STOP clause ("if
 * monkey-patch cannot isolate, keep the source-text detector only"), so a
 * runtime mock is deliberately NOT part of this file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commentMask } from "../../../scripts/ascii-literal-utils.ts";

/** Engine source files that shell out to git via `execFileSync`. */
const GIT_SHELL_OUT_FILES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "path.ts", path: join(import.meta.dir, "..", "src", "path.ts") },
  { name: "sdd.ts", path: join(import.meta.dir, "..", "src", "sdd.ts") },
  { name: "worktree.ts", path: join(import.meta.dir, "..", "src", "worktree.ts") },
];

// ---------------------------------------------------------------------------
// Source-text scan
// ---------------------------------------------------------------------------

type GitExecSite = {
  file: string;
  line: number;
  /** Options object literal text (comments already masked by the scanner). */
  options: string;
};

/**
 * Split a call's comma-separated top-level arguments, starting right after
 * the opening `(`. Handles single/double-quoted strings, template literals
 * with `${...}` interpolation, nested brackets/braces, and nested parens
 * (e.g. `process.env.PATH ?? "git"`). Returns null when the call never
 * closes.
 */
function splitArgs(src: string, start: number): string[] | null {
  const args: string[] = [];
  let argStart = -1;
  let parenDepth = 0; // nested parens inside args
  let bracket = 0;
  let brace = 0;
  let state: "code" | "sq" | "dq" | "bt" | "tplExpr" = "code";
  let tplBrace = 0;
  let closed = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1] ?? "";
    switch (state) {
      case "sq":
        if (c === "\\") i++;
        else if (c === "'") state = "code";
        continue;
      case "dq":
        if (c === "\\") i++;
        else if (c === '"') state = "code";
        continue;
      case "bt":
        if (c === "\\") i++;
        else if (c === "`") state = "code";
        else if (c === "$" && next === "{") {
          state = "tplExpr";
          tplBrace = 1;
          i++;
        }
        continue;
      case "tplExpr":
        if (c === "'") state = "sq";
        else if (c === '"') state = "dq";
        else if (c === "`") state = "bt";
        else if (c === "{") tplBrace++;
        else if (c === "}") {
          tplBrace--;
          if (tplBrace === 0) state = "bt";
        }
        continue;
      default:
        if (c === "'") {
          if (argStart < 0 && parenDepth === 0 && bracket === 0 && brace === 0) argStart = i;
          state = "sq";
        } else if (c === '"') {
          if (argStart < 0 && parenDepth === 0 && bracket === 0 && brace === 0) argStart = i;
          state = "dq";
        } else if (c === "`") {
          if (argStart < 0 && parenDepth === 0 && bracket === 0 && brace === 0) argStart = i;
          state = "bt";
        }
        else if (c === "(") parenDepth++;
        else if (c === ")") {
          if (parenDepth === 0) {
            if (argStart >= 0) args.push(src.slice(argStart, i).trim());
            closed = true;
            break;
          }
          parenDepth--;
        } else if (c === "[") {
          if (argStart < 0 && parenDepth === 0 && bracket === 0 && brace === 0) argStart = i;
          bracket++;
        } else if (c === "]") bracket--;
        else if (c === "{") {
          if (argStart < 0 && parenDepth === 0 && bracket === 0 && brace === 0) argStart = i;
          brace++;
        } else if (c === "}") brace--;
        else if (c === "," && parenDepth === 0 && bracket === 0 && brace === 0) {
          if (argStart >= 0) args.push(src.slice(argStart, i).trim());
          argStart = -1;
        } else if (argStart < 0 && c !== "," && !/\s/.test(c)) argStart = i;
    }
    if (closed) break;
  }
  return closed ? args : null;
}

/** True when the first argument names the git binary (literal or `?? "git"`). */
function isGitBinary(arg: string): boolean {
  const bin = arg.trim();
  return bin === '"git"' || bin.endsWith('?? "git"');
}

/** Scan one source file for git `execFileSync` call sites (real code only). */
function gitExecSites(src: string, file: string): GitExecSite[] {
  const mask = commentMask(src);
  const sites: GitExecSite[] = [];
  const re = /execFileSync\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (mask[m.index] === 1) continue; // inside a comment — not a real call
    const args = splitArgs(src, m.index + m[0].length);
    if (!args || args.length === 0 || !isGitBinary(args[0])) continue;
    // Options object = the last argument when it is an object literal; a
    // call without options has no env to regress on (env unset → inherit).
    const last = args[args.length - 1];
    if (!last.startsWith("{")) continue;
    const line = src.slice(0, m.index).split("\n").length;
    sites.push({ file, line, options: last });
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Env permissiveness check
// ---------------------------------------------------------------------------

/**
 * Extract the value literal of the `env:` property inside an options object
 * literal, or null when the options carry no `env` property (env unset →
 * inherit → permissive by construction).
 */
function envLiteralOf(options: string): string | null {
  const m = /\benv\s*:/.exec(options);
  if (!m) return null;
  const rest = options.slice(m.index + m[0].length).replace(/^\s+/, "");
  if (!rest.startsWith("{")) {
    // Identifier / member expression, e.g. `process.env` — consume to the
    // next comma, newline, or closing brace.
    const end = /[,\n}]/.exec(rest);
    return (end ? rest.slice(0, end.index) : rest).trim();
  }
  let depth = 0;
  let state: "code" | "sq" | "dq" = "code";
  for (let j = 0; j < rest.length; j++) {
    const ch = rest[j];
    if (state === "sq") {
      if (ch === "'") state = "code";
      continue;
    }
    if (state === "dq") {
      if (ch === '"') state = "code";
      continue;
    }
    if (ch === "'") state = "sq";
    else if (ch === '"') state = "dq";
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return rest.slice(0, j + 1).trim();
    }
  }
  return rest.trim(); // unbalanced — best effort, still checked below
}

/**
 * Env permissiveness verdict for one git call site's options object.
 * Permissive: `env` unset / `process.env` / any non-empty subset.
 * Regression: `env: {}` (explicit empty env breaks PATH inheritance) or an
 * env object whose PATH value is an empty string (deliberate breakage).
 */
function envVerdict(options: string): { ok: true } | { ok: false; reason: string } {
  const env = envLiteralOf(options);
  if (env === null) return { ok: true };
  const value = env.trim();
  if (value === "{}") {
    return { ok: false, reason: "empty env object literal `{}` — breaks PATH inheritance" };
  }
  if (/\bPATH\s*:\s*(?:""|'')/.test(value)) {
    return { ok: false, reason: "env object sets PATH to an empty string" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("engine git execFileSync env pinning (plan 20260822-cli-engine-leftover T3)", () => {
  test("site inventory matches the plan scan (path.ts 1, sdd.ts 4, worktree.ts 1)", () => {
    const perFile: Record<string, GitExecSite[]> = {
      "path.ts": [],
      "sdd.ts": [],
      "worktree.ts": [],
    };
    for (const { name, path } of GIT_SHELL_OUT_FILES) {
      perFile[name] = gitExecSites(readFileSync(path, "utf8"), name);
    }
    expect(perFile["path.ts"].length).toBe(1);
    expect(perFile["sdd.ts"].length).toBe(4);
    expect(perFile["worktree.ts"].length).toBe(1);
    // Drift detector: if a git site moves or the count changes, THIS test
    // must be updated — never the production env (plan drift check:
    // "update the test, not production").
    expect(
      perFile["path.ts"].length + perFile["sdd.ts"].length + perFile["worktree.ts"].length,
    ).toBe(6);
  });

  test("regression detector: no git execFileSync passes an empty env", () => {
    const failures: string[] = [];
    let siteCount = 0;
    for (const { name, path } of GIT_SHELL_OUT_FILES) {
      for (const site of gitExecSites(readFileSync(path, "utf8"), name)) {
        siteCount++;
        const verdict = envVerdict(site.options);
        if (!verdict.ok) failures.push(`${name}:${site.line} — ${verdict.reason}`);
      }
    }
    expect(siteCount).toBe(6); // the scan must stay live, not go blind
    expect(failures).toEqual([]);
  });

  test("permissive envs pass: unset, process.env, non-empty subsets", () => {
    expect(envVerdict("{ cwd, stdio: ['ignore', 'pipe', 'pipe'] }").ok).toBe(true);
    expect(envVerdict("{ cwd, env: process.env }").ok).toBe(true);
    expect(envVerdict("{ cwd, env: { PATH: '/usr/local/bin' } }").ok).toBe(true);
    expect(envVerdict("{ cwd, env: { HOME: '/root', PATH: '/usr/bin' } }").ok).toBe(true);
  });

  test("regressions fail: env: {} and env with an empty PATH", () => {
    expect(envVerdict("{ cwd, env: {} }")).toEqual({ ok: false, reason: expect.stringMatching(/^empty env/) });
    expect(envVerdict("{ cwd, env: { PATH: '' } }")).toEqual({
      ok: false,
      reason: expect.stringMatching(/PATH to an empty string/),
    });
    expect(envVerdict("{ cwd, env: { PATH: \"\" } }").ok).toBe(false);
  });
});
