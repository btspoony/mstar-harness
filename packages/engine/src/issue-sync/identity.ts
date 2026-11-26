import { execFileSync } from "node:child_process";
import { gitProbeTimeoutMs } from "../git-probe.js";

export type RepoIdentity =
  | { ok: true; repo: string; author: string }
  | { ok: false; code: "linear.repo-unresolved" | "linear.author-unresolved"; message: string };

/** note: One bounded git read; `null` when git cannot answer (not a repo, timeout, no key). */
function gitRead(repoRoot: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: gitProbeTimeoutMs(),
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * `owner/name` from any remote spelling: `git@host:owner/name.git`,
 * `https://host/owner/name.git`, `ssh://host/owner/name`, or a local path. The
 * last two path segments are the identity; a remote with fewer is not one.
 */
export function normalizeRepoRemote(remote: string): string | null {
  const value = remote.trim();
  if (value === "") return null;
  let path = value;
  if (value.includes("://")) {
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
  } else if (value.includes(":")) {
    // why: scp-like `user@host:owner/name`: everything after the last colon is the path.
    path = value.slice(value.lastIndexOf(":") + 1);
  }
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  const name = segments[segments.length - 1]!.replace(/\.git$/, "");
  const owner = segments[segments.length - 2]!;
  if (owner === "" || name === "") return null;
  return owner + "/" + name;
}

/**
 * This checkout's repository identity and git author.
 *
 * `override` is the `[linear] repo=` value, used only when the checkout has no
 * usable `origin`: an existing remote is the fact, and the key is the fallback
 * the refusal names.
 */
export function readRepoIdentity(repoRoot: string, override?: string): RepoIdentity {
  const name = gitRead(repoRoot, ["config", "--get", "user.name"]);
  const email = gitRead(repoRoot, ["config", "--get", "user.email"]);
  if (name === null || email === null) {
    const missing = [name === null ? "user.name" : null, email === null ? "user.email" : null].filter(Boolean).join(" and ");
    return {
      ok: false,
      code: "linear.author-unresolved",
      message:
        "linear.author-unresolved: this checkout has no git author to stamp the marker with (missing " + missing + " in " +
        repoRoot + "). Set it with 'git config user.name \"Your Name\"' and 'git config user.email \"you@example.com\"', then re-run",
    };
  }
  const origin = gitRead(repoRoot, ["remote", "get-url", "origin"]);
  const repo = (origin === null ? null : normalizeRepoRemote(origin)) ?? normalizeRepoRemote(override ?? "");
  if (repo === null) {
    return {
      ok: false,
      code: "linear.repo-unresolved",
      message:
        "linear.repo-unresolved: this checkout has no origin remote to derive owner/name from, and no [linear] repo= override is set (" +
        repoRoot + "). Add one with 'git remote add origin <url>', or declare the repository in " +
        ".mstarc as '[linear] repo=<owner/name>', then re-run",
    };
  }
  return { ok: true, repo, author: name + " <" + email + ">" };
}
