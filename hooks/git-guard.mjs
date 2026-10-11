#!/usr/bin/env node
// Morning Star harness — ZCode PreToolUse(Bash) git guard.
// Deterministic backstop for the mstar-branch-worktree runtime rules:
//   1. No direct `git commit` on the default protected branch (origin/HEAD,
//      falling back to main/master) without an explicit Assignment
//      `Branch policy: direct on <branch>` — bypass per-session with
//      MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT=1 (environment, or prefixed to the
//      command itself), or disable the whole hook with MSTAR_BRANCH_GUARD=off.
//   2. No bare `git push --force` / `-f` — history rewrites publish with
//      `--force-with-lease=<branch>:<observed-oid>` only.
// Invocation analysis is a gate heuristic, not a shell parser: shell segments
// are split on separators, leading env assignments are skipped, the program
// must be git, and global option tokens (with their separate values) are
// stepped over before the subcommand. Silent pass (exit 0) for anything else,
// outside git repos, or on internal errors — the hook gates, it never blocks
// the session by malfunctioning.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function gitOut(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// Global options that take their value as a separate token.
const VALUE_OPTS = new Set([
  "-c",
  "-C",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--shallow-file",
  "--work-tree",
]);

/** Whitespace tokenizer that honors single/double quotes, so quoted
 * `-C "/path with spaces"` values survive as one token. Shell-unaware
 * beyond quoting (vars, subshells) — a gate heuristic, not a parser. */
function tokenizeSegment(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let hasToken = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens.filter(Boolean);
}

/** Per-segment analysis of every `git` invocation in a command line:
 * `{ sub, dirHint, argv }` where `sub` is the git subcommand, `dirHint` is
 * the `-C`/`--work-tree` target when one is given, and `argv` starts at the
 * subcommand token (its flags and arguments follow). */
function analyzeGitInvocations(command) {
  const invocations = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = tokenizeSegment(segment);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1; // env assignments
    if (!tokens[i] || !/(^|\/)git$/.test(tokens[i])) continue;
    i += 1;
    let sub = null;
    let subIndex = -1;
    let dirHint;
    for (; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token.startsWith("-")) {
        sub = token;
        subIndex = i;
        break;
      }
      if ((token === "-C" || token === "--work-tree" || token === "--git-dir") && tokens[i + 1] && !tokens[i + 1].startsWith("-")) {
        dirHint = tokens[i + 1];
        i += 1;
      } else if (VALUE_OPTS.has(token)) {
        i += 1;
      }
    }
    if (sub) invocations.push({ sub, dirHint, argv: tokens.slice(subIndex) });
  }
  return invocations;
}

// Push options whose following token is a value, not a repository/refspec.
const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

/** Force detection distinguishes option values, repository and refspecs. */
function isBareForcePush(invocation) {
  let repositorySeen = false;
  for (let i = 1; i < invocation.argv.length; i += 1) {
    const token = invocation.argv[i];
    if (token === "--force") return true;
    if (token.startsWith("-")) {
      if (token !== "--force-with-lease" && /^-[^-]*f/.test(token)) return true;
      if (PUSH_VALUE_OPTS.has(token)) i += 1;
      continue;
    }
    if (!repositorySeen) {
      repositorySeen = true;
      continue;
    }
    if (token.startsWith("+")) return true;
  }
  return false;
}

const COMMIT_ESCAPE_IN_COMMAND = /MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT=1(\s|$)/;

const input = await readStdinJson();
try {
  if (process.env.MSTAR_BRANCH_GUARD === "off") process.exit(0);
  if (input?.tool_name && input.tool_name !== "Bash") process.exit(0);

  const command = String(input?.tool_input?.command ?? "");
  if (!command) process.exit(0);

  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();

  const invocations = analyzeGitInvocations(command);
  const isCommit = invocations.some((inv) => inv.sub === "commit");
  const pushInvocations = invocations.filter((inv) => inv.sub === "push");
  if (!isCommit && pushInvocations.length === 0) process.exit(0);

  const gated = invocations.find((inv) => inv.sub === "commit" || inv.sub === "push");
  const workCwd = gated.dirHint
    ? path.isAbsolute(gated.dirHint)
      ? gated.dirHint
      : path.join(cwd, gated.dirHint)
    : cwd;

  let root;
  try {
    root = gitOut(["rev-parse", "--show-toplevel"], workCwd);
  } catch {
    process.exit(0); // not a git repo
  }

  if (isCommit && process.env.MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT !== "1" && !COMMIT_ESCAPE_IN_COMMAND.test(command)) {
    let branch = "";
    try {
      branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"], root);
    } catch {
      process.exit(0);
    }
    if (branch && branch !== "HEAD") {
      // symbolic-ref prints the fully qualified ref (refs/remotes/origin/main)
      let defaultBranch = "";
      try {
        defaultBranch = gitOut(["symbolic-ref", "refs/remotes/origin/HEAD"], root).replace(
          /^refs\/remotes\/origin\//,
          "",
        );
      } catch {
        defaultBranch = /^(main|master)$/.test(branch) ? branch : "";
      }
      if (defaultBranch && branch === defaultBranch) {
        deny(
          `Morning Star branch gate (mstar-branch-worktree): direct commits on the default protected branch \`${branch}\` are blocked. ` +
            `Work on a feature/working branch (e.g. \`git checkout -b feature/<slug>\`), or — only with an explicit ` +
            `\`Branch policy: direct on ${branch}\` decision — re-run with MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT=1 ` +
            `(set it in the session environment, or prefix the command: \`MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT=1 <command>\`).`,
        );
      }
    }
  }

  if (pushInvocations.some(isBareForcePush)) {
    deny(
      "Morning Star push gate (mstar-branch-worktree): bare `git push --force` is blocked — history rewrites on pushed branches " +
        "must publish with `--force-with-lease=<branch>:<observed-oid>` after fetching the remote OID first " +
        "(disable the whole guard with MSTAR_BRANCH_GUARD=off only as a deliberate exception).",
    );
  }
} catch {
  // internal error — pass silently; the hook must never wedge a session
}
process.exit(0);
