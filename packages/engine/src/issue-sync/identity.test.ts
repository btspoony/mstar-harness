/**
 * identity.test.ts — the one git-identity reader: the repository identity
 * (\`owner/name\`) and the author that stamps every pushed marker.
 *
 * The fixture is a REAL temporary repository: a mock of git could not prove the
 * normalization or the empty-config refusals. Global and system config are
 * disabled for the duration, so a developer's own user.email never decides the
 * outcome.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readRepoIdentity } from "./identity.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-identity-test-"));
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedSystem = process.env.GIT_CONFIG_NOSYSTEM;

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedSystem;
  rmSync(ROOT, { recursive: true, force: true });
});

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

/** A real repository with the given origin remote and local identity. */
function repo(options: { remote?: string; name?: string; email?: string } = {}): string {
  const dir = mkdtempSync(join(ROOT, "repo-"));
  git(dir, ["init", "-q"]);
  if (options.remote !== undefined) git(dir, ["remote", "add", "origin", options.remote]);
  git(dir, ["config", "user.name", options.name ?? "Ada Lovelace"]);
  git(dir, ["config", "user.email", options.email ?? "ada@example.com"]);
  return dir;
}

describe("readRepoIdentity", () => {
  test("an ssh remote normalizes to owner/name", () => {
    expect(readRepoIdentity(repo({ remote: "git@github.com:acme/widgets.git" }))).toEqual({
      ok: true,
      repo: "acme/widgets",
      author: "Ada Lovelace <ada@example.com>",
    });
  });

  test("an https remote normalizes to the same owner/name", () => {
    expect(readRepoIdentity(repo({ remote: "https://github.com/acme/widgets.git" }))).toEqual({
      ok: true,
      repo: "acme/widgets",
      author: "Ada Lovelace <ada@example.com>",
    });
  });

  test("an ssh:// remote keeps the last two path segments", () => {
    const identity = readRepoIdentity(repo({ remote: "ssh://git@example.test/acme/widgets" }));
    expect(identity.ok && identity.repo).toBe("acme/widgets");
  });

  test("no origin: the [linear] repo= override wins", () => {
    expect(readRepoIdentity(repo(), "acme/widgets")).toEqual({
      ok: true,
      repo: "acme/widgets",
      author: "Ada Lovelace <ada@example.com>",
    });
  });

  test("no origin and no override: refused, naming both recoveries", () => {
    const identity = readRepoIdentity(repo());
    expect(identity.ok).toBe(false);
    expect(identity.ok === false && identity.code).toBe("linear.repo-unresolved");
    const message = identity.ok === false ? identity.message : "";
    expect(message).toContain("origin");
    expect(message).toContain("[linear] repo=");
  });

  test("an empty user.email is refused, naming the config key to set", () => {
    const identity = readRepoIdentity(repo({ remote: "git@github.com:acme/widgets.git", email: "" }));
    expect(identity.ok).toBe(false);
    expect(identity.ok === false && identity.code).toBe("linear.author-unresolved");
    const message = identity.ok === false ? identity.message : "";
    expect(message).toContain("git config user.email");
  });
});
